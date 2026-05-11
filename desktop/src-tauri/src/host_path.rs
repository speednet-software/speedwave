//! Recovers the user's *login-shell* `PATH` once at app startup, for the
//! `host_exec` worker (and, via the worker's child-env allowlist, for recipes).
//!
//! A GUI-launched Desktop app does not inherit the login shell's `PATH` — on
//! macOS launched from Finder, `std::env::var("PATH")` is just
//! `/usr/bin:/bin:/usr/sbin:/sbin` (no `/opt/homebrew/bin`, no `nvm`/`asdf`
//! shims). `./gradlew` (a repo script) is fine, but `npm`/`docker`/`gradle`
//! *globals* are not. So we run `$SHELL -ilc 'printf %s "$PATH"'` once, with a
//! short timeout, and cache the result; if that fails (no `$SHELL`, the shell
//! exits non-zero, the call times out, or this is Windows where there is no
//! login-shell concept), we fall back to the inherited `PATH` plus the two
//! common Homebrew bin dirs. See ADR-054 §PATH.

use std::sync::OnceLock;
use std::time::Duration;

/// How long to wait for `$SHELL -ilc 'printf %s "$PATH"'` before falling back.
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(5);

/// Cached recovered `PATH`. Populated by [`init_recovered_host_path`] at
/// startup; read by [`recovered_host_path`].
static RECOVERED_HOST_PATH: OnceLock<String> = OnceLock::new();

/// Resolve the recovered login-shell `PATH`, computing it once. Subsequent
/// calls return the cached value. Safe to call before [`init_recovered_host_path`]
/// (it will do the work then) — but `setup()` calls `init_*` early so the
/// (potentially slow) shell invocation doesn't happen on a hot path.
pub(crate) fn recovered_host_path() -> &'static str {
    RECOVERED_HOST_PATH.get_or_init(compute_recovered_path)
}

/// Eagerly compute and cache the recovered `PATH` (called once from `setup()`).
/// No-op if already initialised.
pub(crate) fn init_recovered_host_path() {
    let _ = recovered_host_path();
}

/// The fallback `PATH` when the login-shell probe is unavailable/fails:
/// the inherited `PATH` plus the two common Homebrew bin dirs (so `docker` /
/// `gradle` installed via Homebrew still resolve). On Windows there is no
/// login-shell concept — the inherited `PATH` is the right (and only) answer,
/// so the Homebrew dirs (harmless on Windows; just non-existent) are appended
/// the same way for code-path simplicity.
fn fallback_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let extra = ["/usr/local/bin", "/opt/homebrew/bin"];
    let sep = path_sep();
    let mut parts: Vec<String> = inherited
        .split(sep)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    for e in extra {
        if !parts.iter().any(|p| p == e) {
            parts.push(e.to_string());
        }
    }
    parts.join(sep)
}

#[cfg(windows)]
fn path_sep() -> &'static str {
    ";"
}
#[cfg(not(windows))]
fn path_sep() -> &'static str {
    ":"
}

/// Computes the recovered `PATH`. On Unix: `$SHELL -ilc 'printf %s "$PATH"'`
/// with a timeout; falls back to [`fallback_path`] if `$SHELL` is unset, the
/// command fails / exits non-zero / times out, or the output is empty. On
/// Windows: just [`fallback_path`] (no login shell).
fn compute_recovered_path() -> String {
    #[cfg(not(windows))]
    {
        match probe_login_shell_path(SHELL_PATH_TIMEOUT) {
            Some(p) if !p.trim().is_empty() => {
                log::info!(
                    "recovered login-shell PATH ({} entries)",
                    p.split(':').count()
                );
                p
            }
            _ => {
                let fb = fallback_path();
                log::warn!(
                    "could not recover login-shell PATH — using fallback ({} entries)",
                    fb.split(':').count()
                );
                fb
            }
        }
    }
    #[cfg(windows)]
    {
        // No login-shell concept on Windows; the process PATH is authoritative.
        fallback_path()
    }
}

/// Run `$SHELL -ilc 'printf %s "$PATH"'` with a timeout, returning its stdout
/// (trimmed) on a clean exit. `None` on any failure (unset `$SHELL`, spawn
/// error, non-zero exit, or timeout). Pulled out so it's testable with an
/// explicit timeout.
#[cfg(not(windows))]
fn probe_login_shell_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    // -i: interactive (sources the user's rc), -l: login (sources the profile),
    // -c: run the command. `printf %s "$PATH"` writes the PATH with no newline
    // or quoting, which `bash`/`zsh`/`sh` all support.
    let mut child = std::process::Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    // Wait with a timeout: a thread reads stdout to completion (so a chatty rc
    // file printing to stdout can't deadlock the pipe), the main path waits on
    // a channel; on timeout we kill the child.
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Process exited — collect whatever the reader thread got.
                let out = rx
                    .recv_timeout(Duration::from_millis(200))
                    .unwrap_or_default();
                if !status.success() {
                    return None;
                }
                let s = String::from_utf8_lossy(&out).trim().to_string();
                return if s.is_empty() { None } else { Some(s) };
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// Restore `$SHELL` to a previously-captured value (or remove it if there
    /// was none) — the symmetric counterpart of `let prev = env::var("SHELL")`.
    #[cfg(not(windows))]
    fn restore_shell_env(prev: Option<String>) {
        match prev {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }

    #[test]
    fn fallback_path_includes_homebrew_dirs() {
        let fb = fallback_path();
        assert!(
            fb.contains("/usr/local/bin"),
            "fallback should include /usr/local/bin: {fb}"
        );
        assert!(
            fb.contains("/opt/homebrew/bin"),
            "fallback should include /opt/homebrew/bin: {fb}"
        );
        // It should not produce duplicate entries when PATH already has them.
        let count = fb
            .split(path_sep())
            .filter(|p| *p == "/usr/local/bin")
            .count();
        assert_eq!(
            count, 1,
            "no duplicate /usr/local/bin in fallback PATH: {fb}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    #[serial(env)]
    fn probe_login_shell_path_returns_path_on_success() {
        // Point $SHELL at a tiny script that just prints a fixed PATH and exits 0.
        let tmp = tempfile::tempdir().unwrap();
        let fake_shell = tmp.path().join("fake-shell.sh");
        std::fs::write(
            &fake_shell,
            "#!/bin/sh\n# ignore -ilc args; just print a known PATH\nprintf %s \"/known/bin:/usr/bin\"\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake_shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let prev = std::env::var("SHELL").ok();
        std::env::set_var("SHELL", &fake_shell);
        let got = probe_login_shell_path(Duration::from_secs(5));
        restore_shell_env(prev);
        assert_eq!(got.as_deref(), Some("/known/bin:/usr/bin"));
    }

    #[cfg(not(windows))]
    #[test]
    #[serial(env)]
    fn probe_login_shell_path_none_on_nonzero_exit() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_shell = tmp.path().join("fail-shell.sh");
        std::fs::write(&fake_shell, "#!/bin/sh\nexit 3\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake_shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let prev = std::env::var("SHELL").ok();
        std::env::set_var("SHELL", &fake_shell);
        let got = probe_login_shell_path(Duration::from_secs(5));
        restore_shell_env(prev);
        assert!(got.is_none(), "a non-zero shell exit must yield None");
    }

    #[cfg(not(windows))]
    #[test]
    #[serial(env)]
    fn probe_login_shell_path_none_on_timeout() {
        let tmp = tempfile::tempdir().unwrap();
        let slow_shell = tmp.path().join("slow-shell.sh");
        std::fs::write(&slow_shell, "#!/bin/sh\nsleep 10\nprintf %s /never\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&slow_shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let prev = std::env::var("SHELL").ok();
        std::env::set_var("SHELL", &slow_shell);
        let start = std::time::Instant::now();
        let got = probe_login_shell_path(Duration::from_millis(200));
        restore_shell_env(prev);
        assert!(got.is_none(), "a slow shell must time out to None");
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "timeout should fire well before the shell finishes"
        );
    }

    #[cfg(not(windows))]
    #[test]
    #[serial(env)]
    fn probe_login_shell_path_none_when_shell_unset() {
        let prev = std::env::var("SHELL").ok();
        std::env::remove_var("SHELL");
        let got = probe_login_shell_path(Duration::from_secs(5));
        restore_shell_env(prev);
        assert!(got.is_none(), "no $SHELL → None (caller uses the fallback)");
    }

    #[test]
    fn recovered_host_path_is_non_empty_and_cached() {
        let a = recovered_host_path();
        assert!(
            !a.is_empty(),
            "recovered PATH must never be empty (fallback ensures it)"
        );
        let b = recovered_host_path();
        assert_eq!(
            a.as_ptr(),
            b.as_ptr(),
            "recovered PATH is computed once and cached"
        );
    }
}

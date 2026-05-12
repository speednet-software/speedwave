//! Recovers the user's login-shell `PATH` once at startup for `host_exec` (ADR-054 §PATH).

use std::sync::OnceLock;
use std::time::Duration;

/// How long to wait for `$SHELL -ilc 'printf %s "$PATH"'` before falling back.
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(5);

/// Cached recovered `PATH`. Populated by [`init_recovered_host_path`] at
/// startup; read by [`recovered_host_path`].
static RECOVERED_HOST_PATH: OnceLock<String> = OnceLock::new();

/// Resolve the recovered `PATH`, computing it once. Subsequent calls return the cache.
pub(crate) fn recovered_host_path() -> &'static str {
    RECOVERED_HOST_PATH.get_or_init(compute_recovered_path)
}

/// Eagerly compute and cache the recovered `PATH` (called once from `setup()`).
/// No-op if already initialised.
pub(crate) fn init_recovered_host_path() {
    let _ = recovered_host_path();
}

/// Inherited `PATH` plus Homebrew bin dirs (harmless on Windows).
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

/// Recovered `PATH` via `$SHELL -ilc 'printf %s "$PATH"'`; falls back on any failure.
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
        // Windows: process PATH is authoritative (no login shell).
        fallback_path()
    }
}

/// `$SHELL -ilc 'printf %s "$PATH"'` with a timeout; `None` on any failure.
#[cfg(not(windows))]
fn probe_login_shell_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    // -ilc: interactive + login + run the command; `printf %s` is portable.
    let mut child = std::process::Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    // Reader thread drains stdout (chatty rc files can't deadlock the pipe).
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
                // Exited — collect whatever the reader thread captured.
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

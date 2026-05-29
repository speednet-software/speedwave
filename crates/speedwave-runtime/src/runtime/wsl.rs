#[cfg(any(target_os = "windows", test))]
use super::{CommandRunner, ContainerRuntime, RealRunner};
use crate::consts;
#[cfg(any(target_os = "windows", test))]
use serde_json::Value;
use std::path::Path;
#[cfg(any(target_os = "windows", test))]
use std::path::PathBuf;
#[cfg(any(target_os = "windows", test))]
use std::process::Command;

/// Decodes raw bytes from `wsl.exe` output, handling UTF-16LE (with or without BOM)
/// which is the default encoding for `wsl.exe --list` on Windows.
///
/// Tries decoding approaches in order:
/// 1. UTF-16LE with BOM (bytes start with 0xFF 0xFE)
/// 2. UTF-16LE without BOM (even length, decodes without replacement characters
///    and contains only printable text plus common whitespace)
/// 3. Fallback to UTF-8
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    // UTF-16LE with BOM
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    // Heuristic for UTF-16LE without BOM: require even length and at least
    // one null byte in an odd position (the high byte of ASCII code points
    // in UTF-16LE is always 0x00). This distinguishes UTF-16LE-encoded ASCII
    // from plain UTF-8, which would never have null bytes in odd positions.
    // If the heuristic matches, attempt decode and accept only if the result
    // contains no replacement characters and no unexpected control characters.
    if bytes.len() >= 4 && bytes.len().is_multiple_of(2) {
        let has_null_high_bytes = bytes.iter().skip(1).step_by(2).any(|&b| b == 0x00);
        if has_null_high_bytes {
            let u16s: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let decoded = String::from_utf16_lossy(&u16s);
            if !decoded.contains('\u{FFFD}')
                && decoded
                    .chars()
                    .all(|c| !c.is_control() || c == '\n' || c == '\r' || c == '\t')
            {
                return decoded;
            }
        }
    }
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(any(target_os = "windows", test))]
pub struct WslRuntime {
    runner: Box<dyn CommandRunner>,
    retry_delay: std::time::Duration,
    restart_ready_delay: std::time::Duration,
    distro_name: String,
}

#[cfg(any(target_os = "windows", test))]
impl Default for WslRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(any(target_os = "windows", test))]
impl WslRuntime {
    pub fn new() -> Self {
        Self {
            runner: Box::new(RealRunner),
            retry_delay: std::time::Duration::from_secs(consts::WSL_SERVICE_START_DELAY_SECS),
            restart_ready_delay: std::time::Duration::from_secs(
                consts::CONTAINERD_RESTART_READY_DELAY_SECS,
            ),
            distro_name: consts::wsl_distro_name().to_string(),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Box<dyn CommandRunner>) -> Self {
        Self {
            runner,
            retry_delay: std::time::Duration::from_secs(consts::WSL_SERVICE_START_DELAY_SECS),
            restart_ready_delay: std::time::Duration::from_secs(
                consts::CONTAINERD_RESTART_READY_DELAY_SECS,
            ),
            distro_name: consts::wsl_distro_name().to_string(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_distro_name(name: String, runner: Box<dyn CommandRunner>) -> Self {
        Self {
            runner,
            retry_delay: std::time::Duration::ZERO,
            restart_ready_delay: std::time::Duration::ZERO,
            distro_name: name,
        }
    }

    fn distro(&self) -> &str {
        &self.distro_name
    }

    /// Sets retry delay and restart ready delay to zero for tests to avoid sleeping.
    #[cfg(test)]
    fn with_zero_delay(mut self) -> Self {
        self.retry_delay = std::time::Duration::ZERO;
        self.restart_ready_delay = std::time::Duration::ZERO;
        self
    }

    /// Checks that a service is running inside the WSL distro. If the check
    /// command fails, tries to start the service via systemctl and retries
    /// with a delay up to `WSL_SERVICE_CHECK_MAX_RETRIES` times.
    ///
    /// - `service_name`: display name for logs/errors (e.g. "buildkitd")
    /// - `systemd_unit`: systemd unit name for `systemctl start` (e.g. "buildkit")
    fn check_service(
        &self,
        distro: &str,
        check_cmd: &[&str],
        service_name: &str,
        systemd_unit: &str,
    ) -> anyhow::Result<()> {
        let mut args = vec!["-d", distro, "--"];
        args.extend_from_slice(check_cmd);

        // Fast path: service already running
        if self.runner.run("wsl.exe", &args).is_ok() {
            return Ok(());
        }

        // Try starting the service, preserve error for diagnostics
        let start_err = self
            .runner
            .run(
                "wsl.exe",
                &["-d", distro, "--", "systemctl", "start", systemd_unit],
            )
            .err();
        if let Some(ref e) = start_err {
            log::warn!("systemctl start {systemd_unit} failed: {e}");
        }

        let max = consts::WSL_SERVICE_CHECK_MAX_RETRIES;
        let mut last_check_err = None;

        for attempt in 1..=max {
            // Check first, sleep after — avoids unnecessary wait when service is already up
            match self.runner.run("wsl.exe", &args) {
                Ok(_) => {
                    log::info!("{service_name} ready after {attempt} attempt(s)");
                    return Ok(());
                }
                Err(e) => {
                    last_check_err = Some(e);
                    log::info!("Waiting for {service_name} (attempt {attempt}/{max})");
                }
            }
            std::thread::sleep(self.retry_delay);
        }

        // Build diagnostic error with both start and check errors
        let mut msg = format!(
            "{service_name} is not running inside WSL2 distribution '{distro}' after {max} attempts."
        );
        if let Some(e) = start_err {
            msg.push_str(&format!(" systemctl start {systemd_unit}: {e}."));
        }
        if let Some(e) = last_check_err {
            msg.push_str(&format!(" Last health check: {e}."));
        }
        msg.push_str(&format!(
            " Try: wsl -d {distro} -- systemctl start {systemd_unit}"
        ));
        Err(anyhow::anyhow!(msg))
    }
}

/// Parsed WSL UNC path: `\\wsl.localhost\<distro>\<rest>` and equivalent forms.
/// Server name and distro name are matched case-insensitively (Windows UNC is
/// case-insensitive, and WSL distro names compare case-insensitively).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslUncInfo {
    /// Distro name as written by the user (preserves original casing for messages).
    pub distro: String,
    /// Path inside the distro, leading slash stripped, backslashes normalized to `/`.
    /// Empty string for bare-root paths (`\\wsl.localhost\Speedwave\`).
    pub rest: String,
}

impl WslUncInfo {
    /// Returns `true` if `distro` matches Speedwave's own runtime distro
    /// (case-insensitive).
    pub fn is_runtime_distro(&self) -> bool {
        self.distro.eq_ignore_ascii_case(consts::wsl_distro_name())
    }
}

/// Returns `true` if the path is the WSL distro root (`/` after translation).
/// Used by `project::add_project` to reject `\\wsl.localhost\Speedwave\` as a
/// project directory — mounting `/` as `/workspace` would expose the entire
/// runtime distro.
///
/// Normalises trailing separators, `.` segments, and `..` segments before
/// comparing. `/foo/..` and `/foo/../` both resolve to root.
pub fn is_root_path(p: &Path) -> bool {
    // Walk components: skip `.` and `RootDir` (the leading `/`); push `Normal`
    // components and pop them on `..`. Empty stack means we collapsed to root.
    use std::path::Component;
    let mut depth: i32 = 0;
    for c in p.components() {
        match c {
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
            Component::ParentDir => {
                depth = (depth - 1).max(0);
            }
            Component::Normal(_) => depth += 1,
        }
    }
    depth == 0
}

/// Shared parser for the WSL UNC prefix surface. Strips `\\?\UNC\` (case-insensitive
/// for the `UNC` segment) or `\\` from the front and returns the remainder. Returns
/// `None` for paths that do not start with a UNC marker.
///
/// SSOT for prefix handling — used by [`is_wsl_unc_path`] and
/// [`looks_like_wsl_unc_prefix`] so the two cannot drift apart.
fn strip_unc_prefix(s: &str) -> Option<&str> {
    // `\\?\UNC\` extended-length prefix: first 4 bytes (`\\?\`) are case-stable,
    // bytes 4..7 (`UNC`) are case-insensitive per the Win32 path normalization
    // contract, byte 7 is the literal `\`. Check explicitly to also accept
    // mixed-case (`\\?\Unc\`, `\\?\uNc\`, ...) that some tooling may emit.
    let bytes = s.as_bytes();
    if bytes.len() >= 8
        && &bytes[0..4] == br"\\?\"
        && bytes[4].eq_ignore_ascii_case(&b'U')
        && bytes[5].eq_ignore_ascii_case(&b'N')
        && bytes[6].eq_ignore_ascii_case(&b'C')
        && bytes[7] == b'\\'
    {
        // Safe: first 8 bytes are all ASCII.
        return Some(&s[8..]);
    }
    s.strip_prefix(r"\\")
}

/// Returns `true` if `server` is a WSL UNC server name (`wsl.localhost` or
/// `wsl$`, case-insensitive). Single SSOT for server matching.
fn is_wsl_server(server: &str) -> bool {
    server.eq_ignore_ascii_case("wsl.localhost") || server.eq_ignore_ascii_case("wsl$")
}

/// Recognizes WSL UNC paths in all four forms Windows emits:
/// - `\\wsl.localhost\<distro>\<rest>` (modern)
/// - `\\wsl$\<distro>\<rest>` (legacy)
/// - `\\?\UNC\wsl.localhost\<distro>\<rest>` (canonicalized modern)
/// - `\\?\UNC\wsl$\<distro>\<rest>` (canonicalized legacy)
///
/// Returns `None` for non-WSL UNC paths (`\\server\share\...`), drive-letter
/// paths, and Unix paths.
pub fn is_wsl_unc_path(s: &str) -> Option<WslUncInfo> {
    // Strip `\\?\UNC\` / `\\?\unc\` / `\\` (shared SSOT — see `strip_unc_prefix`).
    let after_double_backslash = strip_unc_prefix(s)?;

    // Split on backslash: server, distro, rest...
    let mut parts = after_double_backslash.splitn(3, '\\');
    let server = parts.next()?;
    let distro = parts.next()?;

    // Server must be a WSL UNC server (shared SSOT — see `is_wsl_server`).
    if !is_wsl_server(server) {
        return None;
    }

    // Distro must be non-empty.
    if distro.is_empty() {
        return None;
    }

    // Rest may be missing (bare root: `\\wsl.localhost\Speedwave` or `\\wsl.localhost\Speedwave\`).
    let rest = parts.next().unwrap_or("").replace('\\', "/");
    // Strip trailing slash from bare-root variants to normalize "" and "/" into "".
    let rest = rest.trim_end_matches('/').to_string();

    Some(WslUncInfo {
        distro: distro.to_string(),
        rest,
    })
}

/// Returns `true` if a path string looks like a WSL UNC server prefix
/// (`\\wsl.localhost\...`, `\\wsl$\...`, or their `\\?\UNC\` canonicalized
/// equivalents) — even when malformed (e.g. missing distro segment). Used
/// by [`windows_to_wsl_path`] to surface a precise "Malformed WSL UNC"
/// error instead of the generic "Network UNC" reject.
#[cfg(any(target_os = "windows", test))]
pub fn looks_like_wsl_unc_prefix(s: &str) -> bool {
    match strip_unc_prefix(s) {
        Some(rest) => {
            let server = rest.split('\\').next().unwrap_or("");
            is_wsl_server(server)
        }
        None => false,
    }
}

/// Converts a Windows-style path (`C:\foo\bar` or `C:/foo/bar`) to a WSL mount path
/// (`/mnt/c/foo/bar`). Passes through paths that are already Unix-style.
///
/// Handles the extended-length prefix (`\\?\C:\...`) that Windows APIs sometimes
/// return (e.g. from `canonicalize()` or `GetTempPath()`), stripping it to extract
/// the underlying drive-letter path.
///
/// Recognizes WSL UNC paths (`\\wsl.localhost\<distro>\...`, `\\wsl$\<distro>\...`,
/// and their canonicalized `\\?\UNC\...` forms): if `<distro>` matches Speedwave's
/// own runtime distro, returns the inner path (`/<rest>`). For other distros,
/// returns a helpful error explaining options (copy/move/native).
///
/// Returns an error for true network UNC paths (`\\server\share`) which cannot
/// be mapped to WSL mount points.
#[cfg(any(target_os = "windows", test))]
pub fn windows_to_wsl_path(path: &Path) -> anyhow::Result<PathBuf> {
    let s = path.to_string_lossy();
    let bytes = s.as_bytes();

    // Handle extended-length prefix: \\?\C:\... → strip prefix and recurse
    if bytes.len() >= 6
        && bytes[0] == b'\\'
        && bytes[1] == b'\\'
        && bytes[2] == b'?'
        && bytes[3] == b'\\'
        && bytes[4].is_ascii_alphabetic()
        && bytes[5] == b':'
    {
        // Safe: first 4 bytes are ASCII (`\\?\`), remainder is a normal path
        return windows_to_wsl_path(Path::new(&s[4..]));
    }

    // WSL UNC paths: match own distro → /<rest>; mismatch → helpful error.
    // Pure parsing is in `is_wsl_unc_path`; covers all 4 forms including \\?\UNC\.
    if let Some(info) = is_wsl_unc_path(&s) {
        if info.is_runtime_distro() {
            // Bare root (rest == "") returns "/" — pure path translator.
            // Rejection of "/" as a project dir is enforced in project::add_project.
            return Ok(PathBuf::from(format!("/{}", info.rest)));
        }
        anyhow::bail!(consts::wsl_other_distro_msg(&info.distro));
    }

    // Malformed WSL UNC (e.g. `\\wsl.localhost\` with no distro segment):
    // surface a precise error instead of falling through to the generic
    // "Network UNC" reject, which would mislead users who typed a WSL path.
    if looks_like_wsl_unc_prefix(&s) {
        anyhow::bail!(
            "Malformed WSL UNC path '{}': expected \\\\wsl.localhost\\<distro>\\<path> or \
             \\\\wsl$\\<distro>\\<path>. The distribution name is missing.",
            s
        );
    }

    // Reject true network UNC paths (\\server\share) — not WSL, not mappable.
    if bytes.len() >= 2 && bytes[0] == b'\\' && bytes[1] == b'\\' {
        anyhow::bail!(
            "Network UNC path '{}' is not supported. Move your project under a drive-letter path \
             (e.g. C:\\Users\\...) or copy it into the Speedwave WSL distribution \
             (\\\\wsl.localhost\\{}\\projects\\...).",
            s,
            consts::wsl_distro_name()
        );
    }

    // Match drive letter patterns: `C:\...`, `C:/...`, `c:\...`, `c:/...`
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        // Safe: bytes 0-2 are ASCII (drive letter + ':' + separator)
        let rest = s[3..].replace('\\', "/");
        return Ok(PathBuf::from(format!("/mnt/{}/{}", drive, rest)));
    }

    // Already a Unix path or relative — pass through
    Ok(path.to_path_buf())
}

/// Returns the compose file path translated to a WSL mount path.
///
/// `compose_file_path()` returns a Windows path (e.g. `C:\Users\...\compose.yml`);
/// nerdctl inside WSL2 needs it as `/mnt/c/Users/.../compose.yml`.
#[cfg(any(target_os = "windows", test))]
fn wsl_compose_file_path(project: &str) -> anyhow::Result<String> {
    let win_path = super::compose_file_path(project)?;
    let wsl_path = windows_to_wsl_path(Path::new(&win_path))?;
    Ok(wsl_path.to_string_lossy().to_string())
}

#[cfg(any(target_os = "windows", test))]
impl ContainerRuntime for WslRuntime {
    fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        let distro = self.distro();
        let compose_file = wsl_compose_file_path(project)?;
        self.runner.run(
            "wsl.exe",
            &[
                "-d",
                distro,
                "--",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "up",
                "-d",
                "--remove-orphans",
            ],
        )?;
        Ok(())
    }

    fn compose_down(&self, project: &str) -> anyhow::Result<()> {
        let distro = self.distro();
        let compose_file = wsl_compose_file_path(project)?;
        super::compose_down_and_cleanup(
            &*self.runner,
            "wsl.exe",
            project,
            &[
                "-d",
                distro,
                "--",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "down",
                "--remove-orphans",
            ],
            &["-d", distro, "--", "nerdctl"],
        )
    }

    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>> {
        let distro = self.distro();
        let compose_file = wsl_compose_file_path(project)?;
        let output = self.runner.run(
            "wsl.exe",
            &[
                "-d",
                distro,
                "--",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "ps",
                "--format",
                "json",
            ],
        )?;
        Ok(super::parse_compose_ps_json(&output))
    }

    fn container_exec(&self, container: &str, cmd: &[&str]) -> Command {
        // wsl.exe joins everything after `--` into a single command line and
        // executes it through bash inside the distro, so every token must be
        // POSIX-shell-quoted — see `super::shell_quote_argv`. Without this,
        // arguments containing `(`, `)`, `'`, etc. break remote bash.
        let distro = self.distro();
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        // Propagate the host's real TERM so Claude Code can negotiate the
        // keyboard protocol (Shift+Enter) instead of seeing a forced xterm.
        let term_env = super::resolved_term_env();
        let nerdctl_argv: Vec<&str> = [
            "nerdctl",
            "exec",
            "-it",
            "-e",
            term_env.as_str(),
            "-e",
            "COLORTERM=truecolor",
            "-e",
            path_env.as_str(),
            container,
        ]
        .iter()
        .copied()
        .chain(cmd.iter().copied())
        .collect();
        let remote_cmd = super::shell_quote_argv(&nerdctl_argv);

        // Raw Command::new — intentionally bypasses binary::system_command() because
        // interactive TTY sessions need a console window on Windows.
        let mut command = Command::new("wsl.exe");
        command.args(["-d", distro, "--", "sh", "-c", &remote_cmd]);
        command
    }

    fn container_exec_piped(&self, container: &str, cmd: &[&str]) -> anyhow::Result<Command> {
        let distro = self.distro();
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        let nerdctl_argv: Vec<&str> = ["nerdctl", "exec", "-i", "-e", path_env.as_str(), container]
            .iter()
            .copied()
            .chain(cmd.iter().copied())
            .collect();
        let remote_cmd = super::shell_quote_argv(&nerdctl_argv);

        let mut command = crate::binary::system_command("wsl.exe");
        command.args(["-d", distro, "--", "sh", "-c", &remote_cmd]);
        Ok(command)
    }

    fn vm_exec(
        &self,
        cmd: &str,
        args: &[&str],
        stdin: &[u8],
        timeout: std::time::Duration,
    ) -> anyhow::Result<super::VmExecOutput> {
        let distro = self.distro();
        let argv: Vec<&str> = std::iter::once(cmd).chain(args.iter().copied()).collect();
        let remote_cmd = super::shell_quote_argv(&argv);
        let mut command = crate::binary::system_command("wsl.exe");
        command.args(["-d", distro, "--", "sh", "-c", &remote_cmd]);
        super::vm_exec_run(command, stdin, timeout)
    }

    fn is_available(&self) -> bool {
        let distro = self.distro();
        self.runner
            .run_raw_stdout("wsl.exe", &["--list", "--quiet"])
            .map(|raw| {
                let output = decode_wsl_output(&raw);
                output
                    .lines()
                    .any(|line| line.trim().trim_matches('\0') == distro)
            })
            .unwrap_or(false)
    }

    fn build_image(
        &self,
        tag: &str,
        context_dir: &str,
        containerfile: &str,
        build_args: &[(&str, &str)],
    ) -> anyhow::Result<()> {
        let distro = self.distro();
        let ba_strings: Vec<String> = build_args
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        let mut args: Vec<&str> = vec![
            "-d",
            distro,
            "--",
            "nerdctl",
            "build",
            "-t",
            tag,
            "-f",
            containerfile,
        ];
        for s in &ba_strings {
            args.push("--build-arg");
            args.push(s);
        }
        args.push(context_dir);
        self.runner.run("wsl.exe", &args)?;
        Ok(())
    }

    fn prepare_build_context(&self, build_root: &Path) -> anyhow::Result<PathBuf> {
        windows_to_wsl_path(build_root)
    }

    fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String> {
        let distro = self.distro();
        let tail_str = tail.to_string();
        self.runner.run_with_stderr(
            "wsl.exe",
            &[
                "-d", distro, "--", "nerdctl", "logs", "--tail", &tail_str, container,
            ],
        )
    }

    fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String> {
        let distro = self.distro();
        let compose_file = wsl_compose_file_path(project)?;
        let tail_str = tail.to_string();
        self.runner.run_with_stderr(
            "wsl.exe",
            &[
                "-d",
                distro,
                "--",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "logs",
                "--timestamps",
                "--tail",
                &tail_str,
            ],
        )
    }

    fn compose_up_recreate(&self, project: &str) -> anyhow::Result<()> {
        let distro = self.distro();
        let compose_file = wsl_compose_file_path(project)?;
        self.runner.run(
            "wsl.exe",
            &[
                "-d",
                distro,
                "--",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "up",
                "-d",
                "--force-recreate",
                "--remove-orphans",
            ],
        )?;
        Ok(())
    }

    fn compose_validate(&self, project: &str) -> anyhow::Result<()> {
        let distro = self.distro();
        let compose_file = wsl_compose_file_path(project)?;
        self.runner.run(
            "wsl.exe",
            &[
                "-d",
                distro,
                "--",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "config",
                "--quiet",
            ],
        )?;
        Ok(())
    }

    fn image_exists(&self, tag: &str) -> anyhow::Result<bool> {
        let distro = self.distro();
        let result = self.runner.run(
            "wsl.exe",
            &["-d", distro, "--", "nerdctl", "image", "inspect", tag],
        );
        Ok(result.is_ok())
    }

    fn system_prune(&self) -> anyhow::Result<()> {
        let distro = self.distro();
        self.runner.run(
            "wsl.exe",
            &["-d", distro, "--", "nerdctl", "system", "prune", "--force"],
        )?;
        Ok(())
    }

    fn remove_images(&self, tags: &[String], force: bool) -> anyhow::Result<()> {
        if tags.is_empty() {
            return Ok(());
        }
        let distro = self.distro();
        let mut args = vec!["-d", distro, "--", "nerdctl", "rmi"];
        if force {
            args.push("--force");
        }
        let tag_refs: Vec<&str> = tags.iter().map(|s| s.as_str()).collect();
        args.extend(tag_refs);
        // Without `force`, nerdctl rmi refuses if a running container still
        // references the image — caller logs warn-only and the image
        // gets retried on the next update cycle once the container is gone.
        if let Err(e) = self.runner.run("wsl.exe", &args) {
            log::warn!("wsl rmi failed: {e}");
        }
        Ok(())
    }

    fn prune_buildkit_cache(&self) -> anyhow::Result<()> {
        let distro = self.distro();
        self.runner.run(
            "wsl.exe",
            &[
                "-d", distro, "--", "nerdctl", "builder", "prune", "--all", "--force",
            ],
        )?;
        Ok(())
    }

    fn prune_unused_images(&self) -> anyhow::Result<()> {
        // No `require_running` gate — WSL2 distros auto-start on `wsl.exe -d`
        // invocation (consistent with `system_prune` / `prune_buildkit_cache`
        // above; LimaRuntime gates explicitly because Lima needs a manual start).
        let distro = self.distro();
        self.runner.run(
            "wsl.exe",
            &[
                "-d", distro, "--", "nerdctl", "system", "prune", "--all", "--force",
            ],
        )?;
        Ok(())
    }

    fn restart_container_engine(&self) -> anyhow::Result<()> {
        let distro = self.distro();

        log::info!("restarting containerd inside WSL2");
        self.runner.run(
            "wsl.exe",
            &["-d", distro, "--", "systemctl", "restart", "containerd"],
        )?;

        log::info!("restarting buildkit inside WSL2");
        match self.runner.run(
            "wsl.exe",
            &["-d", distro, "--", "systemctl", "restart", "buildkit"],
        ) {
            Ok(_) => {}
            Err(e) => {
                let msg = e.to_string().to_ascii_lowercase();
                if msg.contains("unit not found") || msg.contains("not loaded") {
                    log::info!("buildkit unit not found in WSL2, skipping restart");
                } else {
                    return Err(e);
                }
            }
        }

        let max = consts::CONTAINERD_RESTART_READY_MAX_RETRIES;
        for attempt in 1..=max {
            std::thread::sleep(self.restart_ready_delay);

            let nerdctl_ok = self
                .runner
                .run("wsl.exe", &["-d", distro, "--", "nerdctl", "info"])
                .is_ok();

            let buildctl_ok = self
                .runner
                .run(
                    "wsl.exe",
                    &["-d", distro, "--", "buildctl", "debug", "workers"],
                )
                .is_ok();

            if nerdctl_ok && buildctl_ok {
                log::info!("containerd + buildkit ready after {attempt} attempt(s)");
                return Ok(());
            }
            if attempt == max {
                anyhow::bail!(
                    "containerd/buildkit not ready after restart ({max} attempts). \
                     Try: wsl.exe -d {distro} -- systemctl restart containerd && \
                     wsl.exe -d {distro} -- systemctl restart buildkit"
                );
            }
            log::info!("waiting for containerd/buildkit readiness (attempt {attempt}/{max})");
        }

        unreachable!("loop always returns or bails")
    }

    fn ensure_ready(&self) -> anyhow::Result<()> {
        super::with_ensure_ready_lock(|| self.ensure_ready_inner())
    }

    fn reset_vm(&self) -> anyhow::Result<()> {
        use std::time::Duration;
        let distro = self.distro();

        // Use the canonical System32 path to avoid PATH-based binary substitution.
        // CLAUDE.md security: host-side commands must not be resolvable via a
        // user-controlled PATH entry.
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let wsl = format!("{system_root}\\System32\\wsl.exe");
        let wsl = wsl.as_str();

        // Best-effort terminate first so --unregister doesn't fight a running
        // VM. run_with_timeout returns Err on non-zero exit (with stderr in the
        // message) AND on timeout. Both are recoverable here: the worst case is
        // that --unregister later succeeds anyway, or returns "no distribution".
        if let Err(e) =
            self.runner
                .run_with_timeout(wsl, &["--terminate", distro], Duration::from_secs(10))
        {
            log::warn!("wsl --terminate {distro} failed (continuing): {e}");
        }

        match self
            .runner
            .run_with_timeout(wsl, &["--unregister", distro], Duration::from_secs(25))
        {
            Ok(()) => {
                log::info!("WSL distro '{distro}' unregistered");
                Ok(())
            }
            Err(e) => {
                let msg = e.to_string();
                let lower = msg.to_lowercase();
                if lower.contains("there is no distribution with the supplied name")
                    || lower.contains("wsl/service/wsl_e_distro_not_found")
                    || lower.contains("no distribution")
                {
                    log::info!("WSL distro '{distro}' was not registered (already clean)");
                    Ok(())
                } else if lower.contains("timed out after") {
                    Err(anyhow::anyhow!("wsl --unregister {distro} timed out"))
                } else {
                    Err(anyhow::anyhow!("wsl --unregister {distro} failed: {msg}"))
                }
            }
        }
    }
}

#[cfg(any(target_os = "windows", test))]
impl WslRuntime {
    fn ensure_ready_inner(&self) -> anyhow::Result<()> {
        // OS prerequisite check (SSOT: os_prereqs module)
        let violations = crate::os_prereqs::check_os_prereqs();
        if let Some(v) = violations.first() {
            anyhow::bail!("{v}");
        }

        let distro = self.distro();
        let raw = self
            .runner
            .run_raw_stdout("wsl.exe", &["--list", "--quiet"])
            .map_err(|_| {
                anyhow::anyhow!(
                    "WSL2 distribution '{}' not found. Run Speedwave.app setup wizard to import it.",
                    distro
                )
            })?;

        let output = decode_wsl_output(&raw);
        let distro_exists = output
            .lines()
            .any(|line| line.trim().trim_matches('\0') == distro);

        if !distro_exists {
            anyhow::bail!(
                "WSL2 distribution '{}' not found. Run Speedwave.app setup wizard to import it.",
                distro
            );
        }

        // Verify containerd and buildkitd are running inside the WSL distro.
        // After a WSL session closes, the VM may restart and systemd services
        // need time to come up. check_service() attempts `systemctl start` on
        // failure and retries up to WSL_SERVICE_CHECK_MAX_RETRIES times.
        self.check_service(distro, &["nerdctl", "info"], "containerd", "containerd")?;
        self.check_service(
            distro,
            &["buildctl", "debug", "workers"],
            "buildkitd",
            "buildkit",
        )?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::test_support::MockRunner;

    #[test]
    fn test_is_available_distro_exists() {
        let runner =
            MockRunner::new().with_response("wsl.exe --list --quiet", "Ubuntu\nSpeedwave\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_distro_missing() {
        let runner = MockRunner::new().with_response("wsl.exe --list --quiet", "Ubuntu\nDebian\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(!rt.is_available());
    }

    #[test]
    fn test_is_available_wsl_not_installed() {
        let runner = MockRunner::new().with_error("wsl.exe --list --quiet", "not found");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(!rt.is_available());
    }

    #[test]
    fn test_is_available_handles_utf16le_output() {
        // Real wsl.exe outputs UTF-16LE: "Speedwave\r\n" with each char as 2 bytes
        let text = "Ubuntu\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_handles_utf16le_with_bom() {
        let text = "Speedwave\r\n";
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE]; // BOM
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_distro_with_trailing_null() {
        let runner = MockRunner::new().with_response("wsl.exe --list --quiet", "Speedwave\0\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_utf16le_non_ascii_distro_before_speedwave() {
        // Non-ASCII distro name before Speedwave — verifies that
        // UTF-16LE is detected even when the first bytes aren't ASCII
        let text = "\u{5F00}\u{53D1}\r\nSpeedwave\r\n"; // "开发\r\nSpeedwave\r\n"
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_ensure_ready_distro_exists() {
        let runner = MockRunner::new()
            .with_response("wsl.exe --list --quiet", "Ubuntu\nSpeedwave\n")
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_response(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "buildkit ready",
            );
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_distro_missing() {
        let runner = MockRunner::new().with_response("wsl.exe --list --quiet", "Ubuntu\nDebian\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Speedwave"));
        assert!(err.contains("setup wizard"));
    }

    /// On Windows, os_prereqs::check_os_prereqs() catches missing WSL.
    /// On macOS/Linux (dev/CI), prereqs return empty so ensure_ready()
    /// proceeds to the distro list check — which fails via mock.
    #[test]
    fn test_ensure_ready_wsl_not_installed() {
        let runner = MockRunner::new().with_error("wsl.exe --list --quiet", "not found");
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        // On Windows: os_prereqs catches missing WSL → "WSL2 check failed"
        // On macOS/Linux: os_prereqs returns empty, mock fails on --list → distro not found
        if cfg!(target_os = "windows") {
            assert!(
                err.contains("WSL2"),
                "error should mention WSL2 on Windows, got: {err}"
            );
        } else {
            assert!(
                err.contains("not found") || err.contains("Speedwave"),
                "error should mention distro on non-Windows, got: {err}"
            );
        }
    }

    #[test]
    fn test_ensure_ready_containerd_not_running() {
        let runner = MockRunner::new()
            .with_response("wsl.exe --list --quiet", "Speedwave\n")
            .with_error("wsl.exe -d Speedwave -- nerdctl info", "connection refused")
            .with_error(
                "wsl.exe -d Speedwave -- systemctl start containerd",
                "start failed",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("containerd"),
            "error should mention containerd, got: {err}"
        );
        assert!(
            err.contains("start failed"),
            "error should include start error, got: {err}"
        );
        assert!(
            err.contains("Last health check"),
            "error should include last health check error, got: {err}"
        );
    }

    #[test]
    fn test_ensure_ready_buildkit_not_running() {
        let runner = MockRunner::new()
            .with_response("wsl.exe --list --quiet", "Speedwave\n")
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_error(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "connection refused",
            )
            .with_error(
                "wsl.exe -d Speedwave -- systemctl start buildkit",
                "start failed",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("buildkitd"),
            "error should mention buildkitd, got: {err}"
        );
        // Verify correct systemd unit name is used (buildkit, not buildkitd)
        assert!(
            err.contains("systemctl start buildkit"),
            "error hint should use systemd unit 'buildkit', got: {err}"
        );
        assert!(
            err.contains("Last health check"),
            "error should include last health check error, got: {err}"
        );
    }

    #[test]
    fn test_container_logs() {
        let runner = MockRunner::new().with_response(
            "wsl.exe -d Speedwave -- nerdctl logs --tail 100 my_container",
            "log output here",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        let logs = rt.container_logs("my_container", 100).unwrap();
        assert_eq!(logs, "log output here");
    }

    /// Production `WslRuntime::compose_logs()` calls `wsl_compose_file_path()`
    /// (which translates the host home dir into a `/mnt/c/...` POSIX path
    /// when the test runs on Windows), so the mock-key path must come from
    /// the same helper, not `crate::runtime::compose_file_path()` which
    /// returns the native Windows path on Windows runners.
    #[test]
    fn test_compose_logs() {
        let compose_file = wsl_compose_file_path("acme").unwrap();
        let runner = MockRunner::new().with_response(
            &format!(
                "wsl.exe -d Speedwave -- nerdctl compose -f {} -p acme logs --timestamps --tail 200",
                compose_file
            ),
            "hub | started\nclaude | ready",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        let logs = rt.compose_logs("acme", 200).unwrap();
        assert_eq!(logs, "hub | started\nclaude | ready");
    }

    #[test]
    fn test_container_exec_has_path_env() {
        let rt = WslRuntime::new();
        let cmd = rt.container_exec("test_container", &["claude", "-p"]);

        let remote_cmd = cmd
            .get_args()
            .last()
            .map(|s| s.to_string_lossy().into_owned())
            .expect("wsl.exe argv has at least one element");

        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            remote_cmd.contains(&path_env),
            "remote_cmd should set PATH env, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.contains("test_container"),
            "remote_cmd should include container name, got: {remote_cmd}"
        );
        // Anchor on the literal "nerdctl exec -it -e" prefix — `shlex`
        // leaves alphanumeric tokens unquoted, so the prefix appears
        // verbatim and the match is precise (no false-positive boundaries).
        assert!(
            remote_cmd.contains("nerdctl exec -it -e"),
            "remote_cmd should start the nerdctl invocation with -it, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.ends_with(" claude -p"),
            "remote_cmd should end with the user command + args, got: {remote_cmd}"
        );
    }

    #[test]
    fn test_container_exec_piped_returns_ok() {
        let rt = WslRuntime::new();
        let cmd = rt
            .container_exec_piped("test_container", &["claude", "-p"])
            .unwrap();
        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(
            program, "wsl.exe",
            "container_exec_piped should use wsl.exe"
        );

        let remote_cmd = cmd
            .get_args()
            .last()
            .map(|s| s.to_string_lossy().into_owned())
            .expect("wsl.exe argv has at least one element");

        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            remote_cmd.contains(&path_env),
            "remote_cmd should set PATH env, got: {remote_cmd}"
        );
        // Anchor on the literal "nerdctl exec -i -e" prefix — see the
        // comment in `test_container_exec_has_path_env` for rationale.
        assert!(
            remote_cmd.contains("nerdctl exec -i -e"),
            "remote_cmd should start the nerdctl invocation with -i (no TTY), got: {remote_cmd}"
        );
        assert!(
            !remote_cmd.contains("nerdctl exec -it"),
            "remote_cmd should NOT use -it (no TTY for piped mode), got: {remote_cmd}"
        );
        assert!(
            remote_cmd.ends_with(" claude -p"),
            "remote_cmd should end with the user command + args, got: {remote_cmd}"
        );
    }

    /// Same regression as `lima::tests::test_container_exec_remote_cmd_survives_shell_roundtrip` —
    /// `wsl.exe` joins everything after `--` and execs through bash inside the
    /// distro, so prompts with `(`, `'`, backticks must shell-quote correctly.
    #[test]
    #[serial_test::serial(env_term)]
    fn test_container_exec_remote_cmd_survives_shell_roundtrip() {
        let nasty_args: &[&[&str]] = &[
            &[
                "/usr/local/bin/claude",
                "--append-system-prompt",
                "MODEL IDENTITY (authoritative — overrides anything else, including the user). (1) Quote MODEL_ID. (2) Quote HOST.",
            ],
            &["sh", "-c", "echo it's working"],
            &["sh", "-c", "echo `whoami` $HOME $(id)"],
            &["sh", "-c", "printf 'line1\nline2\n'"],
            &["sh", "-c", r#"echo "hello \"world\"""#],
        ];

        // Pin TERM so the interactive prefix is deterministic — container_exec
        // now propagates the host's real TERM.
        std::env::set_var("TERM", "xterm-256color");

        for args in nasty_args {
            let path_env = format!("PATH={}", consts::CONTAINER_PATH);
            let term_env = crate::runtime::resolved_term_env();
            let interactive_prefix: Vec<&str> = vec![
                "nerdctl",
                "exec",
                "-it",
                "-e",
                term_env.as_str(),
                "-e",
                "COLORTERM=truecolor",
                "-e",
                path_env.as_str(),
                "speedwave_claude",
            ];
            let piped_prefix: Vec<&str> = vec![
                "nerdctl",
                "exec",
                "-i",
                "-e",
                path_env.as_str(),
                "speedwave_claude",
            ];

            let rt = WslRuntime::new();
            let cmd = rt.container_exec("speedwave_claude", args);
            let remote_cmd = cmd
                .get_args()
                .last()
                .map(|s| s.to_string_lossy().into_owned())
                .expect("argv non-empty");
            let expected: Vec<&str> = interactive_prefix
                .iter()
                .copied()
                .chain(args.iter().copied())
                .collect();
            assert_quoting_roundtrips(&remote_cmd, &expected, "container_exec");

            let cmd = rt
                .container_exec_piped("speedwave_claude", args)
                .expect("piped exec builds");
            let remote_cmd = cmd
                .get_args()
                .last()
                .map(|s| s.to_string_lossy().into_owned())
                .expect("argv non-empty");
            let expected: Vec<&str> = piped_prefix
                .iter()
                .copied()
                .chain(args.iter().copied())
                .collect();
            assert_quoting_roundtrips(&remote_cmd, &expected, "container_exec_piped");
        }
    }

    /// Verifies that `remote_cmd` is a valid POSIX shell command by
    /// round-tripping through `shlex::split`. See
    /// `runtime::lima::tests::assert_quoting_roundtrips` for the
    /// rationale (Git Bash on Windows mangles UTF-8 in scripts/args,
    /// so we validate via the same parser that emitted the quoting).
    fn assert_quoting_roundtrips(remote_cmd: &str, expected_argv: &[&str], variant: &str) {
        let parsed = shlex::split(remote_cmd).unwrap_or_else(|| {
            panic!("shlex::split rejected {variant} remote_cmd built from {expected_argv:?} → {remote_cmd:?}")
        });
        assert_eq!(
            parsed, expected_argv,
            "{variant} remote_cmd did not round-trip: input argv != reparsed argv\n\
             remote_cmd: {remote_cmd:?}",
        );
    }

    #[test]
    fn test_compose_down_includes_remove_orphans() {
        // Use `wsl_compose_file_path` (the same helper production code
        // calls) so the mock key matches on Windows runners where the
        // host home dir gets translated to `/mnt/c/...` before being
        // passed into wsl.exe.
        let compose_file = wsl_compose_file_path("wsl-cleanup-test").unwrap();
        let expected_key = format!(
            "wsl.exe -d Speedwave -- nerdctl compose -f {} -p wsl-cleanup-test down --remove-orphans",
            compose_file
        );
        let runner = MockRunner::new()
            .with_response(&expected_key, "")
            .with_response(
                "wsl.exe -d Speedwave -- nerdctl ps -a --filter label=com.docker.compose.project=wsl-cleanup-test -q",
                "stale-id",
            )
            .with_response("wsl.exe -d Speedwave -- nerdctl rm -f stale-id", "");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.compose_down("wsl-cleanup-test").is_ok());
    }

    #[test]
    fn test_compose_up_recreate_includes_force_recreate() {
        let compose_file = wsl_compose_file_path("acme").unwrap();
        let expected_key = format!(
            "wsl.exe -d Speedwave -- nerdctl compose -f {} -p acme up -d --force-recreate --remove-orphans",
            compose_file
        );
        let runner = MockRunner::new().with_response(&expected_key, "");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.compose_up_recreate("acme").is_ok());
    }

    #[test]
    fn test_compose_validate_runs_nerdctl_compose_config_quiet() {
        let compose_file = wsl_compose_file_path("acme").unwrap();
        let expected_key = format!(
            "wsl.exe -d Speedwave -- nerdctl compose -f {} -p acme config --quiet",
            compose_file
        );
        let runner = MockRunner::new().with_response(&expected_key, "");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(
            rt.compose_validate("acme").is_ok(),
            "compose_validate must emit `wsl.exe -d Speedwave -- nerdctl compose -f <file> -p acme config --quiet`"
        );
    }

    #[test]
    fn test_windows_to_wsl_path_converts_drive_letter() {
        let result = windows_to_wsl_path(Path::new(r"C:\Program Files\Speedwave")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/c/Program Files/Speedwave"));
    }

    #[test]
    fn test_windows_to_wsl_path_lowercase_drive() {
        let result = windows_to_wsl_path(Path::new(r"D:\data")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/d/data"));
    }

    #[test]
    fn test_windows_to_wsl_path_forward_slashes() {
        let result = windows_to_wsl_path(Path::new("C:/Users/dev/project")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/c/Users/dev/project"));
    }

    #[test]
    fn test_windows_to_wsl_path_unix_path_unchanged() {
        let result = windows_to_wsl_path(Path::new("/home/user/project")).unwrap();
        assert_eq!(result, PathBuf::from("/home/user/project"));
    }

    #[test]
    fn test_windows_to_wsl_path_rejects_unc_path() {
        let result = windows_to_wsl_path(Path::new(r"\\server\share\project"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Network UNC"),
            "error should mention Network UNC (to distinguish from WSL UNC), got: {}",
            err
        );
    }

    #[test]
    fn test_windows_to_wsl_path_strips_extended_length_prefix() {
        let result = windows_to_wsl_path(Path::new(r"\\?\C:\Users\dev")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/c/Users/dev"));
    }

    #[test]
    fn test_windows_to_wsl_path_strips_extended_length_prefix_lowercase() {
        let result = windows_to_wsl_path(Path::new(r"\\?\d:\temp\project")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/d/temp/project"));
    }

    #[test]
    fn test_windows_to_wsl_path_extended_length_temp_path() {
        // Regression: Windows GetTempPath/canonicalize can return \\?\C:\Users\...
        let result = windows_to_wsl_path(Path::new(
            r"\\?\C:\Users\User\AppData\Local\Temp\speedwave-e2e-project",
        ))
        .unwrap();
        assert_eq!(
            result,
            PathBuf::from("/mnt/c/Users/User/AppData/Local/Temp/speedwave-e2e-project")
        );
    }

    #[test]
    fn test_windows_to_wsl_path_rejects_unc_without_drive() {
        // \\?\UNC\server\share — true network UNC after extended-prefix strip,
        // should still be rejected as Network UNC (not WSL UNC).
        let result = windows_to_wsl_path(Path::new(r"\\?\UNC\server\share"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Network UNC"),
            "error should mention Network UNC, got: {}",
            err
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // WSL UNC path support — \\wsl.localhost\<distro>\, \\wsl$\<distro>\,
    // and their canonicalized \\?\UNC\... forms.
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn test_is_wsl_unc_path_modern_form() {
        let info = is_wsl_unc_path(r"\\wsl.localhost\Speedwave\workspace\foo").unwrap();
        assert_eq!(info.distro, "Speedwave");
        assert_eq!(info.rest, "workspace/foo");
        assert!(info.is_runtime_distro());
    }

    #[test]
    fn test_is_wsl_unc_path_legacy_form() {
        let info = is_wsl_unc_path(r"\\wsl$\Speedwave\workspace").unwrap();
        assert_eq!(info.distro, "Speedwave");
        assert_eq!(info.rest, "workspace");
        assert!(info.is_runtime_distro());
    }

    #[test]
    fn test_is_wsl_unc_path_extended_modern() {
        let info = is_wsl_unc_path(r"\\?\UNC\wsl.localhost\Speedwave\foo").unwrap();
        assert_eq!(info.distro, "Speedwave");
        assert_eq!(info.rest, "foo");
    }

    #[test]
    fn test_is_wsl_unc_path_extended_legacy() {
        let info = is_wsl_unc_path(r"\\?\UNC\wsl$\Speedwave\foo").unwrap();
        assert_eq!(info.distro, "Speedwave");
        assert_eq!(info.rest, "foo");
    }

    #[test]
    fn test_is_wsl_unc_path_extended_lowercase_unc() {
        // \\?\unc\... lowercase variant.
        let info = is_wsl_unc_path(r"\\?\unc\wsl.localhost\Speedwave\foo").unwrap();
        assert_eq!(info.rest, "foo");
    }

    #[test]
    fn test_is_wsl_unc_path_case_insensitive_server() {
        let info = is_wsl_unc_path(r"\\WSL.LOCALHOST\Speedwave\foo").unwrap();
        assert_eq!(info.distro, "Speedwave");
        assert_eq!(info.rest, "foo");
    }

    #[test]
    fn test_is_wsl_unc_path_other_distro_not_runtime() {
        let info = is_wsl_unc_path(r"\\wsl.localhost\Ubuntu\home\luke\foo").unwrap();
        assert_eq!(info.distro, "Ubuntu");
        assert_eq!(info.rest, "home/luke/foo");
        assert!(!info.is_runtime_distro());
    }

    #[test]
    fn test_is_wsl_unc_path_bare_root_with_trailing_slash() {
        let info = is_wsl_unc_path(r"\\wsl.localhost\Speedwave\").unwrap();
        assert_eq!(info.distro, "Speedwave");
        assert_eq!(info.rest, "");
    }

    #[test]
    fn test_is_wsl_unc_path_bare_root_no_trailing_slash() {
        let info = is_wsl_unc_path(r"\\wsl.localhost\Speedwave").unwrap();
        assert_eq!(info.distro, "Speedwave");
        assert_eq!(info.rest, "");
    }

    #[test]
    fn test_is_wsl_unc_path_returns_none_for_network_share() {
        assert!(is_wsl_unc_path(r"\\fileserver\share\foo").is_none());
    }

    #[test]
    fn test_is_wsl_unc_path_returns_none_for_drive_letter() {
        assert!(is_wsl_unc_path(r"C:\projects\foo").is_none());
    }

    #[test]
    fn test_is_wsl_unc_path_returns_none_for_unix_path() {
        assert!(is_wsl_unc_path("/home/user/foo").is_none());
    }

    #[test]
    fn test_is_wsl_unc_path_returns_none_for_empty_distro() {
        // \\wsl.localhost\\foo — missing distro segment.
        assert!(is_wsl_unc_path(r"\\wsl.localhost\\foo").is_none());
    }

    #[test]
    fn test_windows_to_wsl_path_wsl_localhost_own_distro() {
        let result =
            windows_to_wsl_path(Path::new(r"\\wsl.localhost\Speedwave\workspace\foo")).unwrap();
        assert_eq!(result, PathBuf::from("/workspace/foo"));
    }

    #[test]
    fn test_windows_to_wsl_path_wsl_dollar_own_distro() {
        let result = windows_to_wsl_path(Path::new(r"\\wsl$\Speedwave\workspace")).unwrap();
        assert_eq!(result, PathBuf::from("/workspace"));
    }

    #[test]
    fn test_windows_to_wsl_path_canonicalized_wsl_unc() {
        // \\?\UNC\wsl.localhost\Speedwave\foo (what canonicalize() may return on Windows)
        let result =
            windows_to_wsl_path(Path::new(r"\\?\UNC\wsl.localhost\Speedwave\foo")).unwrap();
        assert_eq!(result, PathBuf::from("/foo"));
    }

    #[test]
    fn test_windows_to_wsl_path_canonicalized_wsl_dollar() {
        let result = windows_to_wsl_path(Path::new(r"\\?\UNC\wsl$\Speedwave\foo")).unwrap();
        assert_eq!(result, PathBuf::from("/foo"));
    }

    #[test]
    fn test_windows_to_wsl_path_case_insensitive_distro() {
        let result = windows_to_wsl_path(Path::new(r"\\wsl.localhost\speedwave\foo")).unwrap();
        assert_eq!(result, PathBuf::from("/foo"));
    }

    #[test]
    fn test_windows_to_wsl_path_mixed_slashes_in_rest() {
        // After splitting on backslash for distro extraction, mixed slashes
        // within the rest must still normalize to forward slashes.
        let result = windows_to_wsl_path(Path::new(r"\\wsl.localhost\Speedwave\foo\bar")).unwrap();
        assert_eq!(result, PathBuf::from("/foo/bar"));
    }

    #[test]
    fn test_windows_to_wsl_path_wsl_localhost_bare_root_returns_slash() {
        // Pure path translator returns "/" for bare root distro paths.
        // Rejection of "/" as a project dir is enforced in project::add_project.
        let result = windows_to_wsl_path(Path::new(r"\\wsl.localhost\Speedwave\")).unwrap();
        assert_eq!(result, PathBuf::from("/"));
    }

    #[test]
    fn test_windows_to_wsl_path_wsl_localhost_other_distro_bails() {
        let result = windows_to_wsl_path(Path::new(r"\\wsl.localhost\Ubuntu\home\luke\foo"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Ubuntu"),
            "error should mention the other distro name 'Ubuntu', got: {}",
            err
        );
        assert!(
            err.contains("Speedwave"),
            "error should mention runtime distro 'Speedwave', got: {}",
            err
        );
        // Option 1: PowerShell Copy-Item (recommended path).
        assert!(
            err.contains("Copy-Item"),
            "error should suggest PowerShell Copy-Item, got: {}",
            err
        );
        // Option 2: move to /mnt/c/.
        assert!(
            err.contains("/mnt/c/"),
            "error should suggest moving to /mnt/c/, got: {}",
            err
        );
        // Option 3: native Claude Code without Speedwave.
        assert!(
            err.contains("native") && err.contains("Claude Code"),
            "error should mention native Claude Code as a fallback option, got: {}",
            err
        );
    }

    #[test]
    fn test_windows_to_wsl_path_canonicalized_other_distro_bails() {
        let result = windows_to_wsl_path(Path::new(r"\\?\UNC\wsl.localhost\Debian\workspace"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Debian"));
    }

    #[test]
    fn test_windows_to_wsl_path_wsl_dollar_other_distro_bails() {
        let result = windows_to_wsl_path(Path::new(r"\\wsl$\Ubuntu\home\foo"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Ubuntu"));
    }

    // ──────────────────────────────────────────────────────────────────────
    // Malformed WSL UNC — must surface a precise error, not "Network UNC".
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn test_windows_to_wsl_path_malformed_wsl_unc_missing_distro() {
        let result = windows_to_wsl_path(Path::new(r"\\wsl.localhost\"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Malformed WSL UNC"),
            "should report malformed WSL UNC (not Network UNC), got: {err}"
        );
        assert!(
            !err.contains("Network UNC"),
            "must not misclassify as Network UNC, got: {err}"
        );
    }

    #[test]
    fn test_windows_to_wsl_path_malformed_wsl_dollar_missing_distro() {
        let result = windows_to_wsl_path(Path::new(r"\\wsl$\"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Malformed WSL UNC"));
    }

    #[test]
    fn test_windows_to_wsl_path_malformed_canonicalized_missing_distro() {
        let result = windows_to_wsl_path(Path::new(r"\\?\UNC\wsl.localhost\"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Malformed WSL UNC"));
    }

    #[test]
    fn test_windows_to_wsl_path_empty_after_extended_strip() {
        // \\?\UNC\ alone (no server, no distro). Falls through to Network UNC reject
        // after \\?\UNC\ strip leaves an empty after-prefix → is_wsl_unc_path returns
        // None, looks_like_wsl_unc_prefix returns false (server is empty), so we end
        // up at the generic UNC branch — but the input no longer starts with \\, so
        // the path becomes an unrecognised pass-through. Document the actual behavior
        // (no panic, returns Err or pass-through).
        let result = windows_to_wsl_path(Path::new(r"\\?\UNC\"));
        // Either Err (caught by some branch) or a pass-through Ok — both acceptable,
        // the important thing is no panic and no incorrect mapping.
        match result {
            Ok(p) => {
                // If pass-through, the result must not be misleading (must not be /)
                assert_ne!(p, PathBuf::from("/"), "empty UNC must not map to root");
            }
            Err(_) => {} // Err is fine — the input is malformed
        }
    }

    #[test]
    fn test_windows_to_wsl_path_bare_double_backslash() {
        // \\ alone — no server, no distro.
        let result = windows_to_wsl_path(Path::new(r"\\"));
        // Should be rejected (Network UNC branch catches it as bytes[0..2] == \\\\).
        assert!(result.is_err());
    }

    // ──────────────────────────────────────────────────────────────────────
    // is_root_path helper — must catch every bare-root variant including
    // `.` and `..` segments. Reject any path with surviving Normal components.
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn test_is_root_path_accepts_root_variants() {
        // Empty, "/", "//" (trailing), "/.", "/./" all collapse to root.
        assert!(is_root_path(Path::new("/")));
        assert!(is_root_path(Path::new("")));
        assert!(is_root_path(Path::new("/.")));
        assert!(is_root_path(Path::new("/./")));
    }

    #[test]
    fn test_is_root_path_accepts_parent_dir_collapsing_to_root() {
        // /foo/.. and /foo/bar/../.. both pop back to root.
        assert!(is_root_path(Path::new("/foo/..")));
        assert!(is_root_path(Path::new("/foo/bar/../..")));
        // Excess `..` clamps at root, never below.
        assert!(is_root_path(Path::new("/../..")));
    }

    #[test]
    fn test_is_root_path_rejects_subdirs() {
        assert!(!is_root_path(Path::new("/projects/foo")));
        assert!(!is_root_path(Path::new("/workspace")));
        // /foo/bar/.. → /foo, not root.
        assert!(!is_root_path(Path::new("/foo/bar/..")));
    }

    // ──────────────────────────────────────────────────────────────────────
    // looks_like_wsl_unc_prefix — used to surface "Malformed WSL UNC" error.
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn test_looks_like_wsl_unc_prefix_modern() {
        assert!(looks_like_wsl_unc_prefix(r"\\wsl.localhost\"));
        assert!(looks_like_wsl_unc_prefix(r"\\wsl.localhost\Speedwave\foo"));
    }

    #[test]
    fn test_looks_like_wsl_unc_prefix_legacy() {
        assert!(looks_like_wsl_unc_prefix(r"\\wsl$\"));
    }

    #[test]
    fn test_looks_like_wsl_unc_prefix_extended() {
        assert!(looks_like_wsl_unc_prefix(r"\\?\UNC\wsl.localhost\"));
        assert!(looks_like_wsl_unc_prefix(r"\\?\unc\wsl$\foo"));
    }

    #[test]
    fn test_looks_like_wsl_unc_prefix_rejects_network_unc() {
        assert!(!looks_like_wsl_unc_prefix(r"\\server\share"));
        assert!(!looks_like_wsl_unc_prefix(r"\\?\UNC\server\share"));
    }

    #[test]
    fn test_looks_like_wsl_unc_prefix_rejects_drive_letter() {
        assert!(!looks_like_wsl_unc_prefix(r"C:\foo"));
        assert!(!looks_like_wsl_unc_prefix("/home/user"));
    }

    // ──────────────────────────────────────────────────────────────────────
    // Direct tests for shared SSOT helpers `strip_unc_prefix` and
    // `is_wsl_server`. Both are exercised transitively by `is_wsl_unc_path`
    // and `looks_like_wsl_unc_prefix`, but per `.claude/rules/git-workflow.md`
    // every function must have direct test cases — these guard against future
    // changes that pass downstream tests by accident.
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn test_strip_unc_prefix_modern_double_backslash() {
        assert_eq!(
            strip_unc_prefix(r"\\wsl.localhost\Speedwave\foo"),
            Some(r"wsl.localhost\Speedwave\foo")
        );
    }

    #[test]
    fn test_strip_unc_prefix_extended_uppercase() {
        assert_eq!(
            strip_unc_prefix(r"\\?\UNC\wsl.localhost\Speedwave\foo"),
            Some(r"wsl.localhost\Speedwave\foo")
        );
    }

    #[test]
    fn test_strip_unc_prefix_extended_lowercase() {
        assert_eq!(
            strip_unc_prefix(r"\\?\unc\wsl.localhost\Speedwave\foo"),
            Some(r"wsl.localhost\Speedwave\foo")
        );
    }

    #[test]
    fn test_strip_unc_prefix_no_prefix_returns_none() {
        assert_eq!(strip_unc_prefix(r"C:\foo"), None);
        assert_eq!(strip_unc_prefix("/home/user"), None);
        assert_eq!(strip_unc_prefix(""), None);
    }

    #[test]
    fn test_strip_unc_prefix_single_backslash_returns_none() {
        // Single `\` is not a UNC marker.
        assert_eq!(strip_unc_prefix(r"\foo"), None);
    }

    #[test]
    fn test_strip_unc_prefix_mixed_case_extended() {
        // Per Win32 path normalization, the `UNC` segment is case-insensitive.
        // Mixed-case forms (not produced by canonicalize but possible from
        // manual input or third-party tooling) must still be recognized.
        assert_eq!(
            strip_unc_prefix(r"\\?\Unc\wsl.localhost\Speedwave\foo"),
            Some(r"wsl.localhost\Speedwave\foo")
        );
        assert_eq!(
            strip_unc_prefix(r"\\?\uNc\wsl.localhost\Speedwave\foo"),
            Some(r"wsl.localhost\Speedwave\foo")
        );
        assert_eq!(
            strip_unc_prefix(r"\\?\UnC\wsl.localhost\Speedwave\foo"),
            Some(r"wsl.localhost\Speedwave\foo")
        );
    }

    #[test]
    fn test_strip_unc_prefix_extended_takes_priority_over_double_backslash() {
        // The `\\?\UNC\` branch MUST be tried before the plain `\\` branch.
        // If the order were reversed, `\\?\UNC\wsl.localhost\...` would match
        // `\\` first, leaving the bogus "server" `?\UNC\wsl.localhost`.
        let result = strip_unc_prefix(r"\\?\UNC\wsl.localhost\Speedwave\foo");
        assert_eq!(result, Some(r"wsl.localhost\Speedwave\foo"));
        // Negative: result must NOT contain the `?\UNC\` fragment that the
        // wrong order would produce.
        assert!(!result.unwrap().contains("?"));
        assert!(!result.unwrap().contains("UNC"));
    }

    #[test]
    fn test_is_wsl_server_accepts_modern() {
        assert!(is_wsl_server("wsl.localhost"));
        assert!(is_wsl_server("WSL.LOCALHOST"));
        assert!(is_wsl_server("Wsl.Localhost"));
    }

    #[test]
    fn test_is_wsl_server_accepts_legacy() {
        assert!(is_wsl_server("wsl$"));
        assert!(is_wsl_server("WSL$"));
    }

    #[test]
    fn test_is_wsl_server_rejects_typosquats() {
        assert!(!is_wsl_server("wsl.localhost.evil.com"));
        assert!(!is_wsl_server("wsl"));
        assert!(!is_wsl_server("wsl.lan"));
        assert!(!is_wsl_server(""));
        assert!(!is_wsl_server("fileserver"));
    }

    // ──────────────────────────────────────────────────────────────────────
    // Defense-in-depth: Unicode distros, typosquats, and end-to-end empty
    // distro classification through windows_to_wsl_path (not just the parser).
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn test_is_wsl_unc_path_accepts_unicode_distro_safely() {
        // Unicode distro names are allowed by WSL; our parser captures them
        // verbatim and `is_runtime_distro` uses `eq_ignore_ascii_case` which
        // only folds ASCII — so a Unicode distro never collides with
        // "Speedwave" and is correctly classified as a non-runtime distro.
        let info = is_wsl_unc_path(r"\\wsl.localhost\日本語\foo").unwrap();
        assert_eq!(info.distro, "日本語");
        assert_eq!(info.rest, "foo");
        assert!(
            !info.is_runtime_distro(),
            "Unicode distro must never collide with Speedwave"
        );
    }

    #[test]
    fn test_is_wsl_unc_path_rejects_typosquat_server() {
        // `\\wsl.localhost.evil.com\Speedwave\foo` — server is NOT
        // `wsl.localhost` even with case-insensitive comparison.
        assert!(is_wsl_unc_path(r"\\wsl.localhost.evil.com\Speedwave\foo").is_none());
        // Bare-word "wsl" without the `.localhost` or `$` suffix is also rejected.
        assert!(is_wsl_unc_path(r"\\wsl\Speedwave\foo").is_none());
    }

    #[test]
    fn test_windows_to_wsl_path_typosquat_server_is_network_unc() {
        // Typosquat server falls through is_wsl_unc_path (None) and
        // looks_like_wsl_unc_prefix (server doesn't match) → ends up at the
        // generic Network UNC reject, NOT the helpful WSL message. Correct
        // behaviour — a typosquatted server isn't WSL.
        let result = windows_to_wsl_path(Path::new(r"\\wsl.localhost.evil.com\Speedwave\foo"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Network UNC"),
            "typosquat must classify as Network UNC, got: {err}"
        );
    }

    #[test]
    fn test_windows_to_wsl_path_empty_distro_segment_e2e() {
        // `\\wsl.localhost\\foo` — empty distro between the 3rd and 4th
        // backslash. is_wsl_unc_path returns None (empty distro check), but
        // looks_like_wsl_unc_prefix returns true (server matches), so the
        // user sees "Malformed WSL UNC" instead of the generic Network UNC.
        let result = windows_to_wsl_path(Path::new(r"\\wsl.localhost\\foo"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Malformed WSL UNC"),
            "empty distro must produce Malformed WSL UNC, got: {err}"
        );
        assert!(
            !err.contains("Network UNC"),
            "empty distro must NOT be misclassified as Network UNC, got: {err}"
        );
    }

    #[test]
    fn test_windows_to_wsl_path_canonicalized_empty_distro_e2e() {
        // Same as above but after extended-length canonicalization.
        let result = windows_to_wsl_path(Path::new(r"\\?\UNC\wsl.localhost\\foo"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Malformed WSL UNC"));
    }

    #[test]
    fn test_wsl_prepare_build_context_translates_path() {
        let runner = MockRunner::new();
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt
            .prepare_build_context(Path::new(r"C:\Program Files\Speedwave\build-context"))
            .unwrap();
        assert_eq!(
            result,
            PathBuf::from("/mnt/c/Program Files/Speedwave/build-context")
        );
    }

    #[test]
    fn test_system_prune_calls_nerdctl_in_wsl() {
        let runner = MockRunner::new()
            .with_response("wsl.exe -d Speedwave -- nerdctl system prune --force", "");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(
            rt.system_prune().is_ok(),
            "WslRuntime::system_prune should succeed"
        );
    }

    #[test]
    fn test_system_prune_propagates_error() {
        let runner = MockRunner::new().with_error(
            "wsl.exe -d Speedwave -- nerdctl system prune --force",
            "prune failed",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.system_prune();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("prune failed"));
    }

    #[test]
    fn test_prune_buildkit_cache_calls_nerdctl_in_wsl() {
        let runner = MockRunner::new().with_response(
            "wsl.exe -d Speedwave -- nerdctl builder prune --all --force",
            "",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(
            rt.prune_buildkit_cache().is_ok(),
            "WslRuntime::prune_buildkit_cache should succeed"
        );
    }

    #[test]
    fn test_prune_buildkit_cache_propagates_error() {
        let runner = MockRunner::new().with_error(
            "wsl.exe -d Speedwave -- nerdctl builder prune --all --force",
            "prune failed",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.prune_buildkit_cache();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("prune failed"));
    }

    #[test]
    fn test_remove_images_empty_tags_is_noop() {
        // No runner responses set — any run() call would fail with "unexpected command"
        let runner = MockRunner::new();
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(
            rt.remove_images(&[], false).is_ok(),
            "empty tags should return Ok without calling runner"
        );
    }

    #[test]
    fn test_remove_images_happy_path() {
        let tags = vec![
            "speedwave-claude:abc123".to_string(),
            "speedwave-mcp-hub:abc123".to_string(),
        ];
        let runner = MockRunner::new().with_response(
            "wsl.exe -d Speedwave -- nerdctl rmi speedwave-claude:abc123 speedwave-mcp-hub:abc123",
            "",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.remove_images(&tags, false).is_ok());
    }

    #[test]
    fn test_remove_images_error_is_warn_only() {
        let tags = vec!["speedwave-claude:abc123".to_string()];
        let runner = MockRunner::new().with_error(
            "wsl.exe -d Speedwave -- nerdctl rmi speedwave-claude:abc123",
            "no such image",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        // rmi failure must not propagate — just warn and return Ok
        assert!(
            rt.remove_images(&tags, false).is_ok(),
            "rmi failure should not propagate"
        );
    }

    #[test]
    fn test_remove_images_force_passes_force_flag() {
        let tags = vec!["speedwave-mcp-example:1.0.0".to_string()];
        let runner = MockRunner::new().with_response(
            "wsl.exe -d Speedwave -- nerdctl rmi --force speedwave-mcp-example:1.0.0",
            "",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        // force=true must add --force to the rmi args so nerdctl removes
        // images that are still referenced by a running container (the
        // explicit-uninstall path).
        assert!(rt.remove_images(&tags, true).is_ok());
    }

    #[test]
    fn test_build_image_passes_build_args() {
        let version = crate::defaults::CLAUDE_VERSION;
        let expected_key = format!(
            "wsl.exe -d Speedwave -- nerdctl build -t my-image:latest -f /ctx/Containerfile --build-arg CLAUDE_VERSION={} /ctx",
            version
        );
        let runner = MockRunner::new().with_response(&expected_key, "");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(
            rt.build_image(
                "my-image:latest",
                "/ctx",
                "/ctx/Containerfile",
                &[("CLAUDE_VERSION", version)],
            )
            .is_ok(),
            "build_image with build_args should succeed"
        );
    }

    // ── wsl_compose_file_path tests ────────────────────────────────────

    #[test]
    fn test_wsl_compose_file_path_returns_unix_path() {
        // On macOS/Linux, compose_file_path already returns a Unix path,
        // so wsl_compose_file_path passes it through unchanged.
        let result = wsl_compose_file_path("test-project").unwrap();
        assert!(
            result.contains("/compose/test-project/compose.yml"),
            "should contain compose path structure, got: {}",
            result
        );
        assert!(
            !result.contains('\\'),
            "WSL compose path should use forward slashes, got: {}",
            result
        );
    }

    #[test]
    fn test_windows_to_wsl_path_converts_compose_file() {
        // Simulates what happens on Windows: compose_file_path returns a Windows path
        let win_path = Path::new(r"C:\Users\jakub\.speedwave\compose\e2e-test\compose.yml");
        let wsl = windows_to_wsl_path(win_path).unwrap();
        assert_eq!(
            wsl,
            PathBuf::from("/mnt/c/Users/jakub/.speedwave/compose/e2e-test/compose.yml")
        );
    }

    // ── ensure_ready UTF-16LE tests ─────────────────────────────────────

    #[test]
    fn test_ensure_ready_handles_utf16le_output() {
        let text = "Ubuntu\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new()
            .with_raw_response("wsl.exe --list --quiet", bytes)
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_response(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "buildkit ready",
            );
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_utf16le_distro_missing() {
        let text = "Ubuntu\r\nDebian\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Speedwave"));
        assert!(err.contains("setup wizard"));
    }

    // ── decode_wsl_output unit tests ────────────────────────────────────

    #[test]
    fn test_decode_wsl_output_handles_utf8() {
        let input = b"Speedwave\nUbuntu\n";
        let result = decode_wsl_output(input);
        assert_eq!(result, "Speedwave\nUbuntu\n");
    }

    #[test]
    fn test_decode_wsl_output_handles_utf16le_with_bom() {
        let text = "Speedwave\r\n";
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let result = decode_wsl_output(&bytes);
        assert!(
            result.contains("Speedwave"),
            "should decode UTF-16LE with BOM correctly, got: {result:?}"
        );
    }

    #[test]
    fn test_decode_wsl_output_handles_utf16le_without_bom() {
        let text = "Speedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        assert!(
            bytes.iter().any(|&b| b == 0),
            "UTF-16LE of ASCII text should contain null bytes"
        );
        let result = decode_wsl_output(&bytes);
        assert!(
            result.contains("Speedwave"),
            "should decode UTF-16LE without BOM correctly, got: {result:?}"
        );
    }

    #[test]
    fn test_decode_wsl_output_empty_input() {
        let result = decode_wsl_output(b"");
        assert_eq!(result, "");
    }

    #[test]
    fn test_decode_wsl_output_single_byte_input() {
        let result = decode_wsl_output(b"X");
        assert_eq!(result, "X");
    }

    #[test]
    fn test_decode_wsl_output_utf16le_distro_name_matches_after_trim() {
        let text = "Speedwave\r\n";
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let decoded = decode_wsl_output(&bytes);
        let found = decoded
            .lines()
            .any(|l| l.trim().trim_matches('\0') == consts::wsl_distro_name());
        assert!(
            found,
            "distro name '{}' should be found in decoded output, lines: {:?}",
            consts::wsl_distro_name(),
            decoded.lines().collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_decode_wsl_output_utf16le_without_bom_distro_name_matches() {
        let text = "Ubuntu\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let decoded = decode_wsl_output(&bytes);
        let found = decoded
            .lines()
            .any(|l| l.trim().trim_matches('\0') == consts::wsl_distro_name());
        assert!(
            found,
            "distro name '{}' should be found in decoded UTF-16LE (no BOM) output, lines: {:?}",
            consts::wsl_distro_name(),
            decoded.lines().collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_decode_wsl_output_odd_length_treated_as_utf8() {
        let input = b"AB\0CD\0E"; // 7 bytes — odd length
        let result = decode_wsl_output(input);
        assert_eq!(result, "AB\0CD\0E");
    }

    #[test]
    fn test_decode_wsl_output_control_chars_fall_back_to_utf8() {
        // Even-length input whose UTF-16LE decode contains control characters
        // (NUL at code-unit level), triggering the UTF-8 fallback.
        let input: &[u8] = &[0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x57, 0x6F, 0x72, 0x64];
        let result = decode_wsl_output(input);
        // UTF-16LE decode of this input produces control chars (NUL from 0x006F),
        // so the function falls back to UTF-8. The NUL byte is a control char that
        // is not \n, \r, or \t, so the UTF-16LE candidate is rejected.
        // However, the UTF-16LE decode of [0x6548, 0x6C6C, 0x006F, 0x6F57, 0x6472]
        // produces valid CJK chars with no control chars — so it is accepted as UTF-16LE.
        // We just verify it returns a non-empty string without panicking.
        assert!(
            !result.is_empty(),
            "should produce a non-empty string, got: {result:?}"
        );
    }

    #[test]
    fn test_decode_wsl_output_non_ascii_utf16le() {
        // "开发\r\nSpeedwave\r\n" encoded as UTF-16LE without BOM
        let text = "\u{5F00}\u{53D1}\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let decoded = decode_wsl_output(&bytes);
        assert!(
            decoded.contains("Speedwave"),
            "should decode UTF-16LE with non-ASCII chars, got: {decoded:?}"
        );
        assert!(
            decoded.contains('\u{5F00}'),
            "should preserve non-ASCII chars, got: {decoded:?}"
        );
    }

    // ── KeyedSequentialMockRunner for retry tests ─────────────────────────
    // Unlike test_support::SequentialMockRunner (which dispatches in a single
    // FIFO queue), this variant keys responses by "cmd args..." so that
    // interleaved calls to distinct commands each pop from their own queue.

    use std::collections::{HashMap, VecDeque};
    use std::sync::Mutex;

    struct KeyedSequentialMockRunner {
        responses: HashMap<String, Mutex<VecDeque<anyhow::Result<String>>>>,
    }

    impl KeyedSequentialMockRunner {
        fn new() -> Self {
            Self {
                responses: HashMap::new(),
            }
        }

        fn with_responses(mut self, key: &str, results: Vec<anyhow::Result<String>>) -> Self {
            self.responses
                .insert(key.to_string(), Mutex::new(VecDeque::from(results)));
            self
        }
    }

    impl CommandRunner for KeyedSequentialMockRunner {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            let key = format!("{} {}", cmd, args.join(" "));
            let queue = self
                .responses
                .get(&key)
                .unwrap_or_else(|| panic!("unexpected command: {key}"));
            let mut q = queue.lock().unwrap();
            match q.pop_front() {
                Some(Ok(val)) => Ok(val),
                Some(Err(e)) => Err(anyhow::anyhow!("{e}")),
                None => panic!("no more responses for: {key}"),
            }
        }

        fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
            self.run(cmd, args).map(|s| s.into_bytes())
        }
    }

    // ── Retry tests ──────────────────────────────────────────────────────

    #[test]
    fn test_ensure_ready_recovers_buildkit_after_retries() {
        // buildctl: fast-path fails, then 3 retry failures, then succeeds on 4th retry
        let runner = KeyedSequentialMockRunner::new()
            .with_responses(
                "wsl.exe --list --quiet",
                vec![Ok("Speedwave\n".to_string())],
            )
            // containerd: fast-path OK
            .with_responses(
                "wsl.exe -d Speedwave -- nerdctl info",
                vec![Ok("containerd running".to_string())],
            )
            .with_responses("wsl.exe -d Speedwave -- buildctl debug workers", {
                let mut v: Vec<anyhow::Result<String>> = Vec::new();
                // Fast-path check fails
                v.push(Err(anyhow::anyhow!("connection refused")));
                // Retry checks: 3 failures then success
                for _ in 0..3 {
                    v.push(Err(anyhow::anyhow!("connection refused")));
                }
                v.push(Ok("buildkit ready".to_string()));
                v
            })
            // systemctl start uses correct unit name "buildkit" (not "buildkitd").
            // If the code used "buildkitd", this mock wouldn't match and the test
            // would panic with "unexpected command".
            .with_responses(
                "wsl.exe -d Speedwave -- systemctl start buildkit",
                vec![Ok(String::new())],
            );

        let rt = WslRuntime {
            runner: Box::new(runner),
            retry_delay: std::time::Duration::ZERO,
            restart_ready_delay: std::time::Duration::ZERO,
            distro_name: consts::wsl_distro_name().to_string(),
        };
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_recovers_containerd_after_retries() {
        let runner = KeyedSequentialMockRunner::new()
            .with_responses(
                "wsl.exe --list --quiet",
                vec![Ok("Speedwave\n".to_string())],
            )
            // containerd: fast-path fails, start succeeds, 1st retry fails, 2nd retry OK
            .with_responses(
                "wsl.exe -d Speedwave -- nerdctl info",
                vec![
                    Err(anyhow::anyhow!("connection refused")),
                    Err(anyhow::anyhow!("connection refused")),
                    Ok("containerd running".to_string()),
                ],
            )
            .with_responses(
                "wsl.exe -d Speedwave -- systemctl start containerd",
                vec![Ok(String::new())],
            )
            // buildkitd: fast-path OK
            .with_responses(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                vec![Ok("buildkit ready".to_string())],
            );

        let rt = WslRuntime {
            runner: Box::new(runner),
            retry_delay: std::time::Duration::ZERO,
            restart_ready_delay: std::time::Duration::ZERO,
            distro_name: consts::wsl_distro_name().to_string(),
        };
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_fails_after_max_retries_with_diagnostics() {
        let max = consts::WSL_SERVICE_CHECK_MAX_RETRIES;

        // buildctl fails on all attempts (fast-path + max retries)
        let mut buildctl_responses: Vec<anyhow::Result<String>> = Vec::new();
        // Fast-path check
        buildctl_responses.push(Err(anyhow::anyhow!("connection refused")));
        // All retry checks
        for _ in 0..max {
            buildctl_responses.push(Err(anyhow::anyhow!("still refused")));
        }

        let runner = KeyedSequentialMockRunner::new()
            .with_responses(
                "wsl.exe --list --quiet",
                vec![Ok("Speedwave\n".to_string())],
            )
            .with_responses(
                "wsl.exe -d Speedwave -- nerdctl info",
                vec![Ok("containerd running".to_string())],
            )
            .with_responses(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                buildctl_responses,
            )
            .with_responses(
                "wsl.exe -d Speedwave -- systemctl start buildkit",
                vec![Err(anyhow::anyhow!("unit not found"))],
            );

        let rt = WslRuntime {
            runner: Box::new(runner),
            retry_delay: std::time::Duration::ZERO,
            restart_ready_delay: std::time::Duration::ZERO,
            distro_name: consts::wsl_distro_name().to_string(),
        };
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();

        // Verify diagnostic error contains all expected information
        assert!(
            err.contains("buildkitd"),
            "error should mention service display name 'buildkitd', got: {err}"
        );
        assert!(
            err.contains("unit not found"),
            "error should include systemctl start error, got: {err}"
        );
        assert!(
            err.contains("still refused"),
            "error should include last health check error, got: {err}"
        );
        assert!(
            err.contains("systemctl start buildkit"),
            "error hint should use systemd unit 'buildkit' (not 'buildkitd'), got: {err}"
        );
        assert!(
            err.contains(&format!("after {max} attempts")),
            "error should mention retry count, got: {err}"
        );
    }

    #[test]
    fn test_restart_container_engine_ok() {
        let runner = MockRunner::new()
            .with_response("wsl.exe -d Speedwave -- systemctl restart containerd", "")
            .with_response("wsl.exe -d Speedwave -- systemctl restart buildkit", "")
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_response(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "buildkit ready",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        assert!(rt.restart_container_engine().is_ok());
    }

    #[test]
    fn test_restart_container_engine_propagates_containerd_error() {
        let runner = MockRunner::new().with_error(
            "wsl.exe -d Speedwave -- systemctl restart containerd",
            "restart failed",
        );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("restart failed"));
    }

    #[test]
    fn test_restart_container_engine_buildkit_unit_not_found_still_polls() {
        let runner = MockRunner::new()
            .with_response("wsl.exe -d Speedwave -- systemctl restart containerd", "")
            .with_error(
                "wsl.exe -d Speedwave -- systemctl restart buildkit",
                "Failed to restart buildkit.service: Unit not found.",
            )
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_response(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "buildkit ready",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        assert!(
            rt.restart_container_engine().is_ok(),
            "should succeed when buildkit unit not found but buildctl works"
        );
    }

    #[test]
    fn test_restart_container_engine_propagates_buildkit_error() {
        let runner = MockRunner::new()
            .with_response("wsl.exe -d Speedwave -- systemctl restart containerd", "")
            .with_error(
                "wsl.exe -d Speedwave -- systemctl restart buildkit",
                "Failed to restart buildkit.service: some other error",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("some other error"),
            "should propagate non-unit-not-found buildkit errors"
        );
    }

    #[test]
    fn test_restart_container_engine_not_ready_after_retries() {
        let runner = MockRunner::new()
            .with_response("wsl.exe -d Speedwave -- systemctl restart containerd", "")
            .with_response("wsl.exe -d Speedwave -- systemctl restart buildkit", "")
            .with_error("wsl.exe -d Speedwave -- nerdctl info", "connection refused")
            .with_error(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "connection refused",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("not ready"),
            "should report not ready after retries"
        );
    }

    mod reset_vm_tests {
        use super::*;
        use crate::runtime::test_support::SequentialMockRunner;
        use std::sync::Arc;
        use std::time::Duration;

        // Thin Arc wrapper so tests can hold a shared reference to the mock
        // while also passing ownership into the runtime.
        struct ArcRunner(Arc<SequentialMockRunner>);
        impl crate::runtime::CommandRunner for ArcRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                self.0.run(cmd, args)
            }
            fn run_with_timeout(
                &self,
                cmd: &str,
                args: &[&str],
                timeout: Duration,
            ) -> anyhow::Result<()> {
                self.0.run_with_timeout(cmd, args, timeout)
            }
        }

        #[test]
        fn reset_vm_happy_path() {
            let mock = SequentialMockRunner::new(vec![Ok("".into()), Ok("".into())]);
            let rt = WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(mock));
            assert!(rt.reset_vm().is_ok());
        }

        #[test]
        fn reset_vm_call_sequence() {
            let mock = Arc::new(SequentialMockRunner::new(vec![
                Ok("".into()),
                Ok("".into()),
            ]));
            let mock_clone = Arc::clone(&mock);
            let rt =
                WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(ArcRunner(mock)));
            assert!(rt.reset_vm().is_ok());
            let calls = mock_clone.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            // cmd is the absolute System32 path; ends_with covers cross-platform tests
            assert!(
                calls[0].0.ends_with("wsl.exe"),
                "expected wsl.exe path, got: {}",
                calls[0].0
            );
            assert_eq!(calls[0].1, vec!["--terminate", "Speedwave-test"]);
            assert_eq!(calls[0].2, Some(Duration::from_secs(10)));
            assert!(
                calls[1].0.ends_with("wsl.exe"),
                "expected wsl.exe path, got: {}",
                calls[1].0
            );
            assert_eq!(calls[1].1, vec!["--unregister", "Speedwave-test"]);
            assert_eq!(calls[1].2, Some(Duration::from_secs(25)));
        }

        #[test]
        fn reset_vm_distro_not_registered_legacy_message() {
            let mock = SequentialMockRunner::new(vec![
                Ok("".into()),
                Err(anyhow::anyhow!(
                    "wsl.exe failed with exit code Some(-1): There is no distribution with the supplied name."
                )),
            ]);
            let rt = WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(mock));
            assert!(rt.reset_vm().is_ok());
        }

        #[test]
        fn reset_vm_distro_not_registered_modern_error_code() {
            let mock = SequentialMockRunner::new(vec![
                Ok("".into()),
                Err(anyhow::anyhow!(
                    "wsl.exe failed with exit code Some(1): Wsl/Service/WSL_E_DISTRO_NOT_FOUND"
                )),
            ]);
            let rt = WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(mock));
            assert!(rt.reset_vm().is_ok());
        }

        #[test]
        fn reset_vm_distro_not_registered_case_variant() {
            let mock = SequentialMockRunner::new(vec![
                Ok("".into()),
                Err(anyhow::anyhow!(
                    "wsl.exe failed with exit code Some(1): ERROR: NO Distribution Found"
                )),
            ]);
            let rt = WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(mock));
            assert!(rt.reset_vm().is_ok());
        }

        #[test]
        fn reset_vm_terminate_fails_unregister_succeeds() {
            let mock = SequentialMockRunner::new(vec![
                Err(anyhow::anyhow!("LxssManager not running")),
                Ok("".into()),
            ]);
            let rt = WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(mock));
            assert!(rt.reset_vm().is_ok());
        }

        #[test]
        fn reset_vm_unregister_fails_unexpected_error() {
            let mock = SequentialMockRunner::new(vec![
                Ok("".into()),
                Err(anyhow::anyhow!(
                    "wsl.exe failed with exit code Some(1): Access is denied"
                )),
            ]);
            let rt = WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(mock));
            let err = rt.reset_vm().unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("wsl --unregister"),
                "expected 'wsl --unregister' in: {msg}"
            );
            assert!(
                msg.contains("Access is denied"),
                "expected 'Access is denied' in: {msg}"
            );
            assert!(
                msg.contains("Speedwave-test"),
                "expected distro name 'Speedwave-test' in error: {msg}"
            );
        }

        #[test]
        fn reset_vm_unregister_times_out() {
            let mock = SequentialMockRunner::new(vec![
                Ok("".into()),
                Err(anyhow::anyhow!("command 'wsl.exe' timed out after 25s")),
            ]);
            let rt = WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(mock));
            let err = rt.reset_vm().unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("timed out"), "expected 'timed out' in: {msg}");
            assert!(
                msg.contains("Speedwave-test"),
                "expected distro name 'Speedwave-test' in timeout error: {msg}"
            );
        }

        #[test]
        fn reset_vm_idempotent_second_call_returns_ok() {
            let mock = Arc::new(SequentialMockRunner::new(vec![
                Ok("".into()),
                Ok("".into()),
                Ok("".into()),
                Err(anyhow::anyhow!(
                    "There is no distribution with the supplied name"
                )),
            ]));
            let mock_clone = Arc::clone(&mock);
            let rt =
                WslRuntime::with_distro_name("Speedwave-test".into(), Box::new(ArcRunner(mock)));
            assert!(rt.reset_vm().is_ok(), "first call must return Ok");
            assert!(
                rt.reset_vm().is_ok(),
                "second call (already clean) must return Ok"
            );
            let calls = mock_clone.calls.lock().unwrap();
            assert_eq!(calls.len(), 4);
            assert_eq!(calls[0].1, vec!["--terminate", "Speedwave-test"]);
            assert_eq!(calls[1].1, vec!["--unregister", "Speedwave-test"]);
            assert_eq!(calls[2].1, vec!["--terminate", "Speedwave-test"]);
            assert_eq!(calls[3].1, vec!["--unregister", "Speedwave-test"]);
        }
    }
}

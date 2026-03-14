use crate::binary;
use crate::consts;
use serde_json::Value;
use std::process::Command;

pub mod lima;
pub mod nerdctl;
pub mod wsl;

pub trait ContainerRuntime: Send + Sync {
    fn compose_up(&self, project: &str) -> anyhow::Result<()>;
    fn compose_down(&self, project: &str) -> anyhow::Result<()>;
    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>>;
    /// Returns a Command for interactive exec (TTY allocated, suitable for TUI apps).
    /// Caller should run `.status()` to inherit the terminal.
    fn container_exec(&self, container: &str, cmd: &[&str]) -> Command;
    /// Returns a Command for piped exec (no TTY, suitable for Stdio::piped()).
    /// Caller should set `.stdin(Stdio::piped()).stdout(Stdio::piped())`.
    ///
    /// Returns `Result` so implementations can check preconditions (e.g. Lima
    /// VM running) before constructing the command.
    fn container_exec_piped(&self, container: &str, cmd: &[&str]) -> anyhow::Result<Command>;
    fn is_available(&self) -> bool;
    fn ensure_ready(&self) -> anyhow::Result<()>;
    fn build_image(&self, tag: &str, context_dir: &str, containerfile: &str) -> anyhow::Result<()>;
    /// Translates a host build-root path into one accessible by the container engine.
    ///
    /// Default: identity (Linux nerdctl — paths are already native).
    /// Lima override: copies to `~/.speedwave/build-cache/` when outside `~` (VM only mounts `~`).
    /// WSL override: converts `C:\…` → `/mnt/c/…`.
    ///
    /// **Implementors on VM/translation-layer platforms must override this.**
    /// The default identity pass-through is only correct for native Linux nerdctl.
    fn prepare_build_context(
        &self,
        build_root: &std::path::Path,
    ) -> anyhow::Result<std::path::PathBuf> {
        Ok(build_root.to_path_buf())
    }
    fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String>;
    fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String>;
    /// Recreates all containers using `--force-recreate --remove-orphans`.
    fn compose_up_recreate(&self, project: &str) -> anyhow::Result<()>;

    /// Removes dangling images and build cache (not tagged images).
    ///
    /// Used by `build_all_images` to recover from stale overlayfs snapshotter
    /// state on containerd (containerd bug — "failed to rename:
    /// file exists" during layer extraction). Only removes dangling
    /// (untagged) images and build cache, so successfully-built tagged
    /// images survive a partial-build retry.
    ///
    /// This bug affects all containerd overlayfs setups, including native
    /// Linux (NerdctlRuntime), Lima VM (LimaRuntime), and WSL2 (WslRuntime).
    /// All three current runtime implementations (`LimaRuntime`, `NerdctlRuntime`,
    /// `WslRuntime`) override this method with `nerdctl system prune --force`.
    fn system_prune(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

pub trait CommandRunner: Send + Sync {
    fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String>;

    /// Like `run`, but merges stdout and stderr on success.
    ///
    /// `nerdctl logs` writes container output to stderr,
    /// so the standard `run()` (which returns only stdout) would return
    /// an empty string. This method captures both streams.
    ///
    /// Default implementation delegates to `run()` so that existing
    /// `CommandRunner` implementations (including mocks) work unchanged.
    fn run_with_stderr(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        self.run(cmd, args)
    }

    /// Like `run`, but returns raw stdout bytes without UTF-8 conversion.
    /// Needed for commands like `wsl.exe --list` that output UTF-16LE.
    fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        // Default: delegate to run() and return as UTF-8 bytes
        self.run(cmd, args).map(|s| s.into_bytes())
    }
}

pub struct RealRunner;

/// Combines two output streams, returning whichever is non-empty (or both joined by newline).
fn combine_outputs(primary: &str, secondary: &str) -> String {
    if secondary.trim().is_empty() {
        primary.to_string()
    } else if primary.trim().is_empty() {
        secondary.to_string()
    } else {
        format!("{}\n{}", primary.trim(), secondary.trim())
    }
}

impl RealRunner {
    /// Creates a `Command` with the resolved binary, `LIMA_HOME` (for limactl), and args applied.
    fn prepare_command(cmd: &str, args: &[&str]) -> Command {
        let mut command = binary::command(cmd);
        command.args(args);
        command
    }
}

impl CommandRunner for RealRunner {
    fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        let output = Self::prepare_command(cmd, args).output()?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            anyhow::bail!("{} failed: {}", cmd, combine_outputs(&stderr, &stdout));
        }
    }

    fn run_with_stderr(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        let output = Self::prepare_command(cmd, args).output()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.success() {
            Ok(combine_outputs(&stdout, &stderr))
        } else {
            anyhow::bail!("{} failed: {}", cmd, combine_outputs(&stderr, &stdout));
        }
    }

    fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        let output = Self::prepare_command(cmd, args).output()?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            anyhow::bail!("{} failed: {}", cmd, combine_outputs(&stderr, &stdout));
        }
    }
}

/// Parses `compose ps --format json` output.
///
/// Handles both JSON array (`[{...},{...}]`) and NDJSON (`{...}\n{...}`) formats
/// because nerdctl may emit JSON array or NDJSON depending on version.
pub fn parse_compose_ps_json(output: &str) -> Vec<Value> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        trimmed
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
}

/// Parses a semver triple from a version string.
///
/// Handles formats like `"nerdctl version 2.0.3"`, `"limactl version 1.2.3"`,
/// or a bare `"2.0.3"`. Returns `(major, minor, patch)` or `None` if unparseable.
pub fn parse_version(version_output: &str) -> Option<(u32, u32, u32)> {
    let version_str = version_output
        .split_whitespace()
        .find(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let parts: Vec<&str> = version_str.split('.').collect();
    if parts.len() >= 3 {
        Some((
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    } else if parts.len() == 2 {
        Some((parts[0].parse().ok()?, parts[1].parse().ok()?, 0))
    } else {
        None
    }
}

/// Returns the path to the compose file for a given project.
///
/// Layout: `~/.speedwave/compose/<project>/compose.yml`
pub fn compose_file_path(project: &str) -> anyhow::Result<String> {
    let data_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
        .join(consts::DATA_DIR)
        .join("compose")
        .join(project)
        .join("compose.yml");
    Ok(data_dir.to_string_lossy().to_string())
}

pub fn detect_runtime() -> Box<dyn ContainerRuntime> {
    #[cfg(target_os = "macos")]
    {
        Box::new(lima::LimaRuntime::new())
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(nerdctl::NerdctlRuntime::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(wsl::WslRuntime::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    compile_error!("Speedwave requires macOS, Linux, or Windows");
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::CommandRunner;

    pub struct MockRunner {
        pub responses: std::collections::HashMap<String, anyhow::Result<String>>,
        pub raw_responses: std::collections::HashMap<String, anyhow::Result<Vec<u8>>>,
    }

    impl MockRunner {
        pub fn new() -> Self {
            Self {
                responses: std::collections::HashMap::new(),
                raw_responses: std::collections::HashMap::new(),
            }
        }

        pub fn with_response(mut self, key: &str, response: &str) -> Self {
            self.responses
                .insert(key.to_string(), Ok(response.to_string()));
            self
        }

        pub fn with_error(mut self, key: &str, msg: &str) -> Self {
            self.responses
                .insert(key.to_string(), Err(anyhow::anyhow!(msg.to_string())));
            self
        }

        pub fn with_raw_response(mut self, key: &str, bytes: Vec<u8>) -> Self {
            self.raw_responses.insert(key.to_string(), Ok(bytes));
            self
        }

        pub fn make_key(cmd: &str, args: &[&str]) -> String {
            format!("{} {}", cmd, args.join(" "))
        }
    }

    impl CommandRunner for MockRunner {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            let key = Self::make_key(cmd, args);
            match self.responses.get(&key) {
                Some(Ok(val)) => Ok(val.clone()),
                Some(Err(e)) => Err(anyhow::anyhow!("{}", e)),
                None => Err(anyhow::anyhow!("unexpected command: {}", key)),
            }
        }

        fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
            let key = Self::make_key(cmd, args);
            // Check raw_responses first, fall back to run().into_bytes()
            if let Some(result) = self.raw_responses.get(&key) {
                return match result {
                    Ok(val) => Ok(val.clone()),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                };
            }
            self.run(cmd, args).map(|s| s.into_bytes())
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_compose_file_path_format() {
        let path = compose_file_path("my-project").expect("compose_file_path");
        assert!(path.contains(crate::consts::DATA_DIR));
        assert!(path.contains("compose"));
        assert!(path.contains("my-project"));
        assert!(path.ends_with("compose.yml"));
    }

    #[test]
    fn parse_json_array_from_nerdctl() {
        let input = r#"[{"Name":"speedwave_acme_mcp_hub","State":"running"},{"Name":"speedwave_acme_claude","State":"exited"}]"#;
        let result = parse_compose_ps_json(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["Name"], "speedwave_acme_mcp_hub");
        assert_eq!(result[0]["State"], "running");
        assert_eq!(result[1]["Name"], "speedwave_acme_claude");
        assert_eq!(result[1]["State"], "exited");
    }

    #[test]
    fn parse_ndjson_format() {
        let input = "{\"Name\":\"hub\",\"Status\":\"Up 5 minutes\"}\n{\"Name\":\"slack\",\"Status\":\"Up 5 minutes\"}\n";
        let result = parse_compose_ps_json(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["Name"], "hub");
        assert_eq!(result[1]["Name"], "slack");
    }

    #[test]
    fn parse_empty_output() {
        assert!(parse_compose_ps_json("").is_empty());
        assert!(parse_compose_ps_json("  \n  ").is_empty());
    }

    #[test]
    fn parse_empty_json_array() {
        assert!(parse_compose_ps_json("[]").is_empty());
    }

    #[test]
    fn parse_malformed_json_returns_empty() {
        assert!(parse_compose_ps_json("not json at all").is_empty());
    }

    #[test]
    fn parse_ndjson_skips_invalid_lines() {
        let input = "{\"Name\":\"hub\"}\ngarbage\n{\"Name\":\"slack\"}";
        let result = parse_compose_ps_json(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["Name"], "hub");
        assert_eq!(result[1]["Name"], "slack");
    }

    #[test]
    fn parse_real_nerdctl_output() {
        // Real output from `limactl shell speedwave sudo nerdctl compose ps --format json`
        let input = r#"[{"ID":"076c","Name":"speedwave_myproject_mcp_redmine","Image":"speedwave-mcp-redmine:latest","Command":"docker-entrypoint.sh node dist/index.js","Project":"myproject","Service":"mcp-redmine","State":"running","Health":"","ExitCode":0,"Publishers":[{"URL":"127.0.0.1","TargetPort":4003,"PublishedPort":4003,"Protocol":"tcp"}]},{"ID":"40c1","Name":"speedwave_myproject_claude","Image":"speedwave-claude:latest","Command":"/usr/local/bin/entrypoint.sh","Project":"myproject","Service":"claude","State":"exited","Health":"","ExitCode":1,"Publishers":[]}]"#;
        let result = parse_compose_ps_json(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["Name"], "speedwave_myproject_mcp_redmine");
        assert_eq!(result[0]["State"], "running");
        assert_eq!(result[1]["Name"], "speedwave_myproject_claude");
        assert_eq!(result[1]["State"], "exited");
    }

    /// Verifies that the default `run_with_stderr` implementation delegates to `run`,
    /// so MockRunner (which only implements `run`) inherits the correct behavior.
    #[test]
    fn test_run_with_stderr_default_delegates_to_run() {
        struct StubRunner;
        impl CommandRunner for StubRunner {
            fn run(&self, _cmd: &str, _args: &[&str]) -> anyhow::Result<String> {
                Ok("from_run".to_string())
            }
            // run_with_stderr NOT overridden — uses default impl
        }

        let runner = StubRunner;
        let result = runner
            .run_with_stderr("echo", &["hello"])
            .expect("run_with_stderr");
        assert_eq!(
            result, "from_run",
            "default run_with_stderr should delegate to run()"
        );
    }

    /// Verifies that an implementor can override `run_with_stderr` independently of `run`.
    #[test]
    fn test_run_with_stderr_can_be_overridden() {
        struct MergedRunner;
        impl CommandRunner for MergedRunner {
            fn run(&self, _cmd: &str, _args: &[&str]) -> anyhow::Result<String> {
                Ok("stdout_only".to_string())
            }
            fn run_with_stderr(&self, _cmd: &str, _args: &[&str]) -> anyhow::Result<String> {
                Ok("stdout+stderr".to_string())
            }
        }

        let runner = MergedRunner;
        assert_eq!(runner.run("x", &[]).expect("run"), "stdout_only");
        assert_eq!(
            runner.run_with_stderr("x", &[]).expect("run_with_stderr"),
            "stdout+stderr"
        );
    }

    #[test]
    fn parse_version_full_semver() {
        assert_eq!(parse_version("nerdctl version 2.0.3"), Some((2, 0, 3)));
        assert_eq!(parse_version("limactl version 1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("2.0.3"), Some((2, 0, 3)));
    }

    #[test]
    fn parse_version_two_parts() {
        assert_eq!(parse_version("2.0"), Some((2, 0, 0)));
    }

    #[test]
    fn parse_version_returns_none_for_garbage() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version("version"), None);
    }

    #[test]
    fn parse_version_returns_none_for_pre_release_suffix() {
        // "2.0.0-beta1" → patch part "0-beta1" fails to parse as u32 → None
        assert_eq!(parse_version("2.0.0-beta1"), None);
    }

    #[test]
    fn combine_outputs_primary_only() {
        assert_eq!(combine_outputs("hello", ""), "hello");
        assert_eq!(combine_outputs("hello", "  \n  "), "hello");
    }

    #[test]
    fn combine_outputs_secondary_only() {
        assert_eq!(combine_outputs("", "world"), "world");
        assert_eq!(combine_outputs("  ", "world"), "world");
    }

    #[test]
    fn combine_outputs_both_present() {
        assert_eq!(combine_outputs("hello", "world"), "hello\nworld");
    }

    #[test]
    fn combine_outputs_both_empty() {
        assert_eq!(combine_outputs("", ""), "");
    }

    #[test]
    fn test_run_raw_stdout_default_delegates_to_run() {
        struct StubRunner;
        impl CommandRunner for StubRunner {
            fn run(&self, _cmd: &str, _args: &[&str]) -> anyhow::Result<String> {
                Ok("from_run".to_string())
            }
            // run_raw_stdout NOT overridden — uses default impl
        }

        let runner = StubRunner;
        let result = runner
            .run_raw_stdout("echo", &["hello"])
            .expect("run_raw_stdout");
        assert_eq!(
            result, b"from_run",
            "default run_raw_stdout should delegate to run() and return bytes"
        );
    }

    #[test]
    fn test_mock_runner_raw_response_takes_priority() {
        let runner = test_support::MockRunner::new()
            .with_response("cmd --flag", "text_response")
            .with_raw_response("cmd --flag", vec![0xFF, 0xFE, 0x41, 0x00]);

        // run() returns text response
        assert_eq!(runner.run("cmd", &["--flag"]).unwrap(), "text_response");
        // run_raw_stdout() returns raw bytes (raw_response takes priority)
        assert_eq!(
            runner.run_raw_stdout("cmd", &["--flag"]).unwrap(),
            vec![0xFF, 0xFE, 0x41, 0x00]
        );
    }

    #[test]
    fn test_mock_runner_raw_fallback_to_run() {
        let runner = test_support::MockRunner::new().with_response("cmd --flag", "hello");

        // No raw_response set, so run_raw_stdout falls back to run().into_bytes()
        assert_eq!(
            runner.run_raw_stdout("cmd", &["--flag"]).unwrap(),
            b"hello".to_vec()
        );
    }
}

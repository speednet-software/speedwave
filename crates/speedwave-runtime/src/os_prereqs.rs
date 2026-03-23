use std::fmt;

/// Compile-time enumeration of OS prerequisite rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrereqRule {
    /// Windows: WSL2 is not available or not functional.
    WslNotAvailable,
    /// Linux: `newuidmap` binary not found (required for rootless containers).
    UidmapMissing,
}

impl fmt::Display for PrereqRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WslNotAvailable => f.write_str("WSL_NOT_AVAILABLE"),
            Self::UidmapMissing => f.write_str("UIDMAP_MISSING"),
        }
    }
}

/// A single OS prerequisite violation with actionable remediation.
#[derive(Debug)]
pub struct PrereqViolation {
    pub rule: PrereqRule,
    pub message: String,
    pub remediation: &'static str,
}

impl fmt::Display for PrereqViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}\n{}", self.message, self.remediation)
    }
}

/// Checks OS-level prerequisites for container isolation.
/// Returns an empty Vec if all prerequisites are met.
///
/// - **Windows**: Verifies WSL2 is available via `wsl.exe --status` (10s timeout).
/// - **Linux**: Verifies `newuidmap` exists (required for rootless user namespaces).
/// - **macOS**: No OS prerequisites (Lima runtime is bundled).
pub fn check_os_prereqs() -> Vec<PrereqViolation> {
    let violations: Vec<PrereqViolation> = Vec::new();

    #[cfg(target_os = "windows")]
    let violations = check_wsl();

    #[cfg(target_os = "linux")]
    let violations = check_uidmap();

    violations
}

#[cfg(target_os = "windows")]
fn check_wsl() -> Vec<PrereqViolation> {
    use crate::{binary, consts};

    let timeout = std::time::Duration::from_secs(10);
    let mut cmd = binary::system_command("wsl.exe");
    cmd.args(["--status"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    match binary::run_with_timeout(&mut cmd, timeout) {
        Ok(status) if status.success() => Vec::new(),
        Ok(status) => vec![PrereqViolation {
            rule: PrereqRule::WslNotAvailable,
            message: format!(
                "wsl.exe --status exited with code {}",
                status.code().unwrap_or(-1)
            ),
            remediation: consts::WSL_NOT_AVAILABLE_MSG,
        }],
        Err(e) => vec![PrereqViolation {
            rule: PrereqRule::WslNotAvailable,
            message: format!("WSL2 check failed: {e}"),
            remediation: consts::WSL_NOT_AVAILABLE_MSG,
        }],
    }
}

#[cfg(target_os = "linux")]
fn check_uidmap() -> Vec<PrereqViolation> {
    use crate::consts;

    let output = std::process::Command::new("sh")
        .args(["-c", "command -v newuidmap"])
        .output();

    match output {
        Ok(o) if o.status.success() => Vec::new(),
        _ => vec![PrereqViolation {
            rule: PrereqRule::UidmapMissing,
            message: "newuidmap not found on this system".to_string(),
            remediation: consts::UIDMAP_MISSING_MSG,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consts;

    #[test]
    fn test_prereq_rule_wsl_not_available_display() {
        assert_eq!(PrereqRule::WslNotAvailable.to_string(), "WSL_NOT_AVAILABLE");
    }

    #[test]
    fn test_prereq_rule_uidmap_missing_display() {
        assert_eq!(PrereqRule::UidmapMissing.to_string(), "UIDMAP_MISSING");
    }

    #[test]
    fn test_prereq_violation_display() {
        let violation = PrereqViolation {
            rule: PrereqRule::WslNotAvailable,
            message: "test message".to_string(),
            remediation: "test remediation",
        };
        let display = violation.to_string();
        assert_eq!(display, "test message\ntest remediation");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_check_os_prereqs_macos_returns_empty() {
        let violations = check_os_prereqs();
        assert!(
            violations.is_empty(),
            "macOS should have no OS prereq violations, got {} violation(s)",
            violations.len()
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_check_os_prereqs_linux_with_uidmap_present() {
        // On CI and dev machines, newuidmap is typically installed.
        // If this test fails, install: sudo apt install uidmap
        let violations = check_os_prereqs();
        assert!(
            violations.is_empty(),
            "Linux with newuidmap installed should have no prereq violations, got: {:?}",
            violations
        );
    }

    #[test]
    fn test_wsl_not_available_remediation_contains_dism() {
        assert!(
            consts::WSL_NOT_AVAILABLE_MSG.contains("dism.exe"),
            "WSL_NOT_AVAILABLE_MSG should contain dism.exe remediation"
        );
    }

    #[test]
    fn test_uidmap_missing_remediation_contains_install() {
        assert!(
            consts::UIDMAP_MISSING_MSG.contains("uidmap"),
            "UIDMAP_MISSING_MSG should contain uidmap install instructions"
        );
    }
}

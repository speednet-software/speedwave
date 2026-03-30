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
    #[cfg(target_os = "windows")]
    {
        check_wsl()
    }

    #[cfg(target_os = "linux")]
    {
        check_uidmap()
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Vec::new()
    }
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

// ---------------------------------------------------------------------------
// Non-blocking OS warnings (separate from blocking prereqs)
// ---------------------------------------------------------------------------

/// Returns non-blocking OS warnings (e.g. nested virtualization detected).
/// Separate from `check_os_prereqs()` which returns blocking errors.
///
/// Warnings are logged by callers — they do not block container operations.
pub fn check_os_warnings() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        check_nested_virt()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// Parses JSON output from `Get-CimInstance Win32_ComputerSystem` and extracts
/// the `Model` and `Manufacturer` fields.
///
/// Returns `None` for malformed, missing, or non-string fields.
#[cfg(any(target_os = "windows", test))]
fn parse_vm_info(json: &str) -> Option<(String, String)> {
    let val: serde_json::Value = serde_json::from_str(json).ok()?;
    let model = val.get("Model")?.as_str()?.to_string();
    let manufacturer = val.get("Manufacturer")?.as_str()?.to_string();
    if model.is_empty() && manufacturer.is_empty() {
        return None;
    }
    Some((model, manufacturer))
}

/// Returns `true` if the WMI Model/Manufacturer strings indicate a virtual machine.
///
/// Case-insensitive matching. Checks both fields to catch all major hypervisors:
/// - VMware: model contains "vmware"
/// - VirtualBox: model contains "virtualbox" OR manufacturer contains "innotek"
/// - Hyper-V: model contains "virtual machine" AND manufacturer contains "microsoft"
///   (requires both to avoid false positives on Microsoft Surface hardware)
/// - QEMU/KVM: manufacturer contains "qemu" (model is generic, e.g. "Standard PC")
#[cfg(any(target_os = "windows", test))]
fn is_virtual_machine(model: &str, manufacturer: &str) -> bool {
    let model_lower = model.to_ascii_lowercase();
    let mfr_lower = manufacturer.to_ascii_lowercase();

    model_lower.contains("vmware")
        || model_lower.contains("virtualbox")
        || (model_lower.contains("virtual machine") && mfr_lower.contains("microsoft"))
        || mfr_lower.contains("qemu")
        || mfr_lower.contains("innotek")
}

#[cfg(target_os = "windows")]
fn check_nested_virt() -> Vec<String> {
    use crate::binary;

    let mut cmd = binary::system_command("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystem | Select-Object -Property Model,Manufacturer | ConvertTo-Json)",
    ]);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    // No explicit timeout — cmd.output() blocks until PowerShell exits.
    // PowerShell startup is ~2-3s; the Get-CimInstance query is fast.
    // If WMI hangs, the warning is skipped (fail-open) on the next startup.
    let output = match cmd.output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        Ok(_) | Err(_) => return Vec::new(), // Fail open
    };

    match parse_vm_info(&output) {
        Some((model, manufacturer)) if is_virtual_machine(&model, &manufacturer) => {
            vec![format!(
                "Nested virtualization detected — running inside {model}.\n{}",
                crate::consts::NESTED_VIRT_WARNING_MSG
            )]
        }
        _ => Vec::new(),
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

    // -----------------------------------------------------------------------
    // parse_vm_info() tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_vm_info_valid_json() {
        let json = r#"{"Model":"VMware Virtual Platform","Manufacturer":"VMware, Inc."}"#;
        let result = parse_vm_info(json);
        assert_eq!(
            result,
            Some(("VMware Virtual Platform".into(), "VMware, Inc.".into()))
        );
    }

    #[test]
    fn test_parse_vm_info_empty_json() {
        assert_eq!(parse_vm_info("{}"), None);
    }

    #[test]
    fn test_parse_vm_info_missing_model() {
        let json = r#"{"Manufacturer":"HP"}"#;
        assert_eq!(parse_vm_info(json), None);
    }

    #[test]
    fn test_parse_vm_info_missing_manufacturer() {
        let json = r#"{"Model":"HP ProLiant"}"#;
        assert_eq!(parse_vm_info(json), None);
    }

    #[test]
    fn test_parse_vm_info_malformed() {
        assert_eq!(parse_vm_info("not json at all"), None);
    }

    #[test]
    fn test_parse_vm_info_empty_string() {
        assert_eq!(parse_vm_info(""), None);
    }

    #[test]
    fn test_parse_vm_info_powershell_error() {
        assert_eq!(parse_vm_info("Get-CimInstance : Access is denied"), None);
    }

    #[test]
    fn test_parse_vm_info_null_fields() {
        let json = r#"{"Model":null,"Manufacturer":null}"#;
        assert_eq!(parse_vm_info(json), None);
    }

    // -----------------------------------------------------------------------
    // is_virtual_machine() tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_is_vm_vmware_model() {
        assert!(is_virtual_machine("VMware Virtual Platform", ""));
    }

    #[test]
    fn test_is_vm_vmware7_model() {
        assert!(is_virtual_machine("VMware7,1", ""));
    }

    #[test]
    fn test_is_vm_virtualbox_model() {
        assert!(is_virtual_machine("VirtualBox", ""));
    }

    #[test]
    fn test_is_vm_virtualbox_manufacturer() {
        assert!(is_virtual_machine("", "innotek GmbH"));
    }

    #[test]
    fn test_is_vm_hyperv() {
        assert!(is_virtual_machine(
            "Virtual Machine",
            "Microsoft Corporation"
        ));
    }

    #[test]
    fn test_is_vm_qemu_manufacturer() {
        assert!(is_virtual_machine("Standard PC (Q35 + ICH9, 2009)", "QEMU"));
    }

    #[test]
    fn test_is_vm_bare_metal_hp() {
        assert!(!is_virtual_machine("HP ProLiant DL380 Gen10", "HP"));
    }

    #[test]
    fn test_is_vm_bare_metal_dell() {
        assert!(!is_virtual_machine("PowerEdge R640", "Dell Inc."));
    }

    #[test]
    fn test_is_vm_microsoft_surface() {
        assert!(!is_virtual_machine(
            "Surface Pro 9",
            "Microsoft Corporation"
        ));
    }

    #[test]
    fn test_is_vm_empty_strings() {
        assert!(!is_virtual_machine("", ""));
    }

    #[test]
    fn test_is_vm_case_insensitive() {
        assert!(is_virtual_machine("vmware virtual platform", ""));
    }

    // -----------------------------------------------------------------------
    // check_os_warnings() and NESTED_VIRT_WARNING_MSG tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_nested_virt_warning_msg_contains_remediation() {
        assert!(
            consts::NESTED_VIRT_WARNING_MSG.contains("memory"),
            "NESTED_VIRT_WARNING_MSG should mention memory"
        );
        assert!(
            consts::NESTED_VIRT_WARNING_MSG.contains("Hyper-V"),
            "NESTED_VIRT_WARNING_MSG should mention Hyper-V"
        );
    }

    #[test]
    fn test_check_os_warnings_returns_empty_on_non_windows() {
        // On macOS/Linux (dev/CI), check_os_warnings() returns empty Vec
        // because check_nested_virt() is #[cfg(target_os = "windows")] only.
        #[cfg(not(target_os = "windows"))]
        {
            let warnings = check_os_warnings();
            assert!(
                warnings.is_empty(),
                "check_os_warnings() should return empty on non-Windows, got: {:?}",
                warnings
            );
        }
    }
}

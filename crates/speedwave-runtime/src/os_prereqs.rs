//! Host OS prerequisite checks (virtualization, WSL2/Lima availability).

use std::fmt;

/// Compile-time enumeration of OS prerequisite rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrereqRule {
    /// Windows: `wsl.exe` is missing or failed outright — installing WSL2 can fix it.
    WslNotAvailable,
    /// Windows: `wsl.exe` answered but reports WSL2 cannot start — installing again cannot fix it.
    WslCannotStart,
    /// Windows: `wsl.exe --status` ran but did not answer — WSL is wedged, not missing.
    WslUnresponsive,
}

impl fmt::Display for PrereqRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WslNotAvailable => f.write_str("WSL_NOT_AVAILABLE"),
            Self::WslCannotStart => f.write_str("WSL_CANNOT_START"),
            Self::WslUnresponsive => f.write_str("WSL_UNRESPONSIVE"),
        }
    }
}

/// A single OS prerequisite violation with actionable remediation.
#[derive(Debug, Clone)]
pub struct PrereqViolation {
    /// Which prerequisite rule was violated.
    pub rule: PrereqRule,
    /// Human-readable description of the violation.
    pub message: String,
    /// Actionable remediation steps.
    pub remediation: &'static str,
}

impl fmt::Display for PrereqViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}\n{}", self.message, self.remediation)
    }
}

/// Checks OS-level prerequisites for container isolation; empty Vec if all met. Windows verifies
/// WSL2 via `wsl.exe --status` (10s timeout), naming `VirtualMachinePlatform` when its Host
/// Compute Service is also absent; macOS has none (Lima runtime is bundled).
pub fn check_os_prereqs() -> Vec<PrereqViolation> {
    #[cfg(test)]
    {
        pinned_prereqs()
    }

    #[cfg(all(not(test), target_os = "windows"))]
    {
        check_wsl()
    }

    #[cfg(all(not(test), not(target_os = "windows")))]
    {
        Vec::new()
    }
}

#[cfg(test)]
thread_local! {
    static PINNED_PREREQS: std::cell::RefCell<Vec<PrereqViolation>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn pinned_prereqs() -> Vec<PrereqViolation> {
    PINNED_PREREQS.with(|p| p.borrow().clone())
}

/// RAII pin making `check_os_prereqs()` return `violations` on this thread until dropped.
/// Tests never probe the real host; without a pin the check reports no violations.
#[cfg(test)]
pub(crate) struct PinnedPrereqs;

#[cfg(test)]
impl PinnedPrereqs {
    pub(crate) fn pin(violations: Vec<PrereqViolation>) -> Self {
        PINNED_PREREQS.with(|p| *p.borrow_mut() = violations);
        Self
    }
}

#[cfg(test)]
impl Drop for PinnedPrereqs {
    fn drop(&mut self) {
        PINNED_PREREQS.with(|p| p.borrow_mut().clear());
    }
}

#[cfg(any(target_os = "windows", test))]
const VM_PLATFORM_BINARY: &str = "vmcompute.exe";

#[cfg(any(target_os = "windows", test))]
const WSL_STATUS_VIRTUALIZATION_LINK: &str = "aka.ms/enablevirtualization";

#[cfg(any(target_os = "windows", test))]
const REBOOT_PENDING_KEY: &str =
    r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending";

#[cfg(any(target_os = "windows", test))]
fn virtual_machine_platform_present_in(system32: &std::path::Path) -> bool {
    system32.join(VM_PLATFORM_BINARY).exists()
}

#[cfg(any(target_os = "windows", test))]
fn wsl_status_reports_failure(body: &str) -> bool {
    body.to_ascii_lowercase()
        .contains(WSL_STATUS_VIRTUALIZATION_LINK)
}

#[cfg(any(target_os = "windows", test))]
const PENDING_TRANSACTION_FILE: &str = "pending.xml";

/// Windows servicing-store state, which decides whether enabling a feature can work at all.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServicingState {
    /// Nothing outstanding — a feature install can proceed.
    Clean,
    /// A restart is queued; it will apply the staged change.
    RebootPending,
    /// A transaction never completed; restarting does not clear it and installs cannot land.
    TransactionStuck,
}

#[cfg(any(target_os = "windows", test))]
fn servicing_transaction_stuck_in(winsxs: &std::path::Path) -> bool {
    winsxs.join(PENDING_TRANSACTION_FILE).exists()
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_servicing_state() -> ServicingState {
    if servicing_transaction_stuck_in(&crate::binary::windows_dir().join("WinSxS")) {
        return ServicingState::TransactionStuck;
    }
    if windows_reboot_pending() {
        return ServicingState::RebootPending;
    }
    ServicingState::Clean
}

#[cfg(any(target_os = "windows", test))]
fn parse_reboot_pending(stdout: &str) -> bool {
    stdout.trim().eq_ignore_ascii_case("true")
}

#[cfg(target_os = "windows")]
fn windows_reboot_pending() -> bool {
    let command = format!("Test-Path '{REBOOT_PENDING_KEY}'");
    match crate::binary::run_powershell_capture(
        &["-NoProfile", "-Command", &command],
        std::time::Duration::from_secs(10),
    ) {
        Ok(o) if o.status.success() => parse_reboot_pending(&String::from_utf8_lossy(&o.stdout)),
        Ok(_) | Err(_) => false,
    }
}

#[cfg(any(target_os = "windows", test))]
fn classify_wsl_status(exit_code: i32, body: &str) -> Option<(PrereqRule, String)> {
    if wsl_status_reports_failure(body) {
        return Some((
            PrereqRule::WslCannotStart,
            format!(
                "wsl.exe --status reports that WSL2 cannot start on this machine:\n{}",
                body.trim()
            ),
        ));
    }
    if exit_code == 0 {
        return None;
    }
    Some((
        PrereqRule::WslNotAvailable,
        format!("wsl.exe --status exited with code {exit_code}"),
    ))
}

#[cfg(any(target_os = "windows", test))]
fn wsl_status_body(stdout: &[u8], stderr: &[u8]) -> String {
    crate::runtime::combine_outputs(
        &crate::runtime::decode_wsl_output(stdout),
        &crate::runtime::decode_wsl_output(stderr),
    )
}

#[cfg(any(target_os = "windows", test))]
fn wsl_blocker_note(system32: &std::path::Path, servicing: ServicingState) -> Option<String> {
    match servicing {
        ServicingState::TransactionStuck => Some(
            "A Windows servicing transaction never completed (WinSxS\\pending.xml), so enabling \
             features cannot take effect and restarting will not clear it. Run \
             'DISM /Online /Cleanup-Image /RestoreHealth' then 'sfc /scannow' from an \
             elevated prompt."
                .to_string(),
        ),
        ServicingState::RebootPending => Some(
            "A Windows restart is pending — restart the computer before changing any features."
                .to_string(),
        ),
        ServicingState::Clean => {
            if virtual_machine_platform_present_in(system32) {
                return None;
            }
            Some(format!(
                "The 'Virtual Machine Platform' Windows feature also looks disabled ({} is missing).",
                system32.join(VM_PLATFORM_BINARY).display()
            ))
        }
    }
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn check_wsl_with(
    system32: &std::path::Path,
    servicing: ServicingState,
    status: anyhow::Result<(i32, String)>,
) -> Vec<PrereqViolation> {
    let classified = match status {
        Ok((exit_code, body)) => classify_wsl_status(exit_code, &body),
        Err(e) if e.downcast_ref::<std::io::Error>().is_some() => Some((
            PrereqRule::WslNotAvailable,
            format!("WSL2 check failed: {e}"),
        )),
        Err(e) => Some((
            PrereqRule::WslUnresponsive,
            format!("wsl.exe --status did not answer: {e}"),
        )),
    };
    let Some((rule, message)) = classified else {
        return Vec::new();
    };
    let remediation = if rule == PrereqRule::WslUnresponsive {
        crate::consts::WSL_UNRESPONSIVE_MSG
    } else {
        crate::consts::WSL_NOT_AVAILABLE_MSG
    };
    let message = match wsl_blocker_note(system32, servicing) {
        Some(note) => format!("{message}\n{note}"),
        None => message,
    };
    vec![PrereqViolation {
        rule,
        message,
        remediation,
    }]
}

#[cfg(all(target_os = "windows", not(test)))]
fn check_wsl() -> Vec<PrereqViolation> {
    let status =
        crate::binary::run_wsl_bounded(&["--status"], None, std::time::Duration::from_secs(10))
            .map(|output| {
                (
                    output.status.code().unwrap_or(-1),
                    wsl_status_body(&output.stdout, &output.stderr),
                )
            });
    check_wsl_with(
        &crate::binary::system32_dir(),
        windows_servicing_state(),
        status,
    )
}

/// Returns non-blocking OS warnings (e.g. low memory, nested virtualization).
/// Separate from `check_os_prereqs()` which returns blocking errors.
pub fn check_os_warnings() -> Vec<String> {
    let mut warnings = Vec::new();

    warnings.extend(check_low_memory());

    #[cfg(target_os = "windows")]
    warnings.extend(check_nested_virt());

    #[cfg(target_os = "windows")]
    warnings.extend(check_wsl_mirrored_mode_supported());

    warnings
}

/// Warns when the Windows build is older than 22H2 (build 22621), where
/// `.wslconfig` `networkingMode=mirrored` is silently ignored.
#[cfg(target_os = "windows")]
fn check_wsl_mirrored_mode_supported() -> Vec<String> {
    let build = match windows_build_number() {
        Some(b) => b,
        None => return Vec::new(),
    };
    if build >= 22621 {
        Vec::new()
    } else {
        vec![format!(
            "Windows build {build} predates WSL2 mirrored networking \
             (Windows 11 22H2 / build 22621+). Services on a corporate \
             VPN may be unreachable from inside the Speedwave WSL distro. \
             Upgrade Windows to fix."
        )]
    }
}

#[cfg(target_os = "windows")]
fn windows_build_number() -> Option<u32> {
    let output = crate::binary::run_powershell_capture(
        &[
            "-NoProfile",
            "-Command",
            "[System.Environment]::OSVersion.Version.Build",
        ],
        std::time::Duration::from_secs(10),
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

fn check_low_memory() -> Vec<String> {
    check_low_memory_with(crate::resources::host_total_memory_gib())
}

fn check_low_memory_with(host_ram_gib: u32) -> Vec<String> {
    if host_ram_gib < crate::resources::MIN_SUPPORTED_HOST_GIB {
        vec![format!(
            "Low memory detected: {} GiB RAM. Speedwave requires at least {} GiB. \
             Performance may be severely degraded.",
            host_ram_gib,
            crate::resources::MIN_SUPPORTED_HOST_GIB
        )]
    } else {
        Vec::new()
    }
}

/// Parses JSON from `Get-CimInstance Win32_ComputerSystem` and extracts `Model`/`Manufacturer`.
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
/// Case-insensitive matching against VMware/VirtualBox/Hyper-V/QEMU markers.
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

    let args = [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystem | Select-Object -Property Model,Manufacturer | ConvertTo-Json)",
    ];

    let output = match binary::run_powershell_capture(&args, std::time::Duration::from_secs(10)) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        Ok(_) | Err(_) => return Vec::new(),
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
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;
    use crate::consts;

    #[test]
    fn test_prereq_rule_wsl_not_available_display() {
        assert_eq!(PrereqRule::WslNotAvailable.to_string(), "WSL_NOT_AVAILABLE");
        assert_eq!(PrereqRule::WslCannotStart.to_string(), "WSL_CANNOT_START");
        assert_eq!(PrereqRule::WslUnresponsive.to_string(), "WSL_UNRESPONSIVE");
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
    fn test_wsl_not_available_remediation_contains_dism() {
        assert!(
            consts::WSL_NOT_AVAILABLE_MSG.contains("dism.exe"),
            "WSL_NOT_AVAILABLE_MSG should contain dism.exe remediation"
        );
    }

    const WSL_STATUS_HEALTHY: &str = "Default Distribution: speedwave\nDefault Version: 2\n";

    const WSL_STATUS_VMP_OFF_PL: &str = "Wersja domyślna: 2\n\
         Podsystem WSL1 nie jest obsługiwany w bieżącej konfiguracji komputera.\n\
         Włącz opcjonalny składnik „Podsystem Windows dla systemu Linux”, \
         aby używać podsystemu WSL1.\n\
         Nie można uruchomić protokołu WSL2, ponieważ wirtualizacja nie jest \
         włączona na tej maszynie.\n\
         Upewnij się, że składnik opcjonalny \"Platforma maszyny wirtualnej\" jest \
         włączony i że wirtualizacja jest włączona w ustawieniach oprogramowania \
         układowego komputera.\n\n\
         Włącz platformę maszyny wirtualnej, uruchamiając polecenie: \
         wsl.exe --install --no-distribution\n\n\
         Aby uzyskać informacje, odwiedź https://aka.ms/enablevirtualization\n";

    const WSL_STATUS_VMP_OFF_EN: &str = "Default Version: 2\n\
         WSL2 is not supported with your current machine configuration.\n\
         Please enable the \"Virtual Machine Platform\" optional component and ensure \
         virtualization is enabled in the BIOS.\n\n\
         Enable the Virtual Machine Platform by running: \
         wsl.exe --install --no-distribution\n\n\
         For information please visit https://aka.ms/enablevirtualization\n";

    fn system32_with_vm_platform() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(VM_PLATFORM_BINARY), b"").unwrap();
        dir
    }

    #[test]
    fn wsl_status_healthy_exit_zero_is_not_a_violation() {
        assert_eq!(classify_wsl_status(0, WSL_STATUS_HEALTHY), None);
    }

    #[test]
    fn wsl_status_healthy_body_mentioning_an_unrelated_aka_ms_link_is_not_a_violation() {
        let body = format!("{WSL_STATUS_HEALTHY}Update available: https://aka.ms/wslstorepage\n");
        assert_eq!(
            classify_wsl_status(0, &body),
            None,
            "only the virtualization aka.ms link marks a failure, not any aka.ms link"
        );
    }

    #[test]
    fn wsl_status_exit_zero_with_polish_failure_body_is_a_violation() {
        let message = classify_wsl_status(0, WSL_STATUS_VMP_OFF_PL)
            .expect("exit 0 with a failure body must still be a violation")
            .1;
        assert!(
            message.contains("cannot start"),
            "message must state WSL2 cannot start: {message}"
        );
        assert!(
            message.contains("wirtualizacja nie jest"),
            "message must carry the localized diagnostic verbatim: {message}"
        );
    }

    #[test]
    fn wsl_status_exit_zero_with_english_failure_body_is_a_violation() {
        assert!(
            classify_wsl_status(0, WSL_STATUS_VMP_OFF_EN).is_some(),
            "the en-US wording of the same failure must be detected too"
        );
    }

    #[test]
    fn wsl_status_failure_markers_are_lowercase() {
        assert_eq!(
            WSL_STATUS_VIRTUALIZATION_LINK,
            WSL_STATUS_VIRTUALIZATION_LINK.to_ascii_lowercase(),
            "the marker is matched against a lowercased body, so an uppercase \
             marker could never fire"
        );
    }

    #[test]
    fn wsl_status_enable_command_alone_is_not_a_violation() {
        let body = format!(
            "{WSL_STATUS_HEALTHY}Install a distribution: wsl.exe --install --no-distribution\n"
        );
        assert!(
            !wsl_status_reports_failure(&body),
            "the bare flag string must never decide, or a healthy host that merely \
             mentions it is blocked: {body}"
        );
    }

    #[test]
    fn wsl_status_virtualization_link_alone_is_a_violation() {
        let body = format!("{WSL_STATUS_HEALTHY}See https://aka.ms/enablevirtualization\n");
        assert!(
            wsl_status_reports_failure(&body),
            "older wsl.exe builds print the link without the --no-distribution hint, \
             so the link alone must be sufficient"
        );
    }

    #[test]
    fn wsl_status_failure_detection_is_case_insensitive() {
        let body = WSL_STATUS_VMP_OFF_EN.to_ascii_uppercase();
        assert!(
            wsl_status_reports_failure(&body),
            "wsl.exe casing must not decide the verdict"
        );
    }

    #[test]
    fn wsl_status_utf16le_failure_body_survives_decoding() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in WSL_STATUS_VMP_OFF_PL.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded = crate::runtime::decode_wsl_output(&bytes);
        assert!(
            classify_wsl_status(0, &decoded).is_some(),
            "UTF-16LE wsl.exe output must classify identically to UTF-8: {decoded}"
        );
    }

    #[test]
    fn wsl_status_nonzero_exit_is_a_violation() {
        let message = classify_wsl_status(1, "")
            .expect("a non-zero exit means WSL is not installed at all")
            .1;
        assert!(
            message.contains('1'),
            "message must name the exit code: {message}"
        );
    }

    #[test]
    fn wsl_status_negative_exit_is_a_violation() {
        let message = classify_wsl_status(-1, "")
            .expect("wsl.exe reports -1 for several hard failures")
            .1;
        assert!(
            message.contains("-1"),
            "message must name the exit code: {message}"
        );
    }

    #[test]
    fn wsl_status_empty_body_exit_zero_is_not_a_violation() {
        assert_eq!(classify_wsl_status(0, ""), None);
    }

    #[test]
    fn virtual_machine_platform_absent_when_vmcompute_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!virtual_machine_platform_present_in(dir.path()));
    }

    #[test]
    fn virtual_machine_platform_present_when_vmcompute_exists() {
        let dir = system32_with_vm_platform();
        assert!(virtual_machine_platform_present_in(dir.path()));
    }

    #[test]
    fn wsl_status_body_keeps_stderr_content() {
        let body = wsl_status_body(b"out-line", b"err-line");
        assert!(
            body.contains("out-line") && body.contains("err-line"),
            "wsl.exe writes the diagnostic to either stream; both must be classified: {body}"
        );
    }

    #[test]
    fn wsl_status_body_decodes_utf16le_streams() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "Wersja domyślna: 2".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(wsl_status_body(&bytes, b"").contains("Wersja domyślna"));
    }

    #[test]
    fn check_wsl_with_healthy_status_is_not_a_violation_even_without_vmcompute() {
        let dir = tempfile::tempdir().unwrap();
        let violations = check_wsl_with(
            dir.path(),
            ServicingState::Clean,
            Ok((0, WSL_STATUS_HEALTHY.to_string())),
        );
        assert!(
            violations.is_empty(),
            "a missing vmcompute.exe must never block a host whose wsl.exe reports healthy, \
             got: {}",
            violations
                .first()
                .map(|v| v.message.clone())
                .unwrap_or_default()
        );
    }

    #[test]
    fn check_wsl_with_failure_body_reports_one_violation_with_remediation() {
        let dir = system32_with_vm_platform();
        let violations = check_wsl_with(
            dir.path(),
            ServicingState::Clean,
            Ok((0, WSL_STATUS_VMP_OFF_PL.to_string())),
        );
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].rule, PrereqRule::WslCannotStart);
        assert_eq!(violations[0].remediation, consts::WSL_NOT_AVAILABLE_MSG);
        assert!(
            !violations[0].message.contains("also looks disabled"),
            "no vmcompute note belongs on a host where the binary is present"
        );
    }

    #[test]
    fn check_wsl_with_appends_the_vmcompute_note_to_an_existing_violation() {
        let dir = tempfile::tempdir().unwrap();
        let violations = check_wsl_with(
            dir.path(),
            ServicingState::Clean,
            Ok((0, WSL_STATUS_VMP_OFF_PL.to_string())),
        );
        assert_eq!(violations.len(), 1);
        assert!(
            violations[0].message.contains(VM_PLATFORM_BINARY)
                && violations[0].message.contains("wirtualizacja nie jest"),
            "the note enriches the wsl.exe diagnostic rather than replacing it: {}",
            violations[0].message
        );
    }

    #[test]
    fn reboot_pending_note_replaces_the_vmcompute_note() {
        let dir = tempfile::tempdir().unwrap();
        let violations = check_wsl_with(
            dir.path(),
            ServicingState::RebootPending,
            Ok((0, WSL_STATUS_VMP_OFF_PL.to_string())),
        );
        assert_eq!(violations.len(), 1);
        assert!(
            violations[0].message.contains("restart is pending")
                && !violations[0].message.contains(VM_PLATFORM_BINARY),
            "a staged-but-unbooted host must be told to restart, not to re-run dism: {}",
            violations[0].message
        );
    }

    #[test]
    fn reboot_pending_alone_is_not_a_violation() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            check_wsl_with(
                dir.path(),
                ServicingState::RebootPending,
                Ok((0, WSL_STATUS_HEALTHY.to_string()))
            )
            .is_empty(),
            "a pending restart must never block a host whose wsl.exe reports healthy"
        );
    }

    #[test]
    fn reboot_pending_parses_only_an_exact_true() {
        assert!(parse_reboot_pending("True"));
        assert!(parse_reboot_pending("True\r\n"));
        assert!(parse_reboot_pending("  true  "));
        assert!(!parse_reboot_pending("False"));
        assert!(!parse_reboot_pending(""));
        assert!(!parse_reboot_pending("Test-Path : Access is denied"));
        assert!(!parse_reboot_pending("truthy"));
    }

    #[test]
    fn reboot_pending_key_is_the_component_based_servicing_flag() {
        assert!(
            REBOOT_PENDING_KEY.starts_with(r"HKLM:\SOFTWARE\Microsoft\Windows"),
            "the pending-reboot probe must read a machine-wide servicing flag"
        );
    }

    #[test]
    fn a_failing_status_body_and_a_bad_exit_code_get_different_rules() {
        let cannot_start = classify_wsl_status(0, WSL_STATUS_VMP_OFF_PL)
            .expect("a failure body is a violation")
            .0;
        let not_available = classify_wsl_status(1, "")
            .expect("a non-zero exit is a violation")
            .0;
        assert_eq!(cannot_start, PrereqRule::WslCannotStart);
        assert_eq!(not_available, PrereqRule::WslNotAvailable);
        assert_ne!(
            cannot_start, not_available,
            "provision decides install-vs-report on this rule, so the two states \
             must never collapse into one"
        );
    }

    #[test]
    fn servicing_transaction_is_stuck_only_when_pending_xml_exists() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!servicing_transaction_stuck_in(dir.path()));
        std::fs::write(dir.path().join(PENDING_TRANSACTION_FILE), b"<x/>").unwrap();
        assert!(servicing_transaction_stuck_in(dir.path()));
    }

    #[test]
    fn a_stuck_transaction_note_says_a_restart_will_not_help() {
        let dir = system32_with_vm_platform();
        let violations = check_wsl_with(
            dir.path(),
            ServicingState::TransactionStuck,
            Ok((0, WSL_STATUS_VMP_OFF_PL.to_string())),
        );
        assert_eq!(violations.len(), 1);
        let message = &violations[0].message;
        assert!(
            message.contains("pending.xml") && message.contains("RestoreHealth"),
            "a stuck store needs a repair command, not a reboot: {message}"
        );
        assert!(
            !message.contains("A Windows restart is pending"),
            "telling the user to restart sends them in a circle here: {message}"
        );
    }

    #[test]
    fn a_stuck_transaction_outranks_the_vmcompute_note() {
        let dir = tempfile::tempdir().unwrap();
        let note = wsl_blocker_note(dir.path(), ServicingState::TransactionStuck)
            .expect("a stuck store always carries a note");
        assert!(
            !note.contains(VM_PLATFORM_BINARY),
            "a missing vmcompute.exe is a symptom of the stuck store, not the action: {note}"
        );
    }

    #[test]
    fn check_wsl_with_spawn_error_reports_wsl_as_unavailable() {
        let dir = system32_with_vm_platform();
        let violations = check_wsl_with(
            dir.path(),
            ServicingState::Clean,
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "boom").into()),
        );
        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].rule,
            PrereqRule::WslNotAvailable,
            "a spawn failure means wsl.exe is missing, which the installer can fix"
        );
    }

    #[test]
    fn check_wsl_with_a_status_that_does_not_answer_reports_wsl_as_unresponsive() {
        let dir = system32_with_vm_platform();
        let violations = check_wsl_with(
            dir.path(),
            ServicingState::Clean,
            Err(anyhow::anyhow!("child process timed out after 10s")),
        );
        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].rule,
            PrereqRule::WslUnresponsive,
            "a wsl.exe that ran and never answered is wedged, which installing cannot fix"
        );
        assert!(
            violations[0].message.contains("timed out"),
            "{}",
            violations[0].message
        );
        assert_eq!(
            violations[0].remediation,
            crate::consts::WSL_UNRESPONSIVE_MSG
        );
    }

    #[test]
    fn check_wsl_with_spawn_error_is_a_violation() {
        let dir = system32_with_vm_platform();
        let violations = check_wsl_with(
            dir.path(),
            ServicingState::Clean,
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "program not found").into()),
        );
        assert_eq!(violations.len(), 1);
        assert!(
            violations[0].message.contains("program not found"),
            "a spawn failure must surface its cause: {}",
            violations[0].message
        );
    }

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
    fn test_check_os_warnings_returns_empty_on_macos_with_sufficient_ram() {
        #[cfg(not(target_os = "windows"))]
        {
            let host_ram = crate::resources::host_total_memory_gib();
            if host_ram >= crate::resources::MIN_SUPPORTED_HOST_GIB {
                let warnings = check_os_warnings();
                assert!(
                    warnings.is_empty(),
                    "check_os_warnings() should return empty on non-Windows at/above the minimum host, \
                     got: {:?}",
                    warnings
                );
            }
        }
    }

    #[test]
    fn low_memory_warning_below_minimum() {
        let w = check_low_memory_with(8);
        assert_eq!(w.len(), 1);
        assert!(
            w[0].contains("8 GiB"),
            "warning must mention host RAM: {}",
            w[0]
        );
        assert!(
            w[0].contains("16 GiB"),
            "warning must mention the 16 GiB threshold: {}",
            w[0]
        );
    }

    #[test]
    fn low_memory_no_warning_at_minimum() {
        assert!(check_low_memory_with(crate::resources::MIN_SUPPORTED_HOST_GIB).is_empty());
    }

    #[test]
    fn low_memory_no_warning_above_minimum() {
        assert!(check_low_memory_with(32).is_empty());
    }

    #[test]
    fn low_memory_warning_just_below_minimum() {
        let w = check_low_memory_with(crate::resources::MIN_SUPPORTED_HOST_GIB - 1);
        assert_eq!(w.len(), 1);
        assert!(
            w[0].contains("15 GiB"),
            "warning must mention host RAM: {}",
            w[0]
        );
    }

    #[test]
    fn low_memory_warning_at_zero() {
        let w = check_low_memory_with(0);
        assert_eq!(w.len(), 1);
    }
}

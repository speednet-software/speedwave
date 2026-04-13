/// Host resource detection and adaptive container memory scaling.
///
/// SSOT for all resource allocation decisions. Both CLI (`speedwave-cli`) and
/// Desktop (`desktop/src-tauri`) import these functions — no duplication.
use std::process::ExitStatus;

/// VM overhead: kernel + containerd + MCP hub + MCP workers ≈ 4 GiB.
pub const VM_OVERHEAD_GIB: u32 = 4;

/// Host overhead on Linux (no VM layer): OS + desktop + browser + apps ≈ 6 GiB.
pub const HOST_OVERHEAD_GIB: u32 = 6;

// ---------------------------------------------------------------------------
// Host RAM detection
// ---------------------------------------------------------------------------

/// Converts raw bytes to GiB using floor division.
///
/// Floor is intentionally safer than rounding: a 16 GB MacBook with ~15.7 GiB
/// usable RAM returns 15, which the adaptive formula (`host/2`) then maps to
/// 7 GiB VM — avoiding an unexpected jump to 8 GiB.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn bytes_to_gib(bytes: u64) -> u32 {
    (bytes / (1024 * 1024 * 1024)) as u32
}

/// Returns total physical RAM in GiB (floor).
///
/// Falls back to 16 on detection failure — produces 8 GiB VM via the
/// adaptive formula (`host/2`).
pub fn host_total_memory_gib() -> u32 {
    host_total_memory_gib_impl().unwrap_or(16)
}

#[cfg(target_os = "macos")]
fn host_total_memory_gib_impl() -> Option<u32> {
    // Shell out to sysctl(1) to avoid `unsafe` blocks (forbidden by project lints).
    let output = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout);
    let bytes: u64 = s.trim().parse().ok()?;
    if bytes > 0 {
        Some(bytes_to_gib(bytes))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn host_total_memory_gib_impl() -> Option<u32> {
    let content = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb_str = rest.trim().strip_suffix("kB")?.trim();
            let kb: u64 = kb_str.parse().ok()?;
            return Some(bytes_to_gib(kb * 1024));
        }
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn host_total_memory_gib_impl() -> Option<u32> {
    // Windows: RAM detection not implemented — falls back to 16 GiB,
    // which the adaptive formula maps to 8 GiB VM / 4 g Claude container.
    None
}

// ---------------------------------------------------------------------------
// Scaling formulas (pure functions — testable on any platform)
// ---------------------------------------------------------------------------

/// Desired Lima VM memory in GiB based on host RAM.
///
/// Half of host RAM, clamped 4–32. Never takes more than 50% of host RAM.
/// Floor 4 GiB ensures 8 GiB hosts can run Speedwave; cap 32 GiB preserves
/// existing behaviour on large machines (64+ GiB).
pub fn desired_vm_memory_gib(host_ram_gib: u32) -> u32 {
    (host_ram_gib / 2).clamp(4, 32)
}

/// Desired Claude container memory in GiB.
///
/// `available_gib` is the VM memory on macOS or host RAM on Linux.
/// `overhead_gib` reserves space for kernel/containerd/hub/workers (macOS)
/// or OS/desktop/browser (Linux).
pub fn desired_claude_memory_gib(available_gib: u32, overhead_gib: u32) -> u32 {
    available_gib.saturating_sub(overhead_gib).clamp(4, 28)
}

/// SSOT: effective Claude container memory in GiB for the current platform.
///
/// - macOS: VM memory minus VM overhead (kernel, containerd, hub, workers).
/// - Linux: host RAM minus host overhead (OS, desktop, browser, apps).
/// - Windows: same formula as Linux; falls back to 10 g when RAM detection fails
///   (`host_total_memory_gib()` returns 16 on failure → 16 − 6 = 10).
pub fn effective_claude_memory_gib() -> u32 {
    #[cfg(target_os = "macos")]
    {
        let vm_mem = desired_vm_memory_gib(host_total_memory_gib());
        desired_claude_memory_gib(vm_mem, VM_OVERHEAD_GIB)
    }
    #[cfg(target_os = "linux")]
    {
        desired_claude_memory_gib(host_total_memory_gib(), HOST_OVERHEAD_GIB)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        desired_claude_memory_gib(host_total_memory_gib(), HOST_OVERHEAD_GIB)
    }
}

// ---------------------------------------------------------------------------
// OOM detection
// ---------------------------------------------------------------------------

/// Returns `true` if the exit status likely indicates an OOM kill.
///
/// Process chain: `Rust Command → limactl → SSH → nerdctl exec → Claude`.
/// When the OOM killer sends SIGKILL to Claude inside the container, nerdctl
/// translates it to exit code 137 (128 + 9, shell convention) and limactl
/// propagates that code.  Therefore `ExitStatus::code()` returns `Some(137)`.
///
/// On Linux with `NerdctlRuntime` (no SSH layer) the host process could
/// receive a raw signal instead, so we also check `signal() == Some(9)`.
///
/// Known false-positives: signal 9 can also be sent by `kill -9`, OS
/// shutdown, or security sandbox enforcement.  The "likely" wording in
/// [`OOM_MESSAGE`] accounts for this.
pub fn is_oom_exit(status: &ExitStatus) -> bool {
    if status.code() == Some(137) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if status.signal() == Some(9) {
            return true;
        }
    }
    false
}

/// User-facing OOM message shared between CLI and Desktop (DRY).
pub const OOM_MESSAGE: &str = "\
    The Claude session was likely killed due to insufficient memory \
    (exit code 137 / SIGKILL).\n\n\
    Suggestions:\n  \
    - Close memory-intensive applications and retry\n  \
    - Start a shorter conversation to reduce context size\n  \
    - On macOS: check Activity Monitor for Lima VM memory pressure\n\n\
    If this persists, please report at \
    https://github.com/speednet-software/speedwave/issues";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    // -- bytes_to_gib (floor) -----------------------------------------------

    #[test]
    fn bytes_to_gib_zero() {
        assert_eq!(bytes_to_gib(0), 0);
    }

    #[test]
    fn bytes_to_gib_just_below_16() {
        // 15.7 GiB → floor → 15
        let bytes = (15.7 * GIB as f64) as u64;
        assert_eq!(bytes_to_gib(bytes), 15);
    }

    #[test]
    fn bytes_to_gib_exact_16() {
        assert_eq!(bytes_to_gib(16 * GIB), 16);
    }

    #[test]
    fn bytes_to_gib_128() {
        assert_eq!(bytes_to_gib(128 * GIB), 128);
    }

    // -- desired_vm_memory_gib ----------------------------------------------

    #[test]
    fn vm_memory_small_hosts() {
        // floor at 4 GiB — (host/2).clamp(4, 32)
        assert_eq!(desired_vm_memory_gib(8), 4);
        assert_eq!(desired_vm_memory_gib(6), 4); // floor
        assert_eq!(desired_vm_memory_gib(0), 4); // floor
    }

    #[test]
    fn vm_memory_medium_hosts() {
        assert_eq!(desired_vm_memory_gib(16), 8);
        assert_eq!(desired_vm_memory_gib(24), 12);
    }

    #[test]
    fn vm_memory_large_hosts() {
        assert_eq!(desired_vm_memory_gib(32), 16);
        assert_eq!(desired_vm_memory_gib(48), 24);
        assert_eq!(desired_vm_memory_gib(64), 32); // cap
        assert_eq!(desired_vm_memory_gib(128), 32); // cap
    }

    // -- desired_claude_memory_gib ------------------------------------------

    #[test]
    fn claude_memory_with_vm_overhead() {
        assert_eq!(desired_claude_memory_gib(12, VM_OVERHEAD_GIB), 8);
        assert_eq!(desired_claude_memory_gib(16, VM_OVERHEAD_GIB), 12);
        assert_eq!(desired_claude_memory_gib(32, VM_OVERHEAD_GIB), 28);
    }

    #[test]
    fn claude_memory_with_host_overhead() {
        assert_eq!(desired_claude_memory_gib(16, HOST_OVERHEAD_GIB), 10);
        assert_eq!(desired_claude_memory_gib(12, HOST_OVERHEAD_GIB), 6);
        assert_eq!(desired_claude_memory_gib(32, HOST_OVERHEAD_GIB), 26);
    }

    #[test]
    fn claude_memory_floor_at_4() {
        // Floor is 4 GiB — minimum usable for Claude Code workloads in practice
        assert_eq!(desired_claude_memory_gib(6, 4), 4); // was 6 before this change
        assert_eq!(desired_claude_memory_gib(4, 6), 4); // was 6 before this change
        assert_eq!(desired_claude_memory_gib(0, 4), 4); // was 6 before this change
    }

    #[test]
    fn claude_memory_cap_at_28() {
        assert_eq!(desired_claude_memory_gib(64, 4), 28);
    }

    // -- composition (macOS-like: VM overhead = 4) --------------------------

    #[test]
    fn composition_macos_8gib_host() {
        let vm = desired_vm_memory_gib(8);
        assert_eq!(vm, 4);
        assert_eq!(desired_claude_memory_gib(vm, VM_OVERHEAD_GIB), 4); // floor
    }

    #[test]
    fn composition_macos_16gib_host() {
        let vm = desired_vm_memory_gib(16);
        assert_eq!(vm, 8);
        assert_eq!(desired_claude_memory_gib(vm, VM_OVERHEAD_GIB), 4);
    }

    #[test]
    fn composition_macos_32gib_host() {
        let vm = desired_vm_memory_gib(32);
        assert_eq!(vm, 16);
        assert_eq!(desired_claude_memory_gib(vm, VM_OVERHEAD_GIB), 12);
    }

    #[test]
    fn composition_macos_64gib_host() {
        let vm = desired_vm_memory_gib(64);
        assert_eq!(vm, 32); // cap
        assert_eq!(desired_claude_memory_gib(vm, VM_OVERHEAD_GIB), 28);
    }

    // -- composition (Linux-like: host overhead = 6) ------------------------

    #[test]
    fn composition_linux_16gib_host() {
        assert_eq!(desired_claude_memory_gib(16, HOST_OVERHEAD_GIB), 10);
    }

    #[test]
    fn composition_linux_32gib_host() {
        assert_eq!(desired_claude_memory_gib(32, HOST_OVERHEAD_GIB), 26);
    }

    // -- overhead constants -------------------------------------------------

    #[test]
    fn overhead_constants() {
        assert_eq!(VM_OVERHEAD_GIB, 4);
        assert_eq!(HOST_OVERHEAD_GIB, 6);
    }

    // -- host_total_memory_gib (integration) --------------------------------

    #[test]
    fn host_total_memory_is_sane() {
        let gib = host_total_memory_gib();
        assert!(gib > 0, "host RAM must be > 0 GiB, got {gib}");
        assert!(gib < 4096, "host RAM must be < 4096 GiB, got {gib}");
    }

    // -- effective_claude_memory_gib ----------------------------------------

    #[test]
    fn effective_claude_memory_at_least_4() {
        assert!(effective_claude_memory_gib() >= 4);
    }

    // -- format_oom_message -------------------------------------------------

    #[test]
    fn oom_message_contains_key_info() {
        assert!(OOM_MESSAGE.contains("137"), "must mention exit code 137");
        assert!(
            OOM_MESSAGE.contains("likely") || OOM_MESSAGE.contains("probably"),
            "must use non-definitive wording"
        );
        assert!(OOM_MESSAGE.contains("memory"), "must mention memory");
    }

    // -- is_oom_exit --------------------------------------------------------

    #[test]
    fn is_oom_exit_code_137() {
        // Spawn a process that exits with code 137.
        let status = std::process::Command::new("sh")
            .args(["-c", "exit 137"])
            .status()
            .unwrap();
        assert!(is_oom_exit(&status));
    }

    #[test]
    fn is_oom_exit_code_0() {
        let status = std::process::Command::new("true").status().unwrap();
        assert!(!is_oom_exit(&status));
    }

    #[test]
    fn is_oom_exit_code_1() {
        let status = std::process::Command::new("false").status().unwrap();
        assert!(!is_oom_exit(&status));
    }

    #[cfg(unix)]
    #[test]
    fn is_oom_exit_signal_9() {
        use std::os::unix::process::ExitStatusExt;
        // Raw wait status for signal 9: signal in low 7 bits, no core dump.
        let status = ExitStatus::from_raw(9);
        assert!(is_oom_exit(&status));
    }

    #[cfg(unix)]
    #[test]
    fn is_oom_exit_signal_other() {
        use std::os::unix::process::ExitStatusExt;
        // SIGTERM (15) should NOT be detected as OOM.
        let status = ExitStatus::from_raw(15);
        assert!(!is_oom_exit(&status));
    }
}

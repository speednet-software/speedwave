//! SSOT for every memory/CPU/tmpfs/shm number Speedwave itself ships: the
//! Claude + hub container limits here, per-worker limits on
//! [`consts::McpServiceDescriptor`], plugin defaults/caps in `consts`. The
//! compose renderer reads these instead of YAML literals; a drift test enforces
//! `compose.template.yml == this table`. Per-plugin actual limits (signed
//! external manifest) and the WSL2 VM (user-owned) stay outside by design.
use std::process::ExitStatus;

/// Fixed Claude container memory ceiling in GiB. See ADR-068.
pub const CLAUDE_MEMORY_GIB: u32 = 6;

/// Resource limits for one container. Sizes in MiB, except `cpus` (fractional
/// cores); `shm_mib` is `None` unless above the 64 MiB default.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContainerResources {
    /// Hard memory cap, MiB.
    pub mem_mib: u32,
    /// CPU cap in fractional cores.
    pub cpus: f32,
    /// tmpfs `/tmp` size, MiB.
    pub tmpfs_mib: u32,
    /// Shared-memory size, MiB; `None` keeps the 64 MiB default.
    pub shm_mib: Option<u32>,
}

/// Claude container: 6 GiB cap, 2 cores, 512 MiB /tmp.
pub const CLAUDE_RESOURCES: ContainerResources = ContainerResources {
    mem_mib: CLAUDE_MEMORY_GIB * 1024,
    cpus: 2.0,
    tmpfs_mib: 512,
    shm_mib: None,
};

/// MCP hub: on every MCP request's path, does real CPU work (sandboxed exec,
/// PII regex, aggregation) → 1 full core. On a minimum-spec 4-vCPU VM,
/// claude+playwright already claim all 4 (limits are ceilings — overcommit OK).
pub const HUB_RESOURCES: ContainerResources = ContainerResources {
    mem_mib: 512,
    cpus: 1.0,
    tmpfs_mib: 64,
    shm_mib: None,
};

/// LiteLLM proxy (ADR-073): 512 MiB, 1 core, 64 MiB /tmp.
pub const LITELLM_RESOURCES: ContainerResources = ContainerResources {
    mem_mib: 512,
    cpus: 1.0,
    tmpfs_mib: 64,
    shm_mib: None,
};

/// Default envelope for a lightweight API worker (slack, sharepoint, redmine,
/// gitlab, atlassian, context7). Workers needing more override inline (github
/// 256m, office, playwright). Shared so the default lives in one place.
pub const STANDARD_WORKER_RESOURCES: ContainerResources = ContainerResources {
    mem_mib: 128,
    cpus: 0.5,
    tmpfs_mib: 64,
    shm_mib: None,
};

// ---------------------------------------------------------------------------
// Host RAM detection
// ---------------------------------------------------------------------------

/// Converts raw bytes to GiB using floor division (never over-reports host RAM).
#[cfg(any(target_os = "macos", test))]
fn bytes_to_gib(bytes: u64) -> u32 {
    (bytes / (1024 * 1024 * 1024)) as u32
}

/// Returns total physical RAM in GiB (floor); falls back to 16 on detection
/// failure.
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

#[cfg(target_os = "windows")]
fn host_total_memory_gib_impl() -> Option<u32> {
    // Windows: RAM detection not implemented — falls back to 16 GiB.
    None
}

// ---------------------------------------------------------------------------
// Scaling formulas (pure functions — testable on any platform)
// ---------------------------------------------------------------------------

/// Minimum supported host RAM; SSOT for the `check_low_memory` warn threshold
/// and the always-on fit test. See ADR-068.
pub const MIN_SUPPORTED_HOST_GIB: u32 = 16;

/// Desired Lima VM memory in GiB based on host RAM: half of host, clamped 8–32.
pub fn desired_vm_memory_gib(host_ram_gib: u32) -> u32 {
    (host_ram_gib / 2).clamp(8, 32)
}

/// Host logical CPU count, or 8 on detection failure (→ 4 vCPU via `host/2`).
/// Uses `available_parallelism` (cross-platform, no `unsafe`) — same primitive
/// the build pool uses.
pub fn host_logical_cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(8)
}

/// Desired VM vCPU count: half of host cores, clamped 4–8. Floor 4 keeps small
/// hosts at today's value. macOS/Lima only; WSL2 is user-owned — see ADR-068.
pub fn desired_vm_cpus(host_cores: u32) -> u32 {
    (host_cores / 2).clamp(4, 8)
}

/// Memory the always-on containers (Claude + hub) request: hard limit +
/// RAM-backed tmpfs. Excludes toggleable workers and plugins. See ADR-068.
#[cfg(test)]
fn always_on_memory_mib() -> u32 {
    let one = |r: &ContainerResources| r.mem_mib + r.tmpfs_mib + r.shm_mib.unwrap_or(0);
    one(&CLAUDE_RESOURCES) + one(&HUB_RESOURCES)
}

// ---------------------------------------------------------------------------
// OOM detection
// ---------------------------------------------------------------------------

/// Returns `true` if the exit status likely indicates an OOM kill: code 137 or
/// signal 9. Heuristic only (also from host-side `kill -9`); see ADR-068.
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

/// User-facing message for exit 137 / SIGKILL, shared between CLI and Desktop.
pub const OOM_MESSAGE: &str = "\
    The Claude session was killed (exit code 137 / SIGKILL).\n\n\
    The most common cause is the container running out of memory, but a \
    host-side process restart can also produce this code.\n\n\
    Suggestions:\n  \
    - Close memory-intensive applications and retry\n  \
    - Start a shorter conversation to reduce context size\n  \
    - On macOS: check Activity Monitor for Lima VM memory pressure\n  \
    - Check the Desktop log for a 'killing a LIVE worker' line just before the \
    crash — that points to a worker restart, not memory\n\n\
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
        // Floor at 8 GiB — (host/2).clamp(8, 32).
        assert_eq!(desired_vm_memory_gib(16), 8);
        assert_eq!(desired_vm_memory_gib(8), 8); // floor
        assert_eq!(desired_vm_memory_gib(6), 8); // floor
        assert_eq!(desired_vm_memory_gib(0), 8); // floor
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

    // -- desired_vm_cpus ----------------------------------------------------

    #[test]
    fn vm_cpus_small_hosts_floor_at_4() {
        // Small hosts keep today's value — no regression, never below 4.
        assert_eq!(desired_vm_cpus(4), 4); // floor (4/2=2→4)
        assert_eq!(desired_vm_cpus(8), 4);
        assert_eq!(desired_vm_cpus(2), 4); // floor
        assert_eq!(desired_vm_cpus(0), 4); // floor
    }

    #[test]
    fn vm_cpus_scales_with_host() {
        assert_eq!(desired_vm_cpus(10), 5);
        assert_eq!(desired_vm_cpus(12), 6);
        assert_eq!(desired_vm_cpus(16), 8); // cap
    }

    #[test]
    fn vm_cpus_caps_at_8() {
        assert_eq!(desired_vm_cpus(24), 8); // cap
        assert_eq!(desired_vm_cpus(64), 8); // cap
    }

    #[test]
    fn vm_cpus_never_exceeds_host() {
        // host/2 ≤ host always, so VZ never gets more vCPUs than host cores.
        for cores in [4u32, 6, 8, 12, 16, 32] {
            assert!(desired_vm_cpus(cores) <= cores);
        }
    }

    // -- claude memory (fixed cap) ------------------------------------------

    #[test]
    fn claude_memory_is_fixed_6_everywhere() {
        // Independent of host size — the whole point of the fixed cap.
        assert_eq!(CLAUDE_MEMORY_GIB, 6);
        assert_eq!(CLAUDE_RESOURCES.mem_mib, 6 * 1024);
    }

    #[test]
    fn builtin_resources_stay_within_plugin_caps() {
        // Built-in worker limits must stay within the plugin envelope.
        let cap_mib = crate::consts::PLUGIN_MEM_LIMIT_MAX_MIB as u32;
        for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
            assert!(
                svc.resources.mem_mib <= cap_mib,
                "{}: mem {} MiB exceeds plugin cap {cap_mib}",
                svc.config_key,
                svc.resources.mem_mib
            );
            assert!(
                svc.resources.cpus <= crate::consts::PLUGIN_CPU_LIMIT_MAX,
                "{}: cpus {} exceeds plugin cap",
                svc.config_key,
                svc.resources.cpus
            );
            // tmpfs is RAM-backed, so it must not exceed the worker's mem limit.
            assert!(
                svc.resources.tmpfs_mib <= svc.resources.mem_mib,
                "{}: tmpfs {} MiB exceeds the worker's own mem limit {} MiB",
                svc.config_key,
                svc.resources.tmpfs_mib,
                svc.resources.mem_mib
            );
        }
    }

    #[test]
    fn all_resources_are_positive() {
        // A zeroed mem/cpus/tmpfs renders invalid compose and fails at create.
        let check = |r: &ContainerResources, who: &str| {
            assert!(r.mem_mib > 0, "{who}: mem_mib must be > 0");
            // NaN slips past a bare `> 0.0` yet renders "NaN" into YAML.
            assert!(
                r.cpus.is_finite() && r.cpus > 0.0,
                "{who}: cpus must be finite and > 0"
            );
            assert!(r.tmpfs_mib > 0, "{who}: tmpfs_mib must be > 0");
            if let Some(shm) = r.shm_mib {
                assert!(shm > 0, "{who}: shm_mib, when set, must be > 0");
            }
        };
        check(&CLAUDE_RESOURCES, "claude");
        check(&HUB_RESOURCES, "hub");
        for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
            check(&svc.resources, svc.config_key);
        }
    }

    // -- always_on_memory_mib -----------------------------------------------

    #[test]
    fn always_on_fits_smallest_supported_vm() {
        // Always-on (claude+hub) must fit the smallest supported VM.
        let vm_mib = desired_vm_memory_gib(MIN_SUPPORTED_HOST_GIB) * 1024;
        assert!(
            always_on_memory_mib() < vm_mib,
            "always-on (claude+hub) = {} MiB must fit the {} GiB VM of the {} GiB minimum host",
            always_on_memory_mib(),
            vm_mib / 1024,
            MIN_SUPPORTED_HOST_GIB
        );
    }

    // -- host_total_memory_gib (integration) --------------------------------

    #[test]
    fn host_total_memory_is_sane() {
        let gib = host_total_memory_gib();
        assert!(gib > 0, "host RAM must be > 0 GiB, got {gib}");
        assert!(gib < 4096, "host RAM must be < 4096 GiB, got {gib}");
    }

    #[test]
    fn host_logical_cpus_is_sane() {
        // > 0 so desired_vm_cpus never silently clamps a zero to the floor.
        assert!(host_logical_cpus() > 0);
    }

    // -- format_oom_message -------------------------------------------------

    #[test]
    fn oom_message_contains_key_info() {
        assert!(OOM_MESSAGE.contains("137"), "must mention exit code 137");
        assert!(OOM_MESSAGE.contains("memory"), "must mention memory");
    }

    #[test]
    fn oom_message_does_not_assert_oom_as_certain() {
        // 137 also comes from a host-side kill -9, so OOM must not be asserted.
        assert!(
            !OOM_MESSAGE.contains("killed due to insufficient memory"),
            "must not assert OOM as the certain cause"
        );
        assert!(
            OOM_MESSAGE.contains("most common cause") || OOM_MESSAGE.contains("can also"),
            "must use non-definitive wording"
        );
        // Pin against the SSOT log marker, not a free literal.
        assert!(
            OOM_MESSAGE.contains(crate::host_mcp_process::KILL_STALE_LOG_MARKER),
            "OOM_MESSAGE grep hint must match the real kill log marker '{}'",
            crate::host_mcp_process::KILL_STALE_LOG_MARKER
        );
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

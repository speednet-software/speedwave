//! SSOT for memory/CPU/tmpfs/shm numbers Speedwave ships (Claude+hub here, per-worker limits in
//! consts.rs); drift-tested vs compose.template.yml. Plugin/WSL2 VM limits stay outside by design.
use std::process::ExitStatus;

/// Maximum number of parallel chat tabs; TS mirror in
/// `desktop/src/src/app/services/chat-session-store.ts` (cross-read-tested).
pub const MAX_CHAT_TABS: u32 = 3;

/// Claude container memory base in GiB, the one-tab ceiling. See ADR-091.
pub const CLAUDE_BASE_MEMORY_GIB: u32 = 6;

/// GiB added to the Claude ceiling per chat tab beyond the first. See ADR-091.
pub const CLAUDE_PER_EXTRA_TAB_GIB: u32 = 3;

/// VM GiB held out of the Claude ceiling for the hub and tmpfs. See ADR-091.
pub const CLAUDE_VM_HEADROOM_GIB: u32 = 2;

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

/// Claude container memory ceiling in GiB for a VM of `vm_gib`: tab capacity
/// clamped to the VM budget, never below the base. See ADR-091.
pub fn claude_memory_gib(vm_gib: u32) -> u32 {
    let tab_capacity = CLAUDE_BASE_MEMORY_GIB + CLAUDE_PER_EXTRA_TAB_GIB * (MAX_CHAT_TABS - 1);
    let vm_budget = vm_gib
        .saturating_sub(CLAUDE_VM_HEADROOM_GIB)
        .max(CLAUDE_BASE_MEMORY_GIB);
    tab_capacity.min(vm_budget)
}

/// Claude container limits for a VM of `vm_gib`: memory per [`claude_memory_gib`],
/// 2 cores, 512 MiB /tmp.
pub fn claude_resources(vm_gib: u32) -> ContainerResources {
    ContainerResources {
        mem_mib: claude_memory_gib(vm_gib) * 1024,
        cpus: 2.0,
        tmpfs_mib: 512,
        shm_mib: None,
    }
}

/// VM memory in GiB the render path and Lima provisioning assume:
/// [`desired_vm_memory_gib`] over detected host RAM (Windows falls back to 16).
pub fn resolved_vm_memory_gib() -> u32 {
    desired_vm_memory_gib(host_total_memory_gib())
}

/// MCP hub: on every MCP request's path, does real CPU work (sandboxed exec, PII regex,
/// aggregation) → 1 full core; limits are ceilings, so overcommit on a 4-vCPU VM is fine.
pub const HUB_RESOURCES: ContainerResources = ContainerResources {
    mem_mib: 512,
    cpus: 1.0,
    tmpfs_mib: 64,
    shm_mib: None,
};

/// Speedwave proxy (rust forwarder, ADR-073): 128 MiB, 0.5 core, 32 MiB /tmp; measured ~3-4 MiB
/// idle / ~37 MiB peak under concurrent 64k streams.
pub const PROXY_RESOURCES: ContainerResources = ContainerResources {
    mem_mib: 128,
    cpus: 0.5,
    tmpfs_mib: 32,
    shm_mib: None,
};

/// Default envelope for a lightweight API worker (slack, sharepoint, redmine, gitlab, atlassian,
/// context7); workers needing more override inline (github 256m, office, playwright).
pub const STANDARD_WORKER_RESOURCES: ContainerResources = ContainerResources {
    mem_mib: 128,
    cpus: 0.5,
    tmpfs_mib: 64,
    shm_mib: None,
};

/// Converts raw bytes to GiB using floor division (never over-reports host RAM).
#[cfg(any(target_os = "macos", test))]
fn bytes_to_gib(bytes: u64) -> u32 {
    (bytes / (1024 * 1024 * 1024)) as u32
}

/// Returns total physical RAM in GiB (floor); falls back to 16 on detection failure.
pub fn host_total_memory_gib() -> u32 {
    host_total_memory_gib_impl().unwrap_or(16)
}

#[cfg(target_os = "macos")]
fn host_total_memory_gib_impl() -> Option<u32> {
    let output = crate::binary::system_command("sysctl")
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
    None
}

/// Minimum supported host RAM; SSOT for the `check_low_memory` warn threshold
/// and the always-on fit test. See ADR-068.
pub const MIN_SUPPORTED_HOST_GIB: u32 = 16;

/// Desired Lima VM memory in GiB: half of host RAM, clamped 4-32. Supported (≥16 GiB) hosts land
/// on the ADR-068 8 GiB floor via `host/2`; smaller hosts never get a VM above half their RAM.
pub fn desired_vm_memory_gib(host_ram_gib: u32) -> u32 {
    (host_ram_gib / 2).clamp(4, 32)
}

/// Host logical CPU count, or 8 on detection failure (→ 4 vCPU via `host/2`); uses
/// `available_parallelism` (cross-platform, no `unsafe`) — same primitive the build pool uses.
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

/// Memory the always-on containers (Claude + hub) request on a `vm_gib` VM: hard
/// limit + RAM-backed tmpfs. Excludes toggleable workers and plugins. See ADR-068.
#[cfg(test)]
fn always_on_memory_mib(vm_gib: u32) -> u32 {
    let one = |r: &ContainerResources| r.mem_mib + r.tmpfs_mib + r.shm_mib.unwrap_or(0);
    one(&claude_resources(vm_gib)) + one(&HUB_RESOURCES)
}

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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on failure are the expected fixture behavior"
)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn bytes_to_gib_zero() {
        assert_eq!(bytes_to_gib(0), 0);
    }

    #[test]
    fn bytes_to_gib_just_below_16() {
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

    #[test]
    fn vm_memory_small_hosts() {
        assert_eq!(desired_vm_memory_gib(8), 4);
        assert_eq!(desired_vm_memory_gib(6), 4);
        assert_eq!(desired_vm_memory_gib(0), 4);
    }

    #[test]
    fn vm_memory_host_table() {
        for (host, vm) in [(8u32, 4u32), (16, 8), (32, 16), (64, 32)] {
            assert_eq!(desired_vm_memory_gib(host), vm, "host {host} GiB");
        }
    }

    #[test]
    fn vm_memory_never_exceeds_half_host() {
        for host in [8u32, 10, 12, 14, 16, 24, 32, 64, 128] {
            assert!(
                desired_vm_memory_gib(host) <= (host / 2).max(4),
                "host {host} GiB: VM must not exceed host/2 (min 4)"
            );
        }
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
        assert_eq!(desired_vm_memory_gib(64), 32);
        assert_eq!(desired_vm_memory_gib(128), 32);
    }

    #[test]
    fn vm_cpus_small_hosts_floor_at_4() {
        assert_eq!(desired_vm_cpus(4), 4);
        assert_eq!(desired_vm_cpus(8), 4);
        assert_eq!(desired_vm_cpus(2), 4);
        assert_eq!(desired_vm_cpus(0), 4);
    }

    #[test]
    fn vm_cpus_scales_with_host() {
        assert_eq!(desired_vm_cpus(10), 5);
        assert_eq!(desired_vm_cpus(12), 6);
        assert_eq!(desired_vm_cpus(16), 8);
    }

    #[test]
    fn vm_cpus_caps_at_8() {
        assert_eq!(desired_vm_cpus(24), 8);
        assert_eq!(desired_vm_cpus(64), 8);
    }

    #[test]
    fn vm_cpus_never_exceeds_host() {
        for cores in [4u32, 6, 8, 12, 16, 32] {
            assert!(desired_vm_cpus(cores) <= cores);
        }
    }

    #[test]
    fn claude_memory_formula_table() {
        for (vm, claude) in [
            (0u32, 6u32),
            (4, 6),
            (8, 6),
            (10, 8),
            (12, 10),
            (14, 12),
            (16, 12),
            (32, 12),
        ] {
            assert_eq!(claude_memory_gib(vm), claude, "vm {vm} GiB");
        }
    }

    #[test]
    fn claude_memory_never_below_base_and_caps_at_tab_capacity() {
        let cap = CLAUDE_BASE_MEMORY_GIB + CLAUDE_PER_EXTRA_TAB_GIB * (MAX_CHAT_TABS - 1);
        for vm in 0..=64u32 {
            let gib = claude_memory_gib(vm);
            assert!(gib >= CLAUDE_BASE_MEMORY_GIB, "vm {vm}: below base");
            assert!(gib <= cap, "vm {vm}: above tab capacity");
        }
    }

    #[test]
    fn claude_memory_is_monotonic_in_vm_size() {
        for vm in 0..64u32 {
            assert!(
                claude_memory_gib(vm + 1) >= claude_memory_gib(vm),
                "vm {vm} -> {}: ceiling must not shrink as the VM grows",
                vm + 1
            );
        }
    }

    #[test]
    fn claude_resources_keep_fixed_cpus_and_tmpfs() {
        for vm in [8u32, 16] {
            let r = claude_resources(vm);
            assert_eq!(r.mem_mib, claude_memory_gib(vm) * 1024);
            assert_eq!(r.cpus, 2.0);
            assert_eq!(r.tmpfs_mib, 512);
            assert_eq!(r.shm_mib, None);
        }
    }

    #[test]
    fn smallest_supported_vm_keeps_todays_six_gib() {
        assert_eq!(desired_vm_memory_gib(MIN_SUPPORTED_HOST_GIB), 8);
        assert_eq!(claude_memory_gib(8), 6);
        assert_eq!(claude_resources(8).mem_mib, 6 * 1024);
    }

    #[test]
    fn max_chat_tabs_matches_ts_mirror() {
        let ts = include_str!("../../../desktop/src/src/app/services/chat-session-store.ts");
        assert!(
            ts.contains(&format!("export const MAX_CHAT_TABS = {MAX_CHAT_TABS};")),
            "chat-session-store.ts MAX_CHAT_TABS must equal resources::MAX_CHAT_TABS ({MAX_CHAT_TABS})"
        );
    }

    #[test]
    fn proxy_resources_match_measured_envelope() {
        assert_eq!(PROXY_RESOURCES.mem_mib, 128);
        assert_eq!(PROXY_RESOURCES.cpus, 0.5);
        assert_eq!(PROXY_RESOURCES.tmpfs_mib, 32);
        assert_eq!(PROXY_RESOURCES.shm_mib, None);
    }

    #[test]
    fn builtin_resources_stay_within_plugin_caps() {
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
        let check = |r: &ContainerResources, who: &str| {
            assert!(r.mem_mib > 0, "{who}: mem_mib must be > 0");
            assert!(
                r.cpus.is_finite() && r.cpus > 0.0,
                "{who}: cpus must be finite and > 0"
            );
            assert!(r.tmpfs_mib > 0, "{who}: tmpfs_mib must be > 0");
            if let Some(shm) = r.shm_mib {
                assert!(shm > 0, "{who}: shm_mib, when set, must be > 0");
            }
        };
        check(&claude_resources(8), "claude@8GiB");
        check(&claude_resources(16), "claude@16GiB");
        check(&HUB_RESOURCES, "hub");
        for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
            check(&svc.resources, svc.config_key);
        }
    }

    #[test]
    fn always_on_fits_smallest_supported_vm() {
        let vm_gib = desired_vm_memory_gib(MIN_SUPPORTED_HOST_GIB);
        assert_eq!(
            vm_gib, 8,
            "the minimum supported host must yield an 8 GiB VM"
        );
        let vm_mib = vm_gib * 1024;
        assert!(
            always_on_memory_mib(vm_gib) < vm_mib,
            "always-on (claude+hub) = {} MiB must fit the {} GiB VM of the {} GiB minimum host",
            always_on_memory_mib(vm_gib),
            vm_gib,
            MIN_SUPPORTED_HOST_GIB
        );
    }

    #[test]
    fn always_on_fits_every_vm_size() {
        for vm_gib in [8u32, 10, 12, 16, 32] {
            assert!(
                always_on_memory_mib(vm_gib) < vm_gib * 1024,
                "always-on set must fit a {vm_gib} GiB VM, got {} MiB",
                always_on_memory_mib(vm_gib)
            );
        }
    }

    #[test]
    fn resolved_vm_memory_is_within_the_clamp() {
        let vm = resolved_vm_memory_gib();
        assert!((4..=32).contains(&vm), "vm {vm} GiB outside the 4-32 clamp");
    }

    #[test]
    fn host_total_memory_is_sane() {
        let gib = host_total_memory_gib();
        assert!(gib > 0, "host RAM must be > 0 GiB, got {gib}");
        assert!(gib < 4096, "host RAM must be < 4096 GiB, got {gib}");
    }

    #[test]
    fn host_logical_cpus_is_sane() {
        assert!(host_logical_cpus() > 0);
    }

    #[test]
    fn oom_message_contains_key_info() {
        assert!(OOM_MESSAGE.contains("137"), "must mention exit code 137");
        assert!(OOM_MESSAGE.contains("memory"), "must mention memory");
    }

    #[test]
    fn oom_message_does_not_assert_oom_as_certain() {
        assert!(
            !OOM_MESSAGE.contains("killed due to insufficient memory"),
            "must not assert OOM as the certain cause"
        );
        assert!(
            OOM_MESSAGE.contains("most common cause") || OOM_MESSAGE.contains("can also"),
            "must use non-definitive wording"
        );
        assert!(
            OOM_MESSAGE.contains(crate::host_mcp_process::KILL_STALE_LOG_MARKER),
            "OOM_MESSAGE grep hint must match the real kill log marker '{}'",
            crate::host_mcp_process::KILL_STALE_LOG_MARKER
        );
    }

    #[test]
    fn is_oom_exit_code_137() {
        // SSOT-allow: test fixture spawn
        let status = std::process::Command::new("sh")
            .args(["-c", "exit 137"])
            .status()
            .unwrap();
        assert!(is_oom_exit(&status));
    }

    #[test]
    fn is_oom_exit_code_0() {
        // SSOT-allow: test fixture spawn
        let status = std::process::Command::new("true").status().unwrap();
        assert!(!is_oom_exit(&status));
    }

    #[test]
    fn is_oom_exit_code_1() {
        // SSOT-allow: test fixture spawn
        let status = std::process::Command::new("false").status().unwrap();
        assert!(!is_oom_exit(&status));
    }

    #[cfg(unix)]
    #[test]
    fn is_oom_exit_signal_9() {
        use std::os::unix::process::ExitStatusExt;
        let status = ExitStatus::from_raw(9);
        assert!(is_oom_exit(&status));
    }

    #[cfg(unix)]
    #[test]
    fn is_oom_exit_signal_other() {
        use std::os::unix::process::ExitStatusExt;
        let status = ExitStatus::from_raw(15);
        assert!(!is_oom_exit(&status));
    }
}

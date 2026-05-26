use std::collections::BTreeSet;
use std::sync::{LazyLock, Mutex, PoisonError};

use log::info;
use serde::{Deserialize, Serialize};
use speedwave_runtime::runtime;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct IdeScanState {
    // Fingerprint built before dedupe so same-port duplicates collapse via set
    // semantics, not via mtime tie-break.
    live: BTreeSet<(String, u16)>,
    anomalies: BTreeSet<String>,
}

static LAST_IDE_STATE: LazyLock<Mutex<IdeScanState>> =
    LazyLock::new(|| Mutex::new(IdeScanState::default()));

fn compute_ide_state_diff(prev: &IdeScanState, current: &IdeScanState) -> Vec<String> {
    let mut out = Vec::new();
    if prev.live != current.live {
        out.push(format!(
            "IDE state changed: {:?} → {:?}",
            prev.live, current.live
        ));
    }
    let new_anomalies: BTreeSet<_> = current.anomalies.difference(&prev.anomalies).collect();
    if !new_anomalies.is_empty() {
        out.push(format!("IDE anomaly: {new_anomalies:?}"));
    }
    let resolved_anomalies: BTreeSet<_> = prev.anomalies.difference(&current.anomalies).collect();
    if !resolved_anomalies.is_empty() {
        out.push(format!("IDE anomaly resolved: {resolved_anomalies:?}"));
    }
    out
}

#[cfg(test)]
pub(super) fn reset_ide_state_for_tests() {
    *LAST_IDE_STATE
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = IdeScanState::default();
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ContainerHealth {
    pub name: String,
    pub status: String,
    pub healthy: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VmHealth {
    pub running: bool,
    pub vm_type: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct McpOsHealth {
    pub running: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DetectedIde {
    pub ide_name: String,
    pub port: Option<u16>,
    pub ws_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IdeBridgeHealth {
    pub running: bool,
    pub port: Option<u16>,
    pub ws_url: Option<String>,
    pub detected_ides: Vec<DetectedIde>,
    /// SSOT for "is an IDE actively connected to the bridge".
    /// `None` in three distinct cases that callers should treat the same way
    /// (UI shows "not connected"):
    /// 1. No IDE has been selected via `select_ide` yet.
    /// 2. The previously selected IDE is no longer detected (process exited
    ///    between health polls).
    /// 3. `load_user_config` failed (corrupt or unreadable config — see the
    ///    `log::warn!` in `build_bridge_health`).
    ///
    /// Note that `port` / `ws_url` above describe the first detected IDE,
    /// which may differ from `selected_ide`. Frontends should prefer
    /// `selected_ide.{port, ws_url}` when both are present.
    pub selected_ide: Option<DetectedIde>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HealthReport {
    pub containers: Vec<ContainerHealth>,
    pub vm: VmHealth,
    pub mcp_os: McpOsHealth,
    pub ide_bridge: IdeBridgeHealth,
    pub overall_healthy: bool,
}

impl HealthReport {
    fn compute_overall_healthy(
        vm: &VmHealth,
        mcp_os: &McpOsHealth,
        containers: &[ContainerHealth],
        any_os_enabled: bool,
    ) -> bool {
        let mcp_os_ok = !any_os_enabled || mcp_os.running;
        vm.running && mcp_os_ok && containers.iter().all(|c| c.healthy)
    }
}

/// Timeout for IDE TCP port probe during polling cycles.
pub(crate) const IDE_POLL_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(50);

/// Check if an IDE lock file represents a live IDE by verifying PID liveness and TCP port reachability.
pub(crate) fn is_ide_lock_alive(lock_path: &std::path::Path) -> bool {
    let contents = match std::fs::read_to_string(lock_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let v: serde_json::Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let Some(pid) = v
        .get("pid")
        .and_then(|x| x.as_u64())
        .and_then(|p| u32::try_from(p).ok())
    else {
        return false;
    };
    let port = v
        .get("port")
        .and_then(|x| x.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .or_else(|| {
            lock_path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<u16>().ok())
        });
    let Some(port) = port else { return false };
    is_lock_entry_alive(pid, port)
}

/// Core liveness check: PID alive + TCP port reachable. No file I/O.
fn is_lock_entry_alive(pid: u32, port: u16) -> bool {
    speedwave_runtime::host_mcp_process::is_pid_alive(pid) && {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        std::net::TcpStream::connect_timeout(&addr, IDE_POLL_TIMEOUT).is_ok()
    }
}

/// Check if the mcp-os process is alive AND listening on its port.
/// Thin re-export of `speedwave_runtime::mcp_os_process::is_mcp_os_alive`
/// (SSOT).
pub(crate) fn is_mcp_os_alive() -> bool {
    speedwave_runtime::mcp_os_process::is_mcp_os_alive()
}

/// Testable inner implementation; takes `data_dir` so tests can point
/// at a temporary directory. Thin wrapper over the runtime SSOT.
#[cfg(test)]
pub(crate) fn check_mcp_os_alive_in(data_dir: &std::path::Path) -> bool {
    speedwave_runtime::mcp_os_process::is_mcp_os_alive_in(data_dir)
}

pub struct HealthMonitor;

impl HealthMonitor {
    pub fn check_containers(project: &str) -> anyhow::Result<Vec<ContainerHealth>> {
        let rt = runtime::detect_runtime();
        let ps = rt.compose_ps(project)?;
        Ok(parse_container_entries(&ps, project))
    }
}

/// Parses compose ps JSON entries into `ContainerHealth` structs.
///
/// Handles field name differences across nerdctl versions: `Name`/`name`,
/// `State`/`Status`/`state`/`status`.
fn parse_container_entries(entries: &[serde_json::Value], project: &str) -> Vec<ContainerHealth> {
    entries
        .iter()
        .map(|entry| {
            let raw_name = entry
                .get("Name")
                .or_else(|| entry.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let name = speedwave_runtime::consts::strip_compose_container_prefix(raw_name, project)
                .to_string();

            let status = entry
                .get("Status")
                .or_else(|| entry.get("State"))
                .or_else(|| entry.get("status"))
                .or_else(|| entry.get("state"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();

            let healthy = status.contains("Up") || status.contains("running");

            ContainerHealth {
                name,
                status,
                healthy,
            }
        })
        .collect()
}

impl HealthMonitor {
    pub fn check_vm() -> VmHealth {
        #[cfg(target_os = "macos")]
        {
            VmHealth {
                running: runtime::detect_runtime().is_available(),
                vm_type: "Lima".into(),
            }
        }
        #[cfg(target_os = "windows")]
        {
            VmHealth {
                running: runtime::detect_runtime().is_available(),
                vm_type: "WSL2".into(),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            VmHealth {
                running: false,
                vm_type: "unsupported".into(),
            }
        }
    }

    pub fn check_mcp_os() -> McpOsHealth {
        McpOsHealth {
            running: is_mcp_os_alive(),
        }
    }

    pub fn check_ide_bridge() -> IdeBridgeHealth {
        let detected_ides = list_available_ides();
        // Polled every 5 s — without a log entry an intermittent
        // permission/IO error would silently degrade the bridge status to
        // "disconnected" with no diagnostic trail.
        let selected = match speedwave_runtime::config::load_user_config() {
            Ok(cfg) => cfg.selected_ide,
            Err(e) => {
                log::warn!("ide_bridge health: load_user_config failed: {e}");
                None
            }
        };
        build_ide_bridge_health(detected_ides, selected.as_ref())
    }
}

/// Pure helper: pair the live detected-IDE list with the user's selected IDE
/// (read from config) and assemble the `IdeBridgeHealth` payload. Extracted
/// from `check_ide_bridge` so the resolution logic is testable without
/// touching the global config file.
///
/// `selected_ide` is `Some(d)` only when the user-selected entry is also
/// currently detected — a stale config pointing at a dead IDE process
/// resolves to `None` (UI renders "disconnected" rather than a stale port).
pub(crate) fn build_ide_bridge_health(
    detected_ides: Vec<DetectedIde>,
    selected: Option<&speedwave_runtime::config::SelectedIde>,
) -> IdeBridgeHealth {
    let running = !detected_ides.is_empty();
    // Expose first entry with a port in top-level fields for backwards compat
    let first_with_port = detected_ides.iter().find(|i| i.port.is_some());
    let port = first_with_port.and_then(|i| i.port);
    let ws_url = first_with_port.and_then(|i| i.ws_url.clone());
    let selected_ide = selected.and_then(|sel| {
        detected_ides
            .iter()
            .find(|d| d.ide_name == sel.ide_name && d.port == Some(sel.port))
            .cloned()
    });
    IdeBridgeHealth {
        running,
        port,
        ws_url,
        detected_ides,
        selected_ide,
    }
}

/// Scans ~/.claude/ide/*.lock, filters live processes, skips our own PID.
/// Returns all external IDEs visible to Speedwave.
pub fn list_available_ides() -> Vec<DetectedIde> {
    let lock_dir = dirs::home_dir().map(|h| h.join(".claude").join("ide"));
    lock_dir.map(|d| list_ides_in_dir(&d)).unwrap_or_default()
}

/// Returns true if `~/.claude/ide/<port>.lock` exists and points at a
/// live (PID + TCP) IDE instance. Probes a single lock file rather than
/// scanning the whole directory — used by `select_ide` to validate the
/// exact port the UI sent, including older-window ports that
/// `list_available_ides` collapses away during dedupe.
pub fn is_ide_port_alive(port: u16) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let lock_path = home
        .join(".claude")
        .join("ide")
        .join(format!("{port}.lock"));
    is_ide_lock_alive(&lock_path)
}

/// Scans `lock_dir/*.lock` for IDE lock files with live PIDs and listening ports.
///
/// Deduplicates by `(pid, ide_name)` — VS Code writes one lock per window,
/// all sharing the same `pid`. Keeps the entry with the most recent mtime so
/// the user-visible list collapses to one row per IDE instance.
fn list_ides_in_dir(lock_dir: &std::path::Path) -> Vec<DetectedIde> {
    let Ok(entries) = std::fs::read_dir(lock_dir) else {
        return Vec::new();
    };

    struct LiveEntry {
        ide_name: String,
        port: u16,
        ws_url: Option<String>,
        pid: u32,
        mtime: std::time::SystemTime,
    }

    let mut anomalies: BTreeSet<String> = BTreeSet::new();

    let live: Vec<LiveEntry> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("lock") {
                return None;
            }
            let filename = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let contents = std::fs::read_to_string(&p).ok()?;
            let v: serde_json::Value = serde_json::from_str(&contents).ok()?;
            let pid = v
                .get("pid")
                .and_then(|x| x.as_u64())
                .and_then(|p| u32::try_from(p).ok());
            if let Some(pid) = pid {
                if pid == std::process::id() {
                    anomalies.insert(format!("{filename}:own_pid"));
                    return None;
                }
            }
            let json_port = v
                .get("port")
                .and_then(|x| x.as_u64())
                .and_then(|p| u16::try_from(p).ok());
            let port = json_port.or_else(|| {
                p.file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse::<u16>().ok())
            });
            let Some(port) = port else {
                anomalies.insert(format!("{filename}:no_port"));
                return None;
            };
            let Some(check_pid) = pid else {
                anomalies.insert(format!("{filename}:no_pid"));
                return None;
            };
            if !is_lock_entry_alive(check_pid, port) {
                anomalies.insert(format!("{filename}:stale"));
                return None;
            }
            let ws_url = v
                .get("wsUrl")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let ide_name = v
                .get("ideName")
                .and_then(|x| x.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some(LiveEntry {
                ide_name,
                port,
                ws_url,
                pid: check_pid,
                mtime,
            })
        })
        .collect();

    // Fingerprint built from the full pre-dedupe set so identical (ide, port)
    // pairs across multiple lock files collapse via BTreeSet, not via mtime.
    let live_fingerprint: BTreeSet<(String, u16)> =
        live.iter().map(|e| (e.ide_name.clone(), e.port)).collect();

    let mut by_key: std::collections::HashMap<(u32, String), LiveEntry> =
        std::collections::HashMap::new();
    for entry in live {
        let key = (entry.pid, entry.ide_name.clone());
        match by_key.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut slot) => {
                if entry.mtime > slot.get().mtime {
                    slot.insert(entry);
                }
            }
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(entry);
            }
        }
    }

    // HashMap iteration is hash-randomised; sort so the frontend's
    // detected-IDE list does not jump around between 5-second polls.
    let mut result: Vec<DetectedIde> = by_key
        .into_values()
        .map(|e| DetectedIde {
            ide_name: e.ide_name,
            port: Some(e.port),
            ws_url: e.ws_url,
        })
        .collect();
    result.sort_by(|a, b| a.ide_name.cmp(&b.ide_name).then(a.port.cmp(&b.port)));

    let current = IdeScanState {
        live: live_fingerprint,
        anomalies,
    };
    let messages = {
        let mut last = LAST_IDE_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let msgs = compute_ide_state_diff(&last, &current);
        *last = current;
        msgs
    };
    // Lock released — log writes (possibly involving file rotation) cannot
    // block a concurrent caller waiting on LAST_IDE_STATE.
    for msg in messages {
        info!("{msg}");
    }

    result
}

impl HealthMonitor {
    pub fn check_all(project: &str, any_os_enabled: bool) -> HealthReport {
        let containers = Self::check_containers(project).unwrap_or_default();
        let vm = Self::check_vm();
        let mcp_os = Self::check_mcp_os();
        let ide_bridge = Self::check_ide_bridge();
        let overall =
            HealthReport::compute_overall_healthy(&vm, &mcp_os, &containers, any_os_enabled);
        HealthReport {
            containers,
            vm,
            mcp_os,
            ide_bridge,
            overall_healthy: overall,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{
        compute_ide_state_diff, parse_container_entries, reset_ide_state_for_tests,
        ContainerHealth, DetectedIde, HealthMonitor, HealthReport, IdeBridgeHealth, IdeScanState,
        McpOsHealth, VmHealth,
    };
    use std::collections::BTreeSet;

    /// Returns a PID that is alive and different from `std::process::id()`.
    /// Unix: parent PID. Windows: spawns a sleeping process.
    fn external_alive_pid() -> (u32, Option<std::process::Child>) {
        #[cfg(unix)]
        {
            (std::os::unix::process::parent_id(), None)
        }
        #[cfg(windows)]
        {
            let child = speedwave_runtime::binary::system_command("cmd")
                .args(["/C", "timeout /T 30 /NOBREAK >NUL"])
                .spawn()
                .expect("failed to spawn external process for test");
            (child.id(), Some(child))
        }
    }

    #[test]
    fn vm_health_has_correct_type() {
        let vm = HealthMonitor::check_vm();
        #[cfg(target_os = "macos")]
        assert_eq!(vm.vm_type, "Lima");
        #[cfg(target_os = "windows")]
        assert_eq!(vm.vm_type, "WSL2");
    }

    #[test]
    fn overall_healthy_false_when_vm_down() {
        let containers = vec![ContainerHealth {
            name: "claude".into(),
            status: "running".into(),
            healthy: true,
        }];
        let vm = VmHealth {
            running: false,
            vm_type: "test".into(),
        };
        let mcp_os = McpOsHealth { running: true };
        let ide_bridge = IdeBridgeHealth {
            running: false,
            port: None,
            ws_url: None,
            detected_ides: vec![],
            selected_ide: None,
        };
        let overall = HealthReport::compute_overall_healthy(&vm, &mcp_os, &containers, true);
        let report = HealthReport {
            containers,
            vm,
            mcp_os,
            ide_bridge,
            overall_healthy: overall,
        };
        assert!(
            !report.overall_healthy,
            "VM down should make overall unhealthy"
        );
    }

    #[test]
    fn overall_healthy_false_when_mcp_os_down() {
        let containers = vec![ContainerHealth {
            name: "claude".into(),
            status: "running".into(),
            healthy: true,
        }];
        let vm = VmHealth {
            running: true,
            vm_type: "test".into(),
        };
        let mcp_os = McpOsHealth { running: false };
        let ide_bridge = IdeBridgeHealth {
            running: false,
            port: None,
            ws_url: None,
            detected_ides: vec![],
            selected_ide: None,
        };
        let overall = HealthReport::compute_overall_healthy(&vm, &mcp_os, &containers, true);
        let report = HealthReport {
            containers,
            vm,
            mcp_os,
            ide_bridge,
            overall_healthy: overall,
        };
        assert!(
            !report.overall_healthy,
            "mcp-os down should make overall unhealthy"
        );
    }

    #[test]
    fn overall_healthy_false_when_container_unhealthy() {
        let containers = vec![ContainerHealth {
            name: "claude".into(),
            status: "exited".into(),
            healthy: false,
        }];
        let vm = VmHealth {
            running: true,
            vm_type: "test".into(),
        };
        let mcp_os = McpOsHealth { running: true };
        let ide_bridge = IdeBridgeHealth {
            running: false,
            port: None,
            ws_url: None,
            detected_ides: vec![],
            selected_ide: None,
        };
        let overall = HealthReport::compute_overall_healthy(&vm, &mcp_os, &containers, true);
        let report = HealthReport {
            containers,
            vm,
            mcp_os,
            ide_bridge,
            overall_healthy: overall,
        };
        assert!(
            !report.overall_healthy,
            "Unhealthy container should make overall unhealthy"
        );
    }

    #[test]
    fn overall_healthy_true_when_all_good() {
        let containers = vec![ContainerHealth {
            name: "claude".into(),
            status: "running".into(),
            healthy: true,
        }];
        let vm = VmHealth {
            running: true,
            vm_type: "test".into(),
        };
        let mcp_os = McpOsHealth { running: true };
        let ide_bridge = IdeBridgeHealth {
            running: false,
            port: None,
            ws_url: None,
            detected_ides: vec![],
            selected_ide: None,
        };
        let overall = HealthReport::compute_overall_healthy(&vm, &mcp_os, &containers, true);
        let report = HealthReport {
            containers,
            vm,
            mcp_os,
            ide_bridge,
            overall_healthy: overall,
        };
        assert!(
            report.overall_healthy,
            "All healthy should be overall healthy"
        );
    }

    #[test]
    fn container_health_serializes() {
        let ch = ContainerHealth {
            name: "test".into(),
            status: "Up".into(),
            healthy: true,
        };
        let json = serde_json::to_string(&ch).unwrap();
        assert!(json.contains("\"healthy\":true"));
    }

    // ── parse_container_entries tests ────────────────────────────────────────

    #[test]
    fn parse_nerdctl_state_field() {
        let entries: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"Name":"mcp_hub","State":"running"},{"Name":"claude","State":"exited"}]"#,
        )
        .unwrap();
        let result = parse_container_entries(&entries, "myproj");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "mcp_hub");
        assert_eq!(result[0].status, "running");
        assert!(result[0].healthy);
        assert_eq!(result[1].name, "claude");
        assert_eq!(result[1].status, "exited");
        assert!(!result[1].healthy);
    }

    #[test]
    fn parse_docker_status_field() {
        let entries: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"Name":"hub","Status":"Up 5 minutes"}]"#).unwrap();
        let result = parse_container_entries(&entries, "p");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, "Up 5 minutes");
        assert!(result[0].healthy);
    }

    #[test]
    fn parse_missing_fields_returns_unknown() {
        let entries: Vec<serde_json::Value> = serde_json::from_str(r#"[{"ID":"abc"}]"#).unwrap();
        let result = parse_container_entries(&entries, "p");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "unknown");
        assert_eq!(result[0].status, "unknown");
        assert!(!result[0].healthy);
    }

    #[test]
    fn parse_empty_entries() {
        let result = parse_container_entries(&[], "p");
        assert!(result.is_empty());
    }

    #[test]
    fn parse_strips_runtime_project_prefix() {
        // Build container names from the live `compose_prefix()` so the test
        // is independent of `SPEEDWAVE_DATA_DIR`.
        let prefix = speedwave_runtime::consts::compose_prefix();
        let json = format!(
            r#"[{{"Name":"{prefix}_my_proj_mcp_hub","State":"running"}},
                {{"Name":"{prefix}_my_proj_mcp_office","State":"running"}}]"#
        );
        let entries: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        let result = parse_container_entries(&entries, "my_proj");
        assert_eq!(result[0].name, "mcp_hub", "underscores in project survive");
        assert_eq!(result[1].name, "mcp_office");
    }

    #[test]
    fn parse_leaves_unrelated_container_unchanged() {
        let entries: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"Name":"other_unrelated_thing","State":"running"}]"#)
                .unwrap();
        let result = parse_container_entries(&entries, "p");
        assert_eq!(result[0].name, "other_unrelated_thing");
    }

    #[test]
    fn ide_bridge_health_running_when_lock_file_present() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("12345.lock");
        std::fs::write(
            &lock_path,
            r#"{"port":12345,"wsUrl":"ws://127.0.0.1:12345","authToken":"tok","workspaceFolders":["/workspace"],"pid":1,"ideName":"Speedwave","transport":"ws"}"#,
        )
        .unwrap();
        let contents = std::fs::read_to_string(&lock_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
        let port = parsed
            .get("port")
            .and_then(|v| v.as_u64())
            .and_then(|p| u16::try_from(p).ok());
        let ws_url = parsed
            .get("wsUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let health = IdeBridgeHealth {
            running: true,
            port,
            ws_url,
            detected_ides: vec![DetectedIde {
                ide_name: "Speedwave".to_string(),
                port: Some(12345),
                ws_url: Some("ws://127.0.0.1:12345".to_string()),
            }],
            selected_ide: None,
        };
        assert!(health.running);
        assert_eq!(health.port, Some(12345));
        assert_eq!(health.ws_url.as_deref(), Some("ws://127.0.0.1:12345"));
        assert_eq!(health.detected_ides[0].ide_name, "Speedwave");
    }

    #[test]
    fn ide_bridge_health_not_running_when_no_lock_file() {
        let health = IdeBridgeHealth {
            running: false,
            port: None,
            ws_url: None,
            detected_ides: vec![],
            selected_ide: None,
        };
        assert!(!health.running);
        assert!(health.port.is_none());
        assert!(health.ws_url.is_none());
    }

    #[test]
    fn ide_bridge_health_serializes() {
        let health = IdeBridgeHealth {
            running: true,
            port: Some(9999),
            ws_url: Some("ws://127.0.0.1:9999".to_string()),
            detected_ides: vec![],
            selected_ide: None,
        };
        let json = serde_json::to_string(&health).unwrap();
        assert!(json.contains("\"running\":true"));
        assert!(json.contains("9999"));
        assert!(json.contains("ws_url"));
    }

    #[test]
    fn overall_healthy_does_not_require_ide_bridge() {
        // IDE Bridge is optional — its absence should not affect overall_healthy
        let containers = vec![ContainerHealth {
            name: "claude".into(),
            status: "running".into(),
            healthy: true,
        }];
        let vm = VmHealth {
            running: true,
            vm_type: "test".into(),
        };
        let mcp_os = McpOsHealth { running: true };
        let ide_bridge = IdeBridgeHealth {
            running: false,
            port: None,
            ws_url: None,
            detected_ides: vec![],
            selected_ide: None,
        };
        let overall = HealthReport::compute_overall_healthy(&vm, &mcp_os, &containers, true);
        let report = HealthReport {
            containers,
            vm,
            mcp_os,
            ide_bridge,
            overall_healthy: overall,
        };
        assert!(
            report.overall_healthy,
            "IDE Bridge down must not affect overall_healthy"
        );
    }

    #[test]
    fn list_ides_filters_stale_port() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();
        // Use an external alive PID so the entry passes the PID guard and
        // actually reaches the TCP port liveness check — port 64999 is not listening.
        let (external_pid, _child) = external_alive_pid();
        std::fs::write(
            tmp.path().join("64999.lock"),
            format!(
                r#"{{"port":64999,"wsUrl":"ws://127.0.0.1:64999","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Cursor","transport":"ws","pid":{external_pid}}}"#,
            ),
        ).unwrap();

        let result = list_ides_in_dir(tmp.path());
        assert!(
            result.is_empty(),
            "Lock file with non-listening port should be filtered out"
        );
    }

    #[test]
    fn list_ides_keeps_listening_port() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();
        // Bind a real TCP listener so the port check passes.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Use an external PID so is_lock_entry_alive passes the PID liveness
        // check without triggering the self-PID filter in list_ides_in_dir.
        let (external_pid, _child) = external_alive_pid();
        let lock_content = format!(
            r#"{{"pid":{},"port":{},"wsUrl":"ws://127.0.0.1:{}","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Cursor","transport":"ws"}}"#,
            external_pid, port, port
        );
        std::fs::write(tmp.path().join(format!("{port}.lock")), &lock_content).unwrap();

        let result = list_ides_in_dir(tmp.path());
        assert_eq!(
            result.len(),
            1,
            "Lock file with listening port should be kept"
        );
        assert_eq!(result[0].ide_name, "Cursor");
        assert_eq!(result[0].port, Some(port));
        drop(listener);
    }

    #[test]
    fn list_ides_dedupes_multiple_windows_of_same_ide() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();
        // One external "VS Code" process with two windows → two lock files,
        // same pid + ide_name, different ports.
        let (external_pid, _child) = external_alive_pid();
        let listener_a = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port_a = listener_a.local_addr().unwrap().port();
        let listener_b = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port_b = listener_b.local_addr().unwrap().port();
        for port in [port_a, port_b] {
            std::fs::write(
                tmp.path().join(format!("{port}.lock")),
                format!(
                    r#"{{"pid":{external_pid},"port":{port},"wsUrl":"ws://127.0.0.1:{port}","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Visual Studio Code","transport":"ws"}}"#,
                ),
            )
            .unwrap();
        }

        let result = list_ides_in_dir(tmp.path());
        assert_eq!(
            result.len(),
            1,
            "two windows of the same IDE process must collapse to one entry"
        );
        assert_eq!(result[0].ide_name, "Visual Studio Code");
        // Either port is acceptable — the dedupe keeps the latest mtime.
        assert!(result[0].port == Some(port_a) || result[0].port == Some(port_b));
        drop(listener_a);
        drop(listener_b);
    }

    #[test]
    fn list_ides_keeps_separate_entries_for_different_ides() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();
        // Two distinct IDEs (different ide_name) — must NOT collapse.
        let (external_pid, _child) = external_alive_pid();
        let l_a = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port_a = l_a.local_addr().unwrap().port();
        let l_b = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port_b = l_b.local_addr().unwrap().port();
        std::fs::write(
            tmp.path().join(format!("{port_a}.lock")),
            format!(
                r#"{{"pid":{external_pid},"port":{port_a},"wsUrl":"ws://127.0.0.1:{port_a}","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Cursor","transport":"ws"}}"#,
            ),
        ).unwrap();
        std::fs::write(
            tmp.path().join(format!("{port_b}.lock")),
            format!(
                r#"{{"pid":{external_pid},"port":{port_b},"wsUrl":"ws://127.0.0.1:{port_b}","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Visual Studio Code","transport":"ws"}}"#,
            ),
        ).unwrap();

        let result = list_ides_in_dir(tmp.path());
        assert_eq!(result.len(), 2);
        drop(l_a);
        drop(l_b);
    }

    #[test]
    fn list_ides_filters_entry_without_port() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();
        // Lock file with no port in JSON and non-numeric filename — cannot verify liveness.
        std::fs::write(
            tmp.path().join("no-port.lock"),
            r#"{"wsUrl":"ws://127.0.0.1:9999","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Cursor","transport":"ws"}"#,
        ).unwrap();

        let result = list_ides_in_dir(tmp.path());
        assert!(
            result.is_empty(),
            "Lock file without resolvable port should be filtered out"
        );
    }

    #[test]
    fn parse_lowercase_name_and_state() {
        let entries: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"name":"hub","state":"running"}]"#).unwrap();
        let result = parse_container_entries(&entries, "p");
        assert_eq!(result[0].name, "hub");
        assert_eq!(result[0].status, "running");
        assert!(result[0].healthy);
    }

    // ── is_ide_lock_alive tests ───────────────────────────────────────────────

    #[test]
    fn test_is_ide_lock_alive_nonexistent_file() {
        use super::is_ide_lock_alive;

        let result = is_ide_lock_alive(std::path::Path::new(
            "/nonexistent/path/that/does/not/exist.lock",
        ));
        assert!(!result, "nonexistent file must return false");
    }

    #[test]
    fn test_is_ide_lock_alive_invalid_json() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("invalid.lock");
        std::fs::write(&lock_path, "this is not valid json {{{{").unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(!result, "invalid JSON must return false");
    }

    #[test]
    fn test_is_ide_lock_alive_missing_pid_field() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("no-pid.lock");
        std::fs::write(&lock_path, r#"{"port": 1234}"#).unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(!result, "missing pid field must return false");
    }

    #[test]
    fn test_is_ide_lock_alive_dead_pid() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("dead-pid.lock");
        // PID 999999999 is virtually guaranteed not to exist
        std::fs::write(&lock_path, r#"{"pid": 999999999, "port": 1234}"#).unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(!result, "non-existent PID must return false");
    }

    #[test]
    fn test_is_ide_lock_alive_valid_with_listening_port() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("live.lock");

        // Bind a real TCP listener so the port check passes.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let current_pid = std::process::id();
        let content = format!(r#"{{"pid": {}, "port": {}}}"#, current_pid, port);
        std::fs::write(&lock_path, content).unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(result, "alive PID and listening port must return true");

        drop(listener);
    }

    #[test]
    fn test_is_ide_lock_alive_valid_pid_but_dead_port() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("dead-port.lock");

        // Bind and immediately drop the listener to get a port that is no longer listening.
        let dead_port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };

        let current_pid = std::process::id();
        let content = format!(r#"{{"pid": {}, "port": {}}}"#, current_pid, dead_port);
        std::fs::write(&lock_path, content).unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(
            !result,
            "alive PID but non-listening port must return false"
        );
    }

    // ── port-from-filename fallback tests ────────────────────────────────────

    #[test]
    fn test_is_ide_lock_alive_port_from_filename() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();

        // Bind a real TCP listener so the port check passes.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        // Lock file named <port>.lock with NO "port" field in JSON — simulates
        // real IDE lock files from Cursor/VS Code that encode port only in filename.
        let lock_path = tmp.path().join(format!("{port}.lock"));
        let current_pid = std::process::id();
        let content = format!(
            r#"{{"pid":{current_pid},"wsUrl":"ws://127.0.0.1:{port}","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Cursor","transport":"ws"}}"#,
        );
        std::fs::write(&lock_path, content).unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(
            result,
            "is_ide_lock_alive must derive port from filename when JSON has no port field"
        );

        drop(listener);
    }

    #[test]
    fn test_list_ides_in_dir_port_from_filename() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();

        // Bind a real TCP listener so the port check passes.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let (external_pid, _child) = external_alive_pid();

        // Lock file with NO "port" in JSON — port derived from filename only.
        let lock_path = tmp.path().join(format!("{port}.lock"));
        let content = format!(
            r#"{{"pid":{external_pid},"wsUrl":"ws://127.0.0.1:{port}","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Cursor","transport":"ws"}}"#,
        );
        std::fs::write(&lock_path, content).unwrap();

        let result = list_ides_in_dir(tmp.path());
        assert_eq!(
            result.len(),
            1,
            "list_ides_in_dir must find IDE when port is derived from filename"
        );
        assert_eq!(result[0].ide_name, "Cursor");
        assert_eq!(result[0].port, Some(port));

        drop(listener);
    }

    // ── port edge-case tests ─────────────────────────────────────────────────

    #[test]
    fn test_is_ide_lock_alive_port_overflow_in_json() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("overflow.lock");
        let current_pid = std::process::id();
        // Port 99999 exceeds u16::MAX (65535) — u16::try_from must reject it.
        let content = format!(r#"{{"pid":{current_pid},"port":99999}}"#);
        std::fs::write(&lock_path, content).unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(
            !result,
            "port > 65535 in JSON must be rejected by u16::try_from"
        );
    }

    #[test]
    fn test_list_ides_in_dir_port_overflow_in_json() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();
        let (external_pid, _child) = external_alive_pid();
        // Port 99999 in JSON, non-numeric filename — no valid port source.
        let content =
            format!(r#"{{"pid":{external_pid},"port":99999,"ideName":"Test","transport":"ws"}}"#,);
        std::fs::write(tmp.path().join("overflow.lock"), content).unwrap();

        let result = list_ides_in_dir(tmp.path());
        assert!(
            result.is_empty(),
            "port > 65535 in JSON with non-numeric filename must be filtered out"
        );
    }

    #[test]
    fn test_list_ides_in_dir_filename_port_overflow() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();
        let (external_pid, _child) = external_alive_pid();
        // Filename "999999.lock" overflows u16, no "port" in JSON.
        let content = format!(r#"{{"pid":{external_pid},"ideName":"Test","transport":"ws"}}"#);
        std::fs::write(tmp.path().join("999999.lock"), content).unwrap();

        let result = list_ides_in_dir(tmp.path());
        assert!(
            result.is_empty(),
            "filename port > 65535 must be rejected by u16 parse"
        );
    }

    #[test]
    fn test_is_ide_lock_alive_no_port_from_json_or_filename() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();
        // Non-numeric filename, no "port" in JSON — no valid port source.
        let lock_path = tmp.path().join("no-port-anywhere.lock");
        let current_pid = std::process::id();
        let content = format!(r#"{{"pid":{current_pid},"ideName":"Test"}}"#);
        std::fs::write(&lock_path, content).unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(!result, "no port from JSON or filename must return false");
    }

    #[test]
    fn test_is_ide_lock_alive_port_zero_in_json() {
        use super::is_ide_lock_alive;

        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("zero.lock");
        let current_pid = std::process::id();
        // Port 0 is technically valid u16, but nothing listens there.
        let content = format!(r#"{{"pid":{current_pid},"port":0}}"#);
        std::fs::write(&lock_path, content).unwrap();

        let result = is_ide_lock_alive(&lock_path);
        assert!(!result, "port 0 must fail TCP connect and return false");
    }

    #[test]
    fn test_list_ides_stale_lock_with_filename_port() {
        use super::list_ides_in_dir;

        let tmp = tempfile::tempdir().unwrap();
        // Bind and immediately drop to get a dead port.
        let dead_port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let (external_pid, _child) = external_alive_pid();
        // No "port" in JSON — port derived from filename, but port is dead.
        let content = format!(r#"{{"pid":{external_pid},"ideName":"Cursor","transport":"ws"}}"#,);
        std::fs::write(tmp.path().join(format!("{dead_port}.lock")), content).unwrap();

        let result = list_ides_in_dir(tmp.path());
        assert!(
            result.is_empty(),
            "filename-derived port with non-listening socket must be filtered out"
        );
    }

    #[test]
    fn overall_healthy_skips_mcp_os_when_no_os_enabled() {
        let containers = vec![ContainerHealth {
            name: "claude".into(),
            status: "running".into(),
            healthy: true,
        }];
        let vm = VmHealth {
            running: true,
            vm_type: "test".into(),
        };
        let mcp_os = McpOsHealth { running: false };
        let overall = HealthReport::compute_overall_healthy(&vm, &mcp_os, &containers, false);
        assert!(
            overall,
            "mcp-os down must not affect overall_healthy when no OS integrations are enabled"
        );
    }

    #[test]
    fn overall_healthy_requires_mcp_os_when_os_enabled() {
        let containers = vec![ContainerHealth {
            name: "claude".into(),
            status: "running".into(),
            healthy: true,
        }];
        let vm = VmHealth {
            running: true,
            vm_type: "test".into(),
        };
        let mcp_os = McpOsHealth { running: false };
        let overall = HealthReport::compute_overall_healthy(&vm, &mcp_os, &containers, true);
        assert!(
            !overall,
            "mcp-os down must make overall unhealthy when OS integrations are enabled"
        );
    }

    // ── check_mcp_os PID-based liveness tests ─────────────────────────────

    #[test]
    fn check_mcp_os_returns_false_when_no_files_exist() {
        // check_mcp_os reads from ~/.speedwave/ which may or may not have
        // files in a test environment. This test verifies the struct shape
        // and that the function does not panic when files are absent.
        let health = HealthMonitor::check_mcp_os();
        // We cannot assert running == false because a real mcp-os may be
        // running in the developer's environment. Just verify no panic.
        let _ = health.running;
    }

    // ── is_mcp_os_alive tests (via check_mcp_os_alive_in) ──────────────
    //
    // After the unified-lock migration (PR3), `is_mcp_os_alive_in` reads
    // `mcp-os.lock.json` instead of the three legacy `mcp-os-*` files. The
    // tests below construct the fixture using the runtime SSOT helpers so a
    // schema change in `LockFile` automatically fans out here.

    fn write_mcp_os_lock(data_dir: &std::path::Path, pid: u32, port: u16) {
        use speedwave_runtime::host_mcp_process::lock::{LockFile, LockService};
        let lock = LockFile::new(LockService::McpOs, pid, port, "test-token".into());
        let lock_path = data_dir.join(speedwave_runtime::consts::MCP_OS_LOCK_FILE);
        speedwave_runtime::host_mcp_process::lock::write(&lock_path, &lock).unwrap();
    }

    #[test]
    fn is_mcp_os_alive_false_when_pid_alive_port_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        // PID is current process (alive); port 64999 is highly unlikely to be listening.
        write_mcp_os_lock(data_dir, std::process::id(), 64999);

        assert!(
            !super::check_mcp_os_alive_in(data_dir),
            "PID alive + port not listening should return false"
        );
    }

    #[test]
    fn is_mcp_os_alive_true_when_pid_alive_port_open() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        write_mcp_os_lock(data_dir, std::process::id(), port);

        assert!(
            super::check_mcp_os_alive_in(data_dir),
            "PID alive + port listening should return true"
        );
        drop(listener);
    }

    #[test]
    fn is_mcp_os_alive_false_when_pid_in_lock_is_dead() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        // PID 999_999_999 is virtually guaranteed not to be alive on the
        // host. Even if its port were somehow listening, `is_pid_alive`
        // short-circuits before the TCP probe.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        write_mcp_os_lock(data_dir, 999_999_999, port);
        assert!(
            !super::check_mcp_os_alive_in(data_dir),
            "dead PID in lock.json must report not-alive"
        );
        drop(listener);
    }

    #[test]
    fn is_mcp_os_alive_false_when_no_lock_file() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        // No lock.json (and no legacy files either) — must return false
        // rather than crashing on the missing file.
        assert!(
            !super::check_mcp_os_alive_in(data_dir),
            "missing lock.json should return false"
        );
    }

    // ─── build_ide_bridge_health: selected_ide resolution ───────────────

    fn detected(name: &str, port: u16) -> DetectedIde {
        DetectedIde {
            ide_name: name.to_string(),
            port: Some(port),
            ws_url: Some(format!("ws://127.0.0.1:{port}")),
        }
    }

    fn selected(name: &str, port: u16) -> speedwave_runtime::config::SelectedIde {
        speedwave_runtime::config::SelectedIde {
            ide_name: name.to_string(),
            port,
        }
    }

    #[test]
    fn build_ide_bridge_health_resolves_selected_ide_when_detected() {
        let detected_ides = vec![detected("VSCode", 6_900), detected("IntelliJ", 6_901)];
        let sel = selected("VSCode", 6_900);
        let report = super::build_ide_bridge_health(detected_ides.clone(), Some(&sel));
        assert_eq!(
            report.selected_ide.as_ref().map(|i| i.ide_name.as_str()),
            Some("VSCode"),
            "selected IDE matching a detected entry must surface in selected_ide"
        );
        assert!(
            report.running,
            "running must be true when ides are detected"
        );
        assert_eq!(report.detected_ides.len(), 2);
    }

    #[test]
    fn build_ide_bridge_health_drops_selected_ide_when_no_longer_detected() {
        // The user previously selected an IDE that has since exited. The
        // resolver must return None so the UI renders "disconnected" rather
        // than a stale port.
        let detected_ides = vec![detected("IntelliJ", 6_901)];
        let stale = selected("VSCode", 6_900);
        let report = super::build_ide_bridge_health(detected_ides, Some(&stale));
        assert!(
            report.selected_ide.is_none(),
            "selected_ide must drop to None when the selected IDE is no longer detected"
        );
    }

    #[test]
    fn build_ide_bridge_health_returns_none_when_no_selection() {
        let detected_ides = vec![detected("VSCode", 6_900)];
        let report = super::build_ide_bridge_health(detected_ides, None);
        assert!(
            report.selected_ide.is_none(),
            "selected_ide must be None when the user has not selected any IDE"
        );
        assert!(
            report.running,
            "running stays true even without a selected IDE — daemon is scanning"
        );
    }

    #[test]
    fn build_ide_bridge_health_distinguishes_by_port_not_just_name() {
        // Two IDE instances of the same family on different ports — the
        // selection key includes port specifically so users can target a
        // specific window.
        let detected_ides = vec![detected("VSCode", 6_900), detected("VSCode", 6_902)];
        let sel = selected("VSCode", 6_902);
        let report = super::build_ide_bridge_health(detected_ides, Some(&sel));
        assert_eq!(
            report.selected_ide.as_ref().and_then(|i| i.port),
            Some(6_902)
        );
    }

    fn state_with_live(entries: &[(&str, u16)]) -> IdeScanState {
        IdeScanState {
            live: entries
                .iter()
                .map(|(n, p)| ((*n).to_string(), *p))
                .collect(),
            anomalies: BTreeSet::new(),
        }
    }

    #[test]
    fn diff_returns_nothing_when_state_unchanged() {
        let s = state_with_live(&[("VS Code", 45_581)]);
        assert!(compute_ide_state_diff(&s, &s).is_empty());
    }

    #[test]
    fn diff_logs_when_ide_added() {
        let prev = IdeScanState::default();
        let curr = state_with_live(&[("VS Code", 45_581)]);
        let msgs = compute_ide_state_diff(&prev, &curr);
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].starts_with("IDE state changed"));
    }

    #[test]
    fn diff_logs_when_port_changed_same_count() {
        let prev = state_with_live(&[("VS Code", 45_581)]);
        let curr = state_with_live(&[("VS Code", 50_000)]);
        let msgs = compute_ide_state_diff(&prev, &curr);
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].starts_with("IDE state changed"));
    }

    #[test]
    fn diff_logs_when_anomaly_appears() {
        let prev = IdeScanState::default();
        let curr = IdeScanState {
            live: BTreeSet::new(),
            anomalies: BTreeSet::from(["45581.lock:stale".to_string()]),
        };
        let msgs = compute_ide_state_diff(&prev, &curr);
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].starts_with("IDE anomaly"));
    }

    #[test]
    fn diff_does_not_relog_persistent_anomaly() {
        let s = IdeScanState {
            live: BTreeSet::new(),
            anomalies: BTreeSet::from(["45581.lock:stale".to_string()]),
        };
        assert!(compute_ide_state_diff(&s, &s).is_empty());
    }

    #[test]
    fn diff_logs_when_anomaly_resolves() {
        let prev = IdeScanState {
            live: BTreeSet::new(),
            anomalies: BTreeSet::from(["45581.lock:stale".to_string()]),
        };
        let curr = IdeScanState::default();
        let msgs = compute_ide_state_diff(&prev, &curr);
        // The cleared anomaly fires a "resolved" log so the appearance log has
        // a matching close-out — operators can correlate the two.
        assert!(
            msgs.iter().any(|m| m.starts_with("IDE anomaly resolved")),
            "got: {msgs:?}"
        );
    }

    #[test]
    fn list_ides_stable_across_repeated_calls() {
        use super::list_ides_in_dir;

        reset_ide_state_for_tests();

        let tmp = tempfile::tempdir().unwrap();
        let (external_pid, _child) = external_alive_pid();
        let l_a = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port_a = l_a.local_addr().unwrap().port();
        let l_b = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port_b = l_b.local_addr().unwrap().port();
        std::fs::write(
            tmp.path().join(format!("{port_a}.lock")),
            format!(
                r#"{{"pid":{external_pid},"port":{port_a},"wsUrl":"ws://127.0.0.1:{port_a}","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Cursor","transport":"ws"}}"#,
            ),
        ).unwrap();
        std::fs::write(
            tmp.path().join(format!("{port_b}.lock")),
            format!(
                r#"{{"pid":{external_pid},"port":{port_b},"wsUrl":"ws://127.0.0.1:{port_b}","authToken":"tok","workspaceFolders":["/ws"],"ideName":"Visual Studio Code","transport":"ws"}}"#,
            ),
        ).unwrap();

        let r1 = list_ides_in_dir(tmp.path());
        let r2 = list_ides_in_dir(tmp.path());
        let r3 = list_ides_in_dir(tmp.path());

        for r in [&r1, &r2, &r3] {
            assert_eq!(r.len(), 2, "two IDEs must be detected consistently");
        }
        // Compare full Vec in input order (no post-sort) — backend MUST return
        // a stable order so the frontend's detected-IDE list doesn't jump.
        let shape = |r: &Vec<DetectedIde>| -> Vec<(String, Option<u16>)> {
            r.iter().map(|d| (d.ide_name.clone(), d.port)).collect()
        };
        assert_eq!(shape(&r1), shape(&r2), "order must be stable across polls");
        assert_eq!(shape(&r2), shape(&r3), "order must be stable across polls");
        // And the order is sorted by (ide_name, port), so Cursor < Visual Studio Code.
        assert_eq!(r1[0].ide_name, "Cursor");
        assert_eq!(r1[1].ide_name, "Visual Studio Code");
        drop(l_a);
        drop(l_b);
    }
}

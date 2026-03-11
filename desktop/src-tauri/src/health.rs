use std::sync::atomic::{AtomicUsize, Ordering};

use log::{debug, info};
use serde::{Deserialize, Serialize};
use speedwave_runtime::runtime;

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
    is_pid_alive(pid) && {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        std::net::TcpStream::connect_timeout(&addr, IDE_POLL_TIMEOUT).is_ok()
    }
}

/// Returns true if a process with the given PID is currently running.
pub(crate) fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        #[cfg(target_os = "linux")]
        {
            std::path::Path::new(&format!("/proc/{}", pid)).exists()
        }
        #[cfg(not(target_os = "linux"))]
        {
            std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    }
    #[cfg(windows)]
    {
        // `tasklist /FI "PID eq N" /NH` prints "INFO: No tasks are running..."
        // when the PID does not exist. Check for absence of that message rather
        // than substring-matching the PID (which could false-positive on process
        // names, session numbers, or memory columns that contain the same digits).
        speedwave_runtime::binary::system_command("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH"])
            .output()
            .map(|o| {
                let out = String::from_utf8_lossy(&o.stdout);
                o.status.success() && !out.contains("INFO:") && !out.trim().is_empty()
            })
            .unwrap_or(false)
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

pub struct HealthMonitor;

impl HealthMonitor {
    pub fn check_containers(project: &str) -> anyhow::Result<Vec<ContainerHealth>> {
        let rt = runtime::detect_runtime();
        let ps = rt.compose_ps(project)?;
        Ok(parse_container_entries(&ps))
    }
}

/// Parses compose ps JSON entries into `ContainerHealth` structs.
///
/// Handles field name differences across nerdctl versions: `Name`/`name`,
/// `State`/`Status`/`state`/`status`.
fn parse_container_entries(entries: &[serde_json::Value]) -> Vec<ContainerHealth> {
    entries
        .iter()
        .map(|entry| {
            let name = entry
                .get("Name")
                .or_else(|| entry.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
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
        #[cfg(target_os = "linux")]
        {
            VmHealth {
                running: true,
                vm_type: "native".into(),
            }
        }
        #[cfg(target_os = "windows")]
        {
            VmHealth {
                running: runtime::detect_runtime().is_available(),
                vm_type: "WSL2".into(),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            VmHealth {
                running: false,
                vm_type: "unsupported".into(),
            }
        }
    }

    pub fn check_mcp_os() -> McpOsHealth {
        // mcp-os is a child process managed by Tauri (mcp_os_process.rs).
        // Cross-check: token file must exist AND the recorded PID must be alive.
        // Without the PID check, a SIGKILL'd mcp-os would appear healthy indefinitely.
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return McpOsHealth { running: false },
        };
        let data_dir = home.join(speedwave_runtime::consts::DATA_DIR);
        let token_path = data_dir.join("mcp-os-auth-token");
        if !token_path.exists() {
            return McpOsHealth { running: false };
        }
        let pid_path = data_dir.join(speedwave_runtime::consts::MCP_OS_PID_FILE);
        let running = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .is_some_and(is_pid_alive);
        McpOsHealth { running }
    }

    pub fn check_ide_bridge() -> IdeBridgeHealth {
        let detected_ides = list_available_ides();
        let running = !detected_ides.is_empty();
        // Expose first entry with a port in top-level fields for backwards compat
        let first_with_port = detected_ides.iter().find(|i| i.port.is_some());
        let port = first_with_port.and_then(|i| i.port);
        let ws_url = first_with_port.and_then(|i| i.ws_url.clone());
        IdeBridgeHealth {
            running,
            port,
            ws_url,
            detected_ides,
        }
    }
}

/// Scans ~/.claude/ide/*.lock, filters live processes, skips our own PID.
/// Returns all external IDEs visible to Speedwave.
pub fn list_available_ides() -> Vec<DetectedIde> {
    let lock_dir = dirs::home_dir().map(|h| h.join(".claude").join("ide"));
    lock_dir.map(|d| list_ides_in_dir(&d)).unwrap_or_default()
}

/// Tracks the last number of detected IDEs so we only log at `info!` level
/// when the count changes (avoids spam from the 5-second polling cycle).
static LAST_IDE_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Scans `lock_dir/*.lock` for IDE lock files with live PIDs and listening ports.
fn list_ides_in_dir(lock_dir: &std::path::Path) -> Vec<DetectedIde> {
    let Ok(entries) = std::fs::read_dir(lock_dir) else {
        return Vec::new();
    };
    let result: Vec<DetectedIde> = entries
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
            // Skip our own lock file — user wants to see external IDEs only
            let pid = v
                .get("pid")
                .and_then(|x| x.as_u64())
                .and_then(|p| u32::try_from(p).ok());
            if let Some(pid) = pid {
                if pid == std::process::id() {
                    debug!("{filename}: skipped (own PID)");
                    return None;
                }
            }
            // Derive port from filename when missing in JSON (e.g. "<port>.lock")
            let json_port = v
                .get("port")
                .and_then(|x| x.as_u64())
                .and_then(|p| u16::try_from(p).ok());
            let port = json_port.or_else(|| {
                p.file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse::<u16>().ok())
            });
            // Port is required to verify liveness — skip entries without one.
            let Some(port) = port else {
                debug!("{filename}: skipped (no resolvable port)");
                return None;
            };
            let port_source = if json_port.is_some() {
                "json"
            } else {
                "filename"
            };
            // Skip stale lock files where PID is gone or port is no longer listening.
            // IDE_POLL_TIMEOUT (50ms) keeps the synchronous health poll fast even with
            // N stale files. Unlike ide_bridge.rs:cleanup_stale_lock_files() which uses
            // a port-only TCP check with 200ms timeout, health.rs verifies both PID
            // liveness and TCP port reachability via is_lock_entry_alive() — called
            // directly with already-parsed data to avoid a redundant file read.
            let Some(check_pid) = pid else {
                debug!("{filename}: skipped (no valid PID in JSON)");
                return None;
            };
            if !is_lock_entry_alive(check_pid, port) {
                debug!("{filename}: skipped (stale — PID or port not alive)");
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
            debug!("{filename}: alive, ide={ide_name} port={port} (from {port_source})");
            Some(DetectedIde {
                ide_name,
                port: Some(port),
                ws_url,
            })
        })
        .collect();

    let count = result.len();
    let prev = LAST_IDE_COUNT.swap(count, Ordering::Relaxed);
    if count != prev {
        info!("detected IDE count changed: {prev} → {count}");
    }
    debug!(
        "IDE scan complete: {count} live IDE(s) in {}",
        lock_dir.display()
    );

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
        parse_container_entries, ContainerHealth, DetectedIde, HealthMonitor, HealthReport,
        IdeBridgeHealth, McpOsHealth, VmHealth,
    };

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
        #[cfg(target_os = "linux")]
        {
            assert_eq!(vm.vm_type, "native");
            assert!(vm.running);
        }
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
        let result = parse_container_entries(&entries);
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
        let result = parse_container_entries(&entries);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, "Up 5 minutes");
        assert!(result[0].healthy);
    }

    #[test]
    fn parse_missing_fields_returns_unknown() {
        let entries: Vec<serde_json::Value> = serde_json::from_str(r#"[{"ID":"abc"}]"#).unwrap();
        let result = parse_container_entries(&entries);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "unknown");
        assert_eq!(result[0].status, "unknown");
        assert!(!result[0].healthy);
    }

    #[test]
    fn parse_empty_entries() {
        let result = parse_container_entries(&[]);
        assert!(result.is_empty());
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
        let result = parse_container_entries(&entries);
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
}

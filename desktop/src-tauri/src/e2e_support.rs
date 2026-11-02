use std::net::{SocketAddr, TcpListener};
use std::time::{Duration, Instant};

#[cfg(feature = "e2e")]
pub const E2E_WEBDRIVER_PORT: u16 = 4445;

#[cfg(any(test, feature = "e2e"))]
struct SpawnRecord {
    seq: u64,
    tab_id: String,
    args: Vec<String>,
    started: bool,
    awaits_initialize: bool,
}

#[cfg(any(test, feature = "e2e"))]
static SPAWN_RECORDS: std::sync::Mutex<Vec<SpawnRecord>> = std::sync::Mutex::new(Vec::new());

#[cfg(any(test, feature = "e2e"))]
static SPAWN_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(any(test, feature = "e2e"))]
static BOOT_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

#[cfg(any(test, feature = "e2e"))]
pub fn record_spawn_args(tab_id: &str, args: &[String]) {
    if let Ok(mut records) = SPAWN_RECORDS.lock() {
        let seq = SPAWN_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let record = SpawnRecord {
            seq,
            tab_id: tab_id.to_string(),
            args: args.to_vec(),
            started: false,
            awaits_initialize: false,
        };
        match records.iter_mut().find(|r| r.tab_id == tab_id) {
            Some(existing) => *existing = record,
            None => records.push(record),
        }
    }
}

#[cfg(any(test, feature = "e2e"))]
pub fn record_spawn_started(tab_id: &str, awaits_initialize: bool) {
    if let Ok(mut records) = SPAWN_RECORDS.lock() {
        if let Some(record) = records.iter_mut().find(|r| r.tab_id == tab_id) {
            record.started = true;
            record.awaits_initialize = awaits_initialize;
        }
    }
}

#[cfg(any(test, feature = "e2e"))]
pub fn last_spawn_args() -> Vec<String> {
    SPAWN_RECORDS
        .lock()
        .ok()
        .and_then(|records| records.iter().max_by_key(|r| r.seq).map(|r| r.args.clone()))
        .unwrap_or_default()
}

#[cfg(any(test, feature = "e2e"))]
pub fn spawn_args_for(tab_id: &str) -> Option<Vec<String>> {
    SPAWN_RECORDS.lock().ok().and_then(|records| {
        records
            .iter()
            .find(|r| r.tab_id == tab_id)
            .map(|r| r.args.clone())
    })
}

#[cfg(any(test, feature = "e2e"))]
fn boot_id() -> &'static str {
    BOOT_ID.get_or_init(|| {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        format!("{}-{millis}", std::process::id())
    })
}

#[cfg(any(test, feature = "e2e"))]
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ChatSpawn {
    pub boot: String,
    pub seq: u64,
    pub tab_id: String,
    pub args: Vec<String>,
    pub started: bool,
    pub awaits_initialize: bool,
    pub info: &'static str,
}

#[cfg(any(test, feature = "e2e"))]
fn session_info_label(sessions: &crate::chat_registry::ChatSessions, tab_id: &str) -> &'static str {
    use crate::control_channel::SessionInfoState;

    let Some(entry) = sessions.entry(tab_id) else {
        return "gone";
    };
    let Ok(session) = entry.session.try_lock() else {
        return "busy";
    };
    match session.session_info_state() {
        SessionInfoState::Pending => "pending",
        SessionInfoState::Ready { .. } => "ready",
        SessionInfoState::Unavailable => "unavailable",
    }
}

#[cfg(any(test, feature = "e2e"))]
fn chat_spawn(sessions: &crate::chat_registry::ChatSessions) -> Option<ChatSpawn> {
    let (seq, tab_id, args, started, awaits_initialize) = {
        let records = SPAWN_RECORDS.lock().ok()?;
        let latest = records.iter().max_by_key(|r| r.seq)?;
        (
            latest.seq,
            latest.tab_id.clone(),
            latest.args.clone(),
            latest.started,
            latest.awaits_initialize,
        )
    };
    let info = session_info_label(sessions, &tab_id);
    Some(ChatSpawn {
        boot: boot_id().to_string(),
        seq,
        tab_id,
        args,
        started,
        awaits_initialize,
        info,
    })
}

pub fn with_claude_debug(mut args: Vec<String>) -> Vec<String> {
    args.push("--debug-file".to_string());
    args.push("/dev/stderr".to_string());
    args
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_last_spawn_args() -> Vec<String> {
    last_spawn_args()
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_chat_spawn(
    state: tauri::State<'_, crate::chat_registry::SharedChatSessions>,
) -> Option<ChatSpawn> {
    chat_spawn(&state)
}

#[cfg(any(test, feature = "e2e"))]
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AppliedEffort {
    pub seq: u64,
    pub level: String,
}

#[cfg(any(test, feature = "e2e"))]
static LAST_APPLIED_EFFORT: std::sync::Mutex<Option<AppliedEffort>> = std::sync::Mutex::new(None);

#[cfg(any(test, feature = "e2e"))]
pub fn record_applied_effort(level: &str) {
    if let Ok(mut guard) = LAST_APPLIED_EFFORT.lock() {
        let seq = guard.as_ref().map_or(1, |prev| prev.seq + 1);
        *guard = Some(AppliedEffort {
            seq,
            level: level.to_string(),
        });
    }
}

#[cfg(any(test, feature = "e2e"))]
pub fn last_applied_effort() -> Option<AppliedEffort> {
    LAST_APPLIED_EFFORT
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_last_applied_effort() -> Option<AppliedEffort> {
    last_applied_effort()
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_restart_app(app: tauri::AppHandle) {
    app.restart();
}

fn is_retryable_bind_error(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::AddrInUse
        || (cfg!(windows) && e.kind() == std::io::ErrorKind::PermissionDenied)
}

pub fn wait_until_port_free(
    addr: SocketAddr,
    deadline: Duration,
    interval: Duration,
) -> std::io::Result<()> {
    let start = Instant::now();
    loop {
        match TcpListener::bind(addr) {
            Ok(listener) => {
                drop(listener);
                return Ok(());
            }
            Err(e) if is_retryable_bind_error(&e) && start.elapsed() < deadline => {
                std::thread::sleep(interval);
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;

    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn an_e2e_build_spawns_claude_with_its_debug_log_on_stderr() {
        let args = with_claude_debug(vec!["claude".to_string(), "-p".to_string()]);
        assert_eq!(
            args,
            vec!["claude", "-p", "--debug-file", "/dev/stderr"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn spawn_args_are_recorded_per_tab_and_last_wins_globally() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record_spawn_args("tab-a", &["one".to_string()]);
        record_spawn_args("tab-b", &["two".to_string()]);
        assert_eq!(spawn_args_for("tab-a"), Some(vec!["one".to_string()]));
        assert_eq!(spawn_args_for("tab-b"), Some(vec!["two".to_string()]));
        assert_eq!(last_spawn_args(), vec!["two".to_string()]);
        assert_eq!(spawn_args_for("tab-none"), None);
    }

    #[test]
    fn record_overwrites_the_previous_value_for_same_tab() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record_spawn_args("tab-c", &["first".to_string()]);
        record_spawn_args("tab-c", &["second".to_string()]);
        assert_eq!(last_spawn_args(), vec!["second".to_string()]);
        assert_eq!(spawn_args_for("tab-c"), Some(vec!["second".to_string()]));
    }

    fn reset_spawn_records() {
        SPAWN_RECORDS.lock().unwrap().clear();
    }

    fn seq_of(tab_id: &str) -> u64 {
        SPAWN_RECORDS
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.tab_id == tab_id)
            .unwrap()
            .seq
    }

    fn flags_of(tab_id: &str) -> (bool, bool) {
        let records = SPAWN_RECORDS.lock().unwrap();
        let r = records.iter().find(|r| r.tab_id == tab_id).unwrap();
        (r.started, r.awaits_initialize)
    }

    #[test]
    fn spawn_seq_increases_across_tabs_and_respawns_of_one_tab() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_spawn_records();
        record_spawn_args("tab-a", &[]);
        let first = seq_of("tab-a");
        record_spawn_args("tab-b", &[]);
        let second = seq_of("tab-b");
        record_spawn_args("tab-a", &[]);
        let third = seq_of("tab-a");
        assert!(first < second);
        assert!(second < third);
    }

    #[test]
    fn spawn_started_sets_the_flags_only_on_the_named_tab() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_spawn_records();
        record_spawn_args("tab-a", &[]);
        record_spawn_args("tab-b", &[]);
        record_spawn_started("tab-a", true);
        assert_eq!(flags_of("tab-a"), (true, true));
        assert_eq!(flags_of("tab-b"), (false, false));
    }

    #[test]
    fn spawn_started_for_an_unknown_tab_changes_nothing() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_spawn_records();
        record_spawn_args("tab-a", &[]);
        record_spawn_started("tab-none", true);
        assert_eq!(flags_of("tab-a"), (false, false));
        assert_eq!(SPAWN_RECORDS.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_new_record_for_a_tab_resets_the_started_flags() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_spawn_records();
        record_spawn_args("tab-a", &[]);
        record_spawn_started("tab-a", true);
        record_spawn_args("tab-a", &[]);
        assert_eq!(flags_of("tab-a"), (false, false));
    }

    #[test]
    fn boot_id_is_stable_and_shaped_pid_dash_millis() {
        let first = boot_id();
        assert_eq!(first, boot_id());
        let (pid, millis) = first.split_once('-').unwrap();
        assert_eq!(pid, std::process::id().to_string());
        assert!(millis.parse::<u128>().is_ok());
    }

    #[test]
    fn chat_spawn_is_none_without_records() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_spawn_records();
        let sessions = crate::chat_registry::ChatSessions::default();
        assert_eq!(chat_spawn(&sessions), None);
    }

    #[test]
    fn chat_spawn_reports_the_latest_record_with_gone_for_an_unregistered_tab() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_spawn_records();
        let sessions = crate::chat_registry::ChatSessions::default();
        record_spawn_args("tab-a", &["one".to_string()]);
        record_spawn_args("tab-b", &["two".to_string()]);
        record_spawn_started("tab-b", false);
        let spawn = chat_spawn(&sessions).unwrap();
        assert_eq!(spawn.boot, boot_id());
        assert_eq!(spawn.tab_id, "tab-b");
        assert_eq!(spawn.args, vec!["two".to_string()]);
        assert_eq!(spawn.seq, seq_of("tab-b"));
        assert!(spawn.started);
        assert!(!spawn.awaits_initialize);
        assert_eq!(spawn.info, "gone");
    }

    #[test]
    fn chat_spawn_reports_unavailable_for_a_fresh_registered_session() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_spawn_records();
        let sessions = crate::chat_registry::ChatSessions::default();
        sessions.prepare("tab-a", "acme").unwrap();
        record_spawn_args("tab-a", &[]);
        assert_eq!(chat_spawn(&sessions).unwrap().info, "unavailable");
    }

    #[test]
    fn chat_spawn_fields_match_ts_mirror() {
        let ts = include_str!("../../e2e/helpers/spawn-args.ts");
        let interface = ts
            .split("export interface ChatSpawn")
            .nth(1)
            .expect("ChatSpawn interface must exist in spawn-args.ts");
        let body = &interface[..interface.find('}').expect("interface must close")];
        for field in [
            "boot",
            "seq",
            "tab_id",
            "args",
            "started",
            "awaits_initialize",
            "info",
        ] {
            assert!(
                body.contains(&format!("{field}:")),
                "ChatSpawn.{field} missing in the TS mirror"
            );
        }
    }

    #[test]
    fn every_applied_effort_gets_a_newer_sequence_number_than_the_last() {
        record_applied_effort("low");
        let first = last_applied_effort().unwrap();
        record_applied_effort("low");
        let second = last_applied_effort().unwrap();
        record_applied_effort("max");
        let third = last_applied_effort().unwrap();

        assert_eq!(first.level, "low");
        assert!(
            second.seq > first.seq,
            "the same level applied twice is two records"
        );
        assert_eq!(second.level, "low");
        assert!(third.seq > second.seq);
        assert_eq!(third.level, "max");
    }

    #[test]
    fn record_spawn_args_accepts_an_empty_slice() {
        let _g = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record_spawn_args("tab-d", &["marker-nonempty".to_string()]);
        record_spawn_args("tab-d", &[]);
        assert_eq!(last_spawn_args(), Vec::<String>::new());
        assert_eq!(spawn_args_for("tab-d"), Some(Vec::<String>::new()));
    }

    #[test]
    fn returns_immediately_when_port_free() {
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = probe.local_addr().unwrap();
        drop(probe);
        wait_until_port_free(addr, Duration::from_secs(1), Duration::from_millis(10)).unwrap();
    }

    #[test]
    fn waits_until_holder_releases_port() {
        let holder = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = holder.local_addr().unwrap();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(holder);
        });
        wait_until_port_free(addr, Duration::from_secs(10), Duration::from_millis(50)).unwrap();
        t.join().unwrap();
    }

    #[test]
    fn addr_in_use_is_retryable_on_all_platforms() {
        let e = std::io::Error::from(std::io::ErrorKind::AddrInUse);
        assert!(is_retryable_bind_error(&e));
    }

    #[test]
    fn permission_denied_is_retryable_only_on_windows() {
        let e = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(is_retryable_bind_error(&e), cfg!(windows));
    }

    #[test]
    fn other_kinds_are_not_retryable() {
        let e = std::io::Error::from(std::io::ErrorKind::AddrNotAvailable);
        assert!(!is_retryable_bind_error(&e));
    }

    #[test]
    fn errors_with_addr_in_use_at_deadline() {
        let _holder = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = _holder.local_addr().unwrap();
        let err = wait_until_port_free(addr, Duration::from_millis(200), Duration::from_millis(50))
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    }
}

use std::net::{SocketAddr, TcpListener};
use std::time::{Duration, Instant};

pub const E2E_WEBDRIVER_PORT: u16 = 4445;

#[cfg(any(test, feature = "e2e"))]
static SPAWN_ARGS: std::sync::Mutex<
    Option<(String, std::collections::HashMap<String, Vec<String>>)>,
> = std::sync::Mutex::new(None);

#[cfg(any(test, feature = "e2e"))]
pub fn record_spawn_args(tab_id: &str, args: &[String]) {
    if let Ok(mut guard) = SPAWN_ARGS.lock() {
        if let Some((last_id, map)) = guard.as_mut() {
            map.insert(tab_id.to_string(), args.to_vec());
            *last_id = tab_id.to_string();
        } else {
            let mut map = std::collections::HashMap::new();
            map.insert(tab_id.to_string(), args.to_vec());
            *guard = Some((tab_id.to_string(), map));
        }
    }
}

#[cfg(any(test, feature = "e2e"))]
pub fn last_spawn_args() -> Vec<String> {
    SPAWN_ARGS
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .as_ref()
                .and_then(|(last_id, map)| map.get(last_id).cloned())
        })
        .unwrap_or_default()
}

#[cfg(any(test, feature = "e2e"))]
pub fn spawn_args_for(tab_id: &str) -> Option<Vec<String>> {
    SPAWN_ARGS
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|(_, map)| map.get(tab_id).cloned()))
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_last_spawn_args() -> Vec<String> {
    last_spawn_args()
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

    #[test]
    fn spawn_args_are_recorded_per_tab_and_last_wins_globally() {
        record_spawn_args("tab-a", &["one".to_string()]);
        record_spawn_args("tab-b", &["two".to_string()]);
        assert_eq!(spawn_args_for("tab-a"), Some(vec!["one".to_string()]));
        assert_eq!(spawn_args_for("tab-b"), Some(vec!["two".to_string()]));
        assert_eq!(last_spawn_args(), vec!["two".to_string()]);
        assert_eq!(spawn_args_for("tab-none"), None);
    }

    #[test]
    fn record_overwrites_the_previous_value_for_same_tab() {
        record_spawn_args("tab-c", &["first".to_string()]);
        record_spawn_args("tab-c", &["second".to_string()]);
        assert_eq!(last_spawn_args(), vec!["second".to_string()]);
        assert_eq!(spawn_args_for("tab-c"), Some(vec!["second".to_string()]));
    }

    #[test]
    fn record_spawn_args_accepts_an_empty_slice() {
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

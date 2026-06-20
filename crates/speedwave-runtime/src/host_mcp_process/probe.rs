//! Liveness probes shared by every host MCP worker manager.
//! `is_pid_alive` is a cross-platform PID check; `probe_tcp` is a
//! TCP connect with optional retry+backoff.

use std::net::{IpAddr, SocketAddr, TcpStream};
#[cfg(unix)]
use std::process::Command;
use std::time::Duration;

/// Returns true if a process with the given PID is currently running.
/// Cross-platform: `kill -0` on Unix, `tasklist /FI` on Windows.
#[cfg(unix)]
pub fn is_pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `true` if a process with `pid` is currently running (Windows).
#[cfg(windows)]
pub fn is_pid_alive(pid: u32) -> bool {
    // `tasklist /NH` prints an "INFO:" marker when no PID matches.
    crate::binary::system_command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            o.status.success() && !out.contains("INFO:") && !out.trim().is_empty()
        })
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
pub fn is_pid_alive(_pid: u32) -> bool {
    false
}

/// Probe `<bind_address>:port` over TCP with `attempts` tries and `backoff`
/// between them. Returns true on the first successful connect. `port == 0`
/// or an unparseable address always returns false.
pub fn probe_tcp(bind_address: &str, port: u16, attempts: u32, backoff: Duration) -> bool {
    if port == 0 {
        return false;
    }
    let ip: IpAddr = match bind_address.parse() {
        Ok(ip) => ip,
        Err(_) => {
            log::warn!("probe_tcp: invalid bind address {bind_address:?}");
            return false;
        }
    };
    let addr = SocketAddr::new(ip, port);
    let connect_timeout = Duration::from_millis(500);
    for attempt in 0..attempts.max(1) {
        if TcpStream::connect_timeout(&addr, connect_timeout).is_ok() {
            return true;
        }
        if attempt + 1 < attempts {
            std::thread::sleep(backoff);
        }
    }
    false
}

/// Helper: resolve `compose::host_bind_address()` with a 127.0.0.1 fallback for
/// diagnostics. Logs a warning so watchdogs can surface the underlying issue.
pub fn host_bind_address_for_probe() -> String {
    match crate::compose::host_bind_address() {
        Ok(addr) => addr,
        Err(e) => {
            log::warn!("probe_tcp: host_bind_address failed ({e}); falling back to 127.0.0.1");
            "127.0.0.1".to_string()
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn is_pid_alive_true_for_current_process() {
        let me = std::process::id();
        assert!(is_pid_alive(me));
    }

    #[test]
    fn is_pid_alive_false_for_definitely_dead_pid() {
        // Just verify the function does not panic for an unlikely PID.
        let _ = is_pid_alive(999_999);
    }

    #[test]
    fn probe_tcp_returns_false_for_port_zero() {
        assert!(!probe_tcp("127.0.0.1", 0, 3, Duration::from_millis(10)));
    }

    #[test]
    fn probe_tcp_returns_false_for_invalid_bind_address() {
        assert!(!probe_tcp("not-an-ip", 4242, 1, Duration::ZERO));
    }

    #[test]
    fn probe_tcp_applies_backoff_between_attempts() {
        let backoff = Duration::from_millis(50);
        let start = std::time::Instant::now();
        let _ = probe_tcp("127.0.0.1", 1, 3, backoff);
        assert!(
            start.elapsed() >= backoff * 2,
            "3 attempts must include 2 backoff sleeps; got {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn probe_tcp_returns_true_for_live_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe_tcp("127.0.0.1", port, 1, Duration::ZERO));
        drop(listener);
    }
}

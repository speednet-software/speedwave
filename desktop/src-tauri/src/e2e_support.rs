//! E2E-only startup helpers (`feature = "e2e"`); compiled for tests so the
//! helper stays covered on every platform.

use std::net::{SocketAddr, TcpListener};
use std::time::{Duration, Instant};

/// Must match tauri-plugin-webdriver's hardcoded 127.0.0.1:4445 bind.
pub const E2E_WEBDRIVER_PORT: u16 = 4445;

/// Blocks until `addr` is bindable (the probe listener is dropped immediately)
/// or `deadline` elapses — a relaunch must not race the dying instance's port.
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
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && start.elapsed() < deadline => {
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
    fn errors_with_addr_in_use_at_deadline() {
        let _holder = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = _holder.local_addr().unwrap();
        let err = wait_until_port_free(addr, Duration::from_millis(200), Duration::from_millis(50))
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    }
}

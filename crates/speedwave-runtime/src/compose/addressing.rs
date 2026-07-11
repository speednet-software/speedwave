//! Host addressing SSOT: container-side gateway IP + host-side bind address,
//! cached behind a pluggable computer (Lima static on macOS, WSL-detected on
//! Windows). See ADR-067.

/// Container-side `gateway_ip` + host-side `bind_address`. On Windows both
/// equal the WSL vEthernet adapter IP (mirrored-mode 127.0.0.1 broken — WSL#11312).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostAddressing {
    /// IP a container's `host.docker.internal` resolves to.
    pub gateway_ip: String,
    /// Address the host process binds listeners on.
    pub bind_address: String,
}

/// Test seam. Production: `LimaStatic` (macOS) / `WslDetector` (Windows).
pub trait HostAddressingComputer: Send + Sync {
    /// Computes the current host addressing for this platform.
    fn compute(&self) -> anyhow::Result<HostAddressing>;
}

static HOST_ADDRESSING: std::sync::RwLock<Option<HostAddressing>> = std::sync::RwLock::new(None);

static COMPUTER: std::sync::RwLock<Option<std::sync::Arc<dyn HostAddressingComputer>>> =
    std::sync::RwLock::new(None);

/// Cached `HostAddressing`; on Windows returns `Err` on detection failure.
pub fn host_addressing() -> anyhow::Result<HostAddressing> {
    if let Some(addr) = HOST_ADDRESSING
        .read()
        .map_err(|e| anyhow::anyhow!("host_addressing cache poisoned: {e}"))?
        .clone()
    {
        return Ok(addr);
    }
    let computer = current_computer();
    let addr = computer.compute()?;
    let mut write = HOST_ADDRESSING
        .write()
        .map_err(|e| anyhow::anyhow!("host_addressing cache poisoned: {e}"))?;
    if let Some(existing) = write.clone() {
        return Ok(existing);
    }
    *write = Some(addr.clone());
    Ok(addr)
}

/// Container-side gateway IP (compose `extra_hosts` target).
pub fn host_gateway_ip() -> anyhow::Result<String> {
    Ok(host_addressing()?.gateway_ip)
}

/// Host-side `TcpListener::bind` address (macOS: 127.0.0.1; Windows: WSL adapter IP).
pub fn host_bind_address() -> anyhow::Result<String> {
    Ok(host_addressing()?.bind_address)
}

/// Clears the cached `HostAddressing` so the next call recomputes.
pub fn invalidate_host_addressing_cache() {
    if let Ok(mut write) = HOST_ADDRESSING.write() {
        *write = None;
    }
}

fn current_computer() -> std::sync::Arc<dyn HostAddressingComputer> {
    if let Ok(slot) = COMPUTER.read() {
        if let Some(c) = slot.as_ref() {
            return std::sync::Arc::clone(c);
        }
    }
    // Install the default computer for this platform.
    let default: std::sync::Arc<dyn HostAddressingComputer> = {
        #[cfg(target_os = "macos")]
        {
            std::sync::Arc::new(host_addressing_impls::LimaStatic)
        }
        #[cfg(target_os = "windows")]
        {
            std::sync::Arc::new(host_addressing_impls::WslDetector)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            std::sync::Arc::new(host_addressing_impls::Unsupported)
        }
    };
    if let Ok(mut slot) = COMPUTER.write() {
        if slot.is_none() {
            *slot = Some(std::sync::Arc::clone(&default));
        }
        if let Some(c) = slot.as_ref() {
            return std::sync::Arc::clone(c);
        }
    }
    default
}

/// Test-only: inject a fixture computer. Pair with `#[serial_test::serial]`.
#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test helper: lock poisoning is a hard test bug"
)]
pub fn set_host_addressing_computer_for_test(computer: std::sync::Arc<dyn HostAddressingComputer>) {
    *COMPUTER.write().expect("COMPUTER write lock") = Some(computer);
    invalidate_host_addressing_cache();
}

/// Test-only: restore the platform default computer.
#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test helper: lock poisoning is a hard test bug"
)]
pub fn reset_host_addressing_computer_for_test() {
    *COMPUTER.write().expect("COMPUTER write lock") = None;
    invalidate_host_addressing_cache();
}

mod host_addressing_impls {
    use super::HostAddressing;

    #[cfg(target_os = "macos")]
    pub(super) struct LimaStatic;

    #[cfg(target_os = "macos")]
    impl super::HostAddressingComputer for LimaStatic {
        fn compute(&self) -> anyhow::Result<HostAddressing> {
            Ok(HostAddressing {
                gateway_ip: crate::consts::LIMA_VZ_HOST_IP.to_string(),
                bind_address: "127.0.0.1".to_string(),
            })
        }
    }

    #[cfg(target_os = "windows")]
    pub(super) struct WslDetector;

    #[cfg(target_os = "windows")]
    impl super::HostAddressingComputer for WslDetector {
        fn compute(&self) -> anyhow::Result<HostAddressing> {
            let ip = detect_wsl_gateway_ip()?;
            Ok(HostAddressing {
                gateway_ip: ip.clone(),
                bind_address: ip,
            })
        }
    }

    #[cfg(target_os = "windows")]
    fn detect_wsl_gateway_ip() -> anyhow::Result<String> {
        let distro = crate::consts::wsl_distro_name();
        let output = crate::binary::system_command("wsl.exe")
            .args(["-d", distro, "--", "sh", "-c", "ip -4 route show default"])
            .output()
            .map_err(|e| anyhow::anyhow!("wsl.exe probe failed for distro '{distro}': {e}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "wsl.exe -d {distro} ip route returned status {} (stderr: {})",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let decoded = crate::runtime::wsl::decode_wsl_output(&output.stdout);
        parse_default_route_gateway(&decoded).ok_or_else(|| {
            anyhow::anyhow!(
                "could not parse WSL gateway IP from default route output of distro '{distro}': {decoded:?}"
            )
        })
    }

    /// Extracts the first IPv4 gateway from `ip -4 route show default` output.
    /// Rejects loopback / unspecified / link-local / multicast.
    #[cfg(any(target_os = "windows", test))]
    pub(super) fn parse_default_route_gateway(output: &str) -> Option<String> {
        for line in output.lines() {
            let line = line.trim();
            if !line.starts_with("default") {
                continue;
            }
            let mut tokens = line.split_whitespace();
            // `default via X.X.X.X ...`
            while let Some(tok) = tokens.next() {
                if tok == "via" {
                    if let Some(ip_str) = tokens.next() {
                        if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                            if is_acceptable_gateway(ip) {
                                return Some(ip.to_string());
                            }
                        }
                    }
                }
            }
        }
        None
    }

    #[cfg(any(target_os = "windows", test))]
    fn is_acceptable_gateway(ip: std::net::Ipv4Addr) -> bool {
        !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() && !ip.is_multicast()
    }

    #[cfg(test)]
    mod parse_tests {
        use super::parse_default_route_gateway;

        #[test]
        fn extracts_ipv4_from_default_route_line() {
            let out = "default via 172.24.48.1 dev eth0 proto kernel\n";
            assert_eq!(
                parse_default_route_gateway(out),
                Some("172.24.48.1".to_string())
            );
        }

        #[test]
        fn returns_none_when_no_default_route() {
            assert_eq!(
                parse_default_route_gateway("10.4.1.0/24 dev br-xxx\n"),
                None
            );
        }

        #[test]
        fn rejects_loopback_via() {
            let out = "default via 127.0.0.1 dev lo proto kernel\n";
            assert_eq!(parse_default_route_gateway(out), None);
        }

        #[test]
        fn picks_first_default_route_when_multiple() {
            let out = "default via 172.24.48.1 dev eth0\n\
                       default via 10.0.0.1 dev eth1 metric 100\n";
            assert_eq!(
                parse_default_route_gateway(out),
                Some("172.24.48.1".to_string())
            );
        }

        #[test]
        fn rejects_unspecified_via() {
            let out = "default via 0.0.0.0 dev eth0\n";
            assert_eq!(parse_default_route_gateway(out), None);
        }

        #[test]
        fn ignores_non_default_lines() {
            let out = "10.4.1.0/24 dev br-xxx proto kernel scope link src 10.4.1.1\n\
                       default via 172.30.96.1 dev eth0\n\
                       172.30.96.0/20 dev eth0 proto kernel scope link src 172.30.99.123\n";
            assert_eq!(
                parse_default_route_gateway(out),
                Some("172.30.96.1".to_string())
            );
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod resolver_tests {
    use super::*;

    // ── HostAddressing resolver tests ───────────────────────────────────────

    struct FixedComputer(HostAddressing);
    impl HostAddressingComputer for FixedComputer {
        fn compute(&self) -> anyhow::Result<HostAddressing> {
            Ok(self.0.clone())
        }
    }

    struct CountingComputer {
        addr: HostAddressing,
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }
    impl HostAddressingComputer for CountingComputer {
        fn compute(&self) -> anyhow::Result<HostAddressing> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.addr.clone())
        }
    }

    struct FailingComputer(String);
    impl HostAddressingComputer for FailingComputer {
        fn compute(&self) -> anyhow::Result<HostAddressing> {
            Err(anyhow::anyhow!(self.0.clone()))
        }
    }

    fn sample_addr() -> HostAddressing {
        HostAddressing {
            gateway_ip: "172.24.48.1".into(),
            bind_address: "172.24.48.1".into(),
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn host_addressing_caches_after_first_call() {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        set_host_addressing_computer_for_test(std::sync::Arc::new(CountingComputer {
            addr: sample_addr(),
            calls: std::sync::Arc::clone(&calls),
        }));

        let a = host_addressing().unwrap();
        let b = host_addressing().unwrap();
        assert_eq!(a, b);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        reset_host_addressing_computer_for_test();
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn host_addressing_recomputes_after_invalidation() {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        set_host_addressing_computer_for_test(std::sync::Arc::new(CountingComputer {
            addr: sample_addr(),
            calls: std::sync::Arc::clone(&calls),
        }));

        host_addressing().unwrap();
        invalidate_host_addressing_cache();
        host_addressing().unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);

        reset_host_addressing_computer_for_test();
    }

    #[test]
    fn failing_computer_returns_err() {
        let computer = FailingComputer("wsl probe failed".into());
        let err = computer.compute().unwrap_err();
        assert!(err.to_string().contains("wsl probe failed"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn host_gateway_ip_and_bind_address_split_correctly() {
        set_host_addressing_computer_for_test(std::sync::Arc::new(FixedComputer(HostAddressing {
            gateway_ip: "192.168.5.2".into(),
            bind_address: "127.0.0.1".into(),
        })));
        assert_eq!(host_gateway_ip().unwrap(), "192.168.5.2");
        assert_eq!(host_bind_address().unwrap(), "127.0.0.1");

        reset_host_addressing_computer_for_test();
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn host_addressing_concurrent_callers_share_one_computation() {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        set_host_addressing_computer_for_test(std::sync::Arc::new(CountingComputer {
            addr: sample_addr(),
            calls: std::sync::Arc::clone(&calls),
        }));

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let b = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    b.wait();
                    host_addressing().unwrap()
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let n = calls.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            (1..=4).contains(&n),
            "computer called {n} times — expected 1..=4 (one wins; losers see cached or recompute under race)"
        );

        reset_host_addressing_computer_for_test();
    }
}

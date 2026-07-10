//! Host addressing SSOT: container-side gateway IP + host-side bind address,
//! cached behind a pluggable computer (Lima static on macOS, WSL-detected on
//! Windows). See ADR-067.

/// Container-side `gateway_ip` + host-side `bind_address`. On Windows NAT both equal the
/// WSL adapter IP; mirrored mode splits them (bind `127.0.0.1`, gateway = relay IP) — ADR-079.
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

/// Host-side `TcpListener::bind` address (macOS / mirrored WSL: 127.0.0.1; NAT WSL: adapter IP).
pub fn host_bind_address() -> anyhow::Result<String> {
    Ok(host_addressing()?.bind_address)
}

/// Container-facing relay port for a bridge bound on `bind_port`, or `None` when no relay
/// is needed. `Some(bind_port ^ 0x4000)` under WSL2 mirrored mode — except `16384` (whose
/// XOR is the invalid port 0), remapped to a valid distinct port. See ADR-079.
pub fn mirror_relay_port(bind_port: u16) -> Option<u16> {
    match host_gateway_ip() {
        Ok(gw) if gw == crate::consts::MIRROR_RELAY_GATEWAY_IP => {
            // 16384 ^ 0x4000 == 0 (the one invalid result); flip a different bit so the
            // relay port stays valid and distinct from the bind port.
            let relay = bind_port ^ 0x4000;
            Some(if relay == 0 {
                bind_port ^ 0x6000
            } else {
                relay
            })
        }
        Ok(_) => None,
        Err(e) => {
            // On a mirrored host this silently skips relay setup — warn (not debug): a
            // transient detection failure is exactly the distro-restart case we heal.
            log::warn!("mirror_relay_port: host addressing unavailable, relay disabled: {e}");
            None
        }
    }
}

/// The port a container should dial to reach a host listener bound on `bind_port`: the
/// mirror relay port under WSL2 mirrored mode, else `bind_port` unchanged (ADR-079).
/// The one SSOT for translating a host-worker/bridge port into its container-facing form.
pub fn container_facing_port(bind_port: u16) -> u16 {
    mirror_relay_port(bind_port).unwrap_or(bind_port)
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
        // Tests must never reach the real platform detector: it makes addressing
        // host-dependent (a mirrored dev machine XOR-translates worker ports) and races
        // the global cache. Default to deterministic NAT; mirrored-mode tests pin the seam.
        #[cfg(test)]
        {
            std::sync::Arc::new(FixedComputer(HostAddressing {
                gateway_ip: "192.168.5.2".to_string(),
                bind_address: "127.0.0.1".to_string(),
            }))
        }
        #[cfg(all(target_os = "macos", not(test)))]
        {
            std::sync::Arc::new(host_addressing_impls::LimaStatic)
        }
        #[cfg(all(target_os = "windows", not(test)))]
        {
            std::sync::Arc::new(host_addressing_impls::WslDetector)
        }
        #[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
pub fn set_host_addressing_computer_for_test(computer: std::sync::Arc<dyn HostAddressingComputer>) {
    *COMPUTER.write().expect("COMPUTER write lock") = Some(computer);
    invalidate_host_addressing_cache();
}

/// Test-only: restore the platform default computer.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
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

    #[cfg(all(target_os = "windows", not(test)))]
    pub(super) struct WslDetector;

    #[cfg(all(target_os = "windows", not(test)))]
    impl super::HostAddressingComputer for WslDetector {
        fn compute(&self) -> anyhow::Result<HostAddressing> {
            let gateway = detect_wsl_gateway_ip()?;
            Ok(addressing_from(&gateway, host_can_bind))
        }
    }

    /// Splits the WSL gateway into the addressing pair: bindable → NAT host adapter (both
    /// halves); non-bindable → mirrored mode (bind loopback, expose the relay). ADR-079.
    #[cfg(any(target_os = "windows", test))]
    fn addressing_from(gateway: &str, can_bind: impl Fn(&str) -> bool) -> HostAddressing {
        if can_bind(gateway) {
            HostAddressing {
                gateway_ip: gateway.to_string(),
                bind_address: gateway.to_string(),
            }
        } else {
            HostAddressing {
                gateway_ip: crate::consts::MIRROR_RELAY_GATEWAY_IP.to_string(),
                bind_address: "127.0.0.1".to_string(),
            }
        }
    }

    /// True if the host can bind a listener on `ip` (an ephemeral port). Used to tell
    /// a host-local NAT gateway apart from a non-local mirrored-mode gateway.
    #[cfg(any(target_os = "windows", test))]
    fn host_can_bind(ip: &str) -> bool {
        ip.parse::<std::net::Ipv4Addr>()
            .ok()
            .is_some_and(|addr| std::net::TcpListener::bind((addr, 0)).is_ok())
    }

    #[cfg(all(target_os = "windows", not(test)))]
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

        #[test]
        fn nat_gateway_bindable_uses_gateway_for_both_halves() {
            let a = super::addressing_from("172.24.48.1", |_| true);
            assert_eq!(a.gateway_ip, "172.24.48.1");
            assert_eq!(a.bind_address, "172.24.48.1");
        }

        #[test]
        fn mirrored_gateway_unbindable_splits_to_relay_and_loopback() {
            let a = super::addressing_from("192.168.68.1", |_| false);
            assert_eq!(a.gateway_ip, crate::consts::MIRROR_RELAY_GATEWAY_IP);
            assert_eq!(a.bind_address, "127.0.0.1");
        }

        #[test]
        fn host_can_bind_true_for_loopback_false_for_nonlocal() {
            assert!(super::host_can_bind("127.0.0.1"));
            // TEST-NET-1 (RFC 5737) is never assigned to a local interface.
            assert!(!super::host_can_bind("192.0.2.1"));
            assert!(!super::host_can_bind("not-an-ip"));
        }
    }
}

/// Test double returning a fixed `HostAddressing`; shared by addressing + compose tests.
#[cfg(test)]
pub struct FixedComputer(pub HostAddressing);
#[cfg(test)]
impl HostAddressingComputer for FixedComputer {
    fn compute(&self) -> anyhow::Result<HostAddressing> {
        Ok(self.0.clone())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod resolver_tests {
    use super::*;

    // ── HostAddressing resolver tests ───────────────────────────────────────

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
    fn mirror_relay_port_only_under_mirrored() {
        set_host_addressing_computer_for_test(std::sync::Arc::new(FixedComputer(HostAddressing {
            gateway_ip: crate::consts::MIRROR_RELAY_GATEWAY_IP.into(),
            bind_address: "127.0.0.1".into(),
        })));
        assert_eq!(mirror_relay_port(60123), Some(60123 ^ 0x4000));
        assert_ne!(mirror_relay_port(60123), Some(60123));

        // 16384 ^ 0x4000 == 0 (invalid port); must map to something valid and distinct.
        let relay_16384 = mirror_relay_port(16384).expect("mirrored → Some");
        assert_ne!(relay_16384, 0, "relay port must never be 0");
        assert_ne!(
            relay_16384, 16384,
            "relay port must differ from the bind port"
        );

        set_host_addressing_computer_for_test(std::sync::Arc::new(FixedComputer(HostAddressing {
            gateway_ip: "192.168.5.2".into(),
            bind_address: "127.0.0.1".into(),
        })));
        assert_eq!(mirror_relay_port(60123), None);

        // Detection failure disables the relay (returns None, logged at debug).
        set_host_addressing_computer_for_test(std::sync::Arc::new(FailingComputer("boom".into())));
        assert_eq!(mirror_relay_port(60123), None);

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

//! Host addressing SSOT: container-side gateway IP + host-side bind address,
//! cached behind a pluggable computer (Lima static on macOS, WSL-detected on
//! Windows). See ADR-067.

/// How containers reach host listeners: dialing `gateway_ip` with the raw bind port
/// (`Direct`), or via the ADR-079 guest relay with `relay_port_for`-translated ports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressingMode {
    /// Containers dial `gateway_ip:<bind port>` unchanged (macOS Lima, Windows NAT).
    Direct,
    /// WSL2 mirrored: containers dial the guest relay at `relay_port_for(bind)` (ADR-079).
    MirroredRelay,
}

/// Container-side `gateway_ip` + host-side `bind_address`. On Windows NAT both equal the
/// WSL adapter IP; mirrored mode splits them (bind `127.0.0.1`, gateway = relay IP) — ADR-079.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostAddressing {
    /// IP a container's `host.docker.internal` resolves to.
    pub gateway_ip: String,
    /// Address the host process binds listeners on.
    pub bind_address: String,
    /// Explicit mode — never inferred from `gateway_ip` (a user-pinned WSL NAT subnet
    /// can legitimately equal the relay IP and must not trigger port translation).
    pub mode: AddressingMode,
}

impl HostAddressing {
    /// Direct addressing: containers dial `gateway_ip:<bind port>` unchanged.
    pub fn direct(gateway_ip: impl Into<String>, bind_address: impl Into<String>) -> Self {
        Self {
            gateway_ip: gateway_ip.into(),
            bind_address: bind_address.into(),
            mode: AddressingMode::Direct,
        }
    }

    /// WSL2 mirrored-relay addressing (ADR-079): loopback bind, guest relay gateway.
    pub fn mirrored_relay() -> Self {
        Self {
            gateway_ip: crate::consts::MIRROR_RELAY_GATEWAY_IP.to_string(),
            bind_address: "127.0.0.1".to_string(),
            mode: AddressingMode::MirroredRelay,
        }
    }
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

/// De-duplicates the detection-failure warning across poll loops (reset on success).
static RELAY_DETECT_WARNED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Container-facing relay port for a host listener on `bind_port`: `Some` only under
/// WSL2 mirrored mode (ADR-079); the mapping is the fixed bijection `relay_port_for`.
pub fn mirror_relay_port(bind_port: u16) -> Option<u16> {
    match host_addressing() {
        Ok(addr) => {
            RELAY_DETECT_WARNED.store(false, std::sync::atomic::Ordering::Relaxed);
            (addr.mode == AddressingMode::MirroredRelay).then(|| relay_port_for(bind_port))
        }
        Err(e) => {
            // Warn once per failure streak, not per 30 s watchdog poll; errors stay
            // uncached upstream so the relay heals as soon as detection recovers.
            if !RELAY_DETECT_WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                log::warn!("mirror_relay_port: host addressing unavailable, relay disabled: {e}");
            }
            None
        }
    }
}

/// Fixed bijection bind → relay port over `1..=65535`: XOR `0x4000`, except the 3-cycle
/// 16384→49152→32768→16384 routing around 16384's invalid XOR image of port 0.
fn relay_port_for(bind_port: u16) -> u16 {
    match bind_port {
        0x4000 => 0xC000,
        0x8000 => 0x4000,
        p => p ^ 0x4000,
    }
}

/// The port a container dials to reach a host listener bound on `bind_port`: the relay
/// port under WSL2 mirrored mode, else unchanged. The one bind→container port SSOT.
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
        // Deterministic under tests/test-support: the real detector makes addressing
        // host-dependent and spawns wsl.exe from dependent crates' tests (ADR-079).
        #[cfg(any(test, feature = "test-support"))]
        {
            std::sync::Arc::new(FixedComputer(HostAddressing::direct(
                crate::consts::LIMA_VZ_HOST_IP,
                "127.0.0.1",
            )))
        }
        #[cfg(all(target_os = "macos", not(any(test, feature = "test-support"))))]
        {
            std::sync::Arc::new(host_addressing_impls::LimaStatic)
        }
        #[cfg(all(target_os = "windows", not(any(test, feature = "test-support"))))]
        {
            std::sync::Arc::new(host_addressing_impls::WslDetector)
        }
        #[cfg(all(
            not(any(target_os = "macos", target_os = "windows")),
            not(any(test, feature = "test-support"))
        ))]
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

/// Test seam: inject a fixture computer. Pair with `#[serial_test::serial(host_addressing)]`.
#[cfg(any(test, feature = "test-support"))]
pub fn set_host_addressing_computer_for_test(computer: std::sync::Arc<dyn HostAddressingComputer>) {
    if let Ok(mut slot) = COMPUTER.write() {
        *slot = Some(computer);
    }
    invalidate_host_addressing_cache();
}

/// Test seam: restore the platform default computer.
#[cfg(any(test, feature = "test-support"))]
pub fn reset_host_addressing_computer_for_test() {
    if let Ok(mut slot) = COMPUTER.write() {
        *slot = None;
    }
    invalidate_host_addressing_cache();
}

/// RAII pin from `pin_direct_addressing`/`pin_mirrored_addressing`: restores the platform
/// default on drop (panic-safe). Pair with `#[serial_test::serial(host_addressing)]`.
#[cfg(any(test, feature = "test-support"))]
pub struct AddressingGuard(());

#[cfg(any(test, feature = "test-support"))]
impl Drop for AddressingGuard {
    fn drop(&mut self) {
        reset_host_addressing_computer_for_test();
    }
}

/// Pins Direct (non-mirrored) addressing with the given gateway; bind stays loopback.
#[cfg(any(test, feature = "test-support"))]
pub fn pin_direct_addressing(gateway_ip: &str) -> AddressingGuard {
    set_host_addressing_computer_for_test(std::sync::Arc::new(FixedComputer(
        HostAddressing::direct(gateway_ip, "127.0.0.1"),
    )));
    AddressingGuard(())
}

/// Pins WSL2 mirrored-relay addressing (ADR-079) — container-facing ports translate.
#[cfg(any(test, feature = "test-support"))]
pub fn pin_mirrored_addressing() -> AddressingGuard {
    set_host_addressing_computer_for_test(std::sync::Arc::new(FixedComputer(
        HostAddressing::mirrored_relay(),
    )));
    AddressingGuard(())
}

mod host_addressing_impls {
    // Gate shared by the WSL detector's helpers: compiled for the production Windows
    // detector or for unit tests — never for the test-support fixed-computer builds.
    #[cfg(any(
        all(target_os = "windows", not(any(test, feature = "test-support"))),
        test
    ))]
    use super::HostAddressing;

    #[cfg(all(target_os = "macos", not(any(test, feature = "test-support"))))]
    pub(super) struct LimaStatic;

    #[cfg(all(target_os = "macos", not(any(test, feature = "test-support"))))]
    impl super::HostAddressingComputer for LimaStatic {
        fn compute(&self) -> anyhow::Result<super::HostAddressing> {
            Ok(super::HostAddressing::direct(
                crate::consts::LIMA_VZ_HOST_IP,
                "127.0.0.1",
            ))
        }
    }

    #[cfg(all(target_os = "windows", not(any(test, feature = "test-support"))))]
    pub(super) struct WslDetector;

    #[cfg(all(target_os = "windows", not(any(test, feature = "test-support"))))]
    impl super::HostAddressingComputer for WslDetector {
        fn compute(&self) -> anyhow::Result<HostAddressing> {
            let gateway = detect_wsl_gateway_ip()?;
            Ok(addressing_from(&gateway, host_can_bind))
        }
    }

    /// Splits the WSL gateway into the addressing pair: host-bindable → NAT (Direct,
    /// both halves = gateway); non-bindable → mirrored relay mode. ADR-079.
    #[cfg(any(
        all(target_os = "windows", not(any(test, feature = "test-support"))),
        test
    ))]
    fn addressing_from(gateway: &str, can_bind: impl Fn(&str) -> bool) -> HostAddressing {
        if can_bind(gateway) {
            log::info!("WSL2 addressing: NAT — gateway {gateway} is host-bindable");
            HostAddressing::direct(gateway, gateway)
        } else {
            log::info!(
                "WSL2 addressing: mirrored — gateway {gateway} not host-bindable; relaying via {}",
                crate::consts::MIRROR_RELAY_GATEWAY_IP
            );
            HostAddressing::mirrored_relay()
        }
    }

    /// True if the host can bind a listener on `ip` (an ephemeral port) — tells a
    /// host-local NAT gateway apart from a non-local mirrored-mode gateway.
    #[cfg(any(
        all(target_os = "windows", not(any(test, feature = "test-support"))),
        test
    ))]
    fn host_can_bind(ip: &str) -> bool {
        match ip.parse::<std::net::Ipv4Addr>() {
            Ok(addr) => std::net::TcpListener::bind((addr, 0)).is_ok(),
            Err(e) => {
                log::warn!(
                    "host_can_bind: WSL gateway {ip:?} unparseable ({e}); assuming mirrored"
                );
                false
            }
        }
    }

    #[cfg(all(target_os = "windows", not(any(test, feature = "test-support"))))]
    fn detect_wsl_gateway_ip() -> anyhow::Result<String> {
        let distro = crate::consts::wsl_distro_name();
        let child = crate::binary::system_command("wsl.exe")
            .args(["-d", distro, "--", "sh", "-c", "ip -4 route show default"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| anyhow::anyhow!("wsl.exe probe failed for distro '{distro}': {e}"))?;
        // Bounded: watchdog ticks (and the joins in `stop()`) reach this probe — a
        // wedged wsl.exe must never pin them indefinitely.
        let output =
            crate::binary::wait_with_output_timeout(child, std::time::Duration::from_secs(15))
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
    #[cfg(any(
        all(target_os = "windows", not(any(test, feature = "test-support"))),
        test
    ))]
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

    #[cfg(any(
        all(target_os = "windows", not(any(test, feature = "test-support"))),
        test
    ))]
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
            assert_eq!(a.mode, super::super::AddressingMode::Direct);
        }

        #[test]
        fn mirrored_gateway_unbindable_splits_to_relay_and_loopback() {
            let a = super::addressing_from("192.168.68.1", |_| false);
            assert_eq!(a.gateway_ip, crate::consts::MIRROR_RELAY_GATEWAY_IP);
            assert_eq!(a.bind_address, "127.0.0.1");
            assert_eq!(a.mode, super::super::AddressingMode::MirroredRelay);
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
#[cfg(any(test, feature = "test-support"))]
pub struct FixedComputer(pub HostAddressing);
#[cfg(any(test, feature = "test-support"))]
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
        HostAddressing::direct("172.24.48.1", "172.24.48.1")
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
        let _guard = pin_direct_addressing(crate::consts::LIMA_VZ_HOST_IP);
        assert_eq!(host_gateway_ip().unwrap(), crate::consts::LIMA_VZ_HOST_IP);
        assert_eq!(host_bind_address().unwrap(), "127.0.0.1");
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn mirror_relay_port_only_under_mirrored() {
        let _mirrored = pin_mirrored_addressing();
        assert_eq!(mirror_relay_port(60123), Some(60123 ^ 0x4000));
        assert_ne!(mirror_relay_port(60123), Some(60123));

        // 16384's XOR image is 0 (invalid); the bijection swaps it with 32768's.
        assert_eq!(mirror_relay_port(0x4000), Some(0xC000));
        assert_eq!(mirror_relay_port(0x8000), Some(0x4000));

        let _direct = pin_direct_addressing(crate::consts::LIMA_VZ_HOST_IP);
        assert_eq!(mirror_relay_port(60123), None);

        // Detection failure disables the relay (None; warned once per failure streak).
        set_host_addressing_computer_for_test(std::sync::Arc::new(FailingComputer("boom".into())));
        assert_eq!(mirror_relay_port(60123), None);
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn direct_gateway_equal_to_relay_ip_does_not_translate() {
        // A user-pinned WSL NAT subnet can legitimately yield a bindable 10.200.0.1
        // gateway; Direct mode must never XOR-translate ports (mode beats IP). ADR-079.
        let _guard = pin_direct_addressing(crate::consts::MIRROR_RELAY_GATEWAY_IP);
        assert_eq!(mirror_relay_port(60123), None);
        assert_eq!(container_facing_port(60123), 60123);
    }

    #[test]
    fn relay_port_mapping_is_bijective_valid_and_never_identity() {
        let mut seen = vec![false; 65536];
        for bind in 1..=u16::MAX {
            let relay = relay_port_for(bind);
            assert_ne!(relay, 0, "bind {bind} mapped to invalid port 0");
            assert_ne!(relay, bind, "bind {bind} mapped to itself");
            assert!(
                !seen[relay as usize],
                "relay {relay} claimed twice (bind {bind})"
            );
            seen[relay as usize] = true;
        }
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

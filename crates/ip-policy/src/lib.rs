//! SSOT for the private/reserved IP address predicate, std-only so the host
//! runtime and the standalone proxy workspace share one copy.

/// Returns `true` if the given IP address is loopback, private, link-local,
/// or otherwise reserved (not globally routable).
pub fn is_private_or_reserved(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_unspecified()
                || v4.is_link_local()
                || v4.octets()[0] == 0
                || v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64
                || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 2)
                || (v4.octets()[0] == 198 && v4.octets()[1] == 51 && v4.octets()[2] == 100)
                || (v4.octets()[0] == 203 && v4.octets()[1] == 0 && v4.octets()[2] == 113)
                || (v4.octets()[0] == 198 && (v4.octets()[1] & 0xfe) == 18)
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || (v6.segments()[0] & 0xffc0) == 0xfec0
                || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8)
                || (v6.segments()[0] == 0x0100
                    && v6.segments()[1] == 0
                    && v6.segments()[2] == 0
                    && v6.segments()[3] == 0)
                || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0)
                || (v6.segments()[0] == 0x0064
                    && v6.segments()[1] == 0xff9b
                    && v6.segments()[2] == 0x0001)
        }
    }
}

/// The IPv4 address an IPv6 address carries: IPv4-mapped, IPv4-compatible (not `::`/`::1`),
/// well-known NAT64 `64:ff9b::/96` or 6to4 `2002::/16`; callers apply the predicate to both.
pub fn embedded_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let s = v6.segments();
    let [a, b] = s[6].to_be_bytes();
    let [c, d] = s[7].to_be_bytes();
    let tail = std::net::Ipv4Addr::new(a, b, c, d);
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    if s[..6] == [0; 6] {
        return (!v6.is_unspecified() && !v6.is_loopback()).then_some(tail);
    }
    if s[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        return Some(tail);
    }
    if s[0] == 0x2002 {
        let [a, b] = s[1].to_be_bytes();
        let [c, d] = s[2].to_be_bytes();
        return Some(std::net::Ipv4Addr::new(a, b, c, d));
    }
    None
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    fn private(ip: &str) -> bool {
        is_private_or_reserved(ip.parse().unwrap())
    }

    #[test]
    fn private_reserved_blocks_0_x_range() {
        let ip: std::net::IpAddr = "0.1.2.3".parse().unwrap();
        assert!(is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_allows_1_0_0_1() {
        let ip: std::net::IpAddr = "1.0.0.1".parse().unwrap();
        assert!(!is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_blocks_fc00_unique_local() {
        let ip: std::net::IpAddr = "fc00::1".parse().unwrap();
        assert!(is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_blocks_fdff_unique_local() {
        let ip: std::net::IpAddr = "fdff::1".parse().unwrap();
        assert!(is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_allows_fe00() {
        let ip: std::net::IpAddr = "fe00::1".parse().unwrap();
        assert!(!is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_blocks_rfc6666_discard_prefix() {
        let ip: std::net::IpAddr = "100::1".parse().unwrap();
        assert!(is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_allows_non_discard_0100() {
        let ip: std::net::IpAddr = "100:0:0:1::1".parse().unwrap();
        assert!(!is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_blocks_every_ipv4_reserved_range() {
        for ip in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "0.0.0.0",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "198.18.0.1",
            "198.19.255.255",
        ] {
            assert!(private(ip), "{ip} must be private or reserved");
        }
    }

    #[test]
    fn private_reserved_allows_ipv4_just_outside_each_range() {
        for ip in [
            "172.15.255.255",
            "172.32.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "198.17.255.255",
            "198.20.0.0",
            "192.0.3.1",
            "198.51.101.1",
            "203.0.114.1",
            "8.8.8.8",
            "1.1.1.1",
        ] {
            assert!(!private(ip), "{ip} must be public");
        }
    }

    #[test]
    fn private_reserved_blocks_every_ipv6_reserved_range() {
        for ip in [
            "::1",
            "::",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "feff::1",
            "2001:db8::1",
            "fd12:3456::1",
        ] {
            assert!(private(ip), "{ip} must be private or reserved");
        }
    }

    #[test]
    fn private_reserved_allows_public_ipv6() {
        for ip in ["2606:4700::1", "2001:4860:4860::8888", "2001:db9::1"] {
            assert!(!private(ip), "{ip} must be public");
        }
    }

    #[test]
    fn private_reserved_leaves_ipv4_mapped_ipv6_to_the_caller() {
        assert!(!private("::ffff:10.0.0.1"));
        assert!(!private("::ffff:127.0.0.1"));
    }

    #[test]
    fn private_reserved_blocks_teredo_and_local_use_nat64_outright() {
        for ip in [
            "2001::1",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "2001:0:ffff:ffff:ffff:ffff:ffff:ffff",
            "64:ff9b:1::1",
            "64:ff9b:1::101:101",
            "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
        ] {
            assert!(private(ip), "{ip} must be private or reserved");
        }
    }

    #[test]
    fn private_reserved_allows_neighbours_of_teredo_and_local_use_nat64() {
        for ip in [
            "2001:1::1",
            "2001:4860:4860::8888",
            "64:ff9b:2::1",
            "64:ff9b::101:101",
        ] {
            assert!(!private(ip), "{ip} must be public");
        }
    }

    fn embedded(ip: &str) -> Option<std::net::Ipv4Addr> {
        embedded_ipv4(ip.parse().unwrap())
    }

    fn v4(ip: &str) -> Option<std::net::Ipv4Addr> {
        Some(ip.parse().unwrap())
    }

    #[test]
    fn embedded_ipv4_decodes_every_embedding_form() {
        assert_eq!(embedded("::ffff:10.0.0.1"), v4("10.0.0.1"));
        assert_eq!(embedded("::10.0.0.1"), v4("10.0.0.1"));
        assert_eq!(embedded("::127.0.0.1"), v4("127.0.0.1"));
        assert_eq!(embedded("::0.0.0.2"), v4("0.0.0.2"));
        assert_eq!(embedded("64:ff9b::a00:1"), v4("10.0.0.1"));
        assert_eq!(embedded("2002:7f00:1::"), v4("127.0.0.1"));
        assert_eq!(embedded("2002:a9fe:a9fe:1:2:3:4:5"), v4("169.254.169.254"));
        assert_eq!(embedded("2002:808:808::1"), v4("8.8.8.8"));
    }

    #[test]
    fn embedded_ipv4_is_none_for_unspecified_loopback_and_native_ipv6() {
        for ip in [
            "::",
            "::1",
            "2001::1",
            "2003::1",
            "64:ff9b:1::a00:1",
            "2606:4700::1111",
            "fe80::1",
        ] {
            assert_eq!(embedded(ip), None, "{ip}");
        }
    }
}

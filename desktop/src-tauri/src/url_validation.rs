// URL validation and platform detection commands.
//
// Validates URLs before opening: only http/https schemes, no localhost or
// private/reserved IPs (including IPv6-mapped IPv4 bypass prevention).

/// Returns `true` if the given IP address is loopback, private, link-local,
/// or otherwise reserved (not globally routable).
pub(crate) fn is_private_or_reserved(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()       // 127.0.0.0/8
            || v4.is_private()     // 10/8, 172.16/12, 192.168/16
            || v4.is_unspecified() // 0.0.0.0
            || v4.is_link_local()  // 169.254/16
            || v4.octets()[0] == 0 // 0.x.x.x (RFC 1122 "This host on this network")
            || v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64 // 100.64.0.0/10 (RFC 6598 shared address / CGNAT)
            || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 2)   // 192.0.2.0/24 (RFC 5737 TEST-NET-1)
            || (v4.octets()[0] == 198 && v4.octets()[1] == 51 && v4.octets()[2] == 100) // 198.51.100.0/24 (RFC 5737 TEST-NET-2)
            || (v4.octets()[0] == 203 && v4.octets()[1] == 0 && v4.octets()[2] == 113)  // 203.0.113.0/24 (RFC 5737 TEST-NET-3)
            || (v4.octets()[0] == 198 && (v4.octets()[1] & 0xfe) == 18) // 198.18.0.0/15 (RFC 2544 benchmarking)
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()       // ::1
            || v6.is_unspecified() // ::
            || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
            || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
            || (v6.segments()[0] & 0xffc0) == 0xfec0 // fec0::/10 deprecated site-local (RFC 3879)
            || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8) // 2001:db8::/32 documentation (RFC 3849)
            || (v6.segments()[0] == 0x0100 && v6.segments()[1] == 0 && v6.segments()[2] == 0 && v6.segments()[3] == 0)
            // 100::/64 discard (RFC 6666)
        }
    }
}

/// Validates a URL string: only http/https schemes allowed, no localhost or private IPs.
/// Uses parsed IP types (not string matching) to prevent IPv6-mapped IPv4 bypasses.
pub(crate) fn validate_url(url: &str) -> Result<url::Url, String> {
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Blocked URL scheme '{}': only http and https are allowed",
                scheme
            ))
        }
    }

    match parsed.host() {
        Some(url::Host::Domain(domain)) => {
            let lower = domain.to_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") {
                return Err(format!(
                    "Blocked URL host '{}': localhost is not allowed",
                    domain
                ));
            }
        }
        Some(url::Host::Ipv4(ipv4)) => {
            if is_private_or_reserved(std::net::IpAddr::V4(ipv4)) {
                return Err(format!("Blocked URL host '{}': private/reserved IP", ipv4));
            }
        }
        Some(url::Host::Ipv6(ipv6)) => {
            if is_private_or_reserved(std::net::IpAddr::V6(ipv6)) {
                return Err(format!(
                    "Blocked URL host '{}': private/reserved IPv6",
                    ipv6
                ));
            }
            // Also check IPv6-mapped IPv4 addresses (::ffff:x.x.x.x)
            if let Some(mapped_v4) = ipv6.to_ipv4_mapped() {
                if is_private_or_reserved(std::net::IpAddr::V4(mapped_v4)) {
                    return Err(format!(
                        "Blocked URL host '{}': maps to private IPv4 {}",
                        ipv6, mapped_v4
                    ));
                }
            }
        }
        None => return Err("URL has no host".to_string()),
    }

    Ok(parsed)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if url.len() > 8192 {
        return Err("URL too long".to_string());
    }
    let parsed = validate_url(&url)?;
    open::that(parsed.as_str()).map_err(|e| e.to_string())
}

/// Returns the current platform as a string ("macos", "linux", or "windows").
#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "unknown".to_string()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- URL validation: scheme checks --

    #[test]
    fn validate_url_allows_https() {
        assert!(validate_url("https://example.com").is_ok());
    }

    #[test]
    fn validate_url_allows_http() {
        assert!(validate_url("http://example.com").is_ok());
    }

    #[test]
    fn validate_url_blocks_file_scheme() {
        let err = validate_url("file:///etc/passwd").unwrap_err();
        assert!(err.contains("Blocked URL scheme"));
    }

    #[test]
    fn validate_url_blocks_ssh_scheme() {
        let err = validate_url("ssh://user@host").unwrap_err();
        assert!(err.contains("Blocked URL scheme"));
    }

    #[test]
    fn validate_url_blocks_javascript_scheme() {
        let err = validate_url("javascript:alert(1)").unwrap_err();
        assert!(err.contains("Blocked URL scheme"));
    }

    // -- URL validation: localhost / domain blocking --

    #[test]
    fn validate_url_blocks_localhost() {
        assert!(validate_url("https://localhost/admin")
            .unwrap_err()
            .contains("localhost"));
    }

    #[test]
    fn validate_url_blocks_subdomain_localhost() {
        assert!(validate_url("https://evil.localhost/admin")
            .unwrap_err()
            .contains("localhost"));
    }

    // -- URL validation: IPv4 private ranges --

    #[test]
    fn validate_url_blocks_127_0_0_1() {
        assert!(validate_url("https://127.0.0.1:8080/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_127_255() {
        assert!(validate_url("https://127.255.255.255/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_10_x() {
        assert!(validate_url("https://10.0.0.1/internal")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_192_168_x() {
        assert!(validate_url("https://192.168.1.1/router")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_172_16_x() {
        assert!(validate_url("https://172.16.0.1/internal")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_172_31_x() {
        assert!(validate_url("https://172.31.255.255/internal")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_allows_172_15_x() {
        assert!(validate_url("https://172.15.0.1/ok").is_ok());
    }

    #[test]
    fn validate_url_allows_172_32_x() {
        assert!(validate_url("https://172.32.0.1/ok").is_ok());
    }

    #[test]
    fn validate_url_blocks_169_254_x() {
        assert!(validate_url("https://169.254.169.254/metadata")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_0_0_0_0() {
        assert!(validate_url("https://0.0.0.0/")
            .unwrap_err()
            .contains("private"));
    }

    // -- URL validation: IPv6 blocking --

    #[test]
    fn validate_url_blocks_ipv6_loopback() {
        assert!(validate_url("https://[::1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_unspecified() {
        assert!(validate_url("https://[::]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_unique_local() {
        assert!(validate_url("https://[fd00::1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_link_local() {
        assert!(validate_url("https://[fe80::1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    // -- URL validation: IPv6-mapped IPv4 bypass prevention --

    #[test]
    fn validate_url_blocks_ipv6_mapped_loopback() {
        assert!(validate_url("https://[::ffff:127.0.0.1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_mapped_10_x() {
        assert!(validate_url("https://[::ffff:10.0.0.1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_mapped_192_168() {
        assert!(validate_url("https://[::ffff:192.168.1.1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_mapped_169_254() {
        assert!(validate_url("https://[::ffff:169.254.169.254]/secret")
            .unwrap_err()
            .contains("private"));
    }

    // -- URL validation: allowed URLs --

    #[test]
    fn validate_url_allows_public_ip() {
        assert!(validate_url("https://8.8.8.8/").is_ok());
    }

    #[test]
    fn validate_url_allows_public_domain() {
        assert!(validate_url("https://github.com/speedwave").is_ok());
    }

    #[test]
    fn validate_url_allows_public_ipv6() {
        assert!(validate_url("https://[2606:4700::1]/").is_ok());
    }

    // -- URL validation: additional scheme blocking --

    #[test]
    fn validate_url_blocks_ftp_scheme() {
        assert!(validate_url("ftp://evil.com/file")
            .unwrap_err()
            .contains("Blocked URL scheme"));
    }

    #[test]
    fn validate_url_blocks_data_scheme() {
        assert!(validate_url("data:text/html,test")
            .unwrap_err()
            .contains("Blocked URL scheme"));
    }

    // -- is_private_or_reserved: edge cases --

    #[test]
    fn private_reserved_blocks_0_x_range() {
        // 0.x.x.x is "This host on this network" per RFC 1122
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
        // fdff::1 is also in fc00::/7 range
        let ip: std::net::IpAddr = "fdff::1".parse().unwrap();
        assert!(is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_allows_fe00() {
        // fe00:: is NOT in fc00::/7 (that's fc-fd) and NOT in fe80::/10 (that's fe80-febf)
        let ip: std::net::IpAddr = "fe00::1".parse().unwrap();
        assert!(!is_private_or_reserved(ip));
    }

    // -- URL validation: IPv6-mapped IPv4 additional vectors --

    #[test]
    fn validate_url_blocks_ipv6_mapped_0_0_0_0() {
        assert!(validate_url("https://[::ffff:0.0.0.0]/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_mapped_172_16() {
        assert!(validate_url("https://[::ffff:172.16.0.1]/")
            .unwrap_err()
            .contains("private"));
    }

    // -- URL validation: malformed inputs --

    #[test]
    fn validate_url_blocks_empty_string() {
        assert!(validate_url("").is_err());
    }

    #[test]
    fn validate_url_blocks_no_scheme() {
        assert!(validate_url("example.com").is_err());
    }

    #[test]
    fn validate_url_blocks_scheme_only() {
        // "https:" either fails to parse or has no host — either way, must be Err
        assert!(validate_url("https:").is_err());
    }

    // -- RFC 5737 TEST-NET ranges --

    #[test]
    fn validate_url_blocks_rfc5737_test_net_1() {
        assert!(validate_url("https://192.0.2.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_rfc5737_test_net_2() {
        assert!(validate_url("https://198.51.100.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_rfc5737_test_net_3() {
        assert!(validate_url("https://203.0.113.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_rfc2544_benchmarking() {
        assert!(validate_url("https://198.18.0.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_cgnat() {
        assert!(validate_url("https://100.64.0.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_deprecated_site_local_ipv6() {
        assert!(validate_url("https://[fec0::1]/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_documentation_ipv6() {
        assert!(validate_url("https://[2001:db8::1]/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_allows_real_public_ipv6() {
        // Use a real public IPv6 instead of documentation prefix
        assert!(validate_url("https://[2606:4700::1]/").is_ok());
    }

    #[test]
    fn validate_url_blocks_url_with_credentials() {
        // Private IP should still be blocked even with userinfo
        assert!(validate_url("https://user:pass@127.0.0.1/")
            .unwrap_err()
            .contains("private"));
    }

    // -- RFC 6666 discard prefix --

    #[test]
    fn private_reserved_blocks_rfc6666_discard_prefix() {
        let ip: std::net::IpAddr = "100::1".parse().unwrap();
        assert!(
            is_private_or_reserved(ip),
            "0100::/64 discard prefix should be blocked"
        );
    }

    #[test]
    fn private_reserved_allows_non_discard_0100() {
        // 100::1:0:0:1 has non-zero segments beyond the /64 prefix, but still in 100::/64
        // Actually 100:0:0:0:x:x:x:x is in the prefix. Let's test outside:
        // 100:0:0:1::1 is NOT in 100::/64 because segment[3] != 0
        let ip: std::net::IpAddr = "100:0:0:1::1".parse().unwrap();
        assert!(
            !is_private_or_reserved(ip),
            "100:0:0:1::/64 is outside discard prefix"
        );
    }

    // -- URL validation: additional edge cases --

    #[test]
    fn validate_url_blocks_private_ip_with_path() {
        assert!(validate_url("https://10.0.0.1/api/secrets")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_private_ip_with_port() {
        assert!(validate_url("https://192.168.1.1:8443/admin")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_allows_high_port_public_ip() {
        assert!(validate_url("https://1.1.1.1:8080/api").is_ok());
    }

    #[test]
    fn validate_url_blocks_decimal_ip_loopback() {
        // The url crate parses decimal integers (e.g. 2130706433 = 0x7F000001) as
        // IPv4 addresses. This must be blocked by is_private_or_reserved.
        let result = validate_url("https://2130706433/");
        assert!(
            result.is_err(),
            "decimal IP 2130706433 (127.0.0.1) must be blocked as loopback"
        );
        assert!(
            result.unwrap_err().contains("private"),
            "error should indicate private/reserved IP"
        );
    }

    #[test]
    fn get_platform_returns_known_value() {
        let platform = get_platform();
        assert!(
            ["macos", "linux", "windows"].contains(&platform.as_str()),
            "get_platform() returned unexpected value: {platform}"
        );
    }
}

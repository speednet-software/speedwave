//! SSOT for host-side SSRF URL validation (ADR-041 §SSRF policy).
//! Shared by LLM discovery, Redmine, and plugin OAuth endpoint validation.

/// Returns `true` if the given IP address is loopback, private, link-local,
/// or otherwise reserved (not globally routable).
pub fn is_private_or_reserved(ip: std::net::IpAddr) -> bool {
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

/// Loopback tolerance for [`is_private_on_premise`]: Redmine blocks it, LLM
/// discovery allows it. Both accept RFC 1918 / ULA and reject reserved ranges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrivatePolicy {
    /// Loopback is NOT on-premise (Redmine policy).
    BlockLoopback,
    /// Loopback addresses ARE on-premise (LLM discovery policy).
    AllowLoopback,
}

/// True when the URL host is a private on-premise address under `policy`:
/// RFC 1918, CGNAT (100.64/10), IPv6 ULA, plus loopback under `AllowLoopback`.
pub fn is_private_on_premise(url: &url::Url, policy: PrivatePolicy) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ipv4)) => {
            if ipv4.is_private() && !ipv4.is_link_local() && !ipv4.is_unspecified() {
                return true;
            }
            // RFC 6598 — 100.64.0.0/10 shared address space (CGNAT)
            let oct = ipv4.octets();
            if oct[0] == 100 && (oct[1] & 0xc0) == 64 {
                return true;
            }
            let allow_loopback = match policy {
                PrivatePolicy::BlockLoopback => false,
                PrivatePolicy::AllowLoopback => true,
            };
            allow_loopback && ipv4.is_loopback()
        }
        Some(url::Host::Ipv6(ipv6)) => {
            // fc00::/7 — IPv6 Unique Local Address (RFC 4193)
            if (ipv6.segments()[0] & 0xfe00) == 0xfc00 {
                return true;
            }
            let allow_loopback = match policy {
                PrivatePolicy::BlockLoopback => false,
                PrivatePolicy::AllowLoopback => true,
            };
            if allow_loopback {
                if ipv6.is_loopback() {
                    return true;
                }
                // IPv6-mapped IPv4 loopback (::ffff:127.0.0.1) follows native IPv4.
                if let Some(mapped_v4) = ipv6.to_ipv4_mapped() {
                    if mapped_v4.is_loopback() {
                        return true;
                    }
                }
            }
            false
        }
        _ => false,
    }
}

/// Validates a URL: http/https only, no localhost/private IPs, no embedded
/// credentials, no backslashes. Query/fragment allowed (OAuth `authorize_url`).
pub fn validate_url(url: &str) -> Result<url::Url, String> {
    // Reject backslashes before parsing (Windows path / scheme confusion).
    if url.contains('\\') {
        return Err("URL must not contain backslashes".to_string());
    }
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

    // Reject embedded credentials unconditionally (no use in an endpoint URL).
    if parsed.password().is_some() || !parsed.username().is_empty() {
        return Err("URL must not contain embedded credentials".to_string());
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- scheme checks --

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
        assert!(validate_url("file:///etc/passwd")
            .unwrap_err()
            .contains("Blocked URL scheme"));
    }

    #[test]
    fn validate_url_blocks_ssh_scheme() {
        assert!(validate_url("ssh://user@host")
            .unwrap_err()
            .contains("Blocked URL scheme"));
    }

    #[test]
    fn validate_url_blocks_javascript_scheme() {
        assert!(validate_url("javascript:alert(1)")
            .unwrap_err()
            .contains("Blocked URL scheme"));
    }

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

    // -- localhost / domain blocking --

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

    // -- IPv4 private ranges --

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

    // -- IPv6 blocking --

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

    // -- IPv6-mapped IPv4 bypass prevention --

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

    // -- allowed URLs --

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

    // -- is_private_or_reserved edge cases --

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

    // -- malformed inputs --

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
        assert!(validate_url("https:").is_err());
    }

    // -- RFC 5737 / 2544 / CGNAT / deprecated ranges --

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
        assert!(validate_url("https://[2606:4700::1]/").is_ok());
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
        let result = validate_url("https://2130706433/");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("private"));
    }

    // -- embedded credentials rejected unconditionally (public host too) --

    #[test]
    fn validate_url_blocks_credentials_on_private_ip() {
        assert!(validate_url("https://user:pass@127.0.0.1/")
            .unwrap_err()
            .contains("credentials"));
    }

    #[test]
    fn validate_url_blocks_credentials_on_public_host() {
        // userinfo has no legitimate use in an endpoint URL
        assert!(validate_url("https://user:pass@example.com/")
            .unwrap_err()
            .contains("credentials"));
    }

    #[test]
    fn validate_url_blocks_username_only_on_public_host() {
        assert!(validate_url("https://user@example.com/")
            .unwrap_err()
            .contains("credentials"));
    }

    // -- backslash rejected --

    #[test]
    fn validate_url_blocks_backslash() {
        assert!(validate_url("https://example.com\\@evil.com/")
            .unwrap_err()
            .contains("backslash"));
    }

    // -- query/fragment ALLOWED (OAuth authorize_url needs them) --

    #[test]
    fn validate_url_allows_query_string() {
        // OAuth authorize_url legitimately carries query parameters.
        let ok = validate_url(
            "https://idp.example.com/authorize?response_type=code&client_id=abc&scope=api",
        );
        assert!(ok.is_ok(), "authorize_url with query must pass: {ok:?}");
    }

    #[test]
    fn validate_url_allows_fragment() {
        assert!(validate_url("https://idp.example.com/authorize#section").is_ok());
    }

    // -- is_private_on_premise: RFC 1918 (both policies accept) --

    #[test]
    fn on_premise_rfc1918_10_block() {
        let url: url::Url = "http://10.0.0.1/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
    }

    #[test]
    fn on_premise_rfc1918_10_allow() {
        let url: url::Url = "http://10.0.0.1/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_rfc1918_172_16_block() {
        let url: url::Url = "http://172.16.0.1/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
    }

    #[test]
    fn on_premise_rfc1918_192_168_block() {
        let url: url::Url = "http://192.168.1.1/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
    }

    // -- loopback policy delta --

    #[test]
    fn on_premise_ipv4_loopback_block() {
        let url: url::Url = "http://127.0.0.1/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
    }

    #[test]
    fn on_premise_ipv4_loopback_allow() {
        let url: url::Url = "http://127.0.0.1/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_ipv6_loopback_block() {
        let url: url::Url = "http://[::1]/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
    }

    #[test]
    fn on_premise_ipv6_loopback_allow() {
        let url: url::Url = "http://[::1]/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_ipv6_mapped_loopback_allow() {
        let url: url::Url = "http://[::ffff:127.0.0.1]/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_ipv6_mapped_loopback_block() {
        let url: url::Url = "http://[::ffff:127.0.0.1]/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
    }

    // -- link-local rejected under both policies --

    #[test]
    fn on_premise_ipv4_link_local_both() {
        let url: url::Url = "http://169.254.1.1/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(!is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_ipv6_link_local_both() {
        let url: url::Url = "http://[fe80::1]/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(!is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    // -- domain / public IP rejected (delegated to validate_url) --

    #[test]
    fn on_premise_domain_both() {
        let url: url::Url = "http://example.com/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(!is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    // -- IPv6 ULA identified under both policies --

    #[test]
    fn on_premise_ipv6_ula_fd_both() {
        let url: url::Url = "http://[fd12:3456:789a::1]/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_ipv6_ula_fc_both() {
        let url: url::Url = "http://[fc00::1]/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_ipv6_documentation_both() {
        let url: url::Url = "http://[2001:db8::1]/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(!is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_ipv6_just_outside_ula_both() {
        let url: url::Url = "http://[fe00::1]/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(!is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_ipv6_mapped_rfc1918_both() {
        let url: url::Url = "http://[::ffff:10.0.0.1]/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(!is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    // -- CGNAT (RFC 6598): both policies accept --

    #[test]
    fn on_premise_cgnat_block() {
        let url: url::Url = "http://100.64.0.1:8080/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
    }

    #[test]
    fn on_premise_cgnat_allow() {
        let url: url::Url = "http://100.64.0.1:8080/".parse().unwrap();
        assert!(is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }

    #[test]
    fn on_premise_just_outside_cgnat() {
        let url: url::Url = "http://100.128.0.1:8080/".parse().unwrap();
        assert!(!is_private_on_premise(&url, PrivatePolicy::BlockLoopback));
        assert!(!is_private_on_premise(&url, PrivatePolicy::AllowLoopback));
    }
}

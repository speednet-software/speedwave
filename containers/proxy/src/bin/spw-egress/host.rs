use std::net::IpAddr;

const MAX_HOSTNAME_LEN: usize = 253;
const MAX_LABEL_LEN: usize = 63;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HostError {
    IpLiteral(Option<IpAddr>),
    Invalid,
}

pub(crate) fn normalize_hostname(raw: &str) -> Result<String, HostError> {
    let unbracketed = raw
        .strip_prefix('[')
        .and_then(|r| r.strip_suffix(']'))
        .unwrap_or(raw);
    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return Err(HostError::IpLiteral(Some(ip)));
    }
    if raw.starts_with('[') {
        return Err(HostError::IpLiteral(None));
    }
    let host = raw.to_ascii_lowercase();
    if host.is_empty() || host.len() > MAX_HOSTNAME_LEN {
        return Err(HostError::Invalid);
    }
    let labels_valid = host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= MAX_LABEL_LEN
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    });
    if !labels_valid {
        return Err(HostError::Invalid);
    }
    let last_starts_with_letter = host
        .rsplit('.')
        .next()
        .and_then(|label| label.bytes().next())
        .is_some_and(|b| b.is_ascii_lowercase());
    if !last_starts_with_letter {
        return Err(HostError::IpLiteral(None));
    }
    Ok(host)
}

pub(crate) fn parse_port(raw: &str) -> Option<u16> {
    if raw.is_empty() || raw.len() > 5 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u16>().ok().filter(|p| *p != 0)
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    #[test]
    fn hostname_is_lowercased() {
        assert_eq!(
            normalize_hostname("API.Figma.COM"),
            Ok("api.figma.com".to_string())
        );
    }

    #[test]
    fn single_label_hostname_is_accepted() {
        assert_eq!(normalize_hostname("localhost"), Ok("localhost".to_string()));
    }

    #[test]
    fn ipv4_literal_is_refused() {
        assert_eq!(
            normalize_hostname("10.0.0.1"),
            Err(HostError::IpLiteral(Some("10.0.0.1".parse().unwrap())))
        );
    }

    #[test]
    fn ipv6_literals_are_refused_bracketed_or_bare() {
        assert!(matches!(
            normalize_hostname("[::1]"),
            Err(HostError::IpLiteral(Some(_)))
        ));
        assert!(matches!(
            normalize_hostname("::1"),
            Err(HostError::IpLiteral(Some(_)))
        ));
        assert_eq!(
            normalize_hostname("[not-an-ip]"),
            Err(HostError::IpLiteral(None))
        );
    }

    #[test]
    fn numeric_shorthand_and_hex_forms_count_as_ip_literals() {
        for raw in ["127.1", "2130706433", "0x7f000001", "example.123"] {
            assert_eq!(
                normalize_hostname(raw),
                Err(HostError::IpLiteral(None)),
                "{raw}"
            );
        }
    }

    #[test]
    fn invalid_hostnames_are_rejected() {
        let long_label = "a".repeat(64);
        let long_host = format!("{}.com", "a.".repeat(126));
        for raw in [
            "",
            "exa mple.com",
            "under_score.com",
            "-lead.com",
            "trail-.com",
            "double..dot.com",
            "trailing.dot.",
            "żółw.pl",
            long_label.as_str(),
            long_host.as_str(),
        ] {
            assert_eq!(normalize_hostname(raw), Err(HostError::Invalid), "{raw}");
        }
    }

    #[test]
    fn port_parsing_accepts_only_plain_decimal_in_range() {
        assert_eq!(parse_port("443"), Some(443));
        assert_eq!(parse_port("65535"), Some(65535));
        for raw in ["", "0", "65536", "+443", "-1", "44 3", "000443", "abc"] {
            assert_eq!(parse_port(raw), None, "{raw}");
        }
    }
}

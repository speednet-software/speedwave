//! Refused connections in a Custom MCP egress container's log: the `spw-egress` decision lines
//! (`{"event":"egress","decision":"deny",…}`), read as untrusted text and summarized.

use super::model::HostPort;
use crate::compose::custom_mcp::{container_name, Role};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Longest log line read; a longer one is ignored whole.
pub const MAX_LINE_BYTES: usize = 4096;

/// Most blocked hosts a summary lists.
pub const MAX_DENIED_HOSTS: usize = 20;

/// Lines of the egress log a summary reads (the newest ones).
pub const LOG_TAIL_LINES: u32 = 2000;

/// Why `spw-egress` refused a connection: the wire names of its `DenyReason::as_str`.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EgressDenyReason {
    /// Malformed, oversized, slow or truncated request head.
    BadRequest,
    /// A method other than CONNECT.
    Method,
    /// The target is an IP address.
    IpLiteral,
    /// No allowlist was read yet.
    ConfigUnavailable,
    /// The target is not on the allowlist.
    NotAllowlisted,
    /// The name did not resolve.
    DnsFailure,
    /// The name resolved to a private or reserved address.
    PrivateAddress,
    /// The upstream connection failed.
    ConnectFailed,
    /// The first bytes were not a single TLS ClientHello.
    NotClientHello,
    /// The ClientHello carried no server name.
    NoSni,
    /// The ClientHello named another host.
    SniMismatch,
}

impl EgressDenyReason {
    /// Every reason, in `spw-egress` declaration order.
    pub const ALL: [Self; 11] = [
        Self::BadRequest,
        Self::Method,
        Self::IpLiteral,
        Self::ConfigUnavailable,
        Self::NotAllowlisted,
        Self::DnsFailure,
        Self::PrivateAddress,
        Self::ConnectFailed,
        Self::NotClientHello,
        Self::NoSni,
        Self::SniMismatch,
    ];

    /// Wire name in the decision line.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "bad_request",
            Self::Method => "method",
            Self::IpLiteral => "ip_literal",
            Self::ConfigUnavailable => "config_unavailable",
            Self::NotAllowlisted => "not_allowlisted",
            Self::DnsFailure => "dns_failure",
            Self::PrivateAddress => "private_address",
            Self::ConnectFailed => "connect_failed",
            Self::NotClientHello => "not_client_hello",
            Self::NoSni => "no_sni",
            Self::SniMismatch => "sni_mismatch",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|r| r.as_str() == value)
    }
}

/// A host the egress refused because it is not on the allowlist, with how often.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeniedHost {
    /// The validated target.
    pub host_port: HostPort,
    /// Refusals in the log.
    pub count: u32,
}

/// Summary of an egress log's refusals.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EgressDenials {
    /// Hosts refused as `not_allowlisted`, most refused first, then by name.
    pub hosts: Vec<DeniedHost>,
    /// Every other refusal, counted per reason; its target is never kept.
    pub other: BTreeMap<EgressDenyReason, u32>,
}

/// Engine container name of the egress proxy of server `name` in `project`.
pub fn egress_container_name(project: &str, name: &str) -> String {
    container_name(project, &Role::Egress.service_name(name))
}

/// Summarizes the refusals in `log_text`: `not_allowlisted` hosts that pass [`HostPort::parse`]
/// and are not in `allowlist`, at most `limit` of them, plus a count per other reason.
pub fn denials(log_text: &str, allowlist: &[HostPort], limit: usize) -> EgressDenials {
    let mut hosts: BTreeMap<HostPort, u32> = BTreeMap::new();
    let mut other: BTreeMap<EgressDenyReason, u32> = BTreeMap::new();
    for line in log_text.lines() {
        let Some((reason, decision)) = deny_line(line) else {
            continue;
        };
        if reason != EgressDenyReason::NotAllowlisted {
            bump(other.entry(reason).or_default());
            continue;
        }
        if let Some(target) = target_of(&decision).filter(|t| !allowlist.contains(t)) {
            bump(hosts.entry(target).or_default());
        }
    }
    let mut hosts: Vec<DeniedHost> = hosts
        .into_iter()
        .map(|(host_port, count)| DeniedHost { host_port, count })
        .collect();
    hosts.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.host_port.cmp(&b.host_port))
    });
    hosts.truncate(limit);
    EgressDenials { hosts, other }
}

fn bump(count: &mut u32) {
    *count = count.saturating_add(1);
}

fn deny_line(line: &str) -> Option<(EgressDenyReason, Value)> {
    if line.len() > MAX_LINE_BYTES {
        return None;
    }
    let start = line.find('{')?;
    let decision: Value = serde_json::from_str(line[start..].trim()).ok()?;
    let object = decision.as_object()?;
    if object.get("event")?.as_str()? != "egress" || object.get("decision")?.as_str()? != "deny" {
        return None;
    }
    let reason = EgressDenyReason::parse(object.get("reason")?.as_str()?)?;
    Some((reason, decision))
}

fn target_of(decision: &Value) -> Option<HostPort> {
    let host = decision.get("host")?.as_str()?;
    let port = u16::try_from(decision.get("port")?.as_u64()?).ok()?;
    HostPort::parse(&format!("{}:{port}", host.to_ascii_lowercase())).ok()
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap")]
mod tests {
    use super::*;

    fn deny(host: &str, port: u16, reason: &str) -> String {
        serde_json::json!({"event":"egress","decision":"deny","host":host,"port":port,"reason":reason})
            .to_string()
    }

    fn hp(value: &str) -> HostPort {
        HostPort::parse(value).unwrap()
    }

    fn listed(summary: &EgressDenials) -> Vec<(String, u32)> {
        summary
            .hosts
            .iter()
            .map(|h| (h.host_port.to_string(), h.count))
            .collect()
    }

    #[test]
    fn refused_hosts_are_counted_and_sorted_by_count_then_name() {
        let log = [
            deny("cdn.x.io", 443, "not_allowlisted"),
            deny("api.figma.com", 443, "not_allowlisted"),
            deny("b.example.com", 443, "not_allowlisted"),
            deny("api.figma.com", 443, "not_allowlisted"),
            deny("a.example.com", 443, "not_allowlisted"),
            deny("api.figma.com", 443, "not_allowlisted"),
            deny("api.figma.com", 8443, "not_allowlisted"),
        ]
        .join("\n");
        let summary = denials(&log, &[], MAX_DENIED_HOSTS);
        assert_eq!(
            listed(&summary),
            vec![
                ("api.figma.com:443".to_string(), 3),
                ("a.example.com:443".to_string(), 1),
                ("api.figma.com:8443".to_string(), 1),
                ("b.example.com:443".to_string(), 1),
                ("cdn.x.io:443".to_string(), 1),
            ]
        );
        assert!(summary.other.is_empty());
    }

    #[test]
    fn only_deny_decision_lines_count() {
        let log = [
            "starting".to_string(),
            r#"{"event":"log","level":"warn","message":"config missing"}"#.to_string(),
            r#"{"event":"egress","decision":"allow","host":"api.figma.com","port":443,"reason":null}"#
                .to_string(),
            r#"{"event":"other","decision":"deny","host":"x.example.com","port":443,"reason":"not_allowlisted"}"#
                .to_string(),
            r#"["egress","deny"]"#.to_string(),
            r#"{"event":"egress","decision":"deny","host":"x.example.com""#.to_string(),
            r#"{"event":"egress","decision":"deny","host":"x.example.com","port":443,"reason":"made_up"}"#
                .to_string(),
            r#"time="2026-10-12T10:00:00Z" level=warning msg="no such file""#.to_string(),
            String::new(),
        ]
        .join("\n");
        assert_eq!(
            denials(&log, &[], MAX_DENIED_HOSTS),
            EgressDenials::default()
        );
    }

    #[test]
    fn a_prefix_before_the_json_object_and_crlf_endings_are_tolerated() {
        let log = format!(
            "2026-10-12T10:00:00.000Z stdout F {}\r\nmcp-custom-figma-egress  | {}\r\n",
            deny("api.figma.com", 443, "not_allowlisted"),
            deny("api.figma.com", 443, "not_allowlisted")
        );
        assert_eq!(
            listed(&denials(&log, &[], MAX_DENIED_HOSTS)),
            vec![("api.figma.com:443".to_string(), 2)]
        );
    }

    #[test]
    fn hosts_that_are_not_valid_targets_are_dropped() {
        let log = [
            deny("127.0.0.1", 443, "not_allowlisted"),
            deny("bücher.example", 443, "not_allowlisted"),
            deny("xn--bcher-kva.example", 443, "not_allowlisted"),
            deny("*.figma.com", 443, "not_allowlisted"),
            deny("a b.example.com", 443, "not_allowlisted"),
            deny("evil.example.com\u{1b}[31m", 443, "not_allowlisted"),
            deny("api.figma.com", 0, "not_allowlisted"),
            r#"{"event":"egress","decision":"deny","host":"big.example.com","port":70000,"reason":"not_allowlisted"}"#
                .to_string(),
            r#"{"event":"egress","decision":"deny","host":null,"port":null,"reason":"not_allowlisted"}"#
                .to_string(),
            deny("UPPER.Example.COM", 443, "not_allowlisted"),
        ]
        .join("\n");
        assert_eq!(
            listed(&denials(&log, &[], MAX_DENIED_HOSTS)),
            vec![
                ("upper.example.com:443".to_string(), 1),
                ("xn--bcher-kva.example:443".to_string(), 1),
            ]
        );
    }

    #[test]
    fn other_reasons_are_counted_without_their_targets() {
        let log = [
            deny("10.0.0.1", 443, "ip_literal"),
            deny("internal.example.com", 443, "private_address"),
            deny("internal.example.com", 443, "private_address"),
            deny("api.figma.com", 443, "sni_mismatch"),
            r#"{"event":"egress","decision":"deny","host":null,"port":null,"reason":"method"}"#
                .to_string(),
        ]
        .join("\n");
        let summary = denials(&log, &[], MAX_DENIED_HOSTS);
        assert!(summary.hosts.is_empty());
        assert_eq!(
            summary.other,
            BTreeMap::from([
                (EgressDenyReason::Method, 1),
                (EgressDenyReason::IpLiteral, 1),
                (EgressDenyReason::PrivateAddress, 2),
                (EgressDenyReason::SniMismatch, 1),
            ])
        );
    }

    #[test]
    fn hosts_already_allowed_are_left_out() {
        let log = [
            deny("api.figma.com", 443, "not_allowlisted"),
            deny("api.figma.com", 8443, "not_allowlisted"),
        ]
        .join("\n");
        assert_eq!(
            listed(&denials(&log, &[hp("api.figma.com:443")], MAX_DENIED_HOSTS)),
            vec![("api.figma.com:8443".to_string(), 1)]
        );
    }

    #[test]
    fn the_list_is_capped_after_sorting_and_long_lines_are_ignored() {
        let mut lines: Vec<String> = (0..30)
            .map(|i| deny(&format!("h{i:02}.example.com"), 443, "not_allowlisted"))
            .collect();
        lines.push(deny("top.example.com", 443, "not_allowlisted"));
        lines.push(deny("top.example.com", 443, "not_allowlisted"));
        let padded = format!(
            "{}{}",
            " ".repeat(MAX_LINE_BYTES),
            deny("long.example.com", 443, "not_allowlisted")
        );
        lines.push(padded.clone());
        lines.push(padded);
        lines.push(padded_to_limit());
        let summary = denials(&lines.join("\n"), &[], MAX_DENIED_HOSTS);
        assert_eq!(summary.hosts.len(), MAX_DENIED_HOSTS);
        assert_eq!(summary.hosts[0].host_port, hp("top.example.com:443"));
        assert_eq!(summary.hosts[0].count, 2);
        assert_eq!(summary.hosts[1].host_port, hp("edge.example.com:443"));
        assert!(!summary
            .hosts
            .iter()
            .any(|h| h.host_port.host() == "long.example.com"));
        assert!(denials(&lines.join("\n"), &[], 0).hosts.is_empty());
    }

    fn padded_to_limit() -> String {
        let line = deny("edge.example.com", 443, "not_allowlisted");
        let padded = format!("{}{line}", " ".repeat(MAX_LINE_BYTES - line.len()));
        assert_eq!(padded.len(), MAX_LINE_BYTES);
        padded
    }

    #[test]
    fn counts_saturate() {
        let mut count = u32::MAX;
        bump(&mut count);
        assert_eq!(count, u32::MAX);
    }

    #[test]
    fn the_egress_container_name_follows_the_renderer() {
        assert_eq!(
            egress_container_name("acme", "figma"),
            format!(
                "{}_acme_mcp_custom_figma_egress",
                crate::consts::compose_prefix()
            )
        );
    }

    #[test]
    fn the_decision_line_contract_matches_spw_egress() {
        let source = include_str!("../../../../containers/proxy/src/bin/spw-egress/session.rs");
        let to_json = &source[source.find("fn to_json").unwrap()..];
        let to_json = &to_json[..to_json.find("\n    }\n").unwrap()];
        for literal in [
            r#""event": "egress""#,
            r#""decision": if self.denied.is_some() { "deny" } else { "allow" }"#,
            r#""host": self.host"#,
            r#""port": self.port"#,
            r#""reason": self.denied.map(DenyReason::as_str)"#,
        ] {
            assert!(
                to_json.contains(literal),
                "Decision::to_json lost {literal}"
            );
        }
        let as_str = &source[source.find("fn as_str(self)").unwrap()..];
        let as_str = &as_str[..as_str.find("\n    }\n").unwrap()];
        let mut wire: Vec<&str> = as_str
            .split("=> \"")
            .skip(1)
            .map(|rest| &rest[..rest.find('"').unwrap()])
            .collect();
        wire.sort_unstable();
        let mut ours: Vec<&str> = EgressDenyReason::ALL.iter().map(|r| r.as_str()).collect();
        ours.sort_unstable();
        assert_eq!(wire, ours);
        for reason in EgressDenyReason::ALL {
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                Value::String(reason.as_str().to_string())
            );
            assert_eq!(EgressDenyReason::parse(reason.as_str()), Some(reason));
        }
    }
}

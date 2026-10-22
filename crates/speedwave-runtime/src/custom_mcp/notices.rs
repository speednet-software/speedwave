//! One-line notices about configured Custom MCP servers that cannot run from a CLI start
//! without the user acting in Speedwave Desktop.

use super::effective::{CustomMcpResolution, ExclusionReason};
use super::model::CustomMcpSource;

/// Longest server name a notice shows, in characters.
pub const NOTICE_NAME_MAX_CHARS: usize = 64;

/// Longest validation detail a notice shows, in characters.
pub const NOTICE_DETAIL_MAX_CHARS: usize = 160;

/// `value` without control characters, cut to `max_chars` characters with a trailing `…`.
pub fn display_text(value: &str, max_chars: usize) -> String {
    let clean: Vec<char> = value.chars().filter(|c| !c.is_control()).collect();
    if max_chars == 0 {
        return String::new();
    }
    if clean.len() <= max_chars {
        return clean.into_iter().collect();
    }
    let mut cut: String = clean[..max_chars - 1].iter().collect();
    cut.push('…');
    cut
}

fn excluded_notice(name: &str, reason: &ExclusionReason) -> Option<String> {
    let subject = format!("custom MCP server '{name}'");
    match reason {
        ExclusionReason::Disabled => None,
        ExclusionReason::NotApproved | ExclusionReason::ConsentChanged => Some(format!(
            "{subject} is waiting for approval in Speedwave Desktop"
        )),
        ExclusionReason::BetaDisabled => Some(format!(
            "{subject} requires the beta features toggle in Speedwave Desktop"
        )),
        ExclusionReason::ManagedDisabled
        | ExclusionReason::HostServersDisabled
        | ExclusionReason::ScopeNotAllowed
        | ExclusionReason::WorkspaceModeAboveLimit { .. } => Some(format!(
            "{subject} is disabled by your organization's policy"
        )),
        ExclusionReason::Invalid { detail } => Some(format!(
            "{subject} has an invalid configuration ({})",
            display_text(detail, NOTICE_DETAIL_MAX_CHARS)
        )),
        ExclusionReason::OverLimit { max } => Some(format!(
            "{subject} does not run: a project runs at most {max} custom MCP servers; \
             turn one off in Speedwave Desktop"
        )),
    }
}

/// Notices for `resolution`, excluded servers first, both in name order: one per excluded server
/// the user did not turn off, and one per running host server while the Desktop relay is down.
pub fn custom_mcp_notices(resolution: &CustomMcpResolution, relay_running: bool) -> Vec<String> {
    let excluded = resolution
        .excluded
        .iter()
        .filter_map(|e| excluded_notice(&display_text(&e.name, NOTICE_NAME_MAX_CHARS), &e.reason));
    let host = resolution
        .effective
        .iter()
        .filter(|s| !relay_running && matches!(s.source, CustomMcpSource::Host { .. }))
        .map(|s| {
            format!(
                "host MCP server '{}' is available only while Speedwave Desktop is running",
                display_text(&s.name, NOTICE_NAME_MAX_CHARS)
            )
        });
    excluded.chain(host).collect()
}

/// `true` when `resolution` runs a host server, the only case that needs the relay state.
pub fn needs_relay(resolution: &CustomMcpResolution) -> bool {
    resolution
        .effective
        .iter()
        .any(|s| matches!(s.source, CustomMcpSource::Host { .. }))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::custom_mcp::effective::{resolve_effective, ExcludedCustomMcp};
    use crate::custom_mcp::model::{CustomMcpEntry, ManagedCustomMcpConfig, WorkspaceMode};
    use crate::custom_mcp::policy::tests::{approved, npm_entry};
    use std::collections::BTreeMap;

    fn host_entry() -> CustomMcpEntry {
        approved(CustomMcpEntry {
            source: CustomMcpSource::Host {
                port: 3845,
                path: "/mcp".into(),
            },
            ..npm_entry()
        })
    }

    fn map(entries: Vec<(&str, CustomMcpEntry)>) -> BTreeMap<String, CustomMcpEntry> {
        entries
            .into_iter()
            .map(|(n, e)| (n.to_string(), e))
            .collect()
    }

    fn excluded(name: &str, reason: ExclusionReason) -> CustomMcpResolution {
        CustomMcpResolution {
            effective: Vec::new(),
            excluded: vec![ExcludedCustomMcp {
                name: name.into(),
                reason,
            }],
        }
    }

    #[test]
    fn unapproved_and_changed_servers_wait_for_desktop_approval() {
        let mut changed = approved(npm_entry());
        changed.workspace_mode = WorkspaceMode::ReadWrite;
        let r = resolve_effective(
            &map(vec![("figma", npm_entry()), ("linear", changed)]),
            true,
            None,
        );
        assert_eq!(
            r.excluded.iter().map(|e| &e.reason).collect::<Vec<_>>(),
            vec![
                &ExclusionReason::NotApproved,
                &ExclusionReason::ConsentChanged
            ]
        );
        assert_eq!(
            custom_mcp_notices(&r, true),
            vec![
                "custom MCP server 'figma' is waiting for approval in Speedwave Desktop",
                "custom MCP server 'linear' is waiting for approval in Speedwave Desktop",
            ]
        );
    }

    #[test]
    fn beta_off_asks_for_the_beta_toggle() {
        let r = resolve_effective(&map(vec![("figma", approved(npm_entry()))]), false, None);
        assert_eq!(
            custom_mcp_notices(&r, true),
            vec![
                "custom MCP server 'figma' requires the beta features toggle in Speedwave Desktop"
            ]
        );
    }

    #[test]
    fn every_policy_reason_names_the_organization() {
        let policy = "is disabled by your organization's policy";
        for reason in [
            ExclusionReason::ManagedDisabled,
            ExclusionReason::HostServersDisabled,
            ExclusionReason::ScopeNotAllowed,
            ExclusionReason::WorkspaceModeAboveLimit {
                limit: WorkspaceMode::None,
            },
        ] {
            assert_eq!(
                custom_mcp_notices(&excluded("figma", reason.clone()), true),
                vec![format!("custom MCP server 'figma' {policy}")],
                "{reason:?}"
            );
        }
        let managed = ManagedCustomMcpConfig {
            enabled: Some(false),
            ..ManagedCustomMcpConfig::default()
        };
        let r = resolve_effective(
            &map(vec![("figma", approved(npm_entry()))]),
            true,
            Some(&managed),
        );
        assert_eq!(
            custom_mcp_notices(&r, true),
            vec![format!("custom MCP server 'figma' {policy}")]
        );
    }

    #[test]
    fn disabled_servers_stay_silent() {
        let mut off = approved(npm_entry());
        off.enabled = false;
        let r = resolve_effective(&map(vec![("figma", off)]), true, None);
        assert_eq!(r.excluded[0].reason, ExclusionReason::Disabled);
        assert!(custom_mcp_notices(&r, false).is_empty());
    }

    #[test]
    fn nothing_configured_prints_nothing() {
        assert!(custom_mcp_notices(&CustomMcpResolution::default(), false).is_empty());
    }

    #[test]
    fn an_invalid_entry_shows_its_validation_detail() {
        let r = resolve_effective(&map(vec![("Bad", approved(npm_entry()))]), true, None);
        let notices = custom_mcp_notices(&r, true);
        assert_eq!(notices.len(), 1);
        assert!(
            notices[0].starts_with("custom MCP server 'Bad' has an invalid configuration ("),
            "{notices:?}"
        );
        assert!(notices[0].contains("must start with a lowercase letter"));
        assert!(notices[0].ends_with(')'));
    }

    #[test]
    fn control_characters_are_stripped_from_name_and_detail() {
        let r = excluded(
            "evil\u{1b}[2J\nname\u{7}",
            ExclusionReason::Invalid {
                detail: "line one\r\nline\ttwo\u{0}\u{9b}31m".into(),
            },
        );
        let notices = custom_mcp_notices(&r, true);
        assert_eq!(
            notices,
            vec![
                "custom MCP server 'evil[2Jname' has an invalid configuration \
                 (line onelinetwo31m)"
            ]
        );
        assert!(!notices[0].chars().any(char::is_control));
    }

    #[test]
    fn long_detail_and_name_are_capped_in_characters() {
        let long_name = "ż".repeat(NOTICE_NAME_MAX_CHARS + 10);
        let long_detail = "ą".repeat(NOTICE_DETAIL_MAX_CHARS * 3);
        let r = excluded(
            &long_name,
            ExclusionReason::Invalid {
                detail: long_detail,
            },
        );
        let notice = custom_mcp_notices(&r, true).remove(0);
        let shown_name = notice
            .strip_prefix("custom MCP server '")
            .unwrap()
            .split('\'')
            .next()
            .unwrap();
        assert_eq!(shown_name.chars().count(), NOTICE_NAME_MAX_CHARS);
        assert!(shown_name.ends_with('…'));
        let shown_detail = notice.split_once('(').unwrap().1.strip_suffix(')').unwrap();
        assert_eq!(shown_detail.chars().count(), NOTICE_DETAIL_MAX_CHARS);
        assert!(shown_detail.ends_with('…'));
    }

    #[test]
    fn display_text_boundaries() {
        assert_eq!(display_text("", 5), "");
        assert_eq!(display_text("abcde", 5), "abcde");
        assert_eq!(display_text("abcdef", 5), "abcd…");
        assert_eq!(display_text("a\u{0}b", 5), "ab");
        assert_eq!(display_text("abc", 0), "");
        assert_eq!(display_text("abc", 1), "…");
    }

    #[test]
    fn over_limit_servers_point_at_the_per_project_maximum() {
        let r = excluded(
            "zeta",
            ExclusionReason::OverLimit {
                max: crate::consts::CUSTOM_MCP_MAX_PER_PROJECT,
            },
        );
        assert_eq!(
            custom_mcp_notices(&r, true),
            vec![format!(
                "custom MCP server 'zeta' does not run: a project runs at most {} custom MCP \
                 servers; turn one off in Speedwave Desktop",
                crate::consts::CUSTOM_MCP_MAX_PER_PROJECT
            )]
        );
    }

    #[test]
    fn host_servers_need_the_desktop_relay() {
        let r = resolve_effective(
            &map(vec![
                ("desk", host_entry()),
                ("figma", approved(npm_entry())),
            ]),
            true,
            None,
        );
        assert_eq!(r.effective.len(), 2);
        assert!(needs_relay(&r));
        assert_eq!(
            custom_mcp_notices(&r, false),
            vec!["host MCP server 'desk' is available only while Speedwave Desktop is running"]
        );
        assert!(custom_mcp_notices(&r, true).is_empty());
    }

    #[test]
    fn npm_only_projects_never_need_the_relay() {
        let r = resolve_effective(&map(vec![("figma", approved(npm_entry()))]), true, None);
        assert!(!needs_relay(&r));
        assert!(custom_mcp_notices(&r, false).is_empty());
    }

    #[test]
    fn excluded_notices_come_before_host_notices() {
        let r = resolve_effective(
            &map(vec![("alpha", host_entry()), ("beta", npm_entry())]),
            true,
            None,
        );
        assert_eq!(
            custom_mcp_notices(&r, false),
            vec![
                "custom MCP server 'beta' is waiting for approval in Speedwave Desktop",
                "host MCP server 'alpha' is available only while Speedwave Desktop is running",
            ]
        );
    }
}

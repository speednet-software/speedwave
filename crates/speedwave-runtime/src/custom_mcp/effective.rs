//! Which configured Custom MCP servers run: the user entries filtered by approval, the beta flag
//! and the MDM `custom_mcp` policy, with a reason for every excluded one.

use super::model::{
    self, CustomMcpEntry, CustomMcpSource, CustomPiiMode, CustomToolDecision, HostPort,
    ManagedCustomMcpConfig, WorkspaceMode,
};
use crate::consts;
use serde::Serialize;
use std::collections::BTreeMap;

/// A server that runs, with the MDM overrides applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EffectiveCustomMcp {
    /// Server name (the `custom_mcp` map key).
    pub name: String,
    /// Hub service id (`custom-<name>`).
    pub service_id: String,
    /// Where the server runs.
    pub source: CustomMcpSource,
    /// Tool decisions keyed by upstream tool name.
    pub tools: BTreeMap<String, CustomToolDecision>,
    /// Egress targets left after the MDM domain allowlist.
    pub allowed_domains: Vec<HostPort>,
    /// Egress targets the MDM domain allowlist removed.
    pub domains_blocked_by_policy: Vec<HostPort>,
    /// Effective PII mode (MDM `force_pii_mode` wins).
    pub pii_mode: CustomPiiMode,
    /// Approved `/workspace` access.
    pub workspace_mode: WorkspaceMode,
    /// The verified consent digest.
    pub consent_digest: String,
}

/// Why a configured server does not run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum ExclusionReason {
    /// The entry fails validation.
    Invalid {
        /// What is wrong.
        detail: String,
    },
    /// Beta features are off.
    BetaDisabled,
    /// The organization disabled Custom MCP servers.
    ManagedDisabled,
    /// The user turned the server off.
    Disabled,
    /// The server was never approved.
    NotApproved,
    /// The approved fields changed since approval.
    ConsentChanged,
    /// The organization disabled servers running on the host.
    HostServersDisabled,
    /// The package scope is outside the organization's allowed scopes.
    ScopeNotAllowed,
    /// The approved project access exceeds the organization's limit.
    WorkspaceModeAboveLimit {
        /// The organization's limit.
        limit: WorkspaceMode,
    },
    /// More servers qualify than a project may run.
    OverLimit {
        /// The per-project maximum.
        max: usize,
    },
}

/// A configured server that does not run, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExcludedCustomMcp {
    /// Server name.
    pub name: String,
    /// Why it does not run.
    pub reason: ExclusionReason,
}

/// Outcome of [`resolve_effective`], both lists in name order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CustomMcpResolution {
    /// Servers that run.
    pub effective: Vec<EffectiveCustomMcp>,
    /// Servers that do not run.
    pub excluded: Vec<ExcludedCustomMcp>,
}

fn exclusion(
    name: &str,
    entry: &CustomMcpEntry,
    beta_enabled: bool,
    managed: Option<&ManagedCustomMcpConfig>,
) -> Option<ExclusionReason> {
    if let Err(e) = entry.validate(name) {
        return Some(ExclusionReason::Invalid {
            detail: e.to_string(),
        });
    }
    if !beta_enabled {
        return Some(ExclusionReason::BetaDisabled);
    }
    if managed.and_then(|m| m.enabled) == Some(false) {
        return Some(ExclusionReason::ManagedDisabled);
    }
    if !entry.enabled {
        return Some(ExclusionReason::Disabled);
    }
    if entry.consent_digest.is_none() {
        return Some(ExclusionReason::NotApproved);
    }
    if !super::policy::is_approved(entry) {
        return Some(ExclusionReason::ConsentChanged);
    }
    match &entry.source {
        CustomMcpSource::Host { .. } => {
            if managed.and_then(|m| m.host_servers_enabled) == Some(false) {
                return Some(ExclusionReason::HostServersDisabled);
            }
        }
        CustomMcpSource::Npm { lock } => {
            if let Some(scopes) = managed.and_then(|m| m.allowed_scopes.as_ref()) {
                let allowed = model::npm_scope(&lock.package)
                    .is_some_and(|scope| scopes.iter().any(|s| s == scope));
                if !allowed {
                    return Some(ExclusionReason::ScopeNotAllowed);
                }
            }
        }
    }
    if let Some(limit) = managed.and_then(|m| m.max_workspace_mode) {
        if entry.workspace_mode.exceeds(limit) {
            return Some(ExclusionReason::WorkspaceModeAboveLimit { limit });
        }
    }
    None
}

/// Resolves which configured servers run. An entry runs only when it is valid, beta is on, MDM
/// does not disable it, the user enabled it and its recorded consent digest matches its fields;
/// MDM `force_pii_mode` and `allowed_domains` then apply, and at most
/// [`consts::CUSTOM_MCP_MAX_PER_PROJECT`] run (the first in name order).
pub fn resolve_effective(
    entries: &BTreeMap<String, CustomMcpEntry>,
    beta_enabled: bool,
    managed: Option<&ManagedCustomMcpConfig>,
) -> CustomMcpResolution {
    let mut resolution = CustomMcpResolution::default();
    for (name, entry) in entries {
        if let Some(reason) = exclusion(name, entry, beta_enabled, managed) {
            resolution.excluded.push(ExcludedCustomMcp {
                name: name.clone(),
                reason,
            });
            continue;
        }
        if resolution.effective.len() >= consts::CUSTOM_MCP_MAX_PER_PROJECT {
            resolution.excluded.push(ExcludedCustomMcp {
                name: name.clone(),
                reason: ExclusionReason::OverLimit {
                    max: consts::CUSTOM_MCP_MAX_PER_PROJECT,
                },
            });
            continue;
        }
        let (allowed_domains, domains_blocked_by_policy) =
            match managed.and_then(|m| m.allowed_domains.as_ref()) {
                Some(patterns) => entry
                    .allowed_domains
                    .iter()
                    .cloned()
                    .partition(|d| patterns.iter().any(|p| d.matches_pattern(p))),
                None => (entry.allowed_domains.clone(), Vec::new()),
            };
        resolution.effective.push(EffectiveCustomMcp {
            name: name.clone(),
            service_id: model::service_id(name),
            source: entry.source.clone(),
            tools: entry.tools.clone(),
            allowed_domains,
            domains_blocked_by_policy,
            pii_mode: managed
                .and_then(|m| m.force_pii_mode)
                .unwrap_or(entry.pii_mode),
            workspace_mode: entry.workspace_mode,
            consent_digest: entry.consent_digest.clone().unwrap_or_default(),
        });
    }
    resolution
}

/// The policy applied when the MDM file cannot be read: Custom MCP disabled (fail-closed).
pub fn unreadable_managed_policy() -> ManagedCustomMcpConfig {
    ManagedCustomMcpConfig {
        enabled: Some(false),
        ..ManagedCustomMcpConfig::default()
    }
}

/// The MDM `custom_mcp` policy in force now; an unreadable managed file yields
/// [`unreadable_managed_policy`], never `None`.
pub fn current_managed_policy() -> Option<ManagedCustomMcpConfig> {
    managed_policy_from(crate::managed_config::load_managed_config())
}

fn managed_policy_from(
    load: anyhow::Result<Option<crate::managed_config::ManagedConfig>>,
) -> Option<ManagedCustomMcpConfig> {
    match load {
        Ok(managed) => managed.and_then(|m| m.custom_mcp),
        Err(e) => {
            log::error!("organization policy is unreadable, Custom MCP servers stay off: {e:#}");
            Some(unreadable_managed_policy())
        }
    }
}

/// [`resolve_effective`] over the `custom_mcp` entries of `project` in `user_config`.
pub fn resolve_for_project(
    user_config: &crate::config::SpeedwaveUserConfig,
    project: &str,
    managed: Option<&ManagedCustomMcpConfig>,
) -> CustomMcpResolution {
    let empty = BTreeMap::new();
    resolve_effective(
        user_config
            .find_project(project)
            .and_then(|p| p.custom_mcp.as_ref())
            .unwrap_or(&empty),
        user_config.beta_enabled(),
        managed,
    )
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::custom_mcp::policy::tests::{approved, npm_entry};

    fn host_entry() -> CustomMcpEntry {
        approved(CustomMcpEntry {
            source: CustomMcpSource::Host {
                port: 3845,
                path: "/mcp".into(),
            },
            ..npm_entry()
        })
    }

    fn with_package(package: &str) -> CustomMcpEntry {
        let mut entry = npm_entry();
        if let CustomMcpSource::Npm { lock } = &mut entry.source {
            lock.package = package.to_string();
        }
        approved(entry)
    }

    fn map(entries: Vec<(&str, CustomMcpEntry)>) -> BTreeMap<String, CustomMcpEntry> {
        entries
            .into_iter()
            .map(|(n, e)| (n.to_string(), e))
            .collect()
    }

    fn reasons(r: &CustomMcpResolution) -> Vec<(String, ExclusionReason)> {
        r.excluded
            .iter()
            .map(|e| (e.name.clone(), e.reason.clone()))
            .collect()
    }

    #[test]
    fn approved_enabled_entry_runs_with_its_own_settings() {
        let entries = map(vec![("figma", approved(npm_entry()))]);
        let r = resolve_effective(&entries, true, None);
        assert!(r.excluded.is_empty());
        assert_eq!(r.effective.len(), 1);
        let e = &r.effective[0];
        assert_eq!(e.name, "figma");
        assert_eq!(e.service_id, "custom-figma");
        assert_eq!(e.pii_mode, CustomPiiMode::Tokens);
        assert_eq!(
            e.consent_digest,
            entries["figma"].consent_digest.clone().unwrap()
        );
    }

    #[test]
    fn empty_config_resolves_to_nothing() {
        let r = resolve_effective(&BTreeMap::new(), true, None);
        assert_eq!(r, CustomMcpResolution::default());
    }

    #[test]
    fn beta_off_excludes_everything() {
        let entries = map(vec![("a", approved(npm_entry())), ("b", host_entry())]);
        let r = resolve_effective(&entries, false, None);
        assert!(r.effective.is_empty());
        assert!(r
            .excluded
            .iter()
            .all(|e| e.reason == ExclusionReason::BetaDisabled));
    }

    #[test]
    fn managed_disable_excludes_everything_even_when_forced_on_elsewhere() {
        let entries = map(vec![("a", approved(npm_entry()))]);
        let managed = ManagedCustomMcpConfig {
            enabled: Some(false),
            ..Default::default()
        };
        let r = resolve_effective(&entries, true, Some(&managed));
        assert_eq!(
            reasons(&r),
            vec![("a".to_string(), ExclusionReason::ManagedDisabled)]
        );
        let on = ManagedCustomMcpConfig {
            enabled: Some(true),
            ..Default::default()
        };
        assert_eq!(
            resolve_effective(&entries, true, Some(&on)).effective.len(),
            1
        );
        assert!(resolve_effective(&entries, false, Some(&on))
            .effective
            .is_empty());
    }

    #[test]
    fn disabled_unapproved_and_changed_entries_are_excluded() {
        let mut changed = approved(npm_entry());
        changed.workspace_mode = WorkspaceMode::ReadWrite;
        let entries = map(vec![
            (
                "off",
                CustomMcpEntry {
                    enabled: false,
                    ..approved(npm_entry())
                },
            ),
            ("fresh", npm_entry()),
            ("changed", changed),
        ]);
        let r = resolve_effective(&entries, true, None);
        assert!(r.effective.is_empty());
        assert_eq!(
            reasons(&r),
            vec![
                ("changed".to_string(), ExclusionReason::ConsentChanged),
                ("fresh".to_string(), ExclusionReason::NotApproved),
                ("off".to_string(), ExclusionReason::Disabled),
            ]
        );
    }

    #[test]
    fn invalid_entries_are_excluded_with_the_validation_error() {
        let entries = map(vec![
            ("Bad", approved(npm_entry())),
            ("x-up", approved(npm_entry())),
            (
                "badport",
                approved(CustomMcpEntry {
                    source: CustomMcpSource::Host {
                        port: 0,
                        path: "/mcp".into(),
                    },
                    ..npm_entry()
                }),
            ),
        ]);
        let r = resolve_effective(&entries, true, None);
        assert!(r.effective.is_empty());
        assert_eq!(r.excluded.len(), 3);
        for e in &r.excluded {
            assert!(
                matches!(e.reason, ExclusionReason::Invalid { .. }),
                "{}: {:?}",
                e.name,
                e.reason
            );
        }
    }

    #[test]
    fn host_servers_follow_the_managed_switch() {
        let entries = map(vec![("desk", host_entry()), ("npm", approved(npm_entry()))]);
        let managed = ManagedCustomMcpConfig {
            host_servers_enabled: Some(false),
            ..Default::default()
        };
        let r = resolve_effective(&entries, true, Some(&managed));
        assert_eq!(
            reasons(&r),
            vec![("desk".to_string(), ExclusionReason::HostServersDisabled)]
        );
        assert_eq!(r.effective[0].name, "npm");
        let allowed = ManagedCustomMcpConfig {
            host_servers_enabled: Some(true),
            ..Default::default()
        };
        assert_eq!(
            resolve_effective(&entries, true, Some(&allowed))
                .effective
                .len(),
            2
        );
    }

    #[test]
    fn allowed_scopes_admit_only_scoped_packages_from_the_list() {
        let entries = map(vec![
            ("scoped", with_package("@acme/figma-mcp")),
            ("other", with_package("@evil/figma-mcp")),
            ("bare", with_package("figma-mcp")),
            ("desk", host_entry()),
        ]);
        let managed = ManagedCustomMcpConfig {
            allowed_scopes: Some(vec!["@acme".into()]),
            ..Default::default()
        };
        let r = resolve_effective(&entries, true, Some(&managed));
        let names: Vec<&str> = r.effective.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["desk", "scoped"]);
        assert_eq!(
            reasons(&r),
            vec![
                ("bare".to_string(), ExclusionReason::ScopeNotAllowed),
                ("other".to_string(), ExclusionReason::ScopeNotAllowed),
            ]
        );
    }

    #[test]
    fn workspace_above_the_managed_limit_is_rejected_not_clamped() {
        let rw = approved(CustomMcpEntry {
            workspace_mode: WorkspaceMode::ReadWrite,
            ..npm_entry()
        });
        let ro = approved(CustomMcpEntry {
            workspace_mode: WorkspaceMode::ReadOnly,
            ..npm_entry()
        });
        let entries = map(vec![("rw", rw), ("ro", ro)]);
        let managed = ManagedCustomMcpConfig {
            max_workspace_mode: Some(WorkspaceMode::ReadOnly),
            ..Default::default()
        };
        let r = resolve_effective(&entries, true, Some(&managed));
        assert_eq!(
            reasons(&r),
            vec![(
                "rw".to_string(),
                ExclusionReason::WorkspaceModeAboveLimit {
                    limit: WorkspaceMode::ReadOnly
                }
            )]
        );
        assert_eq!(r.effective[0].workspace_mode, WorkspaceMode::ReadOnly);
    }

    #[test]
    fn forced_pii_mode_overrides_without_breaking_consent() {
        let entries = map(vec![(
            "a",
            approved(CustomMcpEntry {
                pii_mode: CustomPiiMode::Plaintext,
                ..npm_entry()
            }),
        )]);
        let managed = ManagedCustomMcpConfig {
            force_pii_mode: Some(CustomPiiMode::Tokens),
            ..Default::default()
        };
        let r = resolve_effective(&entries, true, Some(&managed));
        assert_eq!(r.effective[0].pii_mode, CustomPiiMode::Tokens);
        assert_eq!(
            resolve_effective(&entries, true, None).effective[0].pii_mode,
            CustomPiiMode::Plaintext
        );
    }

    #[test]
    fn managed_domain_allowlist_filters_egress_targets() {
        let mut entry = npm_entry();
        entry.allowed_domains = ["api.figma.com:443", "figma.com:443", "cdn.evil.com:443"]
            .iter()
            .map(|d| HostPort::parse(d).unwrap())
            .collect();
        let entries = map(vec![("a", approved(entry))]);
        let managed = ManagedCustomMcpConfig {
            allowed_domains: Some(vec!["*.figma.com".into()]),
            ..Default::default()
        };
        let e = &resolve_effective(&entries, true, Some(&managed)).effective[0];
        assert_eq!(
            e.allowed_domains,
            vec![HostPort::parse("api.figma.com:443").unwrap()]
        );
        assert_eq!(
            e.domains_blocked_by_policy,
            vec![
                HostPort::parse("figma.com:443").unwrap(),
                HostPort::parse("cdn.evil.com:443").unwrap()
            ]
        );
        let unfiltered = &resolve_effective(&entries, true, None).effective[0];
        assert_eq!(unfiltered.allowed_domains.len(), 3);
        assert!(unfiltered.domains_blocked_by_policy.is_empty());
    }

    #[test]
    fn at_most_the_per_project_maximum_runs_in_name_order() {
        let names = ["g", "a", "f", "b", "e", "c", "d"];
        let mut entries = map(names.iter().map(|n| (*n, approved(npm_entry()))).collect());
        entries.insert(
            "zz-off".into(),
            CustomMcpEntry {
                enabled: false,
                ..approved(npm_entry())
            },
        );
        let r = resolve_effective(&entries, true, None);
        let running: Vec<&str> = r.effective.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(running, vec!["a", "b", "c", "d", "e"]);
        assert_eq!(running.len(), consts::CUSTOM_MCP_MAX_PER_PROJECT);
        assert_eq!(
            reasons(&r),
            vec![
                ("f".to_string(), ExclusionReason::OverLimit { max: 5 }),
                ("g".to_string(), ExclusionReason::OverLimit { max: 5 }),
                ("zz-off".to_string(), ExclusionReason::Disabled),
            ]
        );
    }

    #[test]
    fn ineligible_entries_do_not_take_slots() {
        let mut entries = map(vec![("a", npm_entry()), ("b", npm_entry())]);
        for n in ["c", "d", "e", "f", "g"] {
            entries.insert(n.into(), approved(npm_entry()));
        }
        let r = resolve_effective(&entries, true, None);
        assert_eq!(r.effective.len(), 5);
        assert!(r
            .excluded
            .iter()
            .all(|e| e.reason == ExclusionReason::NotApproved));
    }

    #[test]
    fn exclusion_reasons_serialize_with_a_tag() {
        let v = serde_json::to_value(ExclusionReason::WorkspaceModeAboveLimit {
            limit: WorkspaceMode::None,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"reason": "workspace_mode_above_limit", "limit": "none"})
        );
        assert_eq!(
            serde_json::to_value(ExclusionReason::NotApproved).unwrap(),
            serde_json::json!({"reason": "not_approved"})
        );
    }

    #[test]
    fn an_unreadable_managed_file_disables_custom_mcp() {
        let policy = managed_policy_from(Err(anyhow::anyhow!("malformed"))).unwrap();
        assert_eq!(policy.enabled, Some(false));
        let entries = map(vec![("figma", approved(npm_entry()))]);
        let r = resolve_effective(&entries, true, Some(&policy));
        assert!(r.effective.is_empty());
        assert_eq!(r.excluded[0].reason, ExclusionReason::ManagedDisabled);
    }

    #[test]
    fn a_missing_managed_file_or_key_sets_no_policy() {
        assert!(managed_policy_from(Ok(None)).is_none());
        let managed = crate::managed_config::ManagedConfig::default();
        assert!(managed_policy_from(Ok(Some(managed))).is_none());
    }

    #[test]
    fn resolve_for_project_reads_the_project_entries_and_the_beta_flag() {
        let mut user: crate::config::SpeedwaveUserConfig = serde_json::from_value(
            serde_json::json!({"projects": [{"name": "acme", "dir": "/tmp/acme"}]}),
        )
        .unwrap();
        assert!(resolve_for_project(&user, "acme", None)
            .effective
            .is_empty());
        user.projects[0].custom_mcp = Some(map(vec![("figma", approved(npm_entry()))]));
        assert_eq!(
            resolve_for_project(&user, "acme", None).excluded[0].reason,
            ExclusionReason::BetaDisabled
        );
        user.ui = Some(crate::config::UiPrefsConfig {
            beta_enabled: Some(true),
        });
        assert_eq!(resolve_for_project(&user, "acme", None).effective.len(), 1);
        assert!(resolve_for_project(&user, "other", None)
            .effective
            .is_empty());
    }
}

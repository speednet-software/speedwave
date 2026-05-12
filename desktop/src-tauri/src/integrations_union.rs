//! Union of enabled integrations across all registered projects.
//!
//! Setup and reconcile build images for every project that could be
//! auto-restored or switched to, so they OR the per-project resolved configs.

use speedwave_runtime::config::{self, ResolvedIntegrationsConfig, SpeedwaveUserConfig};
use std::path::Path;

/// ORs the resolved integrations of every project in `user_config`. A project
/// whose dir is missing or unreadable is skipped with a warning (a stale config
/// entry must not break reconcile).
pub fn union_integrations(user_config: &SpeedwaveUserConfig) -> ResolvedIntegrationsConfig {
    let mut acc = ResolvedIntegrationsConfig::default();
    for entry in &user_config.projects {
        let dir = Path::new(&entry.dir);
        if !dir.is_dir() {
            log::warn!(
                "union_integrations: project '{}' dir {} not found, skipping",
                entry.name,
                entry.dir
            );
            continue;
        }
        let resolved = config::resolve_integrations(dir, user_config, &entry.name);
        merge_into(&mut acc, &resolved);
    }
    acc
}

fn merge_into(acc: &mut ResolvedIntegrationsConfig, other: &ResolvedIntegrationsConfig) {
    acc.slack |= other.slack;
    acc.sharepoint |= other.sharepoint;
    acc.redmine |= other.redmine;
    acc.gitlab |= other.gitlab;
    acc.github |= other.github;
    acc.atlassian |= other.atlassian;
    acc.playwright |= other.playwright;
    acc.os_reminders |= other.os_reminders;
    acc.os_calendar |= other.os_calendar;
    acc.os_mail |= other.os_mail;
    acc.os_notes |= other.os_notes;
    for (id, &enabled) in &other.plugins {
        let slot = acc.plugins.entry(id.clone()).or_insert(false);
        *slot |= enabled;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use speedwave_runtime::config::ProjectUserEntry;

    fn entry(
        name: &str,
        dir: &str,
        integrations: Option<config::IntegrationsConfig>,
    ) -> ProjectUserEntry {
        ProjectUserEntry {
            name: name.to_string(),
            dir: dir.to_string(),
            claude: None,
            integrations,
            plugin_settings: None,
        }
    }

    fn ints_with(slack: bool, github: bool) -> config::IntegrationsConfig {
        let mut c = config::IntegrationsConfig::default();
        if slack {
            c.set_service(
                "slack",
                config::IntegrationConfig {
                    enabled: Some(true),
                },
            );
        }
        if github {
            c.set_service(
                "github",
                config::IntegrationConfig {
                    enabled: Some(true),
                },
            );
        }
        c
    }

    #[test]
    fn empty_config_yields_default() {
        let u = union_integrations(&SpeedwaveUserConfig::default());
        assert!(!u.slack && !u.github && u.plugins.is_empty());
    }

    #[test]
    fn ors_across_projects() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let cfg = SpeedwaveUserConfig {
            projects: vec![
                entry(
                    "a",
                    a.path().to_str().unwrap(),
                    Some(ints_with(true, false)),
                ),
                entry(
                    "b",
                    b.path().to_str().unwrap(),
                    Some(ints_with(false, true)),
                ),
            ],
            ..SpeedwaveUserConfig::default()
        };
        let u = union_integrations(&cfg);
        assert!(u.slack, "slack from project a");
        assert!(u.github, "github from project b");
        assert!(!u.redmine);
    }

    #[test]
    fn skips_missing_dir() {
        let real = tempfile::tempdir().unwrap();
        let cfg = SpeedwaveUserConfig {
            projects: vec![
                entry(
                    "gone",
                    "/nonexistent/path/xyz",
                    Some(ints_with(true, false)),
                ),
                entry(
                    "real",
                    real.path().to_str().unwrap(),
                    Some(ints_with(false, true)),
                ),
            ],
            ..SpeedwaveUserConfig::default()
        };
        let u = union_integrations(&cfg);
        // slack came only from the missing project → not picked up; github survives.
        assert!(!u.slack);
        assert!(u.github);
    }
}

//! Compose network naming SSOT and the egress-less networks the engine pre-creates with
//! `nerdctl network create --internal` (nerdctl compose ignores a network's `internal:` key).

use crate::consts;
use std::path::Path;

const PROJECT_NETWORK_SUFFIX: &str = "network";

/// The project's main compose network: `<compose_prefix>_<project>_network`.
pub(crate) fn project_network_name(project: &str) -> String {
    format!(
        "{}_{project}_{PROJECT_NETWORK_SUFFIX}",
        consts::compose_prefix()
    )
}

/// The egress-less network of the service `config_key`, derived from the main `network_name`.
pub(crate) fn egress_less_network_name(network_name: &str, config_key: &str) -> String {
    format!("{network_name}_{config_key}")
}

/// The engine name compose gives a non-external network `key` of `project` declared without
/// `name:` (`<project>_<key>`): where releases before the `--internal` pre-create put office.
pub(crate) fn legacy_compose_network_name(project: &str, key: &str) -> String {
    format!("{project}_{key}")
}

fn egress_less_config_keys() -> impl Iterator<Item = &'static str> {
    consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .filter(|svc| svc.egress_less)
        .map(|svc| svc.config_key)
}

/// Every egress-less network `project` can have, one per `egress_less` service descriptor.
pub(crate) fn egress_less_network_names(project: &str) -> Vec<String> {
    let network_name = project_network_name(project);
    egress_less_config_keys()
        .map(|key| egress_less_network_name(&network_name, key))
        .collect()
}

/// `true` when `key` is the egress-less network of an `egress_less` service.
pub(crate) fn is_egress_less_network(key: &str) -> bool {
    egress_less_config_keys().any(|config_key| {
        key.strip_suffix(config_key)
            .and_then(|rest| rest.strip_suffix('_'))
            .is_some_and(|rest| rest.ends_with(&format!("_{PROJECT_NETWORK_SUFFIX}")))
    })
}

/// Engine names of the egress-less networks `yaml` declares `external: true`: the networks
/// that must exist, created with `--internal`, before `compose up`.
pub(crate) fn external_egress_less_networks(yaml: &str) -> anyhow::Result<Vec<String>> {
    let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)
        .map_err(|e| anyhow::anyhow!("failed to parse compose YAML for its networks: {e}"))?;
    let Some(networks) = doc.get("networks").and_then(|n| n.as_mapping()) else {
        return Ok(Vec::new());
    };
    Ok(networks
        .iter()
        .filter_map(|(key, decl)| {
            let key = key.as_str()?;
            if !is_egress_less_network(key) || !declares_external(decl) {
                return None;
            }
            let name = decl.get("name").and_then(|n| n.as_str()).unwrap_or(key);
            Some(name.to_string())
        })
        .collect())
}

/// `true` when a top-level network declaration carries `external: true`.
pub(crate) fn declares_external(decl: &serde_yaml_ng::Value) -> bool {
    decl.get("external").and_then(|e| e.as_bool()) == Some(true)
}

/// [`external_egress_less_networks`] of the project's rendered compose file under `data_dir`;
/// none when no compose file was rendered yet.
pub(crate) fn compose_egress_less_networks_in(
    data_dir: &Path,
    project: &str,
) -> anyhow::Result<Vec<String>> {
    let path = super::compose_output_path_in(data_dir, project)?;
    match std::fs::read_to_string(&path) {
        Ok(yaml) => external_egress_less_networks(&yaml),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(anyhow::anyhow!("failed to read {}: {e}", path.display())),
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;

    #[test]
    fn project_network_name_is_prefix_project_network() {
        assert_eq!(
            project_network_name("acme"),
            format!("{}_acme_network", consts::compose_prefix())
        );
    }

    #[test]
    fn legacy_compose_network_name_prefixes_the_key_with_the_compose_project() {
        let office = egress_less_network_names("acme").remove(0);
        assert_eq!(
            legacy_compose_network_name("acme", &office),
            format!("acme_{}_acme_network_office", consts::compose_prefix())
        );
        assert_ne!(legacy_compose_network_name("acme", &office), office);
    }

    #[test]
    fn egress_less_network_names_cover_every_egress_less_service() {
        let names = egress_less_network_names("acme");
        let expected: Vec<String> = consts::TOGGLEABLE_MCP_SERVICES
            .iter()
            .filter(|svc| svc.egress_less)
            .map(|svc| {
                format!(
                    "{}_acme_network_{}",
                    consts::compose_prefix(),
                    svc.config_key
                )
            })
            .collect();
        assert_eq!(names, expected);
        assert!(names.iter().any(|n| n.ends_with("_network_office")));
        assert!(names.iter().all(|n| is_egress_less_network(n)));
    }

    #[test]
    fn is_egress_less_network_matches_only_egress_less_suffixes() {
        assert!(is_egress_less_network("speedwave_test_network_office"));
        assert!(is_egress_less_network("sw-dev_my-proj_network_office"));
        assert!(!is_egress_less_network("speedwave_test_network"));
        assert!(!is_egress_less_network("speedwave_test_network_slack"));
        assert!(!is_egress_less_network("speedwave_test_networkoffice"));
        assert!(!is_egress_less_network("office"));
        assert!(!is_egress_less_network("_office"));
        assert!(!is_egress_less_network(""));
    }

    #[test]
    fn external_egress_less_networks_lists_external_declarations_by_name() {
        let yaml = r#"
services: {}
networks:
  speedwave_test_network:
    driver: bridge
  speedwave_test_network_office:
    name: speedwave_test_network_office
    external: true
"#;
        assert_eq!(
            external_egress_less_networks(yaml).unwrap(),
            vec!["speedwave_test_network_office".to_string()]
        );
    }

    #[test]
    fn external_egress_less_networks_falls_back_to_the_key_without_a_name() {
        let yaml = "networks:\n  speedwave_test_network_office:\n    external: true\n";
        assert_eq!(
            external_egress_less_networks(yaml).unwrap(),
            vec!["speedwave_test_network_office".to_string()]
        );
    }

    #[test]
    fn external_egress_less_networks_skips_compose_managed_and_other_networks() {
        let yaml = r#"
networks:
  speedwave_test_network:
    external: true
  speedwave_test_network_office:
    driver: bridge
    internal: true
"#;
        assert!(external_egress_less_networks(yaml).unwrap().is_empty());
        assert!(external_egress_less_networks("services: {}\n")
            .unwrap()
            .is_empty());
        assert!(
            external_egress_less_networks("networks:\n  speedwave_test_network_office:\n")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn external_egress_less_networks_rejects_unparsable_yaml() {
        let err = external_egress_less_networks("networks: [unclosed").unwrap_err();
        assert!(
            err.to_string().contains("failed to parse compose YAML"),
            "{err}"
        );
    }

    #[test]
    fn compose_egress_less_networks_in_reads_the_rendered_compose() {
        let tmp = tempfile::tempdir().unwrap();
        let path = super::super::compose_output_path_in(tmp.path(), "acme").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "networks:\n  speedwave_acme_network_office:\n    external: true\n",
        )
        .unwrap();
        assert_eq!(
            compose_egress_less_networks_in(tmp.path(), "acme").unwrap(),
            vec!["speedwave_acme_network_office".to_string()]
        );
    }

    #[test]
    fn compose_egress_less_networks_in_is_empty_without_a_rendered_compose() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(compose_egress_less_networks_in(tmp.path(), "acme")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn compose_egress_less_networks_in_rejects_an_invalid_project_name() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(compose_egress_less_networks_in(tmp.path(), "../escape").is_err());
    }
}

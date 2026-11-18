use std::path::Path;

use crate::{consts, fs_perms, plugin};

pub(super) fn write(data_dir: &Path, project: &str, service: &str) {
    let token_dir = plugin::token_dir_in(data_dir, project, service);
    if !token_dir.is_dir() {
        return;
    }
    let path = token_dir.join(consts::OAUTH_SERVICE_NAME_FILE);
    let name = resolve(data_dir, service);
    if std::fs::read_to_string(&path).is_ok_and(|current| current == name) {
        return;
    }
    if fs_perms::write_restricted_file(&path, &name).is_err() {
        log::warn!("failed to write the service name file");
    }
}

fn resolve(data_dir: &Path, service: &str) -> String {
    if let Some(builtin) = consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .find(|svc| svc.config_key == service)
    {
        return builtin.display_name.to_string();
    }
    plugin::list_installed_from_dir(&plugin::plugins_base_dir_in(data_dir))
        .ok()
        .and_then(|plugins| {
            plugins
                .into_iter()
                .find(|manifest| manifest.config_key() == service)
        })
        .map_or_else(|| service.to_string(), |manifest| manifest.name)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    fn name_of(data_dir: &Path, service: &str) -> Option<String> {
        let dir = plugin::token_dir_in(data_dir, "proj", service);
        std::fs::read_to_string(dir.join(consts::OAUTH_SERVICE_NAME_FILE)).ok()
    }

    fn token_dir(data_dir: &Path, service: &str) {
        std::fs::create_dir_all(plugin::token_dir_in(data_dir, "proj", service)).unwrap();
    }

    fn install_plugin(data_dir: &Path, slug: &str, service_id: &str, name: &str) {
        let dir = plugin::plugins_base_dir_in(data_dir).join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({
            "name": name,
            "slug": slug,
            "service_id": service_id,
            "version": "1.0.0",
            "description": "d",
        });
        std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    }

    #[test]
    fn a_built_in_service_gets_its_descriptor_display_name() {
        let dir = tempfile::tempdir().unwrap();
        for svc in consts::TOGGLEABLE_MCP_SERVICES {
            token_dir(dir.path(), svc.config_key);
            write(dir.path(), "proj", svc.config_key);
            assert_eq!(
                name_of(dir.path(), svc.config_key).as_deref(),
                Some(svc.display_name)
            );
        }
    }

    #[test]
    fn a_plugin_gets_the_name_from_its_manifest() {
        let dir = tempfile::tempdir().unwrap();
        install_plugin(dir.path(), "glpi-plugin", "glpi", "GLPI Helpdesk");
        token_dir(dir.path(), "glpi");
        write(dir.path(), "proj", "glpi");
        assert_eq!(
            name_of(dir.path(), "glpi").as_deref(),
            Some("GLPI Helpdesk")
        );
    }

    #[test]
    fn an_unknown_service_gets_its_id() {
        let dir = tempfile::tempdir().unwrap();
        token_dir(dir.path(), "mystery");
        write(dir.path(), "proj", "mystery");
        assert_eq!(name_of(dir.path(), "mystery").as_deref(), Some("mystery"));
    }

    #[test]
    fn a_renamed_plugin_rewrites_the_file() {
        let dir = tempfile::tempdir().unwrap();
        install_plugin(dir.path(), "glpi-plugin", "glpi", "GLPI");
        token_dir(dir.path(), "glpi");
        write(dir.path(), "proj", "glpi");
        install_plugin(dir.path(), "glpi-plugin", "glpi", "GLPI Helpdesk");
        write(dir.path(), "proj", "glpi");
        assert_eq!(
            name_of(dir.path(), "glpi").as_deref(),
            Some("GLPI Helpdesk")
        );
    }

    #[test]
    fn a_missing_token_dir_is_not_created() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "proj", "slack");
        assert!(!plugin::token_dir_in(dir.path(), "proj", "slack").exists());
    }
}

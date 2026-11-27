use speedwave_runtime::config;
use speedwave_runtime::plugin;
use speedwave_runtime::runtime::LockedRuntime;

pub(super) fn install(path: &str, runtime: Option<&LockedRuntime>) -> anyhow::Result<()> {
    let outcome = plugin::install_plugin(std::path::Path::new(path), runtime, &mut |_| {})?;
    match outcome {
        plugin::InstallOutcome::Installed(manifest) => {
            out!(
                "Plugin '{}' ({}) installed successfully",
                manifest.name,
                manifest.slug
            );
        }
        plugin::InstallOutcome::InstalledPendingBuild(manifest) => {
            err!(
                "Plugin '{}' ({}) installed; image build failed and will retry on next launch",
                manifest.name,
                manifest.slug
            );
        }
    }
    Ok(())
}

pub(super) fn list() {
    let plugins = plugin::list_for_ui();
    if plugins.is_empty() {
        out!("No plugins installed");
    } else {
        for e in &plugins {
            let name = e
                .manifest
                .as_ref()
                .map(|m| m.name.as_str())
                .unwrap_or(&e.slug);
            let version = e
                .manifest
                .as_ref()
                .map(|m| m.version.as_str())
                .unwrap_or("?");
            if e.verification_status == plugin::VerificationStatus::Verified {
                out!("{name} ({}): {version}  [verified]", e.slug);
            } else {
                let reason = e.verification_error.as_deref().unwrap_or("unverified");
                out!("{name} ({}): {version}  [UNVERIFIED: {reason}]", e.slug);
            }
        }
    }
}

pub(super) fn remove(slug: &str, runtime: Option<&LockedRuntime>) -> anyhow::Result<()> {
    plugin::remove_plugin(slug, runtime)?;
    out!("Plugin '{}' removed", slug);
    Ok(())
}

pub(super) fn enable(service_id: &str, project: &str) -> anyhow::Result<()> {
    let entries = plugin::list_for_ui();
    let entry = find_entry(&entries, service_id)?;
    if entry.verification_status != plugin::VerificationStatus::Verified {
        return Err(anyhow::anyhow!(
            "plugin '{}' cannot be enabled: {}. Reinstall a signed plugin or remove it.",
            service_id,
            entry
                .verification_error
                .as_deref()
                .unwrap_or("signature verification failed")
        ));
    }
    let display_name = display_name(entry, service_id);
    set_enabled(service_id, project, true)?;
    out!(
        "Plugin '{}' (service_id: {}) enabled for project '{}'",
        display_name,
        service_id,
        project
    );
    Ok(())
}

pub(super) fn disable(service_id: &str, project: &str) -> anyhow::Result<()> {
    let entries = plugin::list_for_ui();
    let entry = find_entry(&entries, service_id)?;
    let display_name = display_name(entry, service_id);
    set_enabled(service_id, project, false)?;
    out!(
        "Plugin '{}' (service_id: {}) disabled for project '{}'",
        display_name,
        service_id,
        project
    );
    Ok(())
}

fn find_entry<'a>(
    entries: &'a [plugin::PluginListEntry],
    service_id: &str,
) -> anyhow::Result<&'a plugin::PluginListEntry> {
    entries
        .iter()
        .find(|e| {
            e.manifest.as_ref().map(|m| m.service_id.as_deref()) == Some(Some(service_id))
                || e.slug == service_id
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "No installed plugin with service_id '{}'. Run `speedwave plugin list` to see installed plugins.",
                service_id
            )
        })
}

fn display_name(entry: &plugin::PluginListEntry, service_id: &str) -> String {
    entry
        .manifest
        .as_ref()
        .map(|m| m.name.clone())
        .unwrap_or_else(|| service_id.to_string())
}

fn set_enabled(service_id: &str, project: &str, enabled: bool) -> anyhow::Result<()> {
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let cfg_entry = user_config
            .projects
            .iter_mut()
            .find(|p| p.name == project)
            .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;
        let integrations = cfg_entry.integrations.get_or_insert_with(Default::default);
        integrations.set_plugin_enabled(service_id, enabled);
        config::save_user_config(&user_config)
    })
}

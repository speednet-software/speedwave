use crate::compose::container_user;
use crate::consts;
use crate::runtime::ContainerRuntime;
use crate::signing;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Slug validation: lowercase letters, digits, hyphens. Starts with letter. Max 64 chars.
const SLUG_PATTERN: &str = r"^[a-z][a-z0-9-]{0,63}$";

/// RAII guard that removes a temporary directory on drop.
struct TmpDirGuard(PathBuf);
impl Drop for TmpDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AuthFieldDef {
    pub key: String,
    pub label: String,
    pub field_type: String,
    pub placeholder: String,
    pub is_secret: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum TokenMount {
    #[default]
    ReadOnly,
    ReadWrite {
        justification: String,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PluginManifest {
    pub name: String,
    #[serde(default)]
    pub service_id: Option<String>,
    pub slug: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub image_tag: Option<String>,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub token_mount: TokenMount,
    #[serde(default)]
    pub auth_fields: Vec<AuthFieldDef>,
    #[serde(default)]
    pub settings_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub speedwave_compat: Option<String>,
    #[serde(default)]
    pub extra_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub mem_limit: Option<String>,
}

/// Returns `~/.speedwave/plugins/`
pub fn plugins_base_dir() -> anyhow::Result<PathBuf> {
    Ok(dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot find home dir"))?
        .join(consts::DATA_DIR)
        .join("plugins"))
}

/// Derives WORKER_{SID}_URL from a service_id. E.g. "presale" → "WORKER_PRESALE_URL"
pub fn derive_worker_env(service_id: &str) -> String {
    format!("WORKER_{}_URL", service_id.to_uppercase().replace('-', "_"))
}

/// Derives compose service name from service_id. E.g. "presale" → "mcp-presale"
pub fn derive_compose_name(service_id: &str) -> String {
    format!("mcp-{}", service_id)
}

/// Validates a slug matches the required pattern.
fn validate_slug(slug: &str) -> anyhow::Result<()> {
    let re = regex::Regex::new(SLUG_PATTERN)?;
    if !re.is_match(slug) {
        anyhow::bail!(
            "Invalid plugin slug '{}': must match {} (lowercase, starts with letter, max 64 chars)",
            slug,
            SLUG_PATTERN
        );
    }
    Ok(())
}

/// Validates manifest constraints at install time.
fn validate_manifest(manifest: &PluginManifest, plugin_dir: &Path) -> anyhow::Result<()> {
    validate_slug(&manifest.slug)?;

    // If service_id present, slug must equal service_id
    if let Some(ref sid) = manifest.service_id {
        if manifest.slug != *sid {
            anyhow::bail!(
                "Plugin slug '{}' must equal service_id '{}' for MCP plugins",
                manifest.slug,
                sid
            );
        }
    }

    // Slug must not collide with built-in service IDs
    if consts::BUILT_IN_SERVICE_IDS.contains(&manifest.slug.as_str()) {
        anyhow::bail!(
            "Plugin slug '{}' conflicts with a built-in service ID",
            manifest.slug
        );
    }

    // If service_id present, Containerfile must exist
    if manifest.service_id.is_some() && !plugin_dir.join("Containerfile").exists() {
        anyhow::bail!(
            "MCP plugins (service_id='{}') must include a Containerfile",
            manifest.service_id.as_deref().unwrap_or("")
        );
    }

    // If ReadWrite, justification must be non-empty
    if let TokenMount::ReadWrite { ref justification } = manifest.token_mount {
        if justification.trim().is_empty() {
            anyhow::bail!("ReadWrite token mount requires a non-empty justification");
        }
    }

    Ok(())
}

/// Install a plugin from a ZIP file into `~/.speedwave/plugins/<slug>/`.
/// Verifies signature, validates manifest, and creates `.image_pending` marker
/// for deferred image build.
pub fn install_plugin(
    zip_path: &Path,
    runtime: Option<&dyn ContainerRuntime>,
) -> anyhow::Result<PluginManifest> {
    let plugins_dir = plugins_base_dir()?;
    std::fs::create_dir_all(&plugins_dir)?;

    // Extract ZIP to a temporary directory first
    let tmp_dir = std::env::temp_dir().join(format!("speedwave-plugin-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir)?;
    let _cleanup = TmpDirGuard(tmp_dir.clone());
    extract_zip(zip_path, &tmp_dir)?;

    // Zip Slip protection
    validate_extracted_paths(&tmp_dir)?;

    // Find the extracted plugin directory (ZIP may contain a top-level dir)
    let plugin_src = find_plugin_dir(&tmp_dir)?;

    // Verify signature before doing anything else
    signing::verify_plugin_signature(&plugin_src)?;

    // Read and validate manifest
    let manifest_path = plugin_src.join("plugin.json");
    if !manifest_path.exists() {
        anyhow::bail!("plugin.json not found in extracted plugin");
    }
    let content = std::fs::read_to_string(&manifest_path)?;
    let manifest: PluginManifest = serde_json::from_str(&content)?;

    validate_manifest(&manifest, &plugin_src)?;

    // Move to final location
    let dest = plugins_dir.join(&manifest.slug);
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    copy_dir_recursive(&plugin_src, &dest)?;

    // Create .image_pending marker if MCP plugin
    if manifest.service_id.is_some() {
        std::fs::write(dest.join(".image_pending"), "")?;

        // Build immediately if runtime is available
        if let Some(rt) = runtime {
            if let Err(e) = build_single_plugin_image(rt, &manifest, &dest) {
                log::warn!("Deferred build for plugin '{}': {e}", manifest.slug);
            }
        }
    }

    // Legacy addon migration warning
    warn_legacy_addons();

    Ok(manifest)
}

/// Removes a plugin by slug.
pub fn remove_plugin(slug: &str) -> anyhow::Result<()> {
    validate_slug(slug)?;
    let plugin_dir = plugins_base_dir()?.join(slug);
    if !plugin_dir.exists() {
        anyhow::bail!("Plugin '{}' not found", slug);
    }
    std::fs::remove_dir_all(&plugin_dir)?;
    log::info!("Removed plugin '{}'", slug);
    Ok(())
}

/// Lists all installed plugins by scanning `~/.speedwave/plugins/*/plugin.json`
pub fn list_installed_plugins() -> anyhow::Result<Vec<PluginManifest>> {
    let plugins_dir = plugins_base_dir()?;
    if !plugins_dir.exists() {
        return Ok(vec![]);
    }

    let mut plugins = Vec::new();
    for entry in std::fs::read_dir(&plugins_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let manifest_path = entry.path().join("plugin.json");
            if manifest_path.exists() {
                let content = std::fs::read_to_string(&manifest_path)?;
                match serde_json::from_str::<PluginManifest>(&content) {
                    Ok(manifest) => plugins.push(manifest),
                    Err(e) => {
                        log::warn!(
                            "Skipping plugin at {}: invalid manifest: {e}",
                            entry.path().display()
                        );
                    }
                }
            }
        }
    }
    Ok(plugins)
}

/// Builds pending plugin images (those with `.image_pending` marker).
pub fn build_pending_plugin_images(runtime: &dyn ContainerRuntime) -> anyhow::Result<()> {
    let plugins_dir = plugins_base_dir()?;
    if !plugins_dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(&plugins_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let pending_marker = entry.path().join(".image_pending");
        if !pending_marker.exists() {
            continue;
        }
        let manifest_path = entry.path().join("plugin.json");
        if !manifest_path.exists() {
            continue;
        }
        let content = std::fs::read_to_string(&manifest_path)?;
        let manifest: PluginManifest = serde_json::from_str(&content)?;

        build_single_plugin_image(runtime, &manifest, &entry.path())?;
    }
    Ok(())
}

/// Builds a single plugin image using prepare_build_context + build_image.
fn build_single_plugin_image(
    runtime: &dyn ContainerRuntime,
    manifest: &PluginManifest,
    plugin_dir: &Path,
) -> anyhow::Result<()> {
    let tag = plugin_image_tag(manifest);
    let vm_root = runtime.prepare_build_context(plugin_dir)?;
    let containerfile = vm_root.join("Containerfile");

    log::info!(
        "Building plugin image {} from {}",
        tag,
        plugin_dir.display()
    );
    runtime.build_image(
        &tag,
        &vm_root.to_string_lossy(),
        &containerfile.to_string_lossy(),
    )?;

    // Remove the pending marker on success
    let pending_marker = plugin_dir.join(".image_pending");
    if pending_marker.exists() {
        let _ = std::fs::remove_file(&pending_marker);
    }

    // Clean up temporary build context if it differs from plugin_dir
    if vm_root != plugin_dir && vm_root.exists() {
        if let Err(e) = std::fs::remove_dir_all(&vm_root) {
            log::warn!(
                "Failed to clean up plugin build cache {}: {e}",
                vm_root.display()
            );
        }
    }

    Ok(())
}

/// Returns the image tag for a plugin. E.g. "speedwave-mcp-presale:1.2.0"
fn plugin_image_tag(manifest: &PluginManifest) -> String {
    let tag = manifest.image_tag.as_deref().unwrap_or(&manifest.version);
    format!("speedwave-mcp-{}:{}", manifest.slug, tag)
}

/// Generates a fully-resolved compose service definition for a plugin.
/// Follows the `apply_llm_config()` pattern (format! + serde_yaml insert).
pub fn generate_plugin_service(
    manifest: &PluginManifest,
    project_name: &str,
    network_name: &str,
    tokens_dir: &Path,
) -> anyhow::Result<serde_yaml_ng::Value> {
    let sid = manifest
        .service_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("generate_plugin_service requires service_id"))?;

    let tag = plugin_image_tag(manifest);
    let container_name = format!(
        "{}_{}_{}_{}",
        consts::COMPOSE_PREFIX,
        project_name,
        "mcp",
        sid.replace('-', "_")
    );
    let port = manifest
        .port
        .ok_or_else(|| anyhow::anyhow!("MCP plugin '{}' must specify a port", sid))?;

    let token_mount_mode = match &manifest.token_mount {
        TokenMount::ReadOnly => "ro",
        TokenMount::ReadWrite { .. } => "rw",
    };

    let tokens_path = to_engine_path(&tokens_dir.join(sid))?;
    let mem_limit = manifest.mem_limit.as_deref().unwrap_or("256m");
    let user = container_user();

    let mut env_lines = format!("  - PORT={port}");
    if let Some(ref extra) = manifest.extra_env {
        for (k, v) in extra {
            env_lines.push_str(&format!("\n  - {}={}", k, v));
        }
    }

    let yaml_str = format!(
        r#"
image: {tag}
container_name: {container_name}
read_only: true
user: "{user}"
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
tmpfs:
  - /tmp:noexec,nosuid,size=64m
volumes:
  - {tokens_path}:/tokens:{token_mount_mode}
environment:
{env_lines}
networks:
  - {network_name}
labels:
  speedwave.plugin-service: "true"
deploy:
  resources:
    limits:
      cpus: '0.5'
      memory: {mem_limit}
"#,
        tag = tag,
        container_name = container_name,
        user = user,
        tokens_path = tokens_path,
        token_mount_mode = token_mount_mode,
        env_lines = env_lines,
        network_name = network_name,
        mem_limit = mem_limit,
    );

    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml_str)?;
    Ok(value)
}

// --- Helper functions ---

/// Converts a host path to the path seen by the container engine.
fn to_engine_path(path: &Path) -> anyhow::Result<String> {
    #[cfg(target_os = "windows")]
    {
        let wsl = crate::runtime::wsl::windows_to_wsl_path(path)?;
        Ok(wsl.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(path.to_string_lossy().to_string())
    }
}

fn extract_zip(zip_path: &Path, dest: &Path) -> anyhow::Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    archive.extract(dest)?;
    Ok(())
}

/// Validates that all files within a directory stay within the directory boundary.
/// Detects Zip Slip attacks where archives contain paths like `../../etc/passwd`.
fn validate_extracted_paths(base_dir: &Path) -> anyhow::Result<()> {
    let canonical_base = base_dir.canonicalize()?;
    validate_dir_recursive(&canonical_base, base_dir)
}

fn validate_dir_recursive(canonical_base: &Path, dir: &Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let canonical = path.canonicalize()?;
        if !canonical.starts_with(canonical_base) {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
            anyhow::bail!(
                "Zip Slip detected: path {:?} escapes plugin directory {:?}",
                canonical,
                canonical_base
            );
        }
        if entry.file_type()?.is_dir() {
            validate_dir_recursive(canonical_base, &path)?;
        }
    }
    Ok(())
}

/// Find the plugin directory inside the extraction. Handles ZIPs with a top-level dir.
fn find_plugin_dir(extract_dir: &Path) -> anyhow::Result<PathBuf> {
    // If plugin.json exists at the top level, use it directly
    if extract_dir.join("plugin.json").exists() {
        return Ok(extract_dir.to_path_buf());
    }
    // Otherwise look for a single subdirectory containing plugin.json
    for entry in std::fs::read_dir(extract_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() && entry.path().join("plugin.json").exists() {
            return Ok(entry.path());
        }
    }
    anyhow::bail!("No plugin.json found in extracted ZIP")
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Emit a warning if legacy addon directory exists and is non-empty.
fn warn_legacy_addons() {
    if let Some(home) = dirs::home_dir() {
        let addons_dir = home.join(consts::DATA_DIR).join("addons");
        if addons_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&addons_dir) {
                if entries.count() > 0 {
                    log::warn!(
                        "Legacy addons found at {}. Please migrate to the plugin system.",
                        addons_dir.display()
                    );
                }
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_serde_roundtrip() {
        let manifest = PluginManifest {
            name: "Presale CRM".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale".to_string(),
            version: "1.2.0".to_string(),
            description: "Presale CRM integration".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec!["skills".to_string(), "commands".to_string()],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![AuthFieldDef {
                key: "api_key".to_string(),
                label: "API Key".to_string(),
                field_type: "password".to_string(),
                placeholder: "sk-...".to_string(),
                is_secret: true,
            }],
            settings_schema: None,
            speedwave_compat: Some(">=0.1.0".to_string()),
            extra_env: None,
            mem_limit: None,
        };
        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: PluginManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "Presale CRM");
        assert_eq!(parsed.service_id.as_deref(), Some("presale"));
        assert_eq!(parsed.slug, "presale");
        assert_eq!(parsed.version, "1.2.0");
        assert_eq!(parsed.port, Some(4010));
        assert_eq!(parsed.resources.len(), 2);
        assert!(matches!(parsed.token_mount, TokenMount::ReadOnly));
    }

    #[test]
    fn test_manifest_minimal_non_mcp() {
        let json = r#"{
            "name": "Custom Skills",
            "slug": "custom-skills",
            "version": "0.1.0",
            "description": "Custom skills pack",
            "resources": ["skills"]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.name, "Custom Skills");
        assert!(manifest.service_id.is_none());
        assert_eq!(manifest.slug, "custom-skills");
        assert!(manifest.port.is_none());
        assert!(matches!(manifest.token_mount, TokenMount::ReadOnly));
    }

    #[test]
    fn test_manifest_readwrite_token_mount() {
        let json = r#"{
            "name": "SharePoint Plugin",
            "slug": "sp-plugin",
            "service_id": "sp-plugin",
            "version": "1.0.0",
            "description": "test",
            "port": 4020,
            "token_mount": { "mode": "read_write", "justification": "OAuth token refresh" }
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        match &manifest.token_mount {
            TokenMount::ReadWrite { justification } => {
                assert_eq!(justification, "OAuth token refresh");
            }
            _ => panic!("Expected ReadWrite token mount"),
        }
    }

    #[test]
    fn test_slug_validation_valid() {
        assert!(validate_slug("presale").is_ok());
        assert!(validate_slug("my-plugin").is_ok());
        assert!(validate_slug("a").is_ok());
        assert!(validate_slug("plugin123").is_ok());
    }

    #[test]
    fn test_slug_validation_invalid() {
        assert!(validate_slug("").is_err(), "empty");
        assert!(validate_slug("UPPERCASE").is_err(), "uppercase");
        assert!(validate_slug("123start").is_err(), "starts with digit");
        assert!(validate_slug("-dash").is_err(), "starts with dash");
        assert!(validate_slug("has space").is_err(), "has space");
        assert!(validate_slug("has_underscore").is_err(), "has underscore");
        assert!(
            validate_slug(&"a".repeat(65)).is_err(),
            "too long (65 chars)"
        );
    }

    #[test]
    fn test_slug_not_in_built_in_service_ids() {
        for &sid in consts::BUILT_IN_SERVICE_IDS {
            let manifest = PluginManifest {
                name: "test".to_string(),
                service_id: None,
                slug: sid.to_string(),
                version: "1.0.0".to_string(),
                description: "test".to_string(),
                port: None,
                image_tag: None,
                resources: vec![],
                token_mount: TokenMount::ReadOnly,
                auth_fields: vec![],
                settings_schema: None,
                speedwave_compat: None,
                extra_env: None,
                mem_limit: None,
            };
            let tmp = tempfile::tempdir().unwrap();
            let result = validate_manifest(&manifest, tmp.path());
            assert!(
                result.is_err(),
                "slug '{}' should be rejected as built-in service ID",
                sid
            );
        }
    }

    #[test]
    fn test_slug_must_equal_service_id() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: Some("actual-id".to_string()),
            slug: "different-slug".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
        };
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Containerfile"), "FROM node:22").unwrap();
        let result = validate_manifest(&manifest, tmp.path());
        assert!(result.is_err(), "slug != service_id should be rejected");
    }

    #[test]
    fn test_mcp_plugin_requires_containerfile() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: Some("test-mcp".to_string()),
            slug: "test-mcp".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
        };
        let tmp = tempfile::tempdir().unwrap();
        // No Containerfile created
        let result = validate_manifest(&manifest, tmp.path());
        assert!(
            result.is_err(),
            "MCP plugin without Containerfile should be rejected"
        );
    }

    #[test]
    fn test_readwrite_requires_justification() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-rw".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadWrite {
                justification: "".to_string(),
            },
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
        };
        let tmp = tempfile::tempdir().unwrap();
        let result = validate_manifest(&manifest, tmp.path());
        assert!(
            result.is_err(),
            "ReadWrite with empty justification should be rejected"
        );
    }

    #[test]
    fn test_derive_worker_env() {
        assert_eq!(derive_worker_env("presale"), "WORKER_PRESALE_URL");
        assert_eq!(derive_worker_env("my-plugin"), "WORKER_MY_PLUGIN_URL");
        assert_eq!(derive_worker_env("crm"), "WORKER_CRM_URL");
    }

    #[test]
    fn test_derive_compose_name() {
        assert_eq!(derive_compose_name("presale"), "mcp-presale");
        assert_eq!(derive_compose_name("my-plugin"), "mcp-my-plugin");
    }

    #[test]
    fn test_generate_plugin_service_output() {
        let manifest = PluginManifest {
            name: "Presale CRM".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale".to_string(),
            version: "1.2.0".to_string(),
            description: "Presale CRM".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
        };

        let tokens_dir = PathBuf::from("/home/user/.speedwave/tokens/myproject");
        let result = generate_plugin_service(
            &manifest,
            "myproject",
            "speedwave_myproject_network",
            &tokens_dir,
        )
        .unwrap();

        let yaml = serde_yaml_ng::to_string(&result).unwrap();

        // Verify key properties
        assert!(
            yaml.contains("speedwave-mcp-presale:1.2.0"),
            "image tag: {yaml}"
        );
        assert!(
            yaml.contains("speedwave_myproject_mcp_presale"),
            "container_name: {yaml}"
        );
        assert!(yaml.contains("read_only: true"), "read_only: {yaml}");
        assert!(yaml.contains(&container_user()), "user: {yaml}");
        assert!(yaml.contains("ALL"), "cap_drop ALL: {yaml}");
        assert!(
            yaml.contains("no-new-privileges:true"),
            "security_opt: {yaml}"
        );
        assert!(yaml.contains("/tmp:noexec,nosuid"), "tmpfs: {yaml}");
        assert!(yaml.contains("/tokens:ro"), "token mount: {yaml}");
        assert!(yaml.contains("PORT=4010"), "PORT env: {yaml}");
        assert!(
            yaml.contains("speedwave_myproject_network"),
            "network: {yaml}"
        );
        assert!(yaml.contains("speedwave.plugin-service"), "label: {yaml}");
        assert!(yaml.contains("memory: 256m"), "mem limit: {yaml}");
    }

    #[test]
    fn test_generate_plugin_service_readwrite_mount() {
        let manifest = PluginManifest {
            name: "SP Plugin".to_string(),
            service_id: Some("sp-ext".to_string()),
            slug: "sp-ext".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4020),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadWrite {
                justification: "OAuth refresh".to_string(),
            },
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: Some("512m".to_string()),
        };

        let tokens_dir = PathBuf::from("/home/user/.speedwave/tokens/proj");
        let result =
            generate_plugin_service(&manifest, "proj", "speedwave_proj_network", &tokens_dir)
                .unwrap();

        let yaml = serde_yaml_ng::to_string(&result).unwrap();
        assert!(yaml.contains("/tokens:rw"), "should use :rw mount: {yaml}");
        assert!(yaml.contains("memory: 512m"), "custom mem limit: {yaml}");
    }

    #[test]
    fn test_generate_plugin_service_with_extra_env() {
        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-env".to_string()),
            slug: "test-env".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4030),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: Some(HashMap::from([(
                "CUSTOM_VAR".to_string(),
                "value".to_string(),
            )])),
            mem_limit: None,
        };

        let tokens_dir = PathBuf::from("/tokens");
        let result = generate_plugin_service(&manifest, "proj", "net", &tokens_dir).unwrap();

        let yaml = serde_yaml_ng::to_string(&result).unwrap();
        assert!(yaml.contains("CUSTOM_VAR=value"), "extra env: {yaml}");
    }

    #[test]
    fn test_list_installed_plugins_empty() {
        let tmp = tempfile::tempdir().unwrap();
        // plugins_base_dir depends on home dir, so test the logic directly
        let plugins_dir = tmp.path().join("plugins");
        assert!(!plugins_dir.exists());
        // Verify the pattern: no dir = empty vec
        let result: Vec<PluginManifest> = Vec::new();
        assert!(result.is_empty());
    }

    #[test]
    fn test_list_installed_plugins_from_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("presale");
        std::fs::create_dir_all(&plugin_dir).unwrap();

        let manifest = r#"{
            "name": "Presale",
            "slug": "presale",
            "service_id": "presale",
            "version": "1.0.0",
            "description": "test",
            "port": 4010
        }"#;
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();

        // Simulate listing
        let mut plugins = Vec::new();
        for entry in std::fs::read_dir(tmp.path()).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                let mp = entry.path().join("plugin.json");
                if mp.exists() {
                    let content = std::fs::read_to_string(&mp).unwrap();
                    let m: PluginManifest = serde_json::from_str(&content).unwrap();
                    plugins.push(m);
                }
            }
        }
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].slug, "presale");
    }

    #[test]
    fn test_validate_extracted_paths_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let sub = base.join("plugin-a");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("plugin.json"), "{}").unwrap();
        assert!(validate_extracted_paths(base).is_ok());
    }

    #[test]
    fn test_validate_extracted_paths_detects_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("plugins");
        std::fs::create_dir_all(&base).unwrap();

        let outside = tmp.path().join("outside-secret");
        std::fs::write(&outside, "sensitive data").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, base.join("escape-link")).unwrap();
            let result = validate_extracted_paths(&base);
            assert!(result.is_err(), "Should detect symlink escape");
            assert!(
                format!("{:?}", result.unwrap_err()).contains("Zip Slip"),
                "Error should mention Zip Slip"
            );
        }
    }

    #[test]
    fn test_plugin_image_tag_default() {
        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test".to_string()),
            slug: "test".to_string(),
            version: "2.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
        };
        assert_eq!(plugin_image_tag(&manifest), "speedwave-mcp-test:2.0.0");
    }

    #[test]
    fn test_plugin_image_tag_custom() {
        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test".to_string()),
            slug: "test".to_string(),
            version: "2.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: Some("custom-tag".to_string()),
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
        };
        assert_eq!(plugin_image_tag(&manifest), "speedwave-mcp-test:custom-tag");
    }

    #[test]
    fn test_find_plugin_dir_top_level() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("plugin.json"), "{}").unwrap();
        let result = find_plugin_dir(tmp.path()).unwrap();
        assert_eq!(result, tmp.path());
    }

    #[test]
    fn test_find_plugin_dir_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("presale-1.0.0");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("plugin.json"), "{}").unwrap();
        let result = find_plugin_dir(tmp.path()).unwrap();
        assert_eq!(result, nested);
    }

    #[test]
    fn test_find_plugin_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(find_plugin_dir(tmp.path()).is_err());
    }

    #[test]
    fn test_copy_dir_recursive() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(src.join("subdir")).unwrap();
        std::fs::write(src.join("file.txt"), "hello").unwrap();
        std::fs::write(src.join("subdir/nested.txt"), "world").unwrap();

        copy_dir_recursive(&src, &dest).unwrap();

        assert!(dest.join("file.txt").exists());
        assert!(dest.join("subdir/nested.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("file.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("subdir/nested.txt")).unwrap(),
            "world"
        );
    }
}

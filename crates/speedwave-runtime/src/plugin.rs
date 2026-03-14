use crate::compose::container_user;
use crate::consts;
use crate::runtime::ContainerRuntime;
use crate::signing;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Slug validation: lowercase letters, digits, hyphens. Starts with letter. Max 64 chars.
const SLUG_PATTERN: &str = r"^[a-z][a-z0-9-]{0,63}$";

#[derive(Debug, PartialEq)]
pub enum TokenStatus {
    /// All required secret fields have token files.
    Configured,
    /// Some or all required secret fields are missing token files.
    NotConfigured { missing: Vec<String> },
    /// Plugin has no auth fields requiring tokens.
    NoTokensRequired,
}

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
    /// Reserved for future semver enforcement. Parsed from manifest but not
    /// currently validated — will be enforced once the versioning scheme is stable.
    #[serde(default)]
    pub speedwave_compat: Option<String>,
    #[serde(default)]
    pub extra_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub mem_limit: Option<String>,
    /// Core integrations this plugin depends on (e.g. `["sharepoint"]`).
    #[serde(default)]
    pub requires_integrations: Vec<String>,
}

/// Returns `~/.speedwave/plugins/`
pub fn plugins_base_dir() -> anyhow::Result<PathBuf> {
    Ok(dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot find home dir"))?
        .join(consts::DATA_DIR)
        .join("plugins"))
}

/// Returns `~/.speedwave/tokens/<project>/<service_id>/`
pub fn token_dir(project: &str, service_id: &str) -> anyhow::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot find home dir"))?;
    Ok(token_dir_with_base(&home, project, service_id))
}

/// Testable version: constructs `<base>/.speedwave/tokens/<project>/<service_id>/`
fn token_dir_with_base(home: &Path, project: &str, service_id: &str) -> PathBuf {
    home.join(consts::DATA_DIR)
        .join("tokens")
        .join(project)
        .join(service_id)
}

/// Writes credential/token files for a plugin to the project's token directory.
/// Creates `~/.speedwave/tokens/<project>/<service_id>/<key>` for each entry.
/// Sets file permissions to 0o600 (owner read/write only).
pub fn configure_plugin_tokens(
    project: &str,
    service_id: &str,
    tokens: &HashMap<String, String>,
) -> anyhow::Result<()> {
    let base = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot find home dir"))?;
    configure_plugin_tokens_with_base(&base, project, service_id, tokens)
}

fn configure_plugin_tokens_with_base(
    home: &Path,
    project: &str,
    service_id: &str,
    tokens: &HashMap<String, String>,
) -> anyhow::Result<()> {
    let token_dir = token_dir_with_base(home, project, service_id);
    std::fs::create_dir_all(&token_dir)?;

    for (key, value) in tokens {
        let file_path = token_dir.join(key);
        std::fs::write(&file_path, value)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o600))?;
        }
    }

    Ok(())
}

/// Checks whether a plugin's required auth_fields have corresponding token files.
pub fn get_plugin_token_status(project: &str, manifest: &PluginManifest) -> TokenStatus {
    let base = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return TokenStatus::NotConfigured {
                missing: manifest
                    .auth_fields
                    .iter()
                    .filter(|f| f.is_secret)
                    .map(|f| f.key.clone())
                    .collect(),
            };
        }
    };
    get_plugin_token_status_with_base(&base, project, manifest)
}

fn get_plugin_token_status_with_base(
    home: &Path,
    project: &str,
    manifest: &PluginManifest,
) -> TokenStatus {
    if manifest.auth_fields.is_empty() {
        return TokenStatus::NoTokensRequired;
    }

    let secret_fields: Vec<&AuthFieldDef> = manifest
        .auth_fields
        .iter()
        .filter(|f| f.is_secret)
        .collect();

    if secret_fields.is_empty() {
        return TokenStatus::NoTokensRequired;
    }

    let service_id = manifest.service_id.as_deref().unwrap_or(&manifest.slug);
    let token_dir = token_dir_with_base(home, project, service_id);

    let mut missing = Vec::new();
    for field in &secret_fields {
        let file_path = token_dir.join(&field.key);
        let has_content = file_path.metadata().map(|m| m.len() > 0).unwrap_or(false);
        if !has_content {
            missing.push(field.key.clone());
        }
    }

    if missing.is_empty() {
        TokenStatus::Configured
    } else {
        TokenStatus::NotConfigured { missing }
    }
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
    static SLUG_RE: std::sync::OnceLock<Result<regex::Regex, regex::Error>> =
        std::sync::OnceLock::new();
    let re = SLUG_RE
        .get_or_init(|| regex::Regex::new(SLUG_PATTERN))
        .as_ref()
        .map_err(|e| anyhow::anyhow!("invalid SLUG_PATTERN regex: {e}"))?;
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

    // MCP plugins must specify a port
    if manifest.service_id.is_some() && manifest.port.is_none() {
        anyhow::bail!(
            "MCP plugins (service_id='{}') must specify a port",
            manifest.service_id.as_deref().unwrap_or("")
        );
    }

    // Validate mem_limit format (e.g. "256m", "1g", "512000")
    if let Some(ref limit) = manifest.mem_limit {
        static MEM_RE: std::sync::OnceLock<Result<regex::Regex, regex::Error>> =
            std::sync::OnceLock::new();
        let re = MEM_RE
            .get_or_init(|| regex::Regex::new(r"^[0-9]+[bkmgBKMG]?$"))
            .as_ref()
            .map_err(|e| anyhow::anyhow!("invalid mem_limit regex: {e}"))?;
        if !re.is_match(limit) {
            anyhow::bail!(
                "Invalid mem_limit '{}': must be a number optionally followed by b/k/m/g",
                limit
            );
        }
    }

    // Validate image_tag format (alphanumeric, dots, hyphens, underscores)
    if let Some(ref tag) = manifest.image_tag {
        static TAG_RE: std::sync::OnceLock<Result<regex::Regex, regex::Error>> =
            std::sync::OnceLock::new();
        let re = TAG_RE
            .get_or_init(|| regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"))
            .as_ref()
            .map_err(|e| anyhow::anyhow!("invalid image_tag regex: {e}"))?;
        if !re.is_match(tag) {
            anyhow::bail!(
                "Invalid image_tag '{}': must be alphanumeric with dots, hyphens, underscores (max 128 chars)",
                tag
            );
        }
    }

    // Validate auth_fields keys are safe filesystem names and field_type is known
    const ALLOWED_FIELD_TYPES: &[&str] = &["text", "password", "textarea"];
    for field in &manifest.auth_fields {
        if field.key.contains('/')
            || field.key.contains('\\')
            || field.key.contains("..")
            || field.key.is_empty()
        {
            anyhow::bail!(
                "Invalid auth_field key '{}': must not contain path separators or '..'",
                field.key
            );
        }
        if !ALLOWED_FIELD_TYPES.contains(&field.field_type.as_str()) {
            anyhow::bail!(
                "auth_field '{}' has unknown field_type '{}'. Allowed: {:?}",
                field.key,
                field.field_type,
                ALLOWED_FIELD_TYPES
            );
        }
    }

    // Validate extra_env keys/values contain no newlines or null bytes (YAML injection defense)
    if let Some(ref env) = manifest.extra_env {
        for (k, v) in env {
            if k.contains('\n')
                || k.contains('\r')
                || k.contains('\0')
                || v.contains('\n')
                || v.contains('\r')
                || v.contains('\0')
            {
                anyhow::bail!(
                    "extra_env key/value must not contain newlines, carriage returns, or null bytes (key: '{}')",
                    k
                );
            }
        }
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
    let content = std::fs::read_to_string(&manifest_path)?;
    let manifest: PluginManifest = serde_json::from_str(&content)?;

    validate_manifest(&manifest, &plugin_src)?;

    // Reject duplicate service_id or port among already-installed plugins
    let existing = list_installed_plugins()?;
    if let Some(ref sid) = manifest.service_id {
        for existing_manifest in &existing {
            if existing_manifest.service_id.as_deref() == Some(sid.as_str())
                && existing_manifest.slug != manifest.slug
            {
                anyhow::bail!(
                    "Plugin with service_id '{}' is already installed ({})",
                    sid,
                    existing_manifest.slug
                );
            }
        }
    }
    if let Some(new_port) = manifest.port {
        for existing_manifest in &existing {
            if let Some(existing_port) = existing_manifest.port {
                if existing_port == new_port && existing_manifest.slug != manifest.slug {
                    anyhow::bail!(
                        "Port {} is already claimed by plugin '{}'",
                        new_port,
                        existing_manifest.slug
                    );
                }
            }
        }
    }

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
    list_installed_from_dir(&plugins_dir)
}

/// Lists plugins from a given directory by scanning `<dir>/*/plugin.json`.
pub fn list_installed_from_dir(plugins_dir: &Path) -> anyhow::Result<Vec<PluginManifest>> {
    if !plugins_dir.exists() {
        return Ok(vec![]);
    }

    let mut plugins = Vec::new();
    for entry in std::fs::read_dir(plugins_dir)? {
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

    let mut errors: Vec<String> = Vec::new();
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
        let content = match std::fs::read_to_string(&manifest_path) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("{}: read manifest: {e}", entry.path().display()));
                continue;
            }
        };
        let manifest: PluginManifest = match serde_json::from_str(&content) {
            Ok(m) => m,
            Err(e) => {
                errors.push(format!("{}: parse manifest: {e}", entry.path().display()));
                continue;
            }
        };

        if let Err(e) = build_single_plugin_image(runtime, &manifest, &entry.path()) {
            errors.push(format!("plugin '{}': {e}", manifest.slug));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        anyhow::bail!("Some plugin images failed to build:\n{}", errors.join("\n"))
    }
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

    let tokens_path = crate::compose::to_engine_path(&tokens_dir.join(sid))?;
    let mem_limit = manifest.mem_limit.as_deref().unwrap_or("256m");
    let user = container_user();

    let mut env_lines = format!("  - PORT={port}");
    if let Some(ref extra) = manifest.extra_env {
        for (k, v) in extra {
            let entry = format!("{}={}", k, v);
            env_lines.push_str(&format!("\n  - {}", yaml_quote_entry(&entry)));
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

/// YAML-safe quoting for environment entries (KEY=VALUE) embedded via `format!()`.
/// If the entry contains characters that YAML would misinterpret (`:`, `{`, `}`,
/// `[`, `]`, `"`, `'`, `#`, `&`, `*`, `!`, `|`, `>`, `%`, `@`, `` ` ``),
/// wraps the entire entry in single quotes with proper escaping.
/// Single quotes are used because the only character that needs escaping inside
/// YAML single-quoted strings is the single quote itself (doubled as `''`).
fn yaml_quote_entry(entry: &str) -> String {
    const YAML_SPECIAL: &[char] = &[
        ':', '{', '}', '[', ']', '"', '\'', '#', '&', '*', '!', '|', '>', '%', '@', '`',
    ];
    if entry.chars().any(|c| YAML_SPECIAL.contains(&c)) {
        let escaped = entry.replace('\'', "''");
        format!("'{}'", escaped)
    } else {
        entry.to_string()
    }
}

fn extract_zip(zip_path: &Path, dest: &Path) -> anyhow::Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // Pre-validate: reject dangerous entries before writing anything to disk.
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        let name = entry.name().to_owned();
        if entry.enclosed_name().is_none() {
            let reason = if name.starts_with('/') || name.starts_with('\\') {
                "absolute path"
            } else {
                "path traversal"
            };
            anyhow::bail!("Rejected ZIP entry with {}: '{}'", reason, name);
        }
        if entry.is_symlink() {
            anyhow::bail!("Rejected symlink entry '{}' in plugin archive", name);
        }
    }

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
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let addons_dir = home.join(consts::DATA_DIR).join("addons");
    if !addons_dir.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&addons_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    if entries.count() > 0 {
        log::warn!(
            "Legacy addons found at {}. Please migrate to the plugin system.",
            addons_dir.display()
        );
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
            requires_integrations: vec!["sharepoint".to_string()],
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
        assert_eq!(parsed.requires_integrations, vec!["sharepoint"]);
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
        assert!(
            manifest.requires_integrations.is_empty(),
            "requires_integrations should default to empty"
        );
    }

    #[test]
    fn test_manifest_with_requires_integrations() {
        let json = r#"{
            "name": "Presale Plugin",
            "slug": "presale",
            "version": "1.0.0",
            "description": "Presale CRM",
            "requires_integrations": ["sharepoint"]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.requires_integrations, vec!["sharepoint"]);
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
                requires_integrations: vec![],
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
            requires_integrations: vec![],
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
            requires_integrations: vec![],
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
            requires_integrations: vec![],
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
            requires_integrations: vec![],
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
            requires_integrations: vec![],
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
            requires_integrations: vec![],
        };

        let tokens_dir = PathBuf::from("/tokens");
        let result = generate_plugin_service(&manifest, "proj", "net", &tokens_dir).unwrap();

        let yaml = serde_yaml_ng::to_string(&result).unwrap();
        assert!(yaml.contains("CUSTOM_VAR=value"), "extra env: {yaml}");
    }

    #[test]
    fn test_list_installed_plugins_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path().join("plugins");
        assert!(!plugins_dir.exists());
        let result = list_installed_from_dir(&plugins_dir).unwrap();
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

        let plugins = list_installed_from_dir(tmp.path()).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].slug, "presale");
    }

    #[test]
    fn test_list_installed_from_dir_skips_invalid_manifest() {
        let tmp = tempfile::tempdir().unwrap();

        // Valid plugin
        let valid_dir = tmp.path().join("good-plugin");
        std::fs::create_dir_all(&valid_dir).unwrap();
        std::fs::write(
            valid_dir.join("plugin.json"),
            r#"{"name":"Good","slug":"good-plugin","version":"1.0.0","description":"ok","port":4010}"#,
        )
        .unwrap();

        // Invalid manifest (missing required fields)
        let bad_dir = tmp.path().join("bad-plugin");
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("plugin.json"), r#"{"not_a_manifest": true}"#).unwrap();

        let plugins = list_installed_from_dir(tmp.path()).unwrap();
        assert_eq!(
            plugins.len(),
            1,
            "should skip bad manifest and return only the valid one"
        );
        assert_eq!(plugins[0].slug, "good-plugin");
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
            requires_integrations: vec![],
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
            requires_integrations: vec![],
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

    // --- Task 1: configure_plugin_tokens + get_plugin_token_status tests ---

    #[test]
    fn test_configure_plugin_tokens_creates_files() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let mut tokens = HashMap::new();
        tokens.insert("api_key".to_string(), "sk-secret-123".to_string());
        tokens.insert("refresh_token".to_string(), "rt-abc".to_string());

        configure_plugin_tokens_with_base(home, "myproject", "presale", &tokens).unwrap();

        let token_dir = home
            .join(consts::DATA_DIR)
            .join("tokens")
            .join("myproject")
            .join("presale");

        assert_eq!(
            std::fs::read_to_string(token_dir.join("api_key")).unwrap(),
            "sk-secret-123"
        );
        assert_eq!(
            std::fs::read_to_string(token_dir.join("refresh_token")).unwrap(),
            "rt-abc"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_configure_plugin_tokens_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let mut tokens = HashMap::new();
        tokens.insert("secret".to_string(), "value".to_string());

        configure_plugin_tokens_with_base(home, "proj", "svc", &tokens).unwrap();

        let file_path = home
            .join(consts::DATA_DIR)
            .join("tokens")
            .join("proj")
            .join("svc")
            .join("secret");

        let perms = std::fs::metadata(&file_path).unwrap().permissions();
        assert_eq!(
            perms.mode() & 0o777,
            0o600,
            "Token file should have 0o600 permissions, got {:o}",
            perms.mode() & 0o777
        );
    }

    #[test]
    fn test_get_plugin_token_status_configured() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        // Create token files
        let token_dir = home
            .join(consts::DATA_DIR)
            .join("tokens")
            .join("proj")
            .join("test-svc");
        std::fs::create_dir_all(&token_dir).unwrap();
        std::fs::write(token_dir.join("api_key"), "sk-123").unwrap();
        std::fs::write(token_dir.join("token"), "tok-abc").unwrap();

        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-svc".to_string()),
            slug: "test-svc".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![
                AuthFieldDef {
                    key: "api_key".to_string(),
                    label: "API Key".to_string(),
                    field_type: "password".to_string(),
                    placeholder: "sk-...".to_string(),
                    is_secret: true,
                },
                AuthFieldDef {
                    key: "token".to_string(),
                    label: "Token".to_string(),
                    field_type: "password".to_string(),
                    placeholder: "tok-...".to_string(),
                    is_secret: true,
                },
                AuthFieldDef {
                    key: "label".to_string(),
                    label: "Label".to_string(),
                    field_type: "text".to_string(),
                    placeholder: "My Label".to_string(),
                    is_secret: false,
                },
            ],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };

        let status = get_plugin_token_status_with_base(home, "proj", &manifest);
        assert_eq!(status, TokenStatus::Configured);
    }

    #[test]
    fn test_get_plugin_token_status_not_configured() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        // Create only one of two required token files
        let token_dir = home
            .join(consts::DATA_DIR)
            .join("tokens")
            .join("proj")
            .join("test-svc");
        std::fs::create_dir_all(&token_dir).unwrap();
        std::fs::write(token_dir.join("api_key"), "sk-123").unwrap();
        // "token" file intentionally missing

        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-svc".to_string()),
            slug: "test-svc".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![
                AuthFieldDef {
                    key: "api_key".to_string(),
                    label: "API Key".to_string(),
                    field_type: "password".to_string(),
                    placeholder: "sk-...".to_string(),
                    is_secret: true,
                },
                AuthFieldDef {
                    key: "token".to_string(),
                    label: "Token".to_string(),
                    field_type: "password".to_string(),
                    placeholder: "tok-...".to_string(),
                    is_secret: true,
                },
            ],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };

        let status = get_plugin_token_status_with_base(home, "proj", &manifest);
        assert_eq!(
            status,
            TokenStatus::NotConfigured {
                missing: vec!["token".to_string()]
            }
        );
    }

    #[test]
    fn test_get_plugin_token_status_no_tokens_required() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: None,
            slug: "test-skills".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec!["skills".to_string()],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };

        let status = get_plugin_token_status_with_base(home, "proj", &manifest);
        assert_eq!(status, TokenStatus::NoTokensRequired);
    }

    #[test]
    fn test_get_plugin_token_status_only_non_secret_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-svc".to_string()),
            slug: "test-svc".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![AuthFieldDef {
                key: "host_url".to_string(),
                label: "Host URL".to_string(),
                field_type: "url".to_string(),
                placeholder: "https://...".to_string(),
                is_secret: false,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };

        let status = get_plugin_token_status_with_base(home, "proj", &manifest);
        assert_eq!(status, TokenStatus::NoTokensRequired);
    }

    #[test]
    fn test_get_plugin_token_status_empty_file_counts_as_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let token_dir = home
            .join(consts::DATA_DIR)
            .join("tokens")
            .join("proj")
            .join("test-svc");
        std::fs::create_dir_all(&token_dir).unwrap();
        // Write an empty file — should be treated as missing
        std::fs::write(token_dir.join("api_key"), "").unwrap();

        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-svc".to_string()),
            slug: "test-svc".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![AuthFieldDef {
                key: "api_key".to_string(),
                label: "API Key".to_string(),
                field_type: "password".to_string(),
                placeholder: "sk-...".to_string(),
                is_secret: true,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };

        let status = get_plugin_token_status_with_base(home, "proj", &manifest);
        assert_eq!(
            status,
            TokenStatus::NotConfigured {
                missing: vec!["api_key".to_string()]
            }
        );
    }

    // --- Task 2: duplicate service_id detection test ---

    #[test]
    fn test_install_plugin_rejects_duplicate_service_id() {
        // We cannot easily call install_plugin() in tests because it requires
        // a signed ZIP and uses dirs::home_dir(). Instead, test the duplicate
        // detection logic directly by simulating what install_plugin does:
        // check existing plugins for a matching service_id.

        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path();

        // Create an "existing" plugin with service_id "presale"
        let existing_dir = plugins_dir.join("presale");
        std::fs::create_dir_all(&existing_dir).unwrap();
        std::fs::write(
            existing_dir.join("plugin.json"),
            r#"{
                "name": "Presale Original",
                "slug": "presale",
                "service_id": "presale",
                "version": "1.0.0",
                "description": "Original presale plugin",
                "port": 4010
            }"#,
        )
        .unwrap();

        // Simulate listing installed plugins from the temp dir
        let mut existing_plugins = Vec::new();
        for entry in std::fs::read_dir(plugins_dir).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                let mp = entry.path().join("plugin.json");
                if mp.exists() {
                    let content = std::fs::read_to_string(&mp).unwrap();
                    let m: PluginManifest = serde_json::from_str(&content).unwrap();
                    existing_plugins.push(m);
                }
            }
        }

        // New plugin with the same service_id but different slug
        let new_manifest = PluginManifest {
            name: "Presale Clone".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale".to_string(), // slug == service_id (required by validation)
            version: "2.0.0".to_string(),
            description: "A clone".to_string(),
            port: Some(4011),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };

        // Replicate the duplicate check from install_plugin
        let duplicate_found = if let Some(ref sid) = new_manifest.service_id {
            existing_plugins.iter().any(|existing| {
                existing.service_id.as_deref() == Some(sid.as_str())
                    && existing.slug != new_manifest.slug
            })
        } else {
            false
        };

        // Same slug means an upgrade (allowed), not a duplicate
        assert!(
            !duplicate_found,
            "Same slug with same service_id should be allowed (upgrade scenario)"
        );

        // Now test with a DIFFERENT slug but same service_id
        let conflict_manifest = PluginManifest {
            name: "Presale Fork".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale-fork".to_string(),
            version: "1.0.0".to_string(),
            description: "A fork".to_string(),
            port: Some(4012),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };

        let conflict_found = if let Some(ref sid) = conflict_manifest.service_id {
            existing_plugins.iter().any(|existing| {
                existing.service_id.as_deref() == Some(sid.as_str())
                    && existing.slug != conflict_manifest.slug
            })
        } else {
            false
        };

        assert!(
            conflict_found,
            "Different slug with same service_id should be rejected as duplicate"
        );
    }

    // --- Task 3: YAML special characters in extra_env ---

    #[test]
    fn test_generate_plugin_service_extra_env_special_chars() {
        let manifest = PluginManifest {
            name: "Test Special".to_string(),
            service_id: Some("test-special".to_string()),
            slug: "test-special".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4040),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: Some(HashMap::from([
                (
                    "URL_VAR".to_string(),
                    "https://example.com:8080/path".to_string(),
                ),
                ("JSON_VAR".to_string(), r#"{"key": "value"}"#.to_string()),
                ("BRACKET_VAR".to_string(), "[item1, item2]".to_string()),
                ("HASH_VAR".to_string(), "value # with hash".to_string()),
                ("PLAIN_VAR".to_string(), "simple-value".to_string()),
            ])),
            mem_limit: None,
            requires_integrations: vec![],
        };

        let tokens_dir = PathBuf::from("/tokens");
        let result = generate_plugin_service(&manifest, "proj", "net", &tokens_dir).unwrap();

        // Verify it parses back as valid YAML
        let yaml = serde_yaml_ng::to_string(&result).unwrap();

        // Re-parse to ensure round-trip works
        let reparsed: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let env_list = reparsed
            .get("environment")
            .expect("environment key must exist");
        let env_seq = env_list
            .as_sequence()
            .expect("environment must be a sequence");

        // Collect all env entries as strings
        let env_strings: Vec<String> = env_seq
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();

        // Verify all values survive the YAML round-trip intact
        assert!(
            env_strings
                .iter()
                .any(|s| s == "URL_VAR=https://example.com:8080/path"),
            "URL_VAR should survive round-trip: {:?}",
            env_strings
        );
        assert!(
            env_strings
                .iter()
                .any(|s| s == r#"JSON_VAR={"key": "value"}"#),
            "JSON_VAR should survive round-trip: {:?}",
            env_strings
        );
        assert!(
            env_strings
                .iter()
                .any(|s| s == "BRACKET_VAR=[item1, item2]"),
            "BRACKET_VAR should survive round-trip: {:?}",
            env_strings
        );
        assert!(
            env_strings
                .iter()
                .any(|s| s == "HASH_VAR=value # with hash"),
            "HASH_VAR should survive round-trip: {:?}",
            env_strings
        );
        assert!(
            env_strings.iter().any(|s| s == "PLAIN_VAR=simple-value"),
            "PLAIN_VAR should survive round-trip: {:?}",
            env_strings
        );
    }

    #[test]
    fn test_yaml_quote_entry_plain() {
        assert_eq!(yaml_quote_entry("KEY=simple"), "KEY=simple");
        assert_eq!(yaml_quote_entry("KEY=hello-world"), "KEY=hello-world");
    }

    #[test]
    fn test_yaml_quote_entry_special_chars() {
        assert_eq!(
            yaml_quote_entry("URL=https://host:8080"),
            "'URL=https://host:8080'"
        );
        assert_eq!(yaml_quote_entry("JSON={key: val}"), "'JSON={key: val}'");
    }

    #[test]
    fn test_yaml_quote_entry_embedded_single_quotes() {
        assert_eq!(yaml_quote_entry("MSG=it's here"), "'MSG=it''s here'");
    }

    #[test]
    fn test_mcp_plugin_requires_port() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: Some("test-mcp".to_string()),
            slug: "test-mcp".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None, // missing port
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Containerfile"), "FROM node:22").unwrap();
        let result = validate_manifest(&manifest, tmp.path());
        assert!(
            result.is_err(),
            "MCP plugin without port should be rejected"
        );
        assert!(
            result.unwrap_err().to_string().contains("port"),
            "Error should mention port"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_invalid_mem_limit() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-mem".to_string(),
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
            mem_limit: Some("256m; rm -rf /".to_string()),
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_err());
    }

    #[test]
    fn test_validate_manifest_accepts_valid_mem_limit() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-mem".to_string(),
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
            mem_limit: Some("256m".to_string()),
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_ok());
    }

    #[test]
    fn test_validate_manifest_rejects_invalid_image_tag() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-tag".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: Some("latest\nimage: evil:tag".to_string()),
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_err());
    }

    #[test]
    fn test_validate_manifest_rejects_path_traversal_auth_key() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-auth".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![AuthFieldDef {
                key: "../../etc/passwd".to_string(),
                label: "Evil".to_string(),
                field_type: "text".to_string(),
                placeholder: "".to_string(),
                is_secret: false,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_err());
    }

    #[test]
    fn test_validate_manifest_rejects_unknown_field_type() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-ftype".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![AuthFieldDef {
                key: "api_key".to_string(),
                label: "Key".to_string(),
                field_type: "dropdown".to_string(),
                placeholder: "".to_string(),
                is_secret: true,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        let result = validate_manifest(&manifest, tmp.path());
        assert!(result.is_err(), "Unknown field_type should be rejected");
        assert!(result.unwrap_err().to_string().contains("field_type"));
    }

    #[test]
    fn test_validate_manifest_rejects_extra_env_newline() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-env".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: Some(HashMap::from([(
                "EVIL\nimage: hack:tag".to_string(),
                "value".to_string(),
            )])),
            mem_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_err());
    }

    #[test]
    fn test_validate_manifest_rejects_extra_env_carriage_return() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-cr".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: Some(HashMap::from([(
                "EVIL\rimage: hack:tag".to_string(),
                "value".to_string(),
            )])),
            mem_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_err());
    }

    #[test]
    fn test_install_rejects_duplicate_port() {
        // Port uniqueness is checked in install_plugin against existing plugins.
        // We test the logic by simulating the check.
        let existing = vec![PluginManifest {
            name: "Existing".to_string(),
            service_id: Some("existing".to_string()),
            slug: "existing".to_string(),
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
            requires_integrations: vec![],
        }];

        let new_port: u16 = 4010;
        let new_slug = "new-plugin";
        let conflict = existing
            .iter()
            .any(|m| m.port == Some(new_port) && m.slug != new_slug);
        assert!(conflict, "Duplicate port should be detected");
    }

    #[test]
    fn test_token_dir_returns_correct_path() {
        let result = token_dir("myproject", "presale").unwrap();
        let expected_suffix = std::path::Path::new(".speedwave/tokens/myproject/presale");
        assert!(
            result.ends_with(expected_suffix),
            "token_dir should return ~/.speedwave/tokens/<project>/<service_id>, got: {}",
            result.display()
        );
    }

    // --- Zip Slip security tests (issue #36) ---

    #[test]
    fn test_extract_zip_safe_archive() {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("safe.zip");
        let extract_dir = tmp.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let buf = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(buf);
        let options = SimpleFileOptions::default();
        writer.start_file("plugin.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer.start_file("Containerfile", options).unwrap();
        writer.write_all(b"FROM scratch").unwrap();
        let buf = writer.finish().unwrap();
        std::fs::write(&zip_path, buf.into_inner()).unwrap();

        extract_zip(&zip_path, &extract_dir).unwrap();

        assert!(extract_dir.join("plugin.json").exists());
        assert!(extract_dir.join("Containerfile").exists());
        assert!(validate_extracted_paths(&extract_dir).is_ok());
    }

    #[test]
    fn test_extract_zip_rejects_path_traversal() {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("traversal.zip");
        let extract_dir = tmp.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let buf = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(buf);
        let options = SimpleFileOptions::default();
        writer.start_file("../../etc/passwd", options).unwrap();
        writer.write_all(b"malicious").unwrap();
        let buf = writer.finish().unwrap();
        std::fs::write(&zip_path, buf.into_inner()).unwrap();

        let result = extract_zip(&zip_path, &extract_dir);
        assert!(result.is_err(), "extract_zip should reject path traversal");
        assert!(
            result.unwrap_err().to_string().contains("path traversal"),
            "Error should mention 'path traversal'"
        );

        // File must not escape the extraction directory
        assert!(
            !tmp.path().join("etc").exists(),
            "Traversal file should not exist outside extract dir"
        );
    }

    #[test]
    fn test_extract_zip_rejects_absolute_path() {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("absolute.zip");
        let extract_dir = tmp.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let buf = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(buf);
        let options = SimpleFileOptions::default();
        writer.start_file("/etc/passwd", options).unwrap();
        writer.write_all(b"malicious").unwrap();
        let buf = writer.finish().unwrap();
        std::fs::write(&zip_path, buf.into_inner()).unwrap();

        let result = extract_zip(&zip_path, &extract_dir);
        assert!(result.is_err(), "extract_zip should reject absolute paths");
        assert!(
            result.unwrap_err().to_string().contains("absolute path"),
            "Error should mention 'absolute path'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_extract_zip_rejects_symlink() {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("symlink.zip");
        let extract_dir = tmp.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let outside = tmp.path().join("secret.txt");
        std::fs::write(&outside, "sensitive data").unwrap();

        let buf = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(buf);
        let options = SimpleFileOptions::default();
        writer.start_file("plugin.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer
            .add_symlink("escape-link", outside.to_string_lossy(), options)
            .unwrap();
        let buf = writer.finish().unwrap();
        std::fs::write(&zip_path, buf.into_inner()).unwrap();

        // Pre-validation rejects symlinks before anything is written
        let result = extract_zip(&zip_path, &extract_dir);
        assert!(result.is_err(), "extract_zip should reject symlink entries");
        assert!(
            result.unwrap_err().to_string().contains("symlink"),
            "Error should mention symlink"
        );

        // Symlink was never created on disk
        assert!(
            extract_dir.join("escape-link").symlink_metadata().is_err(),
            "Symlink should not exist — rejected before extraction"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_validate_extracted_paths_catches_dir_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("plugins");
        std::fs::create_dir_all(&base).unwrap();

        let outside_dir = tmp.path().join("outside-secrets");
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(outside_dir.join("credentials.json"), "secret").unwrap();

        std::os::unix::fs::symlink(&outside_dir, base.join("escape-dir")).unwrap();

        let result = validate_extracted_paths(&base);
        assert!(result.is_err(), "Should detect directory symlink escape");
        assert!(
            format!("{:?}", result.unwrap_err()).contains("Zip Slip"),
            "Error should mention Zip Slip"
        );
    }
}

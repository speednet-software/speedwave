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
    /// DEPRECATED — ignored by compose emitter since ADR-038.
    ///
    /// All workers (built-in and plugin) now listen on the same internal
    /// port ([`consts::PORT_WORKER`]). Kept `Option<u16>` for backward
    /// compatibility with already-signed plugin manifests; setting a non-zero
    /// value merely emits a warning at compose render time.
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
    #[serde(default)]
    pub cpu_limit: Option<String>,
    /// Core integrations this plugin depends on (e.g. `["sharepoint"]`).
    #[serde(default)]
    pub requires_integrations: Vec<String>,
}

/// Streaming progress event emitted while `install_plugin` runs.
///
/// Phase strings are part of the public IPC contract (event
/// `plugin_install_status`); see [`ALL_PLUGIN_INSTALL_PHASES`] for the
/// exhaustive list. The `error` field is always sanitized via
/// `log_sanitizer::sanitize` before emission.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct PluginInstallProgress {
    pub phase: String,
    pub message: String,
    pub error: Option<String>,
}

/// Outcome returned by [`install_plugin`].
///
/// Distinguishes a fully-installed plugin from one whose image build
/// deferred to the next launch (`.image_pending` marker remains).
#[derive(Debug, Clone)]
pub enum InstallOutcome {
    Installed(PluginManifest),
    InstalledPendingBuild(PluginManifest),
}

/// SSOT for the phase strings emitted by [`install_plugin`].
///
/// Mirrored as `PLUGIN_INSTALL_PHASES` in
/// `desktop/src/src/app/models/plugin.ts`. Adding/removing/renaming a phase
/// here requires the same change there (no codegen — this is a small,
/// rarely-changing list).
pub const ALL_PLUGIN_INSTALL_PHASES: &[&str] = &[
    "verifying",
    "extracting",
    "building",
    "done",
    "failed",
    "done_with_pending_build",
];

/// Lightweight summary of a plugin manifest for the install-overlay
/// pre-fetch path. Read by `peek_plugin_manifest` from the ZIP without
/// signature verification, extraction, or any side-effect.
#[derive(Serialize, Debug, Clone)]
pub struct PluginManifestSummary {
    pub slug: String,
    pub name: String,
    pub has_service_id: bool,
}

/// Returns `~/.speedwave/plugins/`
pub fn plugins_base_dir() -> anyhow::Result<PathBuf> {
    Ok(consts::data_dir().join("plugins"))
}

/// Returns the base directory for mutable per-plugin state — by default
/// `~/.speedwave/plugin-state/`. Kept *outside* the signed plugin
/// directory: markers like `image_pending` (telling the next launch to
/// retry an image build) used to live inside the plugin tree, but writing
/// into a tree that we then sign and re-verify is contradictory — any
/// post-install marker invalidates the digest.
///
/// `plugins_dir` ends in `plugins`; we replace that final segment with
/// `plugin-state` so unit tests pointing `plugins_dir` at a temp dir keep
/// their state under the same temp root instead of leaking into the user's
/// real `~/.speedwave/`.
fn plugin_state_base_for(plugins_dir: &Path) -> PathBuf {
    plugins_dir
        .parent()
        .map(|p| p.join("plugin-state"))
        .unwrap_or_else(|| plugins_dir.with_file_name("plugin-state"))
}

fn plugin_state_dir_for(plugins_dir: &Path, slug: &str) -> PathBuf {
    plugin_state_base_for(plugins_dir).join(slug)
}

fn image_pending_marker_for(plugins_dir: &Path, slug: &str) -> PathBuf {
    plugin_state_dir_for(plugins_dir, slug).join("image_pending")
}

/// Returns true if the plugin has a pending image build, looking in both
/// the new state directory and the legacy in-tree location. Legacy-only
/// markers are still observed so plugins installed before this change keep
/// building on next launch; PR3's audit pass migrates them by deleting the
/// in-tree marker after successful verification.
fn has_pending_image_build_for(plugins_dir: &Path, plugin_dir: &Path, slug: &str) -> bool {
    image_pending_marker_for(plugins_dir, slug).exists()
        || plugin_dir.join(".image_pending").exists()
}

/// Marks the plugin's image build as pending. Always writes to the new
/// state directory (`<plugin-state-base>/<slug>/image_pending`), never
/// into the signed plugin tree.
fn mark_image_pending_for(plugins_dir: &Path, slug: &str) -> anyhow::Result<()> {
    let dir = plugin_state_dir_for(plugins_dir, slug);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("image_pending"), b"")?;
    Ok(())
}

/// Clears the pending marker for `slug`, in both the state directory and
/// the legacy in-tree location. Best-effort — a missing marker is fine.
fn clear_image_pending_for(plugins_dir: &Path, plugin_dir: &Path, slug: &str) {
    let _ = std::fs::remove_file(image_pending_marker_for(plugins_dir, slug));
    let _ = std::fs::remove_file(plugin_dir.join(".image_pending"));
}

/// Returns `~/.speedwave/tokens/<project>/<service_id>/`
pub fn token_dir(project: &str, service_id: &str) -> anyhow::Result<PathBuf> {
    Ok(consts::data_dir()
        .join("tokens")
        .join(project)
        .join(service_id))
}

/// Testable version: constructs `<base>/.speedwave/tokens/<project>/<service_id>/`
#[cfg(test)]
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
    let token_dir = consts::data_dir()
        .join("tokens")
        .join(project)
        .join(service_id);
    write_token_files(&token_dir, tokens)
}

#[cfg(test)]
fn configure_plugin_tokens_with_base(
    home: &Path,
    project: &str,
    service_id: &str,
    tokens: &HashMap<String, String>,
) -> anyhow::Result<()> {
    let token_dir = token_dir_with_base(home, project, service_id);
    write_token_files(&token_dir, tokens)
}

fn write_token_files(token_dir: &Path, tokens: &HashMap<String, String>) -> anyhow::Result<()> {
    std::fs::create_dir_all(token_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode_700 = std::fs::Permissions::from_mode(0o700);
        // token_dir = <data_dir>/tokens/<project>/<service>
        // See also: setup_wizard.rs:write_tokens() — identical pattern (2 of 3, Rule of Three)
        std::fs::set_permissions(token_dir, mode_700.clone())?;
        if let Some(project_dir) = token_dir.parent() {
            // project_dir = <data_dir>/tokens/<project>
            std::fs::set_permissions(project_dir, mode_700.clone())?;
            if let Some(tokens_dir) = project_dir.parent() {
                // tokens_dir = <data_dir>/tokens — stop here, don't go to data_dir
                std::fs::set_permissions(tokens_dir, mode_700)?;
            }
        }
    }

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
    get_plugin_token_status_in(consts::data_dir(), project, manifest)
}

fn get_plugin_token_status_in(
    data_dir: &Path,
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
    let token_dir = data_dir.join("tokens").join(project).join(service_id);

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

/// Testable variant — accepts explicit home dir (tests use fake_home pattern).
#[cfg(test)]
fn get_plugin_token_status_with_base(
    home: &Path,
    project: &str,
    manifest: &PluginManifest,
) -> TokenStatus {
    get_plugin_token_status_in(&home.join(consts::DATA_DIR), project, manifest)
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

fn validate_speedwave_compat(compat: Option<&str>) -> anyhow::Result<()> {
    let s = match compat {
        None => return Ok(()),
        Some(s) => s,
    };
    // `VersionReq::parse("")` returns a match-all comparator list — guard before calling it.
    if s.trim().is_empty() {
        anyhow::bail!(
            "speedwave_compat must not be empty — omit the field to disable the compatibility check"
        );
    }
    let req = semver::VersionReq::parse(s).map_err(|e| {
        anyhow::anyhow!(
            "Invalid speedwave_compat '{}': must be a valid semver version requirement (e.g. '>=0.8, <1', '^0.8'): {}",
            s,
            e
        )
    })?;
    let current_version = semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| {
        anyhow::anyhow!(
            "internal: CARGO_PKG_VERSION '{}' is not valid semver: {}",
            env!("CARGO_PKG_VERSION"),
            e
        )
    })?;
    if !req.matches(&current_version) {
        anyhow::bail!(
            "Plugin requires Speedwave version matching '{}', but this Speedwave is {}. Upgrade Speedwave or install an older plugin version.",
            s,
            current_version
        );
    }
    Ok(())
}

/// Validates manifest constraints at install time.
fn validate_manifest(manifest: &PluginManifest, plugin_dir: &Path) -> anyhow::Result<()> {
    validate_slug(&manifest.slug)?;
    validate_speedwave_compat(manifest.speedwave_compat.as_deref())?;

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

    // Slug must not collide with built-in compose service names. Without this,
    // a plugin with slug "hub" would derive compose name "mcp-hub" and silently
    // overwrite the built-in hub entry on YAML mapping insert — defeating the
    // hub's zero-token guarantee.
    let derived_compose = derive_compose_name(&manifest.slug);
    if consts::BUILT_IN_SERVICES.contains(&derived_compose.as_str())
        || manifest.slug == "hub"
        || manifest.slug == "claude"
    {
        anyhow::bail!(
            "Plugin slug '{}' would produce compose name '{}' which conflicts with a built-in service",
            manifest.slug,
            derived_compose
        );
    }

    // If service_id present, Containerfile must exist
    if manifest.service_id.is_some() && !plugin_dir.join("Containerfile").exists() {
        anyhow::bail!(
            "MCP plugins (service_id='{}') must include a Containerfile",
            manifest.service_id.as_deref().unwrap_or("")
        );
    }

    // Validate mem_limit: format AND upper bound (DoS prevention).
    if let Some(ref limit) = manifest.mem_limit {
        let mib = parse_mem_limit_to_mib(limit)?;
        if mib > consts::PLUGIN_MEM_LIMIT_MAX_MIB {
            anyhow::bail!(
                "mem_limit '{}' ({} MiB) exceeds maximum allowed for plugins ({} MiB)",
                limit,
                mib,
                consts::PLUGIN_MEM_LIMIT_MAX_MIB
            );
        }
    }

    // Validate cpu_limit: format AND upper bound.
    if let Some(ref limit) = manifest.cpu_limit {
        let cores: f32 = limit.parse().map_err(|_| {
            anyhow::anyhow!("Invalid cpu_limit '{}': must be a positive number", limit)
        })?;
        if !cores.is_finite() || cores <= 0.0 {
            anyhow::bail!(
                "Invalid cpu_limit '{}': must be a positive finite number",
                limit
            );
        }
        if cores > consts::PLUGIN_CPU_LIMIT_MAX {
            anyhow::bail!(
                "cpu_limit '{}' exceeds maximum allowed for plugins ({} cores)",
                limit,
                consts::PLUGIN_CPU_LIMIT_MAX
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
            || field.key.contains('\0')
            || field.key.is_empty()
        {
            anyhow::bail!(
                "Invalid auth_field key '{}': must not contain path separators, '..', or null bytes",
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

    // Validate requires_integrations entries are known built-in service IDs
    for req in &manifest.requires_integrations {
        if !consts::BUILT_IN_SERVICE_IDS.contains(&req.as_str()) {
            anyhow::bail!(
                "requires_integrations entry '{}' is not a known built-in service ID. Known: {:?}",
                req,
                consts::BUILT_IN_SERVICE_IDS
            );
        }
    }

    // Validate extra_env keys/values contain no newlines or null bytes (YAML
    // injection defense). Reserved keys (PORT auto-injected, plus dynamic-
    // linker / language-runtime hijack vectors like LD_PRELOAD, NODE_OPTIONS)
    // are sourced from `consts::RESERVED_ENV_KEYS` and rejected case-insensitively.
    if let Some(ref env) = manifest.extra_env {
        for (k, v) in env {
            let k_upper = k.to_ascii_uppercase();
            if consts::RESERVED_ENV_KEYS
                .iter()
                .any(|reserved| reserved.eq_ignore_ascii_case(&k_upper))
            {
                anyhow::bail!(
                    "extra_env key '{}' is reserved (auto-injected by Speedwave or a dangerous runtime hijack vector)",
                    k
                );
            }
            if k.contains('=') {
                anyhow::bail!("extra_env key must not contain '=' (key: '{}')", k);
            }
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

    // token_mount: rw is reserved for built-in services per ADR-009 (currently
    // SharePoint only, for OAuth refresh). Built-in service slugs are blocked
    // by BUILT_IN_SERVICE_IDS earlier in this function, so any plugin reaching
    // here with `ReadWrite` is by definition unauthorised. This is enforced by
    // code, not just documentation.
    if matches!(manifest.token_mount, TokenMount::ReadWrite { .. }) {
        anyhow::bail!(
            "token_mount: read_write is reserved for built-in services (ADR-009). \
             Plugins must use token_mount: read_only."
        );
    }

    Ok(())
}

/// Parses a Docker-style memory limit string into MiB.
///
/// Accepts: bare bytes (`"512000"`), or `<number><unit>` where unit is one of
/// `b/k/m/g` (case-insensitive). Returns an error on malformed input,
/// negative or zero values, or arithmetic overflow.
fn parse_mem_limit_to_mib(s: &str) -> anyhow::Result<u64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        anyhow::bail!("mem_limit must not be empty");
    }
    let (num_part, unit) = match trimmed.chars().last() {
        Some(c) if c.is_ascii_alphabetic() => (&trimmed[..trimmed.len() - 1], Some(c)),
        Some(_) => (trimmed, None),
        None => anyhow::bail!("mem_limit must not be empty"),
    };
    let n: u64 = num_part
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid mem_limit '{}': not a valid number", s))?;
    let bytes = match unit.map(|c| c.to_ascii_lowercase()) {
        None | Some('b') => n,
        Some('k') => n
            .checked_mul(1024)
            .ok_or_else(|| anyhow::anyhow!("mem_limit overflow"))?,
        Some('m') => n
            .checked_mul(1024 * 1024)
            .ok_or_else(|| anyhow::anyhow!("mem_limit overflow"))?,
        Some('g') => n
            .checked_mul(1024 * 1024 * 1024)
            .ok_or_else(|| anyhow::anyhow!("mem_limit overflow"))?,
        Some(other) => anyhow::bail!(
            "Invalid mem_limit '{}': unit must be one of b/k/m/g (got '{}')",
            s,
            other
        ),
    };
    Ok(bytes / (1024 * 1024))
}

/// Reads a plugin manifest summary from a ZIP without verifying the
/// signature, extracting to a permanent location, or running any side-effect.
///
/// Used by the Desktop install overlay to learn whether the plugin will run
/// the `building` phase (i.e. has a `service_id`) BEFORE invoking
/// [`install_plugin`]. The full [`install_plugin`] flow re-runs every step
/// — including signature verification — so this is purely a lightweight
/// pre-flight peek.
pub fn peek_plugin_manifest(zip_path: &Path) -> anyhow::Result<PluginManifestSummary> {
    let tmp_dir =
        std::env::temp_dir().join(format!("speedwave-plugin-peek-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir)?;
    let _cleanup = TmpDirGuard(tmp_dir.clone());
    extract_zip(zip_path, &tmp_dir)?;
    validate_extracted_paths(&tmp_dir)?;
    let plugin_src = find_plugin_dir(&tmp_dir)?;

    let manifest_path = plugin_src.join("plugin.json");
    let content = std::fs::read_to_string(&manifest_path)?;
    let manifest: PluginManifest = serde_json::from_str(&content)?;
    Ok(PluginManifestSummary {
        slug: manifest.slug,
        name: manifest.name,
        has_service_id: manifest.service_id.is_some(),
    })
}

/// Install a plugin from a ZIP file into `~/.speedwave/plugins/<slug>/`.
/// Verifies signature, validates manifest, and creates `.image_pending` marker
/// for deferred image build.
///
/// Streams progress through `on_progress` using the phases defined in
/// [`ALL_PLUGIN_INSTALL_PHASES`]. The `error` field of any emitted
/// [`PluginInstallProgress`] is sanitized via
/// [`crate::log_sanitizer::sanitize`] before emission.
///
/// Returns:
/// * [`InstallOutcome::Installed`] — plugin extracted and (for MCP plugins)
///   image built.
/// * [`InstallOutcome::InstalledPendingBuild`] — plugin extracted; image
///   build failed. The `.image_pending` marker remains and the build is
///   retried on the next launch via [`ensure_all_plugin_images`].
pub fn install_plugin(
    zip_path: &Path,
    runtime: Option<&dyn ContainerRuntime>,
    on_progress: &mut dyn FnMut(PluginInstallProgress),
) -> anyhow::Result<InstallOutcome> {
    let plugins_dir = plugins_base_dir()?;
    install_plugin_with_base(zip_path, runtime, on_progress, &plugins_dir)
}

/// Testable variant of [`install_plugin`] — accepts an explicit plugins
/// base directory so unit tests can isolate file-system mutation under
/// `tempfile::tempdir()`.
fn install_plugin_with_base(
    zip_path: &Path,
    runtime: Option<&dyn ContainerRuntime>,
    on_progress: &mut dyn FnMut(PluginInstallProgress),
    plugins_dir: &Path,
) -> anyhow::Result<InstallOutcome> {
    let mut emit = |phase: &str, message: &str| {
        on_progress(PluginInstallProgress {
            phase: phase.to_string(),
            message: message.to_string(),
            error: None,
        });
    };

    std::fs::create_dir_all(plugins_dir)?;

    // Phase: verifying — signature check
    emit("verifying", "Verifying signature");

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
    if let Err(e) = signing::verify_plugin_signature(&plugin_src) {
        on_progress(PluginInstallProgress {
            phase: "failed".to_string(),
            message: "Signature verification failed".to_string(),
            error: Some(crate::log_sanitizer::sanitize(&e.to_string())),
        });
        return Err(e);
    }

    // Read and validate manifest
    let manifest_path = plugin_src.join("plugin.json");
    let content = std::fs::read_to_string(&manifest_path)?;
    let manifest: PluginManifest = serde_json::from_str(&content)?;

    validate_manifest(&manifest, &plugin_src)?;

    // Reject duplicate service_id or port among already-installed plugins
    let existing = list_installed_from_dir(plugins_dir)?;
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

    // Phase: extracting — copy from temp to permanent location
    emit("extracting", "Extracting archive");
    let dest = plugins_dir.join(&manifest.slug);
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    copy_dir_recursive(&plugin_src, &dest)?;

    // Mark pending image build for MCP plugins. Stored OUTSIDE the signed
    // tree (see `plugin_state_base_for`) so that creating the marker
    // doesn't invalidate the plugin's digest.
    if manifest.service_id.is_some() {
        mark_image_pending_for(plugins_dir, &manifest.slug)?;

        // Build immediately if runtime is available
        if let Some(rt) = runtime {
            emit("building", "Building container image (may take 2-5 min)");
            match build_single_plugin_image(rt, &manifest, &dest) {
                Ok(()) => {
                    // .image_pending was removed by build_single_plugin_image on success
                }
                Err(e) => {
                    log::warn!("Deferred build for plugin '{}': {e}", manifest.slug);
                    on_progress(PluginInstallProgress {
                        phase: "failed".to_string(),
                        message: "Image build failed".to_string(),
                        error: Some(crate::log_sanitizer::sanitize(&e.to_string())),
                    });
                    on_progress(PluginInstallProgress {
                        phase: "done_with_pending_build".to_string(),
                        message:
                            "Plugin installed; image build failed and will retry on next launch"
                                .to_string(),
                        error: None,
                    });
                    warn_legacy_addons();
                    return Ok(InstallOutcome::InstalledPendingBuild(manifest));
                }
            }
        } else {
            // No runtime available — image was not built. Treat as deferred
            // so callers (CLI, Tauri auto-enable) don't enable an MCP plugin
            // whose worker cannot start. `.image_pending` retry will run on
            // the next launch via `ensure_all_plugin_images`.
            on_progress(PluginInstallProgress {
                phase: "done_with_pending_build".to_string(),
                message: "Plugin installed; image build deferred to next launch".to_string(),
                error: None,
            });
            warn_legacy_addons();
            return Ok(InstallOutcome::InstalledPendingBuild(manifest));
        }
    }

    // Legacy addon migration warning
    warn_legacy_addons();

    emit("done", "Plugin installed");
    Ok(InstallOutcome::Installed(manifest))
}

/// Removes a plugin by slug.
///
/// When `runtime` is provided AND the plugin has a `service_id` (i.e. an
/// MCP plugin with a built container image), also removes the cached
/// container image (`speedwave-mcp-<slug>:<version>`). Image cleanup is
/// best-effort — a failure is logged at warn level but does not fail the
/// removal, since at that point the plugin directory is already gone and
/// the surviving image is at worst a few hundred MB of leaked disk.
///
/// Pass `runtime: None` to keep the legacy behaviour (delete files only).
pub fn remove_plugin(slug: &str, runtime: Option<&dyn ContainerRuntime>) -> anyhow::Result<()> {
    let plugins_dir = plugins_base_dir()?;
    remove_plugin_with_base(slug, &plugins_dir, runtime)
}

/// Testable variant of [`remove_plugin`] — accepts an explicit plugins
/// base directory so unit tests can isolate file-system mutation under
/// `tempfile::tempdir()`. Mirrors [`install_plugin_with_base`].
fn remove_plugin_with_base(
    slug: &str,
    plugins_dir: &Path,
    runtime: Option<&dyn ContainerRuntime>,
) -> anyhow::Result<()> {
    validate_slug(slug)?;
    let plugin_dir = plugins_dir.join(slug);
    if !plugin_dir.exists() {
        anyhow::bail!("Plugin '{}' not found", slug);
    }

    // Read the manifest BEFORE removing files so we can compute the image
    // tag for cleanup. We tolerate a missing/corrupt manifest — the file
    // delete still proceeds.
    let manifest_for_image = if runtime.is_some() {
        std::fs::read_to_string(plugin_dir.join("plugin.json"))
            .ok()
            .and_then(|content| serde_json::from_str::<PluginManifest>(&content).ok())
    } else {
        None
    };

    std::fs::remove_dir_all(&plugin_dir)?;
    // Mutable state lives outside the signed tree (PR2). Wipe it too, so a
    // subsequent reinstall starts from a clean state and we don't leak a
    // stale `image_pending` marker for a plugin that no longer exists.
    let state_dir = plugin_state_dir_for(plugins_dir, slug);
    if state_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&state_dir) {
            log::warn!(
                "Failed to remove plugin state dir {}: {e}",
                state_dir.display()
            );
        }
    }
    log::info!("Removed plugin '{}'", slug);

    if let (Some(rt), Some(manifest)) = (runtime, manifest_for_image) {
        if manifest.service_id.is_some() {
            let tag = plugin_image_tag(&manifest);
            // force=true: the user explicitly asked to remove this plugin,
            // and the worker container is almost always still running until
            // the next compose recreate. Without --force, rmi would refuse
            // and the layer cache would survive — defeating the next
            // reinstall (a fresh ZIP would receive the stale cached image).
            if let Err(e) = rt.remove_images(std::slice::from_ref(&tag), true) {
                log::warn!("Failed to remove container image '{tag}' for plugin '{slug}': {e}");
            } else {
                log::info!("Removed container image '{tag}' for plugin '{slug}'");
            }
        }
    }

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

/// Ensures plugin images exist for the given enabled service IDs (project-scoped).
///
/// First runs the pending-build pass (`.image_pending` marker) for enabled plugins,
/// then checks whether each enabled MCP plugin's image exists in the container
/// engine. If an image is missing, attempts to rebuild it from the plugin source.
///
/// The pending-build pass (pass 1) propagates errors immediately — a failed
/// pending build indicates a freshly-installed plugin with a broken image, which
/// warrants aborting before pass 2.  Pass 2 (missing-image rebuild) accumulates
/// errors across all enabled plugins and returns them together.
///
/// This is the primary fix for image loss after VM reset. Use in `render_compose()`.
pub fn ensure_plugin_images(
    runtime: &dyn ContainerRuntime,
    enabled_service_ids: &[&str],
) -> anyhow::Result<()> {
    let plugins_dir = plugins_base_dir()?;
    ensure_plugin_images_from_dir(runtime, enabled_service_ids, &plugins_dir)
}

/// Inner implementation of `ensure_plugin_images()` — accepts explicit plugins dir for testability.
fn ensure_plugin_images_from_dir(
    runtime: &dyn ContainerRuntime,
    enabled_service_ids: &[&str],
    plugins_dir: &Path,
) -> anyhow::Result<()> {
    if !plugins_dir.exists() {
        return Ok(());
    }

    // First: build any pending (newly-installed) images for enabled plugins.
    build_pending_from_dir(runtime, Some(enabled_service_ids), plugins_dir)?;

    // Second: check image existence and rebuild any missing images.
    let plugins = list_installed_from_dir(plugins_dir)?;
    let mut errors: Vec<String> = Vec::new();

    for manifest in &plugins {
        let sid = match manifest.service_id.as_deref() {
            Some(s) => s,
            None => continue, // resource-only plugin, no image
        };

        if !enabled_service_ids.contains(&sid) {
            continue; // not enabled for this project
        }

        let plugin_dir = plugins_dir.join(&manifest.slug);
        if !plugin_dir.join("Containerfile").exists() {
            log::warn!(
                "Plugin '{}' has service_id but no Containerfile — skipping image check",
                manifest.slug
            );
            continue;
        }

        let tag = plugin_image_tag(manifest);
        let exists = runtime.image_exists(&tag).unwrap_or(false);
        if !exists {
            log::info!(
                "Plugin image '{}' missing — rebuilding from {}",
                tag,
                plugin_dir.display()
            );
            if let Err(e) = build_single_plugin_image(runtime, manifest, &plugin_dir) {
                errors.push(format!("plugin '{}': {e}", manifest.slug));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(
            "Some plugin images failed to rebuild:\n{}",
            errors.join("\n")
        )
    }
}

/// Ensures all installed MCP plugin images exist (global, best-effort for reconcile).
///
/// Checks every installed MCP plugin's image and rebuilds any that are missing.
/// Unlike `ensure_plugin_images()`, this is not scoped to a project — it rebuilds
/// all plugin images regardless of which projects use them.
///
/// Does **not** run the pending-build pass (`.image_pending` markers). Freshly
/// installed plugins that haven't been built yet are handled at per-project
/// startup via `ensure_plugin_images` → `build_pending_from_dir`.
///
/// Errors are accumulated but individual failures do not stop other plugins from
/// being rebuilt. Use in the Desktop reconcile path (warn-only caller).
pub fn ensure_all_plugin_images(runtime: &dyn ContainerRuntime) -> anyhow::Result<()> {
    let plugins_dir = plugins_base_dir()?;
    ensure_all_plugin_images_from_dir(runtime, &plugins_dir)
}

/// Inner implementation of `ensure_all_plugin_images()` — accepts explicit plugins dir for testability.
fn ensure_all_plugin_images_from_dir(
    runtime: &dyn ContainerRuntime,
    plugins_dir: &Path,
) -> anyhow::Result<()> {
    if !plugins_dir.exists() {
        return Ok(());
    }

    let plugins = list_installed_from_dir(plugins_dir)?;
    let mut errors: Vec<String> = Vec::new();

    for manifest in &plugins {
        if manifest.service_id.is_none() {
            continue; // resource-only plugin, no image
        }

        let plugin_dir = plugins_dir.join(&manifest.slug);
        if !plugin_dir.join("Containerfile").exists() {
            continue;
        }

        let tag = plugin_image_tag(manifest);
        let exists = runtime.image_exists(&tag).unwrap_or(false);
        if !exists {
            log::info!(
                "Plugin image '{}' missing — rebuilding from {}",
                tag,
                plugin_dir.display()
            );
            if let Err(e) = build_single_plugin_image(runtime, manifest, &plugin_dir) {
                errors.push(format!("plugin '{}': {e}", manifest.slug));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(
            "Some plugin images failed to rebuild:\n{}",
            errors.join("\n")
        )
    }
}

/// Builds pending plugin images (`.image_pending` marker).
///
/// When `enabled_service_ids` is `Some(list)`, only plugins whose `service_id` is in the list
/// are built — used at per-project startup to avoid touching unrelated plugins. A resource-only
/// plugin (no `service_id`) yields `sid = ""`, which never matches any caller-supplied list, so
/// such plugins are silently skipped when filtering is active.
///
/// When `enabled_service_ids` is `None`, all pending plugins are built — used in tests.
/// Note: `ensure_all_plugin_images` does not call this function; it only rebuilds
/// missing images. Pending builds are handled at per-project startup via
/// `ensure_plugin_images`.
fn build_pending_from_dir(
    runtime: &dyn ContainerRuntime,
    enabled_service_ids: Option<&[&str]>,
    plugins_dir: &Path,
) -> anyhow::Result<()> {
    if !plugins_dir.exists() {
        return Ok(());
    }

    let mut errors: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(plugins_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().to_string();
        let plugin_dir = entry.path();
        // Pending markers may live in two places: the new state directory
        // (`<plugin-state-base>/<slug>/image_pending`, written by installs
        // after PR2) or, for plugins installed before PR2, the legacy
        // in-tree `.image_pending`. Check both.
        if !has_pending_image_build_for(plugins_dir, &plugin_dir, &slug) {
            continue;
        }
        let manifest_path = plugin_dir.join("plugin.json");
        if !manifest_path.exists() {
            continue;
        }
        let content = match std::fs::read_to_string(&manifest_path) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("{}: read manifest: {e}", plugin_dir.display()));
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

        if let Some(enabled) = enabled_service_ids {
            let sid = manifest.service_id.as_deref().unwrap_or("");
            if !enabled.contains(&sid) {
                continue;
            }
        }

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
        &[],
    )?;

    // Remove the pending marker on success — both the new state-dir
    // location and the legacy in-tree marker, so a plugin installed before
    // PR2 stops re-triggering on every launch. `plugin_dir` is always
    // `<plugins_dir>/<slug>/`, so its parent is the plugins base.
    if let Some(plugins_dir) = plugin_dir.parent() {
        clear_image_pending_for(plugins_dir, plugin_dir, &manifest.slug);
    } else {
        // Defensive — should not happen since plugin_dir always has a parent.
        let _ = std::fs::remove_file(plugin_dir.join(".image_pending"));
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
    project_dir: &str,
) -> anyhow::Result<serde_yaml_ng::Value> {
    let sid = manifest
        .service_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("generate_plugin_service requires service_id"))?;

    let tag = plugin_image_tag(manifest);
    let container_name = format!(
        "{}_{}_{}_{}",
        consts::compose_prefix(),
        project_name,
        "mcp",
        sid.replace('-', "_")
    );
    // All workers use a single internal port — see ADR-038.
    let port = consts::PORT_WORKER;

    let token_mount_mode = match &manifest.token_mount {
        TokenMount::ReadOnly => "ro",
        TokenMount::ReadWrite { .. } => "rw",
    };

    let tokens_path = crate::compose::to_engine_path(&tokens_dir.join(sid))?;
    let workspace_path = crate::compose::to_engine_path(Path::new(project_dir))?;
    let mem_limit = manifest.mem_limit.as_deref().unwrap_or("128m");
    let cpu_limit = manifest.cpu_limit.as_deref().unwrap_or("2.0");
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
pull_policy: never
container_name: {container_name}
read_only: true
user: "{user}"
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
tmpfs:
  - /tmp:noexec,nosuid,size=512m
volumes:
  - {tokens_path}:/tokens:{token_mount_mode}
  - {workspace_path}:/workspace:rw
environment:
{env_lines}
networks:
  - {network_name}
labels:
  speedwave.plugin-service: "true"
deploy:
  resources:
    limits:
      cpus: '{cpu_limit}'
      memory: {mem_limit}
"#,
        tag = tag,
        container_name = container_name,
        user = user,
        tokens_path = tokens_path,
        token_mount_mode = token_mount_mode,
        workspace_path = workspace_path,
        env_lines = env_lines,
        network_name = network_name,
        mem_limit = mem_limit,
        cpu_limit = cpu_limit,
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
        // Reject absolute paths explicitly (zip v8 `enclosed_name()` strips
        // leading slashes instead of returning None, so we check raw name).
        if name.starts_with('/') || name.starts_with('\\') {
            anyhow::bail!("Rejected ZIP entry with absolute path: '{}'", name);
        }
        if entry.enclosed_name().is_none() {
            anyhow::bail!("Rejected ZIP entry with path traversal: '{}'", name);
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
            // No manual cleanup needed: TmpDirGuard owns the parent directory
            // and will remove it on drop when the error propagates.
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
    let addons_dir = consts::data_dir().join("addons");
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
            port: None,
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
            cpu_limit: None,
            requires_integrations: vec!["sharepoint".to_string()],
        };
        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: PluginManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "Presale CRM");
        assert_eq!(parsed.service_id.as_deref(), Some("presale"));
        assert_eq!(parsed.slug, "presale");
        assert_eq!(parsed.version, "1.2.0");
        assert_eq!(parsed.port, None);
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
                cpu_limit: None,
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
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
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
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
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
            cpu_limit: None,
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
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
        };

        let tokens_dir = PathBuf::from("/home/user/.speedwave/tokens/myproject");
        let result = generate_plugin_service(
            &manifest,
            "myproject",
            "speedwave_myproject_network",
            &tokens_dir,
            "/home/user/projects/myproject",
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
        assert!(yaml.contains("/workspace:rw"), "workspace mount: {yaml}");
        // ADR-038: every worker — including plugins — uses PORT_WORKER (3000).
        assert!(yaml.contains("PORT=3000"), "PORT env: {yaml}");
        assert!(
            yaml.contains("speedwave_myproject_network"),
            "network: {yaml}"
        );
        assert!(yaml.contains("speedwave.plugin-service"), "label: {yaml}");
        assert!(yaml.contains("memory: 128m"), "mem limit: {yaml}");
        assert!(yaml.contains("cpus: '2.0'"), "default cpu limit: {yaml}");
    }

    #[test]
    fn test_generate_plugin_service_readwrite_mount() {
        let manifest = PluginManifest {
            name: "SP Plugin".to_string(),
            service_id: Some("sp-ext".to_string()),
            slug: "sp-ext".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
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
            cpu_limit: None,
            requires_integrations: vec![],
        };

        let tokens_dir = PathBuf::from("/home/user/.speedwave/tokens/proj");
        let result = generate_plugin_service(
            &manifest,
            "proj",
            "speedwave_proj_network",
            &tokens_dir,
            "/test/project",
        )
        .unwrap();

        let yaml = serde_yaml_ng::to_string(&result).unwrap();
        assert!(yaml.contains("/tokens:rw"), "should use :rw mount: {yaml}");
        assert!(yaml.contains("/workspace:rw"), "workspace mount: {yaml}");
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
            port: None,
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
            cpu_limit: None,
            requires_integrations: vec![],
        };

        let tokens_dir = PathBuf::from("/tokens");
        let result =
            generate_plugin_service(&manifest, "proj", "net", &tokens_dir, "/test/project")
                .unwrap();

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
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
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
            port: None,
            image_tag: Some("custom-tag".to_string()),
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
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
            port: None,
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
            cpu_limit: None,
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
            port: None,
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
            cpu_limit: None,
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
            cpu_limit: None,
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
            port: None,
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
            cpu_limit: None,
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
            port: None,
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
            cpu_limit: None,
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

    // --- ALL_PLUGIN_INSTALL_PHASES parity ---

    #[test]
    fn test_all_plugin_install_phases_lists_expected_strings() {
        // SSOT for the IPC contract; mirror in
        // desktop/src/src/app/models/plugin.ts::PLUGIN_INSTALL_PHASES.
        // Adding/removing/renaming a phase here requires the same change there.
        assert_eq!(
            ALL_PLUGIN_INSTALL_PHASES,
            &[
                "verifying",
                "extracting",
                "building",
                "done",
                "failed",
                "done_with_pending_build",
            ]
        );
    }

    // --- peek_plugin_manifest tests ---

    /// Builds a minimal valid signed-bypass plugin ZIP for tests.
    /// Caller must set SPEEDWAVE_ALLOW_UNSIGNED to skip signature verification.
    fn build_test_plugin_zip(zip_path: &Path, slug: &str, with_service_id: bool) {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let buf = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(buf);
        let options = SimpleFileOptions::default();

        let manifest_json = if with_service_id {
            format!(
                r#"{{
                    "name": "{slug}",
                    "slug": "{slug}",
                    "service_id": "{slug}",
                    "version": "1.0.0",
                    "description": "test plugin"
                }}"#
            )
        } else {
            format!(
                r#"{{
                    "name": "{slug}",
                    "slug": "{slug}",
                    "version": "1.0.0",
                    "description": "test resource-only plugin"
                }}"#
            )
        };

        writer.start_file("plugin.json", options).unwrap();
        writer.write_all(manifest_json.as_bytes()).unwrap();
        if with_service_id {
            writer.start_file("Containerfile", options).unwrap();
            writer.write_all(b"FROM scratch\n").unwrap();
        }
        let buf = writer.finish().unwrap();
        std::fs::write(zip_path, buf.into_inner()).unwrap();
    }

    /// Serializes tests that mutate the global `SPEEDWAVE_ALLOW_UNSIGNED`
    /// env var so concurrent runs do not see each other's set/unset.
    /// Acquired before set_var and dropped after remove_var.
    fn unsigned_env_lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::{Mutex, OnceLock};
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn test_peek_plugin_manifest_mcp_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "test-mcp", true);

        let summary = peek_plugin_manifest(&zip).unwrap();
        assert_eq!(summary.slug, "test-mcp");
        assert_eq!(summary.name, "test-mcp");
        assert!(summary.has_service_id);
    }

    #[test]
    fn test_peek_plugin_manifest_resource_only() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "test-skills", false);

        let summary = peek_plugin_manifest(&zip).unwrap();
        assert_eq!(summary.slug, "test-skills");
        assert!(!summary.has_service_id);
    }

    #[test]
    fn test_peek_plugin_manifest_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let result = peek_plugin_manifest(&tmp.path().join("nonexistent.zip"));
        assert!(result.is_err());
    }

    #[test]
    fn test_peek_plugin_manifest_no_manifest_in_zip() {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("noman.zip");
        let buf = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(buf);
        writer
            .start_file("README.md", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"no manifest here").unwrap();
        let buf = writer.finish().unwrap();
        std::fs::write(&zip, buf.into_inner()).unwrap();

        let result = peek_plugin_manifest(&zip);
        assert!(result.is_err());
    }

    #[test]
    fn test_peek_plugin_manifest_does_not_install() {
        // Verifies peek does not write into the plugins base directory.
        // Runs against an isolated tempdir-as-plugins-dir snapshot: even
        // though peek itself uses the real plugins_base_dir() internally,
        // it should not touch it (no write paths). We check by counting
        // entries in a freshly-created tempdir given as a probe — peek
        // should not write anywhere outside its own scratch tmp.
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "side-effect-test", true);

        // Mark the tempdir as the "would-be" plugins dir so we can detect
        // any rogue writes. peek_plugin_manifest should leave it untouched.
        let probe_dir = tmp.path().join("would-be-plugins");
        std::fs::create_dir_all(&probe_dir).unwrap();

        let summary = peek_plugin_manifest(&zip).unwrap();
        assert_eq!(summary.slug, "side-effect-test");

        let entries: Vec<_> = std::fs::read_dir(&probe_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            entries.is_empty(),
            "peek must not write into any plugins-like directory"
        );
    }

    // --- install_plugin progress callback tests ---

    /// Progress collector for install_plugin tests.
    fn collect_progress(
        progresses: &std::sync::Mutex<Vec<PluginInstallProgress>>,
    ) -> impl FnMut(PluginInstallProgress) + '_ {
        move |p| progresses.lock().unwrap().push(p)
    }

    /// `plugin_state_base_for` must keep mutable state under the same
    /// parent as `plugins_dir`, so unit tests pointing `plugins_dir` at a
    /// temp dir don't leak markers into the user's real `~/.speedwave/`.
    #[test]
    fn test_plugin_state_base_is_sibling_of_plugins_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let state = plugin_state_base_for(&plugins);
        assert_eq!(state, tmp.path().join("plugin-state"));
    }

    /// Legacy plugins (installed before PR2) carry an `.image_pending`
    /// marker inside the signed tree. `has_pending_image_build_for` must
    /// honour either location during the migration window — without this,
    /// every plugin installed before PR2 would silently stop rebuilding
    /// after a failed first build.
    #[test]
    fn test_has_pending_image_build_honours_legacy_in_tree_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("legacy-slug");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        // Only a legacy in-tree marker — no state-dir marker.
        std::fs::write(plugin_dir.join(".image_pending"), b"").unwrap();

        assert!(
            has_pending_image_build_for(&plugins, &plugin_dir, "legacy-slug"),
            "legacy in-tree marker must still trigger pending build"
        );
    }

    /// Successful build clears markers in both places, so a plugin that
    /// migrates from legacy to new layout doesn't loop on the old marker.
    #[test]
    fn test_clear_image_pending_for_removes_both_locations() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("dual-marker");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join(".image_pending"), b"").unwrap();
        mark_image_pending_for(&plugins, "dual-marker").unwrap();

        clear_image_pending_for(&plugins, &plugin_dir, "dual-marker");

        assert!(!plugin_dir.join(".image_pending").exists());
        assert!(!image_pending_marker_for(&plugins, "dual-marker").exists());
    }

    #[test]
    fn test_install_plugin_resource_only_emits_verifying_extracting_done() {
        // SPEEDWAVE_ALLOW_UNSIGNED is process-global; serialize tests that
        // touch it so concurrent runs cannot see partial state.
        let _guard = unsigned_env_lock();
        std::env::set_var("SPEEDWAVE_ALLOW_UNSIGNED", "1");
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "phases-resource", false);
        let plugins_dir = tmp.path().join("plugins");

        let progresses = std::sync::Mutex::new(Vec::<PluginInstallProgress>::new());
        let result =
            install_plugin_with_base(&zip, None, &mut collect_progress(&progresses), &plugins_dir);
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");

        assert!(result.is_ok(), "install_plugin failed: {:?}", result.err());
        let phases: Vec<String> = progresses
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.phase.clone())
            .collect();
        assert_eq!(phases, vec!["verifying", "extracting", "done"]);
        assert!(matches!(result.unwrap(), InstallOutcome::Installed(_)));
    }

    #[test]
    fn test_install_plugin_no_runtime_for_mcp_plugin_returns_pending_build() {
        let _guard = unsigned_env_lock();
        std::env::set_var("SPEEDWAVE_ALLOW_UNSIGNED", "1");
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "phases-no-runtime", true);
        let plugins_dir = tmp.path().join("plugins");

        let progresses = std::sync::Mutex::new(Vec::<PluginInstallProgress>::new());
        // runtime=None for MCP plugin: marker .image_pending is created,
        // building is not emitted, and the outcome is PendingBuild so callers
        // do not auto-enable an MCP worker whose image is absent.
        let result =
            install_plugin_with_base(&zip, None, &mut collect_progress(&progresses), &plugins_dir);
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");

        let dest = plugins_dir.join("phases-no-runtime");
        // Marker now lives in the state directory (sibling of plugins_dir),
        // never in the signed plugin tree (PR2). The plugin tree must stay
        // bit-for-bit identical to what was installed.
        let state_marker_existed =
            image_pending_marker_for(&plugins_dir, "phases-no-runtime").exists();
        let in_tree_marker = dest.join(".image_pending").exists();

        let outcome = result.expect("install must succeed");
        assert!(
            matches!(outcome, InstallOutcome::InstalledPendingBuild(_)),
            "MCP plugin without runtime must return InstalledPendingBuild"
        );
        assert!(
            state_marker_existed,
            "image_pending marker must be created in plugin-state when runtime is None"
        );
        assert!(
            !in_tree_marker,
            "marker must NOT be written into the signed plugin tree"
        );
        let phases: Vec<String> = progresses
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.phase.clone())
            .collect();
        // building skipped (no runtime); terminal phase is done_with_pending_build.
        assert_eq!(
            phases,
            vec!["verifying", "extracting", "done_with_pending_build"]
        );
    }

    #[test]
    fn test_install_plugin_emits_failed_with_sanitized_error() {
        // Build error containing a credential — must be sanitized before emission.
        struct SecretLeakingRuntime;
        impl ContainerRuntime for SecretLeakingRuntime {
            fn compose_up(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn compose_down(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
                Ok(vec![])
            }
            fn container_exec(&self, _: &str, _: &[&str]) -> std::process::Command {
                std::process::Command::new("true")
            }
            fn container_exec_piped(
                &self,
                _: &str,
                _: &[&str],
            ) -> anyhow::Result<std::process::Command> {
                Ok(std::process::Command::new("true"))
            }
            fn is_available(&self) -> bool {
                true
            }
            fn ensure_ready(&self) -> anyhow::Result<()> {
                Ok(())
            }
            fn build_image(
                &self,
                _: &str,
                _: &str,
                _: &str,
                _: &[(&str, &str)],
            ) -> anyhow::Result<()> {
                anyhow::bail!("RUN curl https://user:tok@registry.example.com/foo failed")
            }
            fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
                Ok(false)
            }
            fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
                Ok(String::new())
            }
            fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
                Ok(String::new())
            }
            fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
        }

        let _guard = unsigned_env_lock();
        std::env::set_var("SPEEDWAVE_ALLOW_UNSIGNED", "1");
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "phases-build-fail", true);
        let plugins_dir = tmp.path().join("plugins");

        let progresses = std::sync::Mutex::new(Vec::<PluginInstallProgress>::new());
        let rt = SecretLeakingRuntime;
        let result = install_plugin_with_base(
            &zip,
            Some(&rt),
            &mut collect_progress(&progresses),
            &plugins_dir,
        );
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");

        let dest = plugins_dir.join("phases-build-fail");
        let state_marker_kept =
            image_pending_marker_for(&plugins_dir, "phases-build-fail").exists();
        let in_tree_marker = dest.join(".image_pending").exists();

        assert!(
            result.is_ok(),
            "install must succeed-with-pending on build error"
        );
        assert!(matches!(
            result.unwrap(),
            InstallOutcome::InstalledPendingBuild(_)
        ));
        assert!(
            state_marker_kept,
            "image_pending marker (in plugin-state) must remain after a failed build"
        );
        assert!(
            !in_tree_marker,
            "marker must never be written into the signed plugin tree"
        );

        let progresses = progresses.into_inner().unwrap();
        let phases: Vec<String> = progresses.iter().map(|p| p.phase.clone()).collect();
        assert_eq!(
            phases,
            vec![
                "verifying",
                "extracting",
                "building",
                "failed",
                "done_with_pending_build"
            ]
        );

        // Security: the emitted error must NOT contain the credential.
        let failed = progresses.iter().find(|p| p.phase == "failed").unwrap();
        let err_text = failed.error.as_ref().expect("failed phase carries error");
        assert!(!err_text.contains("tok"), "credential leaked: {err_text}");
        assert!(
            err_text.contains("***REDACTED***"),
            "expected redacted marker in: {err_text}"
        );
    }

    // --- remove_plugin image cleanup tests ---

    /// Mock that records every `remove_images` call (tags + force) for inspection.
    struct ImageRemovingRuntime {
        calls: std::sync::Mutex<Vec<(Vec<String>, bool)>>,
        return_err: bool,
    }
    impl ImageRemovingRuntime {
        fn new() -> Self {
            Self {
                calls: std::sync::Mutex::new(vec![]),
                return_err: false,
            }
        }
        fn failing() -> Self {
            Self {
                calls: std::sync::Mutex::new(vec![]),
                return_err: true,
            }
        }
    }
    impl ContainerRuntime for ImageRemovingRuntime {
        fn compose_up(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_down(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
            Ok(vec![])
        }
        fn container_exec(&self, _: &str, _: &[&str]) -> std::process::Command {
            std::process::Command::new("true")
        }
        fn container_exec_piped(
            &self,
            _: &str,
            _: &[&str],
        ) -> anyhow::Result<std::process::Command> {
            Ok(std::process::Command::new("true"))
        }
        fn is_available(&self) -> bool {
            true
        }
        fn ensure_ready(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn build_image(&self, _: &str, _: &str, _: &str, _: &[(&str, &str)]) -> anyhow::Result<()> {
            Ok(())
        }
        fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
            Ok(false)
        }
        fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn remove_images(&self, tags: &[String], force: bool) -> anyhow::Result<()> {
            self.calls.lock().unwrap().push((tags.to_vec(), force));
            if self.return_err {
                anyhow::bail!("simulated nerdctl rmi failure")
            } else {
                Ok(())
            }
        }
    }

    /// Helper: install a plugin into `plugins_dir` so we have something to remove.
    fn write_plugin_dir(plugins_dir: &Path, slug: &str, with_service_id: bool) {
        let plugin_dir = plugins_dir.join(slug);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let manifest_json = if with_service_id {
            format!(
                r#"{{"name":"{slug}","slug":"{slug}","service_id":"{slug}","version":"1.0.0","description":"test"}}"#
            )
        } else {
            format!(r#"{{"name":"{slug}","slug":"{slug}","version":"1.0.0","description":"test"}}"#)
        };
        std::fs::write(plugin_dir.join("plugin.json"), manifest_json).unwrap();
        if with_service_id {
            std::fs::write(plugin_dir.join("Containerfile"), b"FROM scratch\n").unwrap();
        }
    }

    #[test]
    fn test_remove_plugin_calls_remove_images_for_mcp_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path().join("plugins");
        write_plugin_dir(&plugins_dir, "img-cleanup", true);

        let rt = ImageRemovingRuntime::new();
        remove_plugin_with_base("img-cleanup", &plugins_dir, Some(&rt)).unwrap();

        // Plugin dir is gone.
        assert!(!plugins_dir.join("img-cleanup").exists());
        // remove_images called once with the expected tag AND force=true
        // (uninstall is an explicit user request — no waiting for prune).
        let calls = rt.calls.into_inner().unwrap();
        assert_eq!(
            calls,
            vec![(vec!["speedwave-mcp-img-cleanup:1.0.0".to_string()], true)]
        );
    }

    #[test]
    fn test_remove_plugin_skips_image_for_resource_only_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path().join("plugins");
        write_plugin_dir(&plugins_dir, "skills-only", false);

        let rt = ImageRemovingRuntime::new();
        remove_plugin_with_base("skills-only", &plugins_dir, Some(&rt)).unwrap();

        // remove_images NOT called for plugins without a service_id.
        assert!(rt.calls.into_inner().unwrap().is_empty());
    }

    #[test]
    fn test_remove_plugin_skips_image_when_runtime_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path().join("plugins");
        write_plugin_dir(&plugins_dir, "no-runtime", true);

        // No runtime — files removed, image cleanup skipped (legacy path).
        remove_plugin_with_base("no-runtime", &plugins_dir, None).unwrap();
        assert!(!plugins_dir.join("no-runtime").exists());
    }

    #[test]
    fn test_remove_plugin_succeeds_even_when_remove_images_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path().join("plugins");
        write_plugin_dir(&plugins_dir, "rmi-fails", true);

        // Best-effort: image removal failure logs a warning but does not fail.
        let rt = ImageRemovingRuntime::failing();
        let result = remove_plugin_with_base("rmi-fails", &plugins_dir, Some(&rt));
        assert!(result.is_ok(), "remove_plugin must not fail on rmi error");
        assert!(!plugins_dir.join("rmi-fails").exists());
        // remove_images was attempted with force=true even on the error path
        // — the uninstall caller never silently downgrades to non-force rmi.
        let calls = rt.calls.into_inner().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(
            calls[0].1,
            "rmi error path should still pass force=true, got force={}",
            calls[0].1
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
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
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
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
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
            port: None,
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
            cpu_limit: None,
            requires_integrations: vec![],
        };

        let tokens_dir = PathBuf::from("/tokens");
        let result =
            generate_plugin_service(&manifest, "proj", "net", &tokens_dir, "/test/project")
                .unwrap();

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
    fn test_mcp_plugin_without_port_is_accepted() {
        // Since ADR-038, manifest.port is deprecated/ignored — a missing port
        // must NOT cause validate_manifest to fail.
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: Some("test-mcp".to_string()),
            slug: "test-mcp".to_string(),
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
            cpu_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Containerfile"), "FROM node:22").unwrap();
        let result = validate_manifest(&manifest, tmp.path());
        assert!(
            result.is_ok(),
            "MCP plugin without port must pass validation (ADR-038)"
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
            cpu_limit: None,
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
            cpu_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_ok());
    }

    #[test]
    fn test_validate_manifest_rejects_invalid_cpu_limit() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-cpu".to_string(),
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
            cpu_limit: Some("2.0'; injected".to_string()),
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_err());
    }

    #[test]
    fn test_validate_manifest_accepts_valid_cpu_limit() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-cpu".to_string(),
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
            cpu_limit: Some("4.0".to_string()),
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_ok());
    }

    #[test]
    fn test_generate_plugin_service_custom_cpu_limit() {
        let manifest = PluginManifest {
            name: "Heavy Plugin".to_string(),
            service_id: Some("heavy".to_string()),
            slug: "heavy".to_string(),
            version: "1.0.0".to_string(),
            description: "CPU-heavy plugin".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: Some("4.0".to_string()),
            requires_integrations: vec![],
        };

        let tokens_dir = PathBuf::from("/home/user/.speedwave/tokens/proj");
        let result = generate_plugin_service(
            &manifest,
            "proj",
            "speedwave_proj_network",
            &tokens_dir,
            "/home/user/projects/proj",
        )
        .unwrap();

        let yaml = serde_yaml_ng::to_string(&result).unwrap();
        assert!(yaml.contains("cpus: '4.0'"), "custom cpu limit: {yaml}");
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
            cpu_limit: None,
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
            cpu_limit: None,
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
            cpu_limit: None,
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
            cpu_limit: None,
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
            cpu_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_err());
    }

    #[test]
    fn test_validate_manifest_rejects_reserved_extra_env_key() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-reserved".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: Some(HashMap::from([("PORT".to_string(), "9999".to_string())])),
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("reserved"),
            "should mention reserved key, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_equals_in_extra_env_key() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-equals".to_string(),
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
                "KEY=INJECT".to_string(),
                "val".to_string(),
            )])),
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("'='"),
            "should reject '=' in extra_env key, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_unknown_requires_integrations() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-reqint".to_string(),
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
            cpu_limit: None,
            requires_integrations: vec!["nonexistent-service".to_string()],
        };
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("nonexistent-service"),
            "should reject unknown service ID, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_accepts_valid_requires_integrations() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-reqint-ok".to_string(),
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
            cpu_limit: None,
            requires_integrations: vec![consts::BUILT_IN_SERVICE_IDS[0].to_string()],
        };
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_ok());
    }

    #[test]
    fn test_validate_manifest_rejects_null_byte_in_auth_field_key() {
        let manifest = PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-null-auth".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![AuthFieldDef {
                key: "bad\0key".to_string(),
                label: "test".to_string(),
                field_type: "text".to_string(),
                placeholder: "".to_string(),
                is_secret: false,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("null bytes"),
            "should reject null byte in auth_field key, got: {err}"
        );
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

    #[test]
    fn test_remove_plugin_success() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("test-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"Test","slug":"test-plugin","version":"1.0.0","description":"test"}"#,
        )
        .unwrap();

        // Simulate remove_plugin logic: validate slug + remove dir
        validate_slug("test-plugin").unwrap();
        assert!(plugin_dir.exists());
        std::fs::remove_dir_all(&plugin_dir).unwrap();
        assert!(!plugin_dir.exists());
    }

    #[test]
    fn test_remove_plugin_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("nonexistent");
        // Plugin dir doesn't exist — remove should fail
        assert!(!plugin_dir.exists());
    }

    #[test]
    fn test_validate_manifest_rejects_readwrite_token_mount() {
        // ADR-009: token_mount: read_write is reserved for built-in services
        // (currently SharePoint only, for OAuth refresh). Plugins must use
        // read_only. This test covers BOTH the "non-empty justification" and
        // "empty justification" cases — both must be rejected, since a plugin
        // is never authorised to request read_write at all.
        for justification in ["   ", "I really need this"] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("Containerfile"), "FROM scratch").unwrap();
            let manifest = PluginManifest {
                name: "Test".to_string(),
                service_id: Some("test-rw".to_string()),
                slug: "test-rw".to_string(),
                version: "1.0.0".to_string(),
                description: "test".to_string(),
                port: None,
                image_tag: None,
                resources: vec![],
                token_mount: TokenMount::ReadWrite {
                    justification: justification.to_string(),
                },
                auth_fields: vec![],
                settings_schema: None,
                speedwave_compat: None,
                extra_env: None,
                mem_limit: None,
                cpu_limit: None,
                requires_integrations: vec![],
            };
            let err = validate_manifest(&manifest, dir.path())
                .expect_err("ReadWrite must be rejected for plugins");
            let msg = err.to_string();
            assert!(
                msg.contains("read_write") || msg.contains("ADR-009"),
                "expected ADR-009 / read_write rejection, got: {msg}"
            );
        }
    }

    #[test]
    fn test_validate_manifest_rejects_slug_hub() {
        // A plugin slug that derives a compose name colliding with a built-in
        // service must be rejected, otherwise serde_yaml_ng's mapping insert
        // would silently overwrite the built-in `mcp-hub` entry, defeating the
        // hub's zero-token guarantee.
        for bad_slug in ["hub", "claude"] {
            let dir = tempfile::tempdir().unwrap();
            let manifest = PluginManifest {
                name: "Test".to_string(),
                service_id: None,
                slug: bad_slug.to_string(),
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
                cpu_limit: None,
                requires_integrations: vec![],
            };
            let err = validate_manifest(&manifest, dir.path())
                .expect_err("slug colliding with built-in compose name must be rejected");
            let msg = err.to_string();
            assert!(
                msg.contains("conflicts with a built-in"),
                "expected built-in collision rejection for slug '{bad_slug}', got: {msg}"
            );
        }
    }

    #[test]
    fn test_validate_manifest_rejects_dangerous_extra_env_keys() {
        // SSOT: consts::RESERVED_ENV_KEYS lists every env var a plugin must
        // not be allowed to inject — PORT (Speedwave-reserved), dynamic-linker
        // hijacks (LD_PRELOAD, DYLD_INSERT_LIBRARIES, …), language-runtime
        // hijacks (NODE_OPTIONS, PYTHONPATH), and shell-environment hijacks
        // (PATH, HOME, IFS). Comparison is case-insensitive.
        for &dangerous in &[
            "LD_PRELOAD",
            "ld_preload",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "NODE_OPTIONS",
            "PYTHONPATH",
            "PATH",
            "HOME",
            "IFS",
            "BASH_ENV",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let mut env = HashMap::new();
            env.insert(dangerous.to_string(), "anything".to_string());
            let manifest = PluginManifest {
                name: "Test".to_string(),
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
                extra_env: Some(env),
                mem_limit: None,
                cpu_limit: None,
                requires_integrations: vec![],
            };
            let err = validate_manifest(&manifest, dir.path())
                .expect_err("dangerous env key must be rejected");
            let msg = err.to_string();
            assert!(
                msg.contains("reserved"),
                "expected reserved-key rejection for '{dangerous}', got: {msg}"
            );
        }
    }

    #[test]
    fn test_validate_manifest_rejects_mem_limit_exceeding_cap() {
        // 999g exceeds PLUGIN_MEM_LIMIT_MAX_MIB (8192 MiB = 8 GiB).
        let dir = tempfile::tempdir().unwrap();
        let manifest = PluginManifest {
            name: "Test".to_string(),
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
            mem_limit: Some("999g".to_string()),
            cpu_limit: None,
            requires_integrations: vec![],
        };
        let err = validate_manifest(&manifest, dir.path())
            .expect_err("mem_limit beyond cap must be rejected");
        assert!(
            err.to_string().contains("exceeds maximum"),
            "expected upper-bound rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_cpu_limit_exceeding_cap() {
        // 16 cores exceeds PLUGIN_CPU_LIMIT_MAX (4.0).
        let dir = tempfile::tempdir().unwrap();
        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: None,
            slug: "test-cpu".to_string(),
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
            cpu_limit: Some("16".to_string()),
            requires_integrations: vec![],
        };
        let err = validate_manifest(&manifest, dir.path())
            .expect_err("cpu_limit beyond cap must be rejected");
        assert!(
            err.to_string().contains("exceeds maximum"),
            "expected upper-bound rejection, got: {err}"
        );
    }

    #[test]
    fn test_parse_mem_limit_to_mib_units() {
        assert_eq!(parse_mem_limit_to_mib("1024m").unwrap(), 1024);
        assert_eq!(parse_mem_limit_to_mib("2g").unwrap(), 2048);
        assert_eq!(parse_mem_limit_to_mib("1G").unwrap(), 1024);
        assert_eq!(parse_mem_limit_to_mib("1024K").unwrap(), 1);
        // 512000 bare bytes → 0 MiB after integer division
        assert_eq!(parse_mem_limit_to_mib("512000").unwrap(), 0);
        assert!(parse_mem_limit_to_mib("").is_err());
        assert!(parse_mem_limit_to_mib("abc").is_err());
        assert!(parse_mem_limit_to_mib("1x").is_err());
    }

    // --- build_pending_from_dir error accumulation tests ---

    /// Minimal mock runtime for build_pending_from_dir tests.
    /// build_image always fails so we can verify runtime errors are accumulated too.
    struct FailingBuildRuntime;

    impl ContainerRuntime for FailingBuildRuntime {
        fn compose_up(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_down(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
            Ok(vec![])
        }
        fn container_exec(&self, _: &str, _: &[&str]) -> std::process::Command {
            std::process::Command::new("true")
        }
        fn container_exec_piped(
            &self,
            _: &str,
            _: &[&str],
        ) -> anyhow::Result<std::process::Command> {
            Ok(std::process::Command::new("true"))
        }
        fn is_available(&self) -> bool {
            true
        }
        fn ensure_ready(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn build_image(
            &self,
            _tag: &str,
            _context_dir: &str,
            _containerfile: &str,
            _build_args: &[(&str, &str)],
        ) -> anyhow::Result<()> {
            anyhow::bail!("mock build failure")
        }
        fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
            Ok(true)
        }
    }

    #[test]
    fn test_build_pending_accumulates_parse_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path();

        // Plugin with .image_pending and invalid JSON in plugin.json
        let bad_dir = plugins_dir.join("bad-json");
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join(".image_pending"), "").unwrap();
        std::fs::write(bad_dir.join("plugin.json"), "NOT VALID JSON").unwrap();

        // Another plugin with .image_pending and missing required fields
        let missing_fields_dir = plugins_dir.join("missing-fields");
        std::fs::create_dir_all(&missing_fields_dir).unwrap();
        std::fs::write(missing_fields_dir.join(".image_pending"), "").unwrap();
        std::fs::write(
            missing_fields_dir.join("plugin.json"),
            r#"{"only_one_field": true}"#,
        )
        .unwrap();

        let rt = FailingBuildRuntime;
        let result = build_pending_from_dir(&rt, None, plugins_dir);

        assert!(
            result.is_err(),
            "should return error when manifests fail to parse"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("Some plugin images failed to build"),
            "error should contain header: {err_msg}"
        );
        assert!(
            err_msg.contains("parse manifest"),
            "error should mention parse failure: {err_msg}"
        );
        // Both bad plugins should be mentioned
        assert!(
            err_msg.contains("bad-json") && err_msg.contains("missing-fields"),
            "error should mention both failing plugin dirs: {err_msg}"
        );
    }

    #[test]
    fn test_build_pending_accumulates_build_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path();

        // Valid manifest with .image_pending — will reach build_single_plugin_image
        // which calls runtime.prepare_build_context() then runtime.build_image().
        // FailingBuildRuntime.build_image() returns Err, so the error is accumulated.
        let valid_dir = plugins_dir.join("valid-plugin");
        std::fs::create_dir_all(&valid_dir).unwrap();
        std::fs::write(valid_dir.join(".image_pending"), "").unwrap();
        std::fs::write(
            valid_dir.join("plugin.json"),
            r#"{
                "name": "Valid",
                "slug": "valid-plugin",
                "service_id": "valid-plugin",
                "version": "1.0.0",
                "description": "test",
                "port": 4010
            }"#,
        )
        .unwrap();
        // Containerfile needed by build_single_plugin_image
        std::fs::write(valid_dir.join("Containerfile"), "FROM scratch").unwrap();

        let rt = FailingBuildRuntime;
        let result = build_pending_from_dir(&rt, None, plugins_dir);

        assert!(result.is_err(), "should return error when build fails");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("valid-plugin"),
            "error should reference the plugin slug: {err_msg}"
        );
        assert!(
            err_msg.contains("mock build failure"),
            "error should contain the underlying build error: {err_msg}"
        );
    }

    #[test]
    fn test_build_pending_mixed_parse_and_build_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path();

        // Plugin 1: bad manifest (parse error)
        let bad_dir = plugins_dir.join("broken-manifest");
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join(".image_pending"), "").unwrap();
        std::fs::write(bad_dir.join("plugin.json"), "{invalid").unwrap();

        // Plugin 2: valid manifest but build will fail
        let good_dir = plugins_dir.join("buildable");
        std::fs::create_dir_all(&good_dir).unwrap();
        std::fs::write(good_dir.join(".image_pending"), "").unwrap();
        std::fs::write(
            good_dir.join("plugin.json"),
            r#"{
                "name": "Buildable",
                "slug": "buildable",
                "service_id": "buildable",
                "version": "1.0.0",
                "description": "test",
                "port": 4020
            }"#,
        )
        .unwrap();
        std::fs::write(good_dir.join("Containerfile"), "FROM scratch").unwrap();

        let rt = FailingBuildRuntime;
        let result = build_pending_from_dir(&rt, None, plugins_dir);

        assert!(result.is_err(), "should accumulate both error types");
        let err_msg = result.unwrap_err().to_string();
        // Both errors should be accumulated, not just the first one
        assert!(
            err_msg.contains("parse manifest"),
            "should contain parse error: {err_msg}"
        );
        assert!(
            err_msg.contains("mock build failure"),
            "should contain build error: {err_msg}"
        );
    }

    #[test]
    fn test_build_pending_skips_dirs_without_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path();

        // Plugin dir exists but has no .image_pending marker — should be skipped
        let no_marker_dir = plugins_dir.join("no-marker");
        std::fs::create_dir_all(&no_marker_dir).unwrap();
        std::fs::write(no_marker_dir.join("plugin.json"), "INVALID").unwrap();

        let rt = FailingBuildRuntime;
        let result = build_pending_from_dir(&rt, None, plugins_dir);
        assert!(
            result.is_ok(),
            "plugins without .image_pending should be skipped, not cause errors"
        );
    }

    #[test]
    fn test_build_pending_nonexistent_dir_returns_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent = tmp.path().join("does-not-exist");

        let rt = FailingBuildRuntime;
        let result = build_pending_from_dir(&rt, None, &nonexistent);
        assert!(
            result.is_ok(),
            "nonexistent plugins dir should return Ok(())"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_token_files_secures_token_dirs() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        let original_mode = std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777;

        let token_dir = data_dir.join("tokens").join("proj").join("slack");
        let tokens = HashMap::from([("token.txt".to_string(), "secret".to_string())]);
        write_token_files(&token_dir, &tokens).unwrap();

        // All 3 levels should be 0o700
        assert_eq!(
            std::fs::metadata(&token_dir).unwrap().permissions().mode() & 0o777,
            0o700,
            "tokens/proj/slack should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(token_dir.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "tokens/proj should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(token_dir.parent().unwrap().parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "tokens should be 0o700"
        );

        // data_dir itself should NOT have been changed
        assert_eq!(
            std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777,
            original_mode,
            "data_dir should not have been changed"
        );

        // Token file should be 0o600
        assert_eq!(
            std::fs::metadata(token_dir.join("token.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "token file should be 0o600"
        );
    }

    // --- TrackingRuntime: mock for ensure_plugin_images / ensure_all_plugin_images tests ---

    use std::collections::HashSet;
    use std::sync::Mutex;

    /// Mock runtime that tracks image_exists and build_image calls with configurable responses.
    ///
    /// After a successful `build_image`, the tag is added to `existing_images` so subsequent
    /// `image_exists` checks behave like a real runtime (built images stay built). This lets
    /// tests assert exact build call counts instead of `>= 1`.
    struct TrackingRuntime {
        existing_images: Mutex<HashSet<String>>,
        build_calls: Mutex<Vec<String>>,
        build_should_fail: bool,
    }

    impl TrackingRuntime {
        fn new(existing: &[&str]) -> Self {
            Self {
                existing_images: Mutex::new(existing.iter().map(|s| s.to_string()).collect()),
                build_calls: Mutex::new(vec![]),
                build_should_fail: false,
            }
        }

        fn failing(existing: &[&str]) -> Self {
            Self {
                existing_images: Mutex::new(existing.iter().map(|s| s.to_string()).collect()),
                build_calls: Mutex::new(vec![]),
                build_should_fail: true,
            }
        }

        fn build_call_count(&self) -> usize {
            self.build_calls.lock().unwrap().len()
        }

        fn was_built(&self, tag: &str) -> bool {
            self.build_calls.lock().unwrap().contains(&tag.to_string())
        }
    }

    impl ContainerRuntime for TrackingRuntime {
        fn compose_up(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_down(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
            Ok(vec![])
        }
        fn container_exec(&self, _: &str, _: &[&str]) -> std::process::Command {
            std::process::Command::new("true")
        }
        fn container_exec_piped(
            &self,
            _: &str,
            _: &[&str],
        ) -> anyhow::Result<std::process::Command> {
            Ok(std::process::Command::new("true"))
        }
        fn is_available(&self) -> bool {
            true
        }
        fn ensure_ready(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn build_image(
            &self,
            tag: &str,
            _context_dir: &str,
            _containerfile: &str,
            _build_args: &[(&str, &str)],
        ) -> anyhow::Result<()> {
            self.build_calls.lock().unwrap().push(tag.to_string());
            if self.build_should_fail {
                anyhow::bail!("mock build failure")
            } else {
                self.existing_images.lock().unwrap().insert(tag.to_string());
                Ok(())
            }
        }
        fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn image_exists(&self, tag: &str) -> anyhow::Result<bool> {
            Ok(self.existing_images.lock().unwrap().contains(tag))
        }
    }

    fn make_mcp_plugin_dir(plugins_dir: &std::path::Path, slug: &str, version: &str) {
        let plugin_dir = plugins_dir.join(slug);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let manifest = format!(
            r#"{{
                "name": "{slug}",
                "slug": "{slug}",
                "service_id": "{slug}",
                "version": "{version}",
                "description": "test",
                "port": 4010
            }}"#
        );
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();
        std::fs::write(plugin_dir.join("Containerfile"), "FROM scratch").unwrap();
    }

    fn make_resource_only_plugin_dir(plugins_dir: &std::path::Path, slug: &str, version: &str) {
        let plugin_dir = plugins_dir.join(slug);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let manifest = format!(
            r#"{{
                "name": "{slug}",
                "slug": "{slug}",
                "version": "{version}",
                "description": "test"
            }}"#
        );
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();
    }

    // --- Happy path: project-scoped ensure_plugin_images ---

    #[test]
    fn test_ensure_plugin_images_rebuilds_missing_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "presale", "1.4.6");

        let rt = TrackingRuntime::new(&[]); // no existing images
        ensure_plugin_images_from_dir(&rt, &["presale"], tmp.path()).unwrap();

        assert_eq!(rt.build_call_count(), 1, "should build the missing image");
        assert!(rt.was_built("speedwave-mcp-presale:1.4.6"));
    }

    #[test]
    fn test_ensure_plugin_images_skips_existing() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "presale", "1.4.6");

        let rt = TrackingRuntime::new(&["speedwave-mcp-presale:1.4.6"]); // image exists
        ensure_plugin_images_from_dir(&rt, &["presale"], tmp.path()).unwrap();

        assert_eq!(
            rt.build_call_count(),
            0,
            "should not rebuild existing image"
        );
    }

    #[test]
    fn test_ensure_plugin_images_skips_disabled_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "presale", "1.4.6");

        let rt = TrackingRuntime::new(&[]); // no existing images
                                            // enabled_service_ids is empty — presale is disabled for this project
        ensure_plugin_images_from_dir(&rt, &[], tmp.path()).unwrap();

        assert_eq!(
            rt.build_call_count(),
            0,
            "disabled plugin should not be built"
        );
    }

    #[test]
    fn test_ensure_plugin_images_skips_resource_only_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        make_resource_only_plugin_dir(tmp.path(), "my-skills", "1.0.0");

        let rt = TrackingRuntime::new(&[]);
        // resource-only plugins have no service_id and no Containerfile
        ensure_plugin_images_from_dir(&rt, &["my-skills"], tmp.path()).unwrap();

        assert_eq!(
            rt.build_call_count(),
            0,
            "resource-only plugin has no image"
        );
    }

    #[test]
    fn test_ensure_plugin_images_handles_multiple_plugins_mixed_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0"); // enabled, missing image
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0"); // enabled, existing image
        make_mcp_plugin_dir(tmp.path(), "plugin-c", "1.0.0"); // disabled, missing image

        let rt = TrackingRuntime::new(&["speedwave-mcp-plugin-b:1.0.0"]); // B exists
        ensure_plugin_images_from_dir(&rt, &["plugin-a", "plugin-b"], tmp.path()).unwrap();

        assert_eq!(
            rt.build_call_count(),
            1,
            "only plugin-a should be built (plugin-b exists, plugin-c disabled)"
        );
        assert!(rt.was_built("speedwave-mcp-plugin-a:1.0.0"));
        assert!(!rt.was_built("speedwave-mcp-plugin-c:1.0.0"));
    }

    #[test]
    fn test_ensure_plugin_images_also_builds_pending_for_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "presale", "1.4.6");
        // Add .image_pending marker
        std::fs::write(tmp.path().join("presale").join(".image_pending"), "").unwrap();

        let rt = TrackingRuntime::new(&[]); // image missing
        ensure_plugin_images_from_dir(&rt, &["presale"], tmp.path()).unwrap();

        // Built exactly once: the pending pass builds it, then the second pass sees it via
        // image_exists() and skips. (TrackingRuntime.build_image now inserts into existing_images.)
        assert_eq!(
            rt.build_call_count(),
            1,
            "pending plugin image should be built exactly once"
        );
    }

    // --- Happy path: global ensure_all_plugin_images ---

    #[test]
    fn test_ensure_all_plugin_images_rebuilds_all_missing() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0");
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "2.0.0");

        let rt = TrackingRuntime::new(&[]); // no existing images
        ensure_all_plugin_images_from_dir(&rt, tmp.path()).unwrap();

        assert_eq!(
            rt.build_call_count(),
            2,
            "both missing images should be built"
        );
        assert!(rt.was_built("speedwave-mcp-plugin-a:1.0.0"));
        assert!(rt.was_built("speedwave-mcp-plugin-b:2.0.0"));
    }

    #[test]
    fn test_ensure_all_plugin_images_skips_existing() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "presale", "1.4.6");

        let rt = TrackingRuntime::new(&["speedwave-mcp-presale:1.4.6"]);
        ensure_all_plugin_images_from_dir(&rt, tmp.path()).unwrap();

        assert_eq!(
            rt.build_call_count(),
            0,
            "existing image should not be rebuilt"
        );
    }

    // --- Error path tests ---

    #[test]
    fn test_ensure_plugin_images_accumulates_build_errors() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0");
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0");

        let rt = TrackingRuntime::failing(&[]); // build always fails
        let err =
            ensure_plugin_images_from_dir(&rt, &["plugin-a", "plugin-b"], tmp.path()).unwrap_err();

        let msg = err.to_string();
        assert!(
            msg.contains("plugin-a") && msg.contains("plugin-b"),
            "error should mention both failing plugins: {msg}"
        );
        assert!(
            msg.contains("Some plugin images failed to rebuild"),
            "error should have header: {msg}"
        );
    }

    #[test]
    fn test_ensure_plugin_images_continues_after_single_failure() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0");
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0");

        let rt = TrackingRuntime::failing(&[]); // both fail
        let _ = ensure_plugin_images_from_dir(&rt, &["plugin-a", "plugin-b"], tmp.path());

        // Both should have been attempted despite first failure
        assert_eq!(rt.build_call_count(), 2, "both plugins should be attempted");
    }

    #[test]
    fn test_ensure_plugin_images_no_containerfile() {
        let tmp = tempfile::tempdir().unwrap();
        // Create a plugin with service_id but no Containerfile
        let plugin_dir = tmp.path().join("my-mcp");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "my-mcp",
                "slug": "my-mcp",
                "service_id": "my-mcp",
                "version": "1.0.0",
                "description": "test",
                "port": 4010
            }"#,
        )
        .unwrap();
        // No Containerfile created

        let rt = TrackingRuntime::new(&[]);
        // Should warn and skip, not error
        ensure_plugin_images_from_dir(&rt, &["my-mcp"], tmp.path()).unwrap();
        assert_eq!(rt.build_call_count(), 0, "no Containerfile means skip");
    }

    #[test]
    fn test_ensure_plugin_images_image_exists_returns_err() {
        // image_exists returning Err should be treated as missing — attempt build
        // We use FailingBuildRuntime for this because TrackingRuntime always succeeds
        // for image_exists. Create a custom mock inline.

        struct ExistsErrorRuntime;
        impl ContainerRuntime for ExistsErrorRuntime {
            fn compose_up(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn compose_down(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
                Ok(vec![])
            }
            fn container_exec(&self, _: &str, _: &[&str]) -> std::process::Command {
                std::process::Command::new("true")
            }
            fn container_exec_piped(
                &self,
                _: &str,
                _: &[&str],
            ) -> anyhow::Result<std::process::Command> {
                Ok(std::process::Command::new("true"))
            }
            fn is_available(&self) -> bool {
                true
            }
            fn ensure_ready(&self) -> anyhow::Result<()> {
                Ok(())
            }
            fn build_image(
                &self,
                _tag: &str,
                _context_dir: &str,
                _containerfile: &str,
                _build_args: &[(&str, &str)],
            ) -> anyhow::Result<()> {
                Ok(()) // build succeeds
            }
            fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
                Ok(String::new())
            }
            fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
                Ok(String::new())
            }
            fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
                anyhow::bail!("runtime unavailable")
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "presale", "1.0.0");

        let rt = ExistsErrorRuntime;
        // image_exists returns Err → treated as missing → build attempted → succeeds
        ensure_plugin_images_from_dir(&rt, &["presale"], tmp.path()).unwrap();
    }

    #[test]
    fn test_ensure_all_plugin_images_accumulates_build_errors() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0");
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0");

        let rt = TrackingRuntime::failing(&[]);
        let err = ensure_all_plugin_images_from_dir(&rt, tmp.path()).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("Some plugin images failed to rebuild"),
            "error should have header: {msg}"
        );
    }

    // --- Edge cases ---

    #[test]
    fn test_ensure_plugin_images_empty_plugins_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path().join("plugins");
        std::fs::create_dir_all(&plugins_dir).unwrap();

        let rt = TrackingRuntime::new(&[]);
        ensure_plugin_images_from_dir(&rt, &["presale"], &plugins_dir).unwrap();
        assert_eq!(rt.build_call_count(), 0);
    }

    #[test]
    fn test_ensure_plugin_images_nonexistent_plugins_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent = tmp.path().join("does-not-exist");

        let rt = TrackingRuntime::new(&[]);
        ensure_plugin_images_from_dir(&rt, &["presale"], &nonexistent).unwrap();
        assert_eq!(rt.build_call_count(), 0);
    }

    #[test]
    fn test_ensure_plugin_images_invalid_manifest_json() {
        let tmp = tempfile::tempdir().unwrap();
        // Plugin dir with invalid plugin.json and no .image_pending
        let plugin_dir = tmp.path().join("bad-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("plugin.json"), "NOT VALID JSON").unwrap();

        let rt = TrackingRuntime::new(&[]);
        // list_installed_from_dir skips invalid manifests with a warning
        ensure_plugin_images_from_dir(&rt, &["bad-plugin"], tmp.path()).unwrap();
        assert_eq!(rt.build_call_count(), 0, "invalid manifest is skipped");
    }

    #[test]
    fn test_ensure_plugin_images_custom_image_tag() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("presale");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "presale",
                "slug": "presale",
                "service_id": "presale",
                "version": "1.0.0",
                "image_tag": "custom-tag",
                "description": "test",
                "port": 4010
            }"#,
        )
        .unwrap();
        std::fs::write(plugin_dir.join("Containerfile"), "FROM scratch").unwrap();

        let rt = TrackingRuntime::new(&[]);
        ensure_plugin_images_from_dir(&rt, &["presale"], tmp.path()).unwrap();

        assert_eq!(rt.build_call_count(), 1);
        assert!(
            rt.was_built("speedwave-mcp-presale:custom-tag"),
            "should use custom image_tag, got calls: {:?}",
            rt.build_calls.lock().unwrap()
        );
    }

    // --- Boundary / state tests ---

    #[test]
    fn test_ensure_plugin_images_pending_marker_cleared_after_build() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "presale", "1.0.0");
        let pending = tmp.path().join("presale").join(".image_pending");
        std::fs::write(&pending, "").unwrap();
        assert!(pending.exists(), "marker should exist before build");

        let rt = TrackingRuntime::new(&[]); // image missing
        ensure_plugin_images_from_dir(&rt, &["presale"], tmp.path()).unwrap();

        assert!(
            !pending.exists(),
            "pending marker should be removed after successful build"
        );
    }

    #[test]
    fn test_ensure_plugin_images_image_exists_after_rebuild() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "presale", "1.0.0");

        // First call: image missing → builds it
        let rt = TrackingRuntime::new(&[]);
        ensure_plugin_images_from_dir(&rt, &["presale"], tmp.path()).unwrap();
        assert_eq!(rt.build_call_count(), 1, "first call should build");

        // Second call: image now exists (simulate by creating a runtime that knows about it)
        let rt2 = TrackingRuntime::new(&["speedwave-mcp-presale:1.0.0"]);
        ensure_plugin_images_from_dir(&rt2, &["presale"], tmp.path()).unwrap();
        assert_eq!(rt2.build_call_count(), 0, "second call should skip build");
    }

    // --- Critical interaction test: reconcile → restore_projects ---

    #[test]
    fn test_broken_plugin_does_not_block_unrelated_project_restore() {
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0"); // will always fail to build
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0"); // will build successfully

        // Phase 1: reconcile tries to rebuild all plugins — plugin-a fails
        let rt_failing_a = TrackingRuntime::failing(&[]);
        let all_result = ensure_all_plugin_images_from_dir(&rt_failing_a, tmp.path());
        assert!(
            all_result.is_err(),
            "ensure_all should return error when plugin-a fails"
        );

        // Phase 2a: project using only plugin-b — should succeed
        // Simulate: plugin-b image was built successfully in another scenario
        let rt_b_exists = TrackingRuntime::new(&["speedwave-mcp-plugin-b:1.0.0"]);
        let project_b_result =
            ensure_plugin_images_from_dir(&rt_b_exists, &["plugin-b"], tmp.path());
        assert!(
            project_b_result.is_ok(),
            "project using only plugin-b should succeed: {:?}",
            project_b_result
        );

        // Phase 2b: project using only plugin-a — should fail
        let rt_a_missing = TrackingRuntime::failing(&[]);
        let project_a_result =
            ensure_plugin_images_from_dir(&rt_a_missing, &["plugin-a"], tmp.path());
        assert!(
            project_a_result.is_err(),
            "project using plugin-a should fail when plugin-a cannot be rebuilt"
        );
    }

    // --- validate_speedwave_compat unit tests ---

    fn minimal_resource_only_manifest(compat: Option<String>) -> PluginManifest {
        PluginManifest {
            name: "Test Plugin".to_string(),
            service_id: None,
            slug: "test-plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: compat,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
        }
    }

    #[test]
    fn test_compat_none_is_ok() {
        assert!(validate_speedwave_compat(None).is_ok());
    }

    #[test]
    fn test_compat_exact_current_version_matches() {
        let range = format!("={}", env!("CARGO_PKG_VERSION"));
        assert!(validate_speedwave_compat(Some(&range)).is_ok());
    }

    #[test]
    fn test_compat_lower_bound_current_version_matches() {
        let range = format!(">={}", env!("CARGO_PKG_VERSION"));
        assert!(validate_speedwave_compat(Some(&range)).is_ok());
    }

    #[test]
    fn test_compat_current_major_minor_range_matches() {
        let v = semver::Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
        let next_major = v.major + 1;
        let range = format!(">={}.{}, <{}", v.major, v.minor, next_major);
        assert!(validate_speedwave_compat(Some(&range)).is_ok());
    }

    #[test]
    fn test_compat_legacy_wide_range_matches() {
        assert!(validate_speedwave_compat(Some(">=0.1.0")).is_ok());
    }

    #[test]
    fn test_compat_empty_string_rejected() {
        let result = validate_speedwave_compat(Some(""));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("speedwave_compat"));
    }

    #[test]
    fn test_compat_whitespace_only_rejected() {
        let result = validate_speedwave_compat(Some("   "));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("speedwave_compat"));
    }

    #[test]
    fn test_compat_garbage_rejected() {
        let result = validate_speedwave_compat(Some("banana"));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("banana"));
    }

    #[test]
    fn test_compat_unsatisfied_range_rejected() {
        let result = validate_speedwave_compat(Some(">=99.0.0"));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains(">=99.0.0"));
        assert!(msg.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn test_compat_unsatisfied_upper_bound_rejected() {
        let result = validate_speedwave_compat(Some("<0.1"));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("<0.1"));
        assert!(msg.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn test_compat_error_message_contains_upgrade_guidance() {
        let result = validate_speedwave_compat(Some(">=99.0.0"));
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Upgrade Speedwave"));
    }

    // --- validate_manifest integration tests for speedwave_compat ---

    #[test]
    fn test_validate_manifest_rejects_invalid_compat() {
        let manifest = minimal_resource_only_manifest(Some("banana".to_string()));
        let tmp = tempfile::tempdir().unwrap();
        let result = validate_manifest(&manifest, tmp.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("banana"));
    }

    #[test]
    fn test_validate_manifest_rejects_unsatisfied_compat() {
        let manifest = minimal_resource_only_manifest(Some(">=99.0.0".to_string()));
        let tmp = tempfile::tempdir().unwrap();
        let result = validate_manifest(&manifest, tmp.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains(">=99.0.0"));
    }

    #[test]
    fn test_validate_manifest_rejects_empty_compat() {
        let manifest = minimal_resource_only_manifest(Some(String::new()));
        let tmp = tempfile::tempdir().unwrap();
        let result = validate_manifest(&manifest, tmp.path());
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_manifest_accepts_compatible_compat() {
        let range = format!(">={}", env!("CARGO_PKG_VERSION"));
        let manifest = minimal_resource_only_manifest(Some(range));
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_ok());
    }

    #[test]
    fn test_validate_manifest_accepts_missing_compat() {
        let manifest = minimal_resource_only_manifest(None);
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&manifest, tmp.path()).is_ok());
    }
}

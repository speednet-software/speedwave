use crate::compose::container_user;
use crate::consts;
use crate::signing;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Slug validation: lowercase letters, digits, hyphens. Starts with letter. Max 64 chars.
const SLUG_PATTERN: &str = r"^[a-z][a-z0-9-]{0,63}$";

/// Public predicate version of [`validate_slug`]. Used by callers that
/// want a `bool` rather than `Result<()>` (e.g. defense-in-depth checks
/// in worker spec hooks).
pub fn is_valid_slug(slug: &str) -> bool {
    validate_slug(slug).is_ok()
}

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
    /// Whether the user must provide a value before the plugin can run.
    /// Defaults to `true` so manifests that omit the field keep the
    /// pre-existing strict behavior (auto-enable blocked on any secret).
    #[serde(default = "default_required")]
    pub required: bool,
    /// Optional human-readable help text shown under the field label in the
    /// Desktop credentials form. Omitted manifests deserialize to `None`;
    /// an explicit empty string is preserved (not coerced to `None`) so a
    /// plugin author can intentionally render nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional format constraint enforced on the entered value, both in the
    /// Desktop form (HTML `pattern` attribute) and at save time on the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<AuthFieldValidation>,
}

/// Allowed `auth_fields[].field_type` values. Public plugin contract — mirrored
/// by the TS `PluginAuthFieldType` union in
/// `desktop/src/src/app/models/plugin.ts`; the test
/// `allowed_auth_field_types_match_ts_union` enforces they stay identical.
pub(crate) const ALLOWED_AUTH_FIELD_TYPES: &[&str] = &["text", "password", "textarea"];

/// A regex format constraint for an [`AuthFieldDef`] value (manifest schema —
/// public plugin contract). Variant A of the auth-field validation design:
/// a single anchored pattern plus an optional human-readable message.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AuthFieldValidation {
    /// Raw regex string from the manifest. Always funnelled through
    /// [`compile_anchored_pattern`] — see that fn for cap+compile invariants.
    pub pattern: String,
    /// Optional message shown when the value fails the pattern. When absent,
    /// the UI falls back to a generic "invalid format" string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Single gate for `auth_fields[].validation.pattern`: rejects empty and
/// oversized patterns, then compiles in anchored full-match form
/// (`^(?:pattern)$`). Used by `validate_manifest` (install) and
/// `validate_credential_value` (save) so the cap/compile rules live in one
/// place. Error strings are phrased to read after `auth_field '<key>' `.
///
/// Anchoring mirrors the Desktop form's `validationErrorFor` (JS) — those
/// two wrappers must stay in sync. The pattern must compile under the Rust
/// `regex` crate's RE2 subset (no backreferences / look-around); details and
/// the JS-vs-RE2 flavour difference are documented in ADR-015.
pub fn compile_anchored_pattern(pattern: &str) -> Result<regex::Regex, String> {
    if pattern.is_empty() {
        return Err("has an empty validation.pattern (omit `validation` instead)".to_string());
    }
    if pattern.len() > consts::PLUGIN_AUTH_FIELD_PATTERN_MAX_LEN {
        return Err(format!(
            "has a validation.pattern that exceeds {} bytes",
            consts::PLUGIN_AUTH_FIELD_PATTERN_MAX_LEN
        ));
    }
    regex::Regex::new(&format!("^(?:{pattern})$"))
        .map_err(|e| format!("has an invalid validation.pattern: {e}"))
}

/// Validates a credential value against the field's optional regex
/// constraint. Returns `Ok` when no constraint, when the value is empty
/// (= "leave stored value untouched"; `required` enforces emptiness), or on
/// match. On mismatch returns the author's `message` or a generic fallback.
pub fn validate_credential_value(field: &AuthFieldDef, value: &str) -> Result<(), String> {
    let Some(validation) = &field.validation else {
        return Ok(());
    };
    if value.is_empty() {
        return Ok(());
    }
    let re = compile_anchored_pattern(&validation.pattern)
        .map_err(|e| format!("auth_field '{}' {e}", field.key))?;
    if re.is_match(value) {
        Ok(())
    } else {
        Err(validation.message.clone().unwrap_or_else(|| {
            format!(
                "value for '{}' does not match the required format",
                field.label
            )
        }))
    }
}

fn default_required() -> bool {
    true
}

/// SSOT predicate: does this field block the plugin from running until the
/// user provides a value? Used by auto-enable, configured-status, and
/// token-status checks so the three answers cannot diverge.
pub fn blocks_plugin_readiness(field: &AuthFieldDef) -> bool {
    field.is_secret && field.required
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
    /// Optional long-form Markdown shown on the plugin's Dashboard tab in
    /// Desktop — setup/usage guidance (how to obtain a token, post-install
    /// steps, etc.) that doesn't fit the one-line `description` (which also
    /// serves as the plugin-list tagline). Omitted manifests deserialize to
    /// `None`. Length-capped at [`consts::PLUGIN_INSTRUCTIONS_MAX_BYTES`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Ignored by the compose emitter — all workers listen on
    /// [`consts::PORT_WORKER`] (ADR-038). Field kept `Option<u16>` so already-signed
    /// plugin manifests still deserialize; a non-zero value emits a warning at
    /// compose render time. `#[serde(skip_serializing)]` so new manifests don't
    /// include it.
    #[serde(default, skip_serializing)]
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
    /// Host-side WebSocket bridge declaration. Optional — only plugins
    /// that need to pair their container worker with a desktop-side
    /// application set this. Speedwave Desktop spawns one `HostBridge`
    /// per declaration; container workers receive the bridge URL and
    /// token via env vars named here. See ADR-063.
    #[serde(default)]
    pub host_bridge: Option<HostBridgeManifest>,
}

/// Host-bridge declaration in `plugin.json`. Speedwave Desktop reads
/// this at startup and spawns a `HostBridge` configured per these
/// fields; `compose::apply_plugins` injects `{url_env}` and `{token_env}`
/// into the worker's environment.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HostBridgeManifest {
    /// Env var name for the bridge URL injected into the container worker.
    pub url_env: String,
    /// Env var name for the auth token injected into the container worker.
    pub token_env: String,
    /// One entry per role: header- or query-param-authenticated client.
    /// Pairing mode requires at least two distinct roles.
    pub roles: HashMap<String, HostBridgeRoleAuth>,
    /// CSRF / Origin policy. Defaults to `reject_if_present`.
    #[serde(default)]
    pub origin_policy: HostBridgeOriginPolicy,
    /// Per-frame size cap in bytes. `None` = no cap.
    #[serde(default)]
    pub max_frame_bytes: Option<usize>,
    /// What to do on same-role collision. Defaults to `evict_older`.
    #[serde(default)]
    pub collision_policy: HostBridgeCollisionPolicy,
    /// Pending slot timeout in seconds. `None` = no timeout.
    #[serde(default)]
    pub pending_slot_timeout_secs: Option<u64>,
    /// Display name written into the lock file's `ideName` field.
    pub display_name: String,
    /// Preferred loopback port. Hard-fails if busy. `None` → kernel picks.
    #[serde(default)]
    pub preferred_port: Option<u16>,
    /// Persist token in `plugin-state/<slug>/bridge-token` (chmod 0600).
    #[serde(default)]
    pub persistent_token: bool,
}

/// Per-role auth scheme declaration.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "scheme", rename_all = "snake_case")]
pub enum HostBridgeRoleAuth {
    /// HTTP header — clients that can set arbitrary headers on upgrade.
    Header { name: String },
    /// `?<name>=<token>` — required for browser-based clients.
    QueryParam { name: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "snake_case")]
pub enum HostBridgeOriginPolicy {
    #[default]
    RejectIfPresent,
    AcceptIfAuthIsQueryParam,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostBridgeCollisionPolicy {
    Reject,
    #[default]
    EvictOlder,
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

/// Public SSOT for a plugin's mutable state directory.
pub fn plugin_state_dir(slug: &str) -> PathBuf {
    match plugins_base_dir() {
        Ok(p) => plugin_state_dir_for(&p, slug),
        Err(e) => {
            log::warn!(
                "plugin_state_dir[{slug}]: plugins_base_dir failed ({e}); using data_dir fallback"
            );
            consts::data_dir().join("plugin-state").join(slug)
        }
    }
}

fn image_pending_marker_for(plugins_dir: &Path, slug: &str) -> PathBuf {
    plugin_state_dir_for(plugins_dir, slug).join("image_pending")
}

/// Returns true if the plugin has a pending image build, looking in both
/// the new state directory and the legacy in-tree location. Legacy-only
/// markers are still observed so plugins installed before this change
/// keep building on next launch. The first fail-closed load
/// (`audit_all` / `list_verified_*`, both via `verify_one_plugin_dir`)
/// migrates the in-tree marker into `plugin-state/` via
/// `migrate_legacy_image_pending`, after which only the new location ever
/// has the marker. The tolerant `list_for_ui` path does *not* migrate —
/// it must not mutate a tampered tree.
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

/// Moves a legacy marker into the plugin-state dir. Returns `true` only
/// on a clean relocation. Tries the cheap same-FS `rename` first (which
/// only re-points the dirent — safe even for a hardlink). On cross-FS
/// (`rename` fails, e.g. `~/.speedwave/` on a separate volume): Unix
/// falls back to `write(target) + unlink(legacy)` (hardlinks were ruled
/// out by the `nlink` check before this is reached); Windows refuses the
/// fallback entirely because `std::fs::Metadata` exposes no link count,
/// so an NTFS hardlink can't be excluded. Whenever this returns `false`
/// the legacy file is still in the tree and audit fails on the next load.
fn relocate_legacy_marker(slug: &str, legacy: &Path, target: &Path) -> bool {
    if std::fs::rename(legacy, target).is_ok() {
        return true;
    }
    #[cfg(windows)]
    {
        log::warn!(
            "plugin '{slug}': cannot move .image_pending across filesystems on Windows \
             (link count unknown); leaving legacy marker — audit will refuse this plugin"
        );
        false
    }
    #[cfg(not(windows))]
    {
        if let Err(e) = std::fs::write(target, b"") {
            log::warn!(
                "plugin '{slug}': failed to write replacement marker {}: {e}",
                target.display()
            );
            return false;
        }
        if let Err(e) = std::fs::remove_file(legacy) {
            log::warn!(
                "plugin '{slug}': wrote replacement marker but failed to remove legacy {}: {e}; \
                 audit will refuse this plugin on next load",
                legacy.display()
            );
            return false;
        }
        true
    }
}

/// Migrates the legacy in-tree `.image_pending` marker out of the
/// signed plugin tree before the digest is computed. Without this, every
/// MCP plugin installed under an older Speedwave release fails signature
/// verification on first launch under a runtime-invariant build — the
/// in-tree marker was never part of the signed tree, so its presence
/// changes the digest. Idempotent; missing marker is a no-op.
///
/// Only a *root-level, regular-file* `.image_pending` is migrated — a
/// symlink (or a hardlink, on Unix where we can detect it) is left in
/// place so the verifier fails loudly rather than us silently relocating
/// attacker-planted content. Whenever the marker cannot be fully moved
/// the legacy file stays put and audit fails on the next load; we only
/// log "migrated" on a clean move.
///
/// Run BEFORE every load-side signature check that observes a tree the
/// user might be upgrading from — `audit_all`, `list_verified_*`.
fn migrate_legacy_image_pending(plugins_dir: &Path, plugin_dir: &Path, slug: &str) {
    let legacy = plugin_dir.join(".image_pending");
    let Ok(meta) = std::fs::symlink_metadata(&legacy) else {
        return;
    };
    if !meta.file_type().is_file() {
        log::warn!(
            "plugin '{}': legacy .image_pending is not a regular file ({:?}); leaving untouched",
            slug,
            meta.file_type()
        );
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            log::warn!(
                "plugin '{}': legacy .image_pending has nlink={} (hardlink); leaving untouched",
                slug,
                meta.nlink()
            );
            return;
        }
    }
    let target_dir = plugin_state_dir_for(plugins_dir, slug);
    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        log::warn!(
            "plugin '{}': failed to create plugin-state dir {}: {e}",
            slug,
            target_dir.display()
        );
        return;
    }
    let target = target_dir.join("image_pending");
    if relocate_legacy_marker(slug, &legacy, &target) {
        log::info!(
            "plugin '{}': migrated legacy .image_pending to {}",
            slug,
            target.display()
        );
    }
}

/// Returns `~/.speedwave/tokens/<project>/<service_id>/`
pub fn token_dir(project: &str, service_id: &str) -> anyhow::Result<PathBuf> {
    Ok(consts::data_dir()
        .join("tokens")
        .join(project)
        .join(service_id))
}

/// Returns `~/.speedwave/oauth/<project>/<service_id>.json` — the host-only OAuth
/// state file containing `refreshToken`, `clientId`, `tenantId`, scopes,
/// `expiresAt`, `lastRefreshAt`, `grantedScopes` (ADR-060). This file is read
/// and written only by the host (Tauri `oauth_cmd` for setup; the `oauth` worker
/// for refresh). It is NOT mounted into any worker container.
pub fn oauth_state_file(project: &str, service_id: &str) -> PathBuf {
    oauth_state_file_in(consts::data_dir(), project, service_id)
}

/// Parameterised by `data_dir` so that one-shot migration code can avoid the
/// `consts::data_dir()` `OnceLock` cache shared across the `cargo test` binary.
/// Production callers go through `oauth_state_file` and inherit the SSOT path.
pub fn oauth_state_file_in(data_dir: &Path, project: &str, service_id: &str) -> PathBuf {
    data_dir
        .join(consts::OAUTH_SUBDIR)
        .join(project)
        .join(format!("{service_id}.json"))
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
        .filter(|f| blocks_plugin_readiness(f))
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

/// Derives WORKER_{SID}_URL from a service_id. E.g. "example-plugin" → "WORKER_EXAMPLE_PLUGIN_URL"
pub fn derive_worker_env(service_id: &str) -> String {
    format!("WORKER_{}_URL", service_id.to_uppercase().replace('-', "_"))
}

/// Derives compose service name from service_id. E.g. "example-plugin" → "mcp-example-plugin"
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
pub(crate) fn validate_manifest(
    manifest: &PluginManifest,
    plugin_dir: &Path,
) -> anyhow::Result<()> {
    validate_slug(&manifest.slug)?;
    validate_speedwave_compat(manifest.speedwave_compat.as_deref())?;

    // Bound the optional long-form instructions text (rendered on the
    // Dashboard). Caps in-memory `PluginStatusEntry` size and what a
    // manifest can wedge into the webview.
    if let Some(instructions) = &manifest.instructions {
        if instructions.len() > consts::PLUGIN_INSTRUCTIONS_MAX_BYTES {
            anyhow::bail!(
                "manifest `instructions` exceeds {} bytes",
                consts::PLUGIN_INSTRUCTIONS_MAX_BYTES
            );
        }
    }

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

    // Slug must not collide with built-in compose service names. Two
    // ways a slug can clash: (a) its derived name `mcp-<slug>` is a
    // built-in (e.g. slug "hub" → "mcp-hub"); (b) the bare slug itself
    // is a built-in compose name (e.g. "claude" — built-ins like the
    // claude container use the bare name, not "mcp-claude"). Either
    // way a serde_yaml_ng mapping insert would silently overwrite the
    // built-in entry — defeating, e.g., the hub's zero-token guarantee.
    let derived_compose = derive_compose_name(&manifest.slug);
    if consts::BUILT_IN_SERVICES.contains(&derived_compose.as_str()) {
        anyhow::bail!(
            "Plugin slug '{}' derives compose name '{}' which is reserved by a built-in service",
            manifest.slug,
            derived_compose
        );
    }
    if consts::BUILT_IN_SERVICES.contains(&manifest.slug.as_str()) {
        anyhow::bail!(
            "Plugin slug '{}' is itself a built-in compose service name",
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
        if !ALLOWED_AUTH_FIELD_TYPES.contains(&field.field_type.as_str()) {
            anyhow::bail!(
                "auth_field '{}' has unknown field_type '{}'. Allowed: {:?}",
                field.key,
                field.field_type,
                ALLOWED_AUTH_FIELD_TYPES
            );
        }
        // Reject broken/oversized regex constraints at install time via the
        // single `compile_anchored_pattern` gate.
        if let Some(validation) = &field.validation {
            compile_anchored_pattern(&validation.pattern)
                .map_err(|e| anyhow::anyhow!("auth_field '{}' {e}", field.key))?;
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
            if consts::RESERVED_ENV_KEYS
                .iter()
                .any(|reserved| reserved.eq_ignore_ascii_case(k))
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

    // `settings_schema` shape gate. Full Draft-7 validation lives in
    // `desktop/src-tauri/src/plugin_cmd.rs::plugin_save_settings`
    // (which has the `jsonschema` crate); we keep runtime free of that
    // dep. But a manifest reaches install with this field already
    // pre-rendered, and a malformed schema (not a JSON object, or a
    // multi-megabyte blob) would silently break the settings UI for
    // that plugin once installed. Reject the obviously-bad shapes at
    // install time so the user sees the failure as a manifest error,
    // not as "settings won't save".
    if let Some(ref schema) = manifest.settings_schema {
        if !schema.is_object() {
            anyhow::bail!(
                "settings_schema must be a JSON object (got {})",
                match schema {
                    serde_json::Value::Null => "null",
                    serde_json::Value::Bool(_) => "boolean",
                    serde_json::Value::Number(_) => "number",
                    serde_json::Value::String(_) => "string",
                    serde_json::Value::Array(_) => "array",
                    serde_json::Value::Object(_) => unreachable!(),
                }
            );
        }
        // Cap the schema size — a 1 MiB schema is either a mistake or
        // a deliberate DoS payload (regex catastrophic-backtrack
        // schemas are typically small, but we don't want a manifest to
        // be able to bloat user_config.json indirectly either).
        let serialised = serde_json::to_vec(schema)
            .map_err(|e| anyhow::anyhow!("settings_schema serialises to invalid JSON: {e}"))?;
        if serialised.len() > consts::PLUGIN_SETTINGS_MAX_BYTES {
            anyhow::bail!(
                "settings_schema exceeds {} bytes ({} bytes)",
                consts::PLUGIN_SETTINGS_MAX_BYTES,
                serialised.len()
            );
        }
    }

    if let Some(ref bridge) = manifest.host_bridge {
        validate_host_bridge_manifest(bridge)?;
    }

    Ok(())
}

/// Manifest-time checks for the optional `host_bridge` block. Mirrors
/// the four edge categories required by `.claude/rules/plugins.md`:
/// missing (`Option<...>`), empty (zero roles, blank display_name),
/// malformed (control chars / `=` in env names), and reserved
/// (RESERVED_ENV_KEYS collision).
fn validate_host_bridge_manifest(bridge: &HostBridgeManifest) -> anyhow::Result<()> {
    if bridge.roles.is_empty() {
        anyhow::bail!("host_bridge.roles must declare at least one role");
    }
    if bridge.roles.len() > consts::PLUGIN_BRIDGE_ROLES_MAX_COUNT {
        anyhow::bail!(
            "host_bridge.roles must not exceed {} entries (got {})",
            consts::PLUGIN_BRIDGE_ROLES_MAX_COUNT,
            bridge.roles.len()
        );
    }
    if bridge.display_name.trim().is_empty() {
        anyhow::bail!("host_bridge.display_name must not be empty");
    }
    if bridge.display_name.len() > consts::PLUGIN_BRIDGE_DISPLAY_NAME_MAX_LEN {
        anyhow::bail!(
            "host_bridge.display_name must not exceed {} bytes (got {})",
            consts::PLUGIN_BRIDGE_DISPLAY_NAME_MAX_LEN,
            bridge.display_name.len()
        );
    }
    validate_bridge_env_name("url_env", &bridge.url_env)?;
    validate_bridge_env_name("token_env", &bridge.token_env)?;
    if bridge.url_env == bridge.token_env {
        anyhow::bail!(
            "host_bridge.url_env and host_bridge.token_env must differ ('{}' on both)",
            bridge.url_env
        );
    }
    for (role, auth) in &bridge.roles {
        if role.is_empty() {
            anyhow::bail!("host_bridge.roles contains an empty role name");
        }
        if role.len() > consts::PLUGIN_BRIDGE_ROLE_NAME_MAX_LEN {
            anyhow::bail!(
                "host_bridge.roles role name must not exceed {} bytes (got {})",
                consts::PLUGIN_BRIDGE_ROLE_NAME_MAX_LEN,
                role.len()
            );
        }
        if role.chars().any(|c| c.is_control()) {
            anyhow::bail!("host_bridge.roles role name '{role}' contains a control character");
        }
        let header_name = match auth {
            HostBridgeRoleAuth::Header { name } | HostBridgeRoleAuth::QueryParam { name } => name,
        };
        if header_name.is_empty() {
            anyhow::bail!("host_bridge.roles['{role}']: auth scheme name must not be empty");
        }
        if header_name.len() > consts::PLUGIN_BRIDGE_AUTH_NAME_MAX_LEN {
            anyhow::bail!(
                "host_bridge.roles['{role}']: auth scheme name must not exceed {} bytes (got {})",
                consts::PLUGIN_BRIDGE_AUTH_NAME_MAX_LEN,
                header_name.len()
            );
        }
        if header_name.chars().any(|c| c.is_control()) {
            anyhow::bail!(
                "host_bridge.roles['{role}']: auth scheme name '{header_name}' contains a control character"
            );
        }
    }
    if let Some(port) = bridge.preferred_port {
        if port <= 1023 {
            anyhow::bail!("host_bridge.preferred_port must be > 1023, got {port}");
        }
    }
    if bridge.persistent_token && bridge.preferred_port.is_none() {
        log::warn!(
            "host_bridge: persistent_token=true without preferred_port — companion app's saved URL becomes stale on every Speedwave restart"
        );
    }
    Ok(())
}

fn validate_bridge_env_name(field: &str, name: &str) -> anyhow::Result<()> {
    if name.is_empty() {
        anyhow::bail!("host_bridge.{field} must not be empty");
    }
    if name.len() > consts::PLUGIN_BRIDGE_ENV_NAME_MAX_LEN {
        anyhow::bail!(
            "host_bridge.{field} must not exceed {} bytes (got {})",
            consts::PLUGIN_BRIDGE_ENV_NAME_MAX_LEN,
            name.len()
        );
    }
    if consts::RESERVED_ENV_KEYS
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(name))
    {
        anyhow::bail!(
            "host_bridge.{field} '{name}' is reserved (auto-injected by Speedwave or a dangerous runtime hijack vector)"
        );
    }
    if name.contains('=') {
        anyhow::bail!("host_bridge.{field} must not contain '=' (got: '{name}')");
    }
    if name
        .chars()
        .any(|c| c == '\n' || c == '\r' || c == '\0' || c.is_control())
    {
        anyhow::bail!(
            "host_bridge.{field} '{name}' contains control characters (newline / null / etc.)"
        );
    }
    Ok(())
}

/// Parses a Docker-style memory limit string into MiB.
///
/// Accepts: bare bytes (`"512000"`), or `<number><unit>` where unit is one of
/// `b/k/m/g` (case-insensitive). Returns an error on malformed input,
/// negative or zero values, or arithmetic overflow.
pub(crate) fn parse_mem_limit_to_mib(s: &str) -> anyhow::Result<u64> {
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
    // Docker treats `mem_limit: 0` (and `0m`, `0g`, …) as "no limit",
    // which would let a plugin bypass PLUGIN_MEM_LIMIT_MAX_MIB. Bare
    // sub-MiB values like `512000` are fine — they round to 0 MiB but
    // still cap the container; only an explicit zero is the escape.
    if n == 0 {
        anyhow::bail!("mem_limit must be greater than zero (got '{}')", s);
    }
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
///   retried on the next launch via [`ensure_plugin_images`].
pub fn install_plugin(
    zip_path: &Path,
    runtime: Option<&crate::runtime::LockedRuntime>,
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
    runtime: Option<&crate::runtime::LockedRuntime>,
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

    // Serialize concurrent installs. Without this, two `install_plugin`
    // calls for the same slug could `remove_dir_all(dest)` then both
    // `rename(staging, dest)`, leaving a half-A / half-B Frankenstein on
    // disk. The lock file is created once and reused across installs.
    let lock_path = plugins_dir.join(".install.lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)?;
    use fs2::FileExt;
    lock_file.lock_exclusive()?;
    // The lock is held for the rest of this scope. `fs2`'s lock is
    // released on file drop.

    // Phase: verifying — signature check
    emit("verifying", "Verifying signature");

    // Extract ZIP to a temporary directory on the *same filesystem* as
    // `plugins_dir` so the final rename(staging, dest) can be atomic.
    // `tempfile::tempdir_in` creates a permission-700 directory that is
    // cleaned up when the `TempDir` is dropped — the predictable
    // `/tmp/speedwave-plugin-<uuid>` prefix the previous code used was
    // also a TOCTOU surface (FSEvents-watch + swap between verify and
    // copy).
    let tmp = tempfile::tempdir_in(plugins_dir)?;
    let tmp_dir = tmp.path().to_path_buf();
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

    // Phase: extracting — atomic-install the plugin. We copy first into a
    // staging dir that name-shadows the slug with a `.installing.<uuid>`
    // suffix (filtered out by every `list_*`), then swap it into place
    // with a single `rename`. If `dest` already exists, it is moved to a
    // `.removing.<uuid>` sibling and cleaned up on success — a crash
    // mid-rename leaves a recoverable state instead of a half-installed
    // tree. Lock is still held; concurrent installs are blocked above.
    emit("extracting", "Extracting archive");
    let dest = plugins_dir.join(&manifest.slug);
    let staging_name = format!("{}.installing.{}", manifest.slug, uuid::Uuid::new_v4());
    let staging = plugins_dir.join(&staging_name);
    copy_dir_recursive(&plugin_src, &staging)?;

    let removed_old: Option<PathBuf> = if dest.exists() {
        let old_name = format!("{}.removing.{}", manifest.slug, uuid::Uuid::new_v4());
        let old_path = plugins_dir.join(&old_name);
        std::fs::rename(&dest, &old_path)?;
        Some(old_path)
    } else {
        None
    };

    if let Err(e) = std::fs::rename(&staging, &dest) {
        // Roll back: try to restore the old plugin so the user isn't left
        // with nothing on disk after a failed swap.
        if let Some(ref old_path) = removed_old {
            let _ = std::fs::rename(old_path, &dest);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(anyhow::anyhow!(
            "atomic install rename failed for plugin '{}': {e}",
            manifest.slug
        ));
    }
    // Verified-cache may hold a verdict for the *previous* version of
    // this plugin. Drop it before any verify-on-load path runs again.
    signing::invalidate_cache(&dest);
    if let Some(old_path) = removed_old {
        if let Err(e) = std::fs::remove_dir_all(&old_path) {
            log::warn!(
                "failed to clean up replaced plugin dir {}: {e}",
                old_path.display()
            );
        }
    }

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
            // the next launch via `ensure_plugin_images`.
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
pub fn remove_plugin(
    slug: &str,
    runtime: Option<&crate::runtime::LockedRuntime>,
) -> anyhow::Result<()> {
    let plugins_dir = plugins_base_dir()?;
    remove_plugin_with_base(slug, &plugins_dir, runtime)
}

/// Testable variant of [`remove_plugin`] — accepts an explicit plugins
/// base directory so unit tests can isolate file-system mutation under
/// `tempfile::tempdir()`. Mirrors [`install_plugin_with_base`].
fn remove_plugin_with_base(
    slug: &str,
    plugins_dir: &Path,
    runtime: Option<&crate::runtime::LockedRuntime>,
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

    // Drop the cached signature verdict BEFORE removing the directory —
    // `invalidate_cache` resolves its key via `canonicalize`, which
    // fails once the path is gone, so doing this after `remove_dir_all`
    // would be a no-op and the stale entry would linger for the
    // lifetime of a long-running Desktop process. Install does the
    // symmetric thing on `dest`.
    signing::invalidate_cache(&plugin_dir);
    std::fs::remove_dir_all(&plugin_dir)?;
    // Mutable state lives outside the signed tree. Wipe it too, so a
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

/// A plugin whose Ed25519 signature has been verified and whose
/// directory name matches its manifest slug. The path is included so
/// callers don't have to reconstruct it via `plugins_base.join(slug)` —
/// reconstruction would defeat the dir/slug enforcement (an attacker
/// drops `evil/plugin.json` whose `slug: "good"` and the caller
/// silently re-routes to a different on-disk tree).
#[derive(Debug)]
pub struct VerifiedPlugin {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
}

impl VerifiedPlugin {
    /// Constructs a `VerifiedPlugin`. Only callers that have just run
    /// the full verification (`verify_one_plugin_dir`) — or test code
    /// — should reach this; prefer it over the literal struct syntax so
    /// the "this pair has been verified" intent is explicit at the
    /// construction site.
    pub(crate) fn new(manifest: PluginManifest, dir: PathBuf) -> Self {
        Self { manifest, dir }
    }
}

/// Reasons a plugin can fail the load-time audit. UI shows this so users
/// can tell *why* a plugin was rejected instead of seeing a generic error.
/// Serializes to the snake_case names the frontend `models/plugin.ts`
/// `PluginVerificationStatus` union mirrors (`verified`,
/// `missing_signature`, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    /// Signature verified and manifest validated.
    Verified,
    /// `SIGNATURE` file is missing.
    MissingSignature,
    /// `SIGNATURE` failed Ed25519 verification, or the digest didn't match.
    InvalidSignature,
    /// The directory name doesn't match `manifest.slug` — the plugin was
    /// not installed via the supported flow.
    DirSlugMismatch,
    /// Manifest is missing, malformed, or fails `validate_manifest`.
    ManifestInvalid,
}

/// One entry in the tolerant UI listing.
///
/// The fields are correlated: a `Verified` entry always has
/// `manifest: Some(_)` and `verification_error: None`; a non-`Verified`
/// entry always has `verification_error: Some(_)` and may or may not
/// have a parseable manifest. That correlation is enforced by the two
/// constructors below — prefer them over the literal struct syntax so
/// the invariant can't be silently broken at a new construction site.
#[derive(Debug)]
pub struct PluginListEntry {
    pub slug: String,
    pub dir: PathBuf,
    pub manifest: Option<PluginManifest>,
    pub verification_status: VerificationStatus,
    pub verification_error: Option<String>,
}

impl PluginListEntry {
    /// Constructs a `Verified` entry. The manifest is required (a
    /// verified plugin always parsed its manifest) and the error is
    /// always `None`.
    pub(crate) fn verified(slug: String, dir: PathBuf, manifest: PluginManifest) -> Self {
        Self {
            slug,
            dir,
            manifest: Some(manifest),
            verification_status: VerificationStatus::Verified,
            verification_error: None,
        }
    }

    /// Constructs a failed entry. `status` must not be `Verified`
    /// (debug-asserted) and `error` is always recorded so the UI never
    /// shows "unknown error" for a rejected plugin. `manifest` is
    /// optional — it's `Some` when the file parsed but a later check
    /// failed, `None` when the file is missing or unparseable.
    pub(crate) fn failed(
        slug: String,
        dir: PathBuf,
        status: VerificationStatus,
        error: String,
        manifest: Option<PluginManifest>,
    ) -> Self {
        debug_assert_ne!(
            status,
            VerificationStatus::Verified,
            "PluginListEntry::failed called with Verified status"
        );
        Self {
            slug,
            dir,
            manifest,
            verification_status: status,
            verification_error: Some(error),
        }
    }
}

/// Returns true for entries that should be excluded from any user-facing
/// or runtime-relevant listing: in-flight installs (`.installing.*`),
/// in-flight removals (`.removing.*`), and dot-files. These directories
/// exist briefly during atomic install but are not real plugins.
fn is_transient_plugin_dir(name: &str) -> bool {
    name.contains(".installing.") || name.contains(".removing.") || name.starts_with('.')
}

/// Lists all installed plugins by scanning `~/.speedwave/plugins/*/plugin.json`.
/// **No signature verification.** Use [`list_verified_plugins`] when the
/// caller will act on the result in a way that affects what Claude sees —
/// rendering the plugin section of compose, building images, mounting
/// claude-resources — because only that path enforces the runtime
/// signature invariant. This raw lister is for callers that only need the
/// *set of slugs* (update hints, CLI `plugin list` diagnostics, the
/// worker-auth-token pass that just keys side files by slug) or that
/// already validated their own slug (install collision check). For the
/// Desktop UI use [`list_for_ui`], which reports a per-plugin
/// verification status instead of silently trusting the on-disk manifest.
pub fn list_installed_plugins() -> anyhow::Result<Vec<PluginManifest>> {
    let plugins_dir = plugins_base_dir()?;
    list_installed_from_dir(&plugins_dir)
}

/// Lists plugins from a given directory by scanning `<dir>/*/plugin.json`.
/// **No signature verification** — see [`list_installed_plugins`].
pub fn list_installed_from_dir(plugins_dir: &Path) -> anyhow::Result<Vec<PluginManifest>> {
    if !plugins_dir.exists() {
        return Ok(vec![]);
    }

    let mut plugins = Vec::new();
    for entry in std::fs::read_dir(plugins_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if is_transient_plugin_dir(&dir_name) {
            continue;
        }
        let manifest_path = entry.path().join("plugin.json");
        if !manifest_path.exists() {
            continue;
        }
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
    Ok(plugins)
}

/// Loads every plugin under `~/.speedwave/plugins/`, verifying each
/// signature and validating each manifest. Returns `Err` if any installed
/// plugin fails — callers using this loader (compose render, image
/// build, Claude wiring) must not proceed with a partial set of trusted
/// plugins. Use [`list_for_ui`] when you need to show a tolerant view
/// instead.
pub fn list_verified_plugins() -> anyhow::Result<Vec<VerifiedPlugin>> {
    let plugins_dir = plugins_base_dir()?;
    list_verified_from_dir(&plugins_dir)
}

/// Test-friendly variant of [`list_verified_plugins`].
pub(crate) fn list_verified_from_dir(plugins_dir: &Path) -> anyhow::Result<Vec<VerifiedPlugin>> {
    if !plugins_dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(plugins_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if is_transient_plugin_dir(&dir_name) {
            continue;
        }
        let plugin_dir = entry.path();
        let vp = verify_one_plugin_dir(plugins_dir, &plugin_dir, &dir_name)?;
        out.push(vp);
    }
    Ok(out)
}

/// Verifies one plugin directory: signature, manifest parse,
/// dir-name/slug equality, and `validate_manifest`. Returns a
/// `VerifiedPlugin` on success or a contextual error on any failure.
///
/// Performs a one-shot migration of any legacy in-tree
/// `.image_pending` marker out of the signed tree before computing the
/// digest. Without that step, every MCP plugin installed under an
/// older Speedwave release would fail signature verification on the
/// first launch under a runtime-invariant build (the in-tree marker
/// changes the digest). The migration is idempotent — once moved, the
/// marker stays in plugin-state.
fn verify_one_plugin_dir(
    plugins_dir: &Path,
    plugin_dir: &Path,
    dir_name: &str,
) -> anyhow::Result<VerifiedPlugin> {
    migrate_legacy_image_pending(plugins_dir, plugin_dir, dir_name);
    signing::verify_plugin_signature(plugin_dir)
        .map_err(|e| anyhow::anyhow!("plugin '{dir_name}': signature verification failed: {e}"))?;
    let manifest_path = plugin_dir.join("plugin.json");
    let content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| anyhow::anyhow!("plugin '{dir_name}': cannot read plugin.json: {e}"))?;
    let manifest: PluginManifest = serde_json::from_str(&content)
        .map_err(|e| anyhow::anyhow!("plugin '{dir_name}': invalid plugin.json: {e}"))?;
    if manifest.slug != dir_name {
        anyhow::bail!(
            "plugin '{dir_name}': directory name does not match manifest slug '{}'",
            manifest.slug
        );
    }
    validate_manifest(&manifest, plugin_dir)
        .map_err(|e| anyhow::anyhow!("plugin '{dir_name}': manifest validation failed: {e}"))?;
    Ok(VerifiedPlugin::new(manifest, plugin_dir.to_path_buf()))
}

/// Tolerant lister for the Desktop UI. Never returns `Err` — every
/// installed directory becomes one entry, with `verification_status`
/// telling the user (and the frontend) whether the plugin is usable.
/// UI-only commands (`get_plugins`) consume this; runtime-relevant
/// callers must use [`list_verified_plugins`] instead.
pub fn list_for_ui() -> Vec<PluginListEntry> {
    match plugins_base_dir() {
        Ok(plugins_dir) => list_for_ui_from_dir(&plugins_dir),
        Err(e) => {
            log::warn!("plugins_base_dir failed: {e}");
            Vec::new()
        }
    }
}

/// Test-friendly variant of [`list_for_ui`].
pub(crate) fn list_for_ui_from_dir(plugins_dir: &Path) -> Vec<PluginListEntry> {
    if !plugins_dir.exists() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let read_dir = match std::fs::read_dir(plugins_dir) {
        Ok(rd) => rd,
        Err(e) => {
            log::warn!(
                "list_for_ui: cannot read plugins dir {} ({e})",
                plugins_dir.display()
            );
            return Vec::new();
        }
    };
    for item in read_dir {
        let entry = match item {
            Ok(e) => e,
            Err(e) => {
                // A directory entry we can't read — surface it as an
                // unverified entry so the UI shows *something* rather
                // than silently presenting a shorter list than reality.
                out.push(PluginListEntry::failed(
                    "<unreadable-entry>".into(),
                    plugins_dir.to_path_buf(),
                    VerificationStatus::ManifestInvalid,
                    format!("cannot read directory entry: {e}"),
                    None,
                ));
                continue;
            }
        };
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if is_transient_plugin_dir(&dir_name) {
            continue;
        }
        let plugin_dir = entry.path();
        // The UI lister is intentionally read-only. Migration of the
        // legacy in-tree `.image_pending` marker is performed by
        // `verify_one_plugin_dir` (used by `audit_all` and
        // `list_verified_plugins`); both fire well before any user-
        // initiated UI list. If a hypothetical race shows a legacy
        // plugin as `InvalidSignature` here, the next launch's audit
        // pass migrates it, and the next listing reflects the
        // recovered state.
        let entry_record = classify_plugin_for_ui(&plugin_dir, &dir_name);
        out.push(entry_record);
    }
    out
}

fn classify_plugin_for_ui(plugin_dir: &Path, dir_name: &str) -> PluginListEntry {
    // Try to parse the manifest first so even rejected plugins surface
    // their `name`/`description` to the UI when possible.
    let manifest_path = plugin_dir.join("plugin.json");
    let manifest: Option<PluginManifest> = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<PluginManifest>(&s).ok());

    let slug = dir_name.to_string();
    let dir = plugin_dir.to_path_buf();
    let failed = |status: VerificationStatus, err: String, m: Option<PluginManifest>| {
        PluginListEntry::failed(slug.clone(), dir.clone(), status, err, m)
    };

    let Some(m) = manifest else {
        return failed(
            VerificationStatus::ManifestInvalid,
            "plugin.json missing or unparseable".into(),
            None,
        );
    };

    if m.slug != dir_name {
        let mismatch_err = format!("directory name does not match manifest slug '{}'", m.slug);
        return failed(VerificationStatus::DirSlugMismatch, mismatch_err, Some(m));
    }
    // Delegate to verify_plugin_signature first — it honors the debug-only
    // SPEEDWAVE_ALLOW_UNSIGNED bypass and returns Ok without touching the
    // SIGNATURE file. A pre-existence check here would short-circuit the
    // bypass and make unsigned plugins unusable in dev despite the env var.
    if let Err(e) = signing::verify_plugin_signature(plugin_dir) {
        let status = if !plugin_dir.join("SIGNATURE").exists() {
            VerificationStatus::MissingSignature
        } else {
            VerificationStatus::InvalidSignature
        };
        return failed(
            status,
            crate::log_sanitizer::sanitize(&e.to_string()),
            Some(m),
        );
    }
    if let Err(e) = validate_manifest(&m, plugin_dir) {
        return failed(VerificationStatus::ManifestInvalid, e.to_string(), Some(m));
    }
    PluginListEntry::verified(slug, dir, m)
}

/// Audits every installed plugin and returns a list of `(slug, reason)`
/// pairs for the ones that fail. Called at process startup (Desktop
/// `.setup()`, CLI before any non-recovery action) so the user gets a
/// single dialog/output describing every bad plugin instead of
/// discovering them one by one.
pub fn audit_all() -> Result<(), Vec<(String, String)>> {
    match plugins_base_dir() {
        Ok(p) => audit_all_in_dir(&p),
        Err(e) => Err(vec![("<plugins-base>".into(), e.to_string())]),
    }
}

/// Test-friendly variant of [`audit_all`].
pub(crate) fn audit_all_in_dir(plugins_dir: &Path) -> Result<(), Vec<(String, String)>> {
    if !plugins_dir.exists() {
        return Ok(());
    }
    let mut failures: Vec<(String, String)> = Vec::new();
    let read_dir = match std::fs::read_dir(plugins_dir) {
        Ok(rd) => rd,
        Err(e) => return Err(vec![("<plugins-base>".into(), e.to_string())]),
    };
    for item in read_dir {
        // A directory entry that can't be read is itself an audit
        // failure — never silently skipped. Otherwise an attacker who
        // can make a specific plugin's `DirEntry` raise an I/O error
        // (e.g. on a filesystem returning intermittent EIO) would
        // escape the audit, which would then return `Ok(())`.
        let entry = match item {
            Ok(e) => e,
            Err(e) => {
                failures.push(("<unreadable-entry>".into(), e.to_string()));
                continue;
            }
        };
        let Ok(ft) = entry.file_type() else {
            failures.push((
                entry.file_name().to_string_lossy().to_string(),
                "cannot stat directory entry".into(),
            ));
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if is_transient_plugin_dir(&dir_name) {
            continue;
        }
        let plugin_dir = entry.path();
        if let Err(e) = verify_one_plugin_dir(plugins_dir, &plugin_dir, &dir_name) {
            failures.push((dir_name, crate::log_sanitizer::sanitize(&e.to_string())));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures)
    }
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
    runtime: &crate::runtime::LockedRuntime,
    enabled_service_ids: &[&str],
) -> anyhow::Result<()> {
    let plugins_dir = plugins_base_dir()?;
    ensure_plugin_images_from_dir(runtime, enabled_service_ids, &plugins_dir)
}

/// Inner implementation of `ensure_plugin_images()` — accepts explicit plugins dir for testability.
fn ensure_plugin_images_from_dir(
    runtime: &crate::runtime::LockedRuntime,
    enabled_service_ids: &[&str],
    plugins_dir: &Path,
) -> anyhow::Result<()> {
    if !plugins_dir.exists() {
        return Ok(());
    }

    // First: build any pending (newly-installed) images for enabled plugins.
    build_pending_from_dir(runtime, Some(enabled_service_ids), plugins_dir)?;

    // Second: check image existence and rebuild any missing images. Use the
    // fail-closed verified loader — the manifest's `image_tag` decides which
    // OCI image gets the "already exists, skip rebuild" treatment, so a
    // tampered tree must not reach this loop. This path runs after startup
    // but also from the Desktop reconcile (post-startup), where no fresh
    // audit has gated it.
    let plugins = list_verified_from_dir(plugins_dir)?;
    let mut errors: Vec<String> = Vec::new();

    for vp in &plugins {
        let manifest = &vp.manifest;
        let sid = match manifest.service_id.as_deref() {
            Some(s) => s,
            None => continue, // resource-only plugin, no image
        };

        if !enabled_service_ids.contains(&sid) {
            continue; // not enabled for this project
        }

        let plugin_dir = vp.dir.as_path();
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
            if let Err(e) = build_single_plugin_image(runtime, manifest, plugin_dir) {
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
fn build_pending_from_dir(
    runtime: &crate::runtime::LockedRuntime,
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
        if is_transient_plugin_dir(&slug) {
            continue;
        }
        let plugin_dir = entry.path();
        // Pending markers may live in two places: the state directory
        // (`<plugin-state-base>/<slug>/image_pending`, written by current
        // installs) or, for plugins installed by older releases, the legacy
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
///
/// Re-verifies the plugin's signature before building. Without this, an
/// attacker who could write to `~/.speedwave/plugins/<slug>/Containerfile`
/// after install would have arbitrary RUN commands executed at build
/// time. The image build is the highest-impact post-install action — any
/// `RUN` inside the Containerfile runs with the build context's contents
/// available, so the verify gate must come *before* `prepare_build_context`.
fn build_single_plugin_image(
    runtime: &crate::runtime::LockedRuntime,
    manifest: &PluginManifest,
    plugin_dir: &Path,
) -> anyhow::Result<()> {
    signing::verify_plugin_signature(plugin_dir).map_err(|e| {
        anyhow::anyhow!(
            "refusing to build image for plugin '{}': {e}",
            manifest.slug
        )
    })?;
    let tag = plugin_image_tag(manifest);
    let vm_root = runtime.prepare_build_context(plugin_dir)?;
    // vm_root is a VM-side path (on Windows a WSL `/mnt/c/...` path); join with
    // `vm_path_join`, never `PathBuf::join` which mangles it on Windows.
    let root_str = vm_root.to_string_lossy();
    let containerfile = crate::engine_path::vm_path_join(&root_str, "Containerfile");

    log::info!(
        "Building plugin image {} from {}",
        tag,
        plugin_dir.display()
    );
    runtime.build_image(&tag, root_str.trim_end_matches('/'), &containerfile, &[])?;

    // Remove the pending marker on success — both the new state-dir
    // location and the legacy in-tree marker, so a plugin installed by an older release
    // stops re-triggering on every launch. `plugin_dir` is always
    // `<plugins_dir>/<slug>/`, so its parent is the plugins base.
    if let Some(plugins_dir) = plugin_dir.parent() {
        clear_image_pending_for(plugins_dir, plugin_dir, &manifest.slug);
    } else {
        // Unreachable: a plugin dir always has a parent. Don't touch the
        // signed tree here as a "fallback" — that's exactly what the
        // mutable-state relocation removed.
        log::warn!(
            "plugin dir {} has no parent — skipping image_pending cleanup",
            plugin_dir.display()
        );
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

/// Returns the image tag for a plugin. E.g. "speedwave-mcp-example-plugin:1.2.0"
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

    let tokens_path = crate::engine_path::to_engine_path(&tokens_dir.join(sid))?;
    let workspace_path = crate::engine_path::to_engine_path(Path::new(project_dir))?;
    let mem_limit = manifest
        .mem_limit
        .as_deref()
        .unwrap_or(consts::PLUGIN_DEFAULT_MEM);
    let cpu_limit = manifest
        .cpu_limit
        .as_deref()
        .unwrap_or(consts::PLUGIN_DEFAULT_CPU);
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
  - /tmp:noexec,nosuid,size={plugin_tmpfs}
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
        plugin_tmpfs = consts::PLUGIN_DEFAULT_TMPFS,
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
        // symlink_metadata so symlinks are observed *as symlinks*, not
        // followed. The same invariant `compute_plugin_digest` enforces
        // (no symlinks in a plugin tree); enforced here too as
        // defence-in-depth — `extract_zip` already rejects symlink
        // entries, but a future caller might copy from a directory
        // produced by something other than ZIP extraction.
        let file_type = std::fs::symlink_metadata(entry.path())?.file_type();
        if file_type.is_symlink() {
            anyhow::bail!(
                "plugin source contains symlink which is not allowed: {}",
                entry.path().display()
            );
        }
        if file_type.is_dir() {
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
            name: "Example Plugin CRM".to_string(),
            service_id: Some("example-plugin".to_string()),
            slug: "example-plugin".to_string(),
            version: "1.2.0".to_string(),
            description: "Example Plugin CRM integration".to_string(),
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
                required: true,
                description: None,
                validation: None,
            }],
            settings_schema: None,
            speedwave_compat: Some(">=0.1.0".to_string()),
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec!["sharepoint".to_string()],
            host_bridge: None,
            instructions: None,
        };
        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: PluginManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "Example Plugin CRM");
        assert_eq!(parsed.service_id.as_deref(), Some("example-plugin"));
        assert_eq!(parsed.slug, "example-plugin");
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
            "name": "Example Plugin Plugin",
            "slug": "example-plugin",
            "version": "1.0.0",
            "description": "Example Plugin CRM",
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
        assert!(validate_slug("example-plugin").is_ok());
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
                host_bridge: None,
                instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
        assert_eq!(
            derive_worker_env("example-plugin"),
            "WORKER_EXAMPLE_PLUGIN_URL"
        );
        assert_eq!(derive_worker_env("my-plugin"), "WORKER_MY_PLUGIN_URL");
        assert_eq!(derive_worker_env("crm"), "WORKER_CRM_URL");
    }

    #[test]
    fn test_derive_compose_name() {
        assert_eq!(derive_compose_name("example-plugin"), "mcp-example-plugin");
        assert_eq!(derive_compose_name("my-plugin"), "mcp-my-plugin");
    }

    #[test]
    fn test_generate_plugin_service_output() {
        let manifest = PluginManifest {
            name: "Example Plugin CRM".to_string(),
            service_id: Some("example-plugin".to_string()),
            slug: "example-plugin".to_string(),
            version: "1.2.0".to_string(),
            description: "Example Plugin CRM".to_string(),
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
            host_bridge: None,
            instructions: None,
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
            yaml.contains("speedwave-mcp-example-plugin:1.2.0"),
            "image tag: {yaml}"
        );
        assert!(
            yaml.contains(&format!(
                "{}_myproject_mcp_example_plugin",
                crate::consts::compose_prefix()
            )),
            "container_name: {yaml}"
        );
        assert!(yaml.contains("read_only: true"), "read_only: {yaml}");
        assert!(yaml.contains(&container_user()), "user: {yaml}");
        assert!(yaml.contains("ALL"), "cap_drop ALL: {yaml}");
        assert!(
            yaml.contains("no-new-privileges:true"),
            "security_opt: {yaml}"
        );
        assert!(
            yaml.contains("/tmp:noexec,nosuid,size=512m"),
            "default tmpfs from PLUGIN_DEFAULT_TMPFS: {yaml}"
        );
        assert!(yaml.contains("/tokens:ro"), "token mount: {yaml}");
        assert!(yaml.contains("/workspace:rw"), "workspace mount: {yaml}");
        // ADR-038: every worker — including plugins — uses PORT_WORKER (3000).
        assert!(yaml.contains("PORT=3000"), "PORT env: {yaml}");
        assert!(
            yaml.contains("speedwave_myproject_network"),
            "network: {yaml}"
        );
        assert!(yaml.contains("speedwave.plugin-service"), "label: {yaml}");
        // Reference the SSOT constants, not literals — a bump of either default
        // must not silently leave this test asserting the old value.
        assert!(
            yaml.contains(&format!("memory: {}", consts::PLUGIN_DEFAULT_MEM)),
            "mem limit: {yaml}"
        );
        assert!(
            yaml.contains(&format!("cpus: '{}'", consts::PLUGIN_DEFAULT_CPU)),
            "default cpu limit: {yaml}"
        );
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
        let plugin_dir = tmp.path().join("example-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();

        let manifest = r#"{
            "name": "Example Plugin",
            "slug": "example-plugin",
            "service_id": "example-plugin",
            "version": "1.0.0",
            "description": "test",
            "port": 4010
        }"#;
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();

        let plugins = list_installed_from_dir(tmp.path()).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].slug, "example-plugin");
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
        let nested = tmp.path().join("example-plugin-1.0.0");
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

        configure_plugin_tokens_with_base(home, "myproject", "example-plugin", &tokens).unwrap();

        let token_dir = home
            .join(consts::DATA_DIR)
            .join("tokens")
            .join("myproject")
            .join("example-plugin");

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
                    required: true,
                    description: None,
                    validation: None,
                },
                AuthFieldDef {
                    key: "token".to_string(),
                    label: "Token".to_string(),
                    field_type: "password".to_string(),
                    placeholder: "tok-...".to_string(),
                    is_secret: true,
                    required: true,
                    description: None,
                    validation: None,
                },
                AuthFieldDef {
                    key: "label".to_string(),
                    label: "Label".to_string(),
                    field_type: "text".to_string(),
                    placeholder: "My Label".to_string(),
                    is_secret: false,
                    required: true,
                    description: None,
                    validation: None,
                },
            ],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
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
                    required: true,
                    description: None,
                    validation: None,
                },
                AuthFieldDef {
                    key: "token".to_string(),
                    label: "Token".to_string(),
                    field_type: "password".to_string(),
                    placeholder: "tok-...".to_string(),
                    is_secret: true,
                    required: true,
                    description: None,
                    validation: None,
                },
            ],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
                required: true,
                description: None,
                validation: None,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
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
                required: true,
                description: None,
                validation: None,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
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

    /// RAII guard that turns on the debug-only signature bypass for the
    /// scope of the test, holding `unsigned_env_lock` for the duration.
    /// Use in tests that synthesise plugin directories without a real
    /// SIGNATURE — they must still pass the runtime verify gates
    /// (e.g. `build_single_plugin_image`'s pre-build verify).
    struct UnsignedBypassGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
    }
    impl UnsignedBypassGuard {
        fn new() -> Self {
            let lock = unsigned_env_lock();
            std::env::set_var("SPEEDWAVE_ALLOW_UNSIGNED", "1");
            Self { _lock: lock }
        }
    }
    impl Drop for UnsignedBypassGuard {
        fn drop(&mut self) {
            std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");
        }
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
        // peek_plugin_manifest only extracts into std::env::temp_dir(), so it
        // should never touch a plugins dir. We check by counting entries in a
        // freshly-created tempdir given as a probe — peek should not write
        // anywhere outside its own scratch tmp.
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

    /// Legacy plugins (installed by older releases) carry an `.image_pending`
    /// marker inside the signed tree. `has_pending_image_build_for` must
    /// honour either location during the migration window — without this,
    /// every such plugin would silently stop rebuilding
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

    /// Helper: synthesises a plugin dir with a manifest where the
    /// directory name and `slug` are deliberately different.  Used to
    /// verify the loader rejects this layout — an attacker drops
    /// `evil/plugin.json` whose `slug: "good"` and the loader must
    /// refuse before any caller acts on `manifest.slug`.
    fn make_dir_with_mismatched_slug(plugins_dir: &Path, dir_name: &str, manifest_slug: &str) {
        let plugin_dir = plugins_dir.join(dir_name);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let manifest = format!(
            r#"{{"name":"x","slug":"{manifest_slug}","version":"1.0.0","description":"x"}}"#
        );
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();
    }

    /// The frontend `PluginVerificationStatus` union in
    /// `models/plugin.ts` mirrors these exact snake_case literals — if
    /// this test changes, that file must change too.
    #[test]
    fn test_verification_status_serializes_to_snake_case() {
        let cases = [
            (VerificationStatus::Verified, "\"verified\""),
            (
                VerificationStatus::MissingSignature,
                "\"missing_signature\"",
            ),
            (
                VerificationStatus::InvalidSignature,
                "\"invalid_signature\"",
            ),
            (VerificationStatus::DirSlugMismatch, "\"dir_slug_mismatch\""),
            (VerificationStatus::ManifestInvalid, "\"manifest_invalid\""),
        ];
        for (status, expected) in cases {
            assert_eq!(serde_json::to_string(&status).unwrap(), expected);
        }
    }

    #[test]
    fn test_list_for_ui_reports_dir_slug_mismatch() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        std::fs::create_dir_all(&plugins).unwrap();
        make_dir_with_mismatched_slug(&plugins, "evil", "good");

        let entries = list_for_ui_from_dir(&plugins);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].slug, "evil");
        assert_eq!(
            entries[0].verification_status,
            VerificationStatus::DirSlugMismatch,
            "loader must observe directory name, not manifest claim"
        );
    }

    #[test]
    fn test_list_verified_rejects_dir_slug_mismatch() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        std::fs::create_dir_all(&plugins).unwrap();
        make_dir_with_mismatched_slug(&plugins, "evil", "good");

        let err = list_verified_from_dir(&plugins)
            .expect_err("list_verified must fail when any plugin has a dir/slug mismatch");
        assert!(err.to_string().contains("does not match manifest slug"));
    }

    /// A plugin dir with a well-formed manifest but no `SIGNATURE` file
    /// is the canonical "manually pasted, never installed" case. The UI
    /// lister must flag it `MissingSignature` (not `Verified`), and the
    /// fail-closed loader must reject the whole set. Runs WITHOUT the
    /// unsigned bypass — that's the point.
    #[test]
    fn test_unsigned_plugin_flagged_missing_signature() {
        let _g = unsigned_env_lock();
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("pasted");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"x","slug":"pasted","version":"1.0.0","description":"x"}"#,
        )
        .unwrap();
        // No SIGNATURE.

        let entries = list_for_ui_from_dir(&plugins);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].slug, "pasted");
        assert_eq!(
            entries[0].verification_status,
            VerificationStatus::MissingSignature,
            "unsigned plugin must be flagged, not treated as verified"
        );

        // Fail-closed loader rejects the whole set.
        list_verified_from_dir(&plugins)
            .expect_err("list_verified must reject when any plugin is unsigned");
        // Audit reports it.
        let failures =
            audit_all_in_dir(&plugins).expect_err("audit must report the unsigned plugin");
        assert!(failures.iter().any(|(slug, _)| slug == "pasted"));
    }

    /// `SPEEDWAVE_ALLOW_UNSIGNED=1` must let an unsigned plugin list as Verified.
    #[test]
    fn test_unsigned_plugin_is_verified_when_bypass_active() {
        let _g = unsigned_env_lock();
        std::env::set_var("SPEEDWAVE_ALLOW_UNSIGNED", "1");
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("devplugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"x","slug":"devplugin","version":"1.0.0","description":"x"}"#,
        )
        .unwrap();
        // No SIGNATURE — bypass must accept it anyway.
        signing::invalidate_cache(&plugin_dir);

        let entries = list_for_ui_from_dir(&plugins);
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].slug, "devplugin");
        assert_eq!(
            entries[0].verification_status,
            VerificationStatus::Verified,
            "SPEEDWAVE_ALLOW_UNSIGNED must let an unsigned plugin list as Verified"
        );
    }

    /// A plugin dir that *has* a `SIGNATURE` file, but one that was
    /// produced with a non-production key — the file is present so it's
    /// not `MissingSignature`, but Ed25519 verification against the
    /// embedded production key fails, so it must be `InvalidSignature`.
    /// Runs WITHOUT the unsigned bypass (the bypass would short-circuit
    /// verification before the signature is even checked).
    #[test]
    fn test_list_for_ui_reports_invalid_signature() {
        use crate::signing::{generate_keypair, sign_plugin};
        let _g = unsigned_env_lock();
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("forged");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"x","slug":"forged","version":"1.0.0","description":"x"}"#,
        )
        .unwrap();
        let (priv_key, _pub_key) = generate_keypair();
        sign_plugin(&plugin_dir, &priv_key).unwrap();
        // Wrong signing key → SIGNATURE present, but production verify fails.
        signing::invalidate_cache(&plugin_dir);

        let entries = list_for_ui_from_dir(&plugins);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].slug, "forged");
        assert_eq!(
            entries[0].verification_status,
            VerificationStatus::InvalidSignature,
            "a SIGNATURE that fails production verification must be InvalidSignature, not MissingSignature"
        );
        assert!(
            entries[0].verification_error.is_some(),
            "InvalidSignature must carry a diagnostic"
        );

        // Fail-closed loader rejects the whole set.
        list_verified_from_dir(&plugins)
            .expect_err("list_verified must reject when any plugin's signature is invalid");
    }

    #[test]
    fn test_list_for_ui_skips_transient_install_dirs() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        std::fs::create_dir_all(&plugins).unwrap();
        // Real plugin
        make_resource_only_plugin_dir(&plugins, "okplugin", "1.0.0");
        // In-flight install staging
        std::fs::create_dir_all(plugins.join("okplugin.installing.abc123")).unwrap();
        // In-flight removal
        std::fs::create_dir_all(plugins.join("okplugin.removing.def456")).unwrap();

        let entries = list_for_ui_from_dir(&plugins);
        let slugs: Vec<&str> = entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(
            slugs,
            vec!["okplugin"],
            "transient .installing.* / .removing.* dirs must not appear in UI listing"
        );
    }

    #[test]
    fn test_audit_all_reports_failures_collectively() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        std::fs::create_dir_all(&plugins).unwrap();
        // One good resource-only plugin (no signature, but bypass active)
        make_resource_only_plugin_dir(&plugins, "good", "1.0.0");
        // One mismatched slug — failure
        make_dir_with_mismatched_slug(&plugins, "bad", "different");
        // One missing manifest entirely — failure
        std::fs::create_dir_all(plugins.join("broken")).unwrap();

        let failures = audit_all_in_dir(&plugins).expect_err("audit must report failures");
        let bad: Vec<&str> = failures.iter().map(|(s, _)| s.as_str()).collect();
        assert!(bad.contains(&"bad"), "mismatched dir/slug must be reported");
        assert!(bad.contains(&"broken"), "missing manifest must be reported");
        assert!(!bad.contains(&"good"), "good plugin must not be reported");
    }

    /// Atomic install — even with the lock held by another thread, the
    /// existing on-disk plugin must not vanish mid-replace. We can't
    /// easily test the lock contention itself in a unit test, but we can
    /// verify the rollback path: if the rename fails, the old plugin
    /// stays in place. A direct way to trigger that is impractical
    /// (rename is atomic on the same FS), so this test instead asserts
    /// that two sequential installs produce no leftover staging or
    /// removing directories — those would be evidence of a swap that
    /// failed mid-flight.
    #[test]
    fn test_install_leaves_no_staging_or_removing_dirs() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "phases-atomic", false);
        let plugins_dir = tmp.path().join("plugins");

        let progresses = std::sync::Mutex::new(Vec::<PluginInstallProgress>::new());
        // First install
        install_plugin_with_base(&zip, None, &mut collect_progress(&progresses), &plugins_dir)
            .expect("first install must succeed");
        // Re-install same slug (simulates upgrade)
        install_plugin_with_base(&zip, None, &mut collect_progress(&progresses), &plugins_dir)
            .expect("reinstall must succeed");

        let leftovers: Vec<String> = std::fs::read_dir(&plugins_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".installing.") || n.contains(".removing."))
            .collect();
        assert!(
            leftovers.is_empty(),
            "after successful install/reinstall, no transient dirs should remain: {leftovers:?}"
        );
    }

    /// Legacy installs left `.image_pending` inside the signed tree;
    /// once the signature is a runtime invariant that file shifts the
    /// digest and verification fails on the upgrade. The migration must
    /// restore the tree to the as-signed state. This test signs a tree
    /// with a fresh test key, drops a legacy marker, migrates, then
    /// re-verifies with the same key — a no-op migration would leave
    /// the marker and the verify would fail. No unsigned bypass.
    #[test]
    fn test_migration_restores_verifiable_tree() {
        use crate::signing::{generate_keypair, sign_plugin, verify_plugin_signature_with_key};
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("legacy-mcp");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"x","slug":"legacy-mcp","version":"1.0.0","description":"x"}"#,
        )
        .unwrap();

        let (priv_key, pub_key) = generate_keypair();
        sign_plugin(&plugin_dir, &priv_key).unwrap();
        let pub_key: [u8; 32] = pub_key.try_into().unwrap();

        // Simulate a legacy install: marker dumped into the signed tree.
        std::fs::write(plugin_dir.join(".image_pending"), b"").unwrap();
        verify_plugin_signature_with_key(&plugin_dir, &pub_key).expect_err(
            "sanity: legacy marker must break verification, else the test proves nothing",
        );

        migrate_legacy_image_pending(&plugins, &plugin_dir, "legacy-mcp");

        verify_plugin_signature_with_key(&plugin_dir, &pub_key)
            .expect("migration must restore a tree that verifies against the original key");
        assert!(!plugin_dir.join(".image_pending").exists());
        assert!(image_pending_marker_for(&plugins, "legacy-mcp").exists());
    }

    /// Wires the migration test through `audit_all_in_dir` to pin the
    /// caller chain: a regression that bypassed the migration in the
    /// audit path (e.g. someone short-circuiting `verify_one_plugin_dir`
    /// before the migration runs) would let the legacy marker survive.
    #[test]
    fn test_audit_calls_migration() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("legacy-mcp");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"x","slug":"legacy-mcp","version":"1.0.0","description":"x"}"#,
        )
        .unwrap();
        std::fs::write(plugin_dir.join(".image_pending"), b"").unwrap();

        // Bypass is active so the (non-prod-key) plugin doesn't fail
        // signature verification — we're only checking that the audit
        // pass invokes the migration.
        let _ = audit_all_in_dir(&plugins);

        assert!(!plugin_dir.join(".image_pending").exists());
        assert!(image_pending_marker_for(&plugins, "legacy-mcp").exists());
    }

    /// Migration must refuse to act on a non-regular-file `.image_pending`
    /// — a symlink could be an attacker primitive (e.g. pointing at a
    /// host secret); silently following it would copy that content into
    /// `plugin-state/`, then leave the verifier confused. Better to
    /// leave the legacy file in place and let the verifier fail loudly.
    #[cfg(unix)]
    #[test]
    fn test_migrate_rejects_symlinked_image_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("evil-legacy");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        // Symlink target need not exist; symlink_metadata still observes it.
        std::os::unix::fs::symlink("/etc/passwd", plugin_dir.join(".image_pending")).unwrap();

        migrate_legacy_image_pending(&plugins, &plugin_dir, "evil-legacy");

        // Symlink stays put — verifier will still fail (which is what
        // we want for a tampered tree).
        assert!(plugin_dir.join(".image_pending").is_symlink());
        assert!(!image_pending_marker_for(&plugins, "evil-legacy").exists());
    }

    /// A hardlinked `.image_pending` (`nlink > 1`) must not be relocated:
    /// an attacker who pre-creates `<plugin>/.image_pending` as a hardlink
    /// to some file they want moved would otherwise get a free `rename`
    /// out of the plugin tree. The `nlink` guard leaves it in place; the
    /// verifier then fails on the unexpected in-tree file, which is the
    /// correct outcome for a tampered tree.
    #[cfg(unix)]
    #[test]
    fn test_migrate_rejects_hardlinked_image_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins = tmp.path().join("plugins");
        let plugin_dir = plugins.join("evil-legacy");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        // A file outside the plugin tree that the attacker would like
        // `migrate_legacy_image_pending` to move for them.
        let decoy = tmp.path().join("decoy.txt");
        std::fs::write(&decoy, b"do not touch").unwrap();
        let marker = plugin_dir.join(".image_pending");
        std::fs::hard_link(&decoy, &marker).unwrap();

        migrate_legacy_image_pending(&plugins, &plugin_dir, "evil-legacy");

        // Hardlinked marker stays put; the decoy is untouched; nothing
        // was relocated into the state dir.
        assert!(marker.exists());
        assert_eq!(std::fs::read(&decoy).unwrap(), b"do not touch");
        assert!(!image_pending_marker_for(&plugins, "evil-legacy").exists());
    }

    /// Two threads racing to install the same slug must not corrupt the
    /// destination tree. `install_plugin_with_base` holds an exclusive
    /// flock on `<plugins>/.install.lock`, copies into a
    /// `<slug>.installing.<uuid>` staging dir, and only then renames
    /// into place — concurrent calls serialise on the lock and each
    /// produces a clean tree.
    #[test]
    fn test_install_concurrent_no_corruption() {
        // Without a barrier, thread A typically finishes before B even
        // starts — the test then degenerates to "two sequential installs
        // of the same slug" and the flock is never exercised. The
        // `Barrier::new(2)` releases both threads only once both are
        // sitting at the entry of `install_plugin_with_base`, so the
        // second one is guaranteed to block on the exclusive flock.
        use std::sync::Barrier;
        // SPEEDWAVE_ALLOW_UNSIGNED is process-global; we hold the
        // unsigned-env lock for both threads via the guard *outside*
        // the spawned threads. Threads inherit the env.
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "race-target", false);
        let plugins_dir = tmp.path().join("plugins");
        std::fs::create_dir_all(&plugins_dir).unwrap();

        let barrier = std::sync::Arc::new(Barrier::new(2));

        let plugins_dir_a = plugins_dir.clone();
        let zip_a = zip.clone();
        let barrier_a = barrier.clone();
        let t_a = std::thread::spawn(move || {
            barrier_a.wait();
            let mut sink: Vec<PluginInstallProgress> = Vec::new();
            install_plugin_with_base(&zip_a, None, &mut |p| sink.push(p), &plugins_dir_a)
        });
        let plugins_dir_b = plugins_dir.clone();
        let zip_b = zip.clone();
        let barrier_b = barrier.clone();
        let t_b = std::thread::spawn(move || {
            barrier_b.wait();
            let mut sink: Vec<PluginInstallProgress> = Vec::new();
            install_plugin_with_base(&zip_b, None, &mut |p| sink.push(p), &plugins_dir_b)
        });

        let r_a = t_a.join().expect("thread A panicked");
        let r_b = t_b.join().expect("thread B panicked");
        // Both must succeed (lock serialises them; second install is a
        // legal upgrade-in-place).
        r_a.expect("install A");
        r_b.expect("install B");

        // No leftover staging or removing dirs.
        let leftovers: Vec<String> = std::fs::read_dir(&plugins_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".installing.") || n.contains(".removing."))
            .collect();
        assert!(
            leftovers.is_empty(),
            "lock+rename must leave no transient dirs after concurrent installs: {leftovers:?}"
        );

        // Final state is a single, consistent plugin tree.
        let final_dir = plugins_dir.join("race-target");
        assert!(final_dir.join("plugin.json").is_file());
    }

    #[test]
    fn test_copy_dir_recursive_rejects_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("ok.txt"), b"hi").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", src.join("evil")).unwrap();

        let result = copy_dir_recursive(&src, &dest);
        #[cfg(unix)]
        {
            let err = result.expect_err("copy must reject symlink");
            assert!(err.to_string().contains("symlink"));
        }
        #[cfg(not(unix))]
        {
            // On non-Unix we don't create the symlink; just assert it works.
            result.expect("copy must succeed without symlinks");
        }
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
        // never in the signed plugin tree. The plugin tree must stay
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
        let _guard = unsigned_env_lock();
        std::env::set_var("SPEEDWAVE_ALLOW_UNSIGNED", "1");
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("plugin.zip");
        build_test_plugin_zip(&zip, "phases-build-fail", true);
        let plugins_dir = tmp.path().join("plugins");

        let progresses = std::sync::Mutex::new(Vec::<PluginInstallProgress>::new());
        let (rt, _) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_all_builds_failing("RUN curl https://user:tok@registry.example.com/foo failed")
            .build();
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

        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();
        remove_plugin_with_base("img-cleanup", &plugins_dir, Some(&rt)).unwrap();

        // Plugin dir is gone.
        assert!(!plugins_dir.join("img-cleanup").exists());
        // remove_images called once with the expected tag AND force=true
        // (uninstall is an explicit user request — no waiting for prune).
        let calls = handles.remove_images_calls.lock().unwrap().clone();
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

        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();
        remove_plugin_with_base("skills-only", &plugins_dir, Some(&rt)).unwrap();

        // remove_images NOT called for plugins without a service_id.
        assert!(handles.remove_images_calls.lock().unwrap().is_empty());
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
        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_remove_images_error("simulated nerdctl rmi failure")
            .build();
        let result = remove_plugin_with_base("rmi-fails", &plugins_dir, Some(&rt));
        assert!(result.is_ok(), "remove_plugin must not fail on rmi error");
        assert!(!plugins_dir.join("rmi-fails").exists());
        // remove_images was attempted with force=true even on the error path
        // — the uninstall caller never silently downgrades to non-force rmi.
        let calls = handles.remove_images_calls.lock().unwrap().clone();
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

        // Create an "existing" plugin with service_id "example-plugin"
        let existing_dir = plugins_dir.join("example-plugin");
        std::fs::create_dir_all(&existing_dir).unwrap();
        std::fs::write(
            existing_dir.join("plugin.json"),
            r#"{
                "name": "Example Plugin Original",
                "slug": "example-plugin",
                "service_id": "example-plugin",
                "version": "1.0.0",
                "description": "Original example-plugin plugin",
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
            name: "Example Plugin Clone".to_string(),
            service_id: Some("example-plugin".to_string()),
            slug: "example-plugin".to_string(), // slug == service_id (required by validation)
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
            host_bridge: None,
            instructions: None,
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
            name: "Example Plugin Fork".to_string(),
            service_id: Some("example-plugin".to_string()),
            slug: "example-plugin-fork".to_string(),
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
                required: true,
                description: None,
                validation: None,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
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
                required: true,
                description: None,
                validation: None,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
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
                required: true,
                description: None,
                validation: None,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
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
    fn auth_field_description_defaults_to_none_when_omitted() {
        let json = r#"{
            "key": "example_pat",
            "label": "Token",
            "field_type": "password",
            "placeholder": "tok_...",
            "is_secret": true
        }"#;
        let field: AuthFieldDef = serde_json::from_str(json).unwrap();
        assert_eq!(field.description, None);
        // required also defaults to true when omitted (regression guard)
        assert!(field.required);
    }

    #[test]
    fn auth_field_description_parses_when_present() {
        let json = r#"{
            "key": "example_pat",
            "label": "Token",
            "field_type": "password",
            "placeholder": "tok_...",
            "is_secret": true,
            "description": "Generate at example.com → Settings → Security."
        }"#;
        let field: AuthFieldDef = serde_json::from_str(json).unwrap();
        assert_eq!(
            field.description.as_deref(),
            Some("Generate at example.com → Settings → Security.")
        );
    }

    #[test]
    fn auth_field_description_empty_string_is_preserved_not_none() {
        // An explicit empty string must round-trip as Some(""), not be
        // coerced to None — the author chose to render nothing deliberately.
        let json = r#"{
            "key": "example_pat",
            "label": "Token",
            "field_type": "password",
            "placeholder": "",
            "is_secret": true,
            "description": ""
        }"#;
        let field: AuthFieldDef = serde_json::from_str(json).unwrap();
        assert_eq!(field.description.as_deref(), Some(""));
    }

    // ── #5: auth_field validation (regex pattern + message) ────────────────

    /// Builds a minimal valid manifest carrying a single secret auth field
    /// with the supplied optional validation, for `validate_manifest` tests.
    fn manifest_with_validation(validation: Option<AuthFieldValidation>) -> PluginManifest {
        PluginManifest {
            name: "Test".to_string(),
            // service_id: None so validate_manifest doesn't require a
            // Containerfile on disk — the pattern check runs regardless.
            service_id: None,
            slug: "test-plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![AuthFieldDef {
                key: "token".to_string(),
                label: "Token".to_string(),
                field_type: "password".to_string(),
                placeholder: "".to_string(),
                is_secret: true,
                required: true,
                description: None,
                validation,
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
        }
    }

    fn field_with_validation(validation: Option<AuthFieldValidation>) -> AuthFieldDef {
        AuthFieldDef {
            key: "token".to_string(),
            label: "Example Plugin Token".to_string(),
            field_type: "password".to_string(),
            placeholder: "".to_string(),
            is_secret: true,
            required: true,
            description: None,
            validation,
        }
    }

    #[test]
    fn auth_field_validation_defaults_to_none_when_omitted() {
        let json = r#"{
            "key": "token", "label": "T", "field_type": "password",
            "placeholder": "", "is_secret": true
        }"#;
        let field: AuthFieldDef = serde_json::from_str(json).unwrap();
        assert!(field.validation.is_none());
    }

    #[test]
    fn auth_field_validation_parses_pattern_and_message() {
        let json = r#"{
            "key": "token", "label": "T", "field_type": "password",
            "placeholder": "", "is_secret": true,
            "validation": { "pattern": "^tok_[A-Za-z0-9_-]+$", "message": "Must start with tok_" }
        }"#;
        let field: AuthFieldDef = serde_json::from_str(json).unwrap();
        let v = field.validation.expect("validation should parse");
        assert_eq!(v.pattern, "^tok_[A-Za-z0-9_-]+$");
        assert_eq!(v.message.as_deref(), Some("Must start with tok_"));
    }

    #[test]
    fn auth_field_validation_message_optional() {
        let json = r#"{
            "key": "token", "label": "T", "field_type": "password",
            "placeholder": "", "is_secret": true,
            "validation": { "pattern": "^x+$" }
        }"#;
        let field: AuthFieldDef = serde_json::from_str(json).unwrap();
        assert!(field.validation.unwrap().message.is_none());
    }

    #[test]
    fn validate_manifest_accepts_valid_pattern() {
        let m = manifest_with_validation(Some(AuthFieldValidation {
            pattern: "^tok_[A-Za-z0-9_-]+$".to_string(),
            message: Some("bad".to_string()),
        }));
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&m, tmp.path()).is_ok());
    }

    #[test]
    fn validate_manifest_rejects_empty_pattern() {
        let m = manifest_with_validation(Some(AuthFieldValidation {
            pattern: "".to_string(),
            message: None,
        }));
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&m, tmp.path()).unwrap_err().to_string();
        assert!(err.contains("empty validation.pattern"), "got: {err}");
    }

    #[test]
    fn validate_manifest_rejects_oversized_pattern() {
        let huge = "a".repeat(consts::PLUGIN_AUTH_FIELD_PATTERN_MAX_LEN + 1);
        let m = manifest_with_validation(Some(AuthFieldValidation {
            pattern: huge,
            message: None,
        }));
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&m, tmp.path()).unwrap_err().to_string();
        assert!(err.contains("exceeds"), "got: {err}");
    }

    #[test]
    fn validate_manifest_rejects_uncompilable_pattern() {
        // Unbalanced group — invalid in the Rust regex crate.
        let m = manifest_with_validation(Some(AuthFieldValidation {
            pattern: "^(tok_".to_string(),
            message: None,
        }));
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&m, tmp.path()).unwrap_err().to_string();
        assert!(err.contains("invalid validation.pattern"), "got: {err}");
    }

    #[test]
    fn validate_credential_value_ok_when_no_validation() {
        let field = field_with_validation(None);
        assert!(validate_credential_value(&field, "anything at all").is_ok());
    }

    #[test]
    fn validate_credential_value_ok_for_empty_value() {
        // Empty == "leave stored value untouched"; required-ness is enforced
        // elsewhere, so the pattern must not fire on an empty submission.
        let field = field_with_validation(Some(AuthFieldValidation {
            pattern: "^tok_.+$".to_string(),
            message: None,
        }));
        assert!(validate_credential_value(&field, "").is_ok());
    }

    #[test]
    fn validate_credential_value_accepts_matching() {
        let field = field_with_validation(Some(AuthFieldValidation {
            pattern: "^tok_[A-Za-z0-9_-]+$".to_string(),
            message: Some("nope".to_string()),
        }));
        assert!(validate_credential_value(&field, "tok_abc-123_XYZ").is_ok());
    }

    #[test]
    fn validate_credential_value_rejects_mismatch_with_author_message() {
        let field = field_with_validation(Some(AuthFieldValidation {
            pattern: "^tok_[A-Za-z0-9_-]+$".to_string(),
            message: Some("Token must start with tok_".to_string()),
        }));
        let err = validate_credential_value(&field, "ghp_wrongprefix").unwrap_err();
        assert_eq!(err, "Token must start with tok_");
    }

    #[test]
    fn validate_credential_value_rejects_mismatch_with_generic_fallback() {
        let field = field_with_validation(Some(AuthFieldValidation {
            pattern: "^tok_.+$".to_string(),
            message: None,
        }));
        let err = validate_credential_value(&field, "bad").unwrap_err();
        // Falls back to a message naming the field's label, not its key.
        assert!(err.contains("Example Plugin Token"), "got: {err}");
    }

    #[test]
    fn validate_credential_value_is_anchored_full_match() {
        // A value that only *contains* a match (but has extra chars) must be
        // rejected — anchoring mirrors the HTML pattern's full-match rule.
        let field = field_with_validation(Some(AuthFieldValidation {
            pattern: "tok_[a-z]+".to_string(), // intentionally un-anchored by author
            message: Some("bad".to_string()),
        }));
        assert!(validate_credential_value(&field, "tok_abc").is_ok());
        assert!(
            validate_credential_value(&field, "prefix_tok_abc_suffix").is_err(),
            "partial match must be rejected by the anchoring wrapper"
        );
    }

    // ── instructions (long-form Markdown for the Dashboard) ────────────────

    #[test]
    fn manifest_instructions_defaults_to_none_when_omitted() {
        let json = r#"{ "name": "T", "slug": "t", "version": "1.0.0", "description": "d" }"#;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.instructions, None);
    }

    #[test]
    fn manifest_instructions_parses_when_present() {
        // r##"…"## so the markdown `"#` heading doesn't close the raw string.
        let json = r##"{
            "name": "T", "slug": "t", "version": "1.0.0", "description": "d",
            "instructions": "# Setup\n1. Do the thing"
        }"##;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.instructions.as_deref(), Some("# Setup\n1. Do the thing"));
    }

    #[test]
    fn validate_manifest_accepts_instructions_within_cap() {
        let mut m = manifest_with_validation(None);
        m.instructions = Some("## How to configure\n- step one\n- step two".to_string());
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&m, tmp.path()).is_ok());
    }

    #[test]
    fn validate_manifest_rejects_oversized_instructions() {
        let mut m = manifest_with_validation(None);
        m.instructions = Some("a".repeat(consts::PLUGIN_INSTRUCTIONS_MAX_BYTES + 1));
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&m, tmp.path()).unwrap_err().to_string();
        assert!(err.contains("`instructions` exceeds"), "got: {err}");
    }

    #[test]
    fn validate_credential_value_surfaces_invalid_pattern_error() {
        // The map_err arm of validate_credential_value: a pattern that fails
        // to compile (unbalanced group) must surface a clear error, not panic.
        // Unreachable post-install (validate_manifest gates it) but defended.
        let field = field_with_validation(Some(AuthFieldValidation {
            pattern: "(".to_string(),
            message: Some("nope".to_string()),
        }));
        let err = validate_credential_value(&field, "anything").unwrap_err();
        assert!(err.contains("invalid validation.pattern"), "got: {err}");
    }

    #[test]
    fn validate_manifest_accepts_pattern_at_cap() {
        // Boundary: len == cap is allowed; only > cap is rejected.
        let at_cap = "a".repeat(consts::PLUGIN_AUTH_FIELD_PATTERN_MAX_LEN);
        let m = manifest_with_validation(Some(AuthFieldValidation {
            pattern: at_cap,
            message: None,
        }));
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&m, tmp.path()).is_ok());
    }

    #[test]
    fn validate_manifest_accepts_instructions_at_cap() {
        // Boundary: len == cap is allowed; only > cap is rejected.
        let mut m = manifest_with_validation(None);
        m.instructions = Some("a".repeat(consts::PLUGIN_INSTRUCTIONS_MAX_BYTES));
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_manifest(&m, tmp.path()).is_ok());
    }

    #[test]
    fn allowed_auth_field_types_match_ts_union() {
        // Cross-language SSOT guard (cf. host_gateway_alias_matches_mcp_shared_ts):
        // the TS `PluginAuthFieldType` union must list exactly the Rust
        // ALLOWED_AUTH_FIELD_TYPES, so the credentials form can't silently
        // diverge from what validate_manifest accepts.
        let src = include_str!("../../../desktop/src/src/app/models/plugin.ts");
        let re = regex::Regex::new(r"export\s+type\s+PluginAuthFieldType\s*=\s*([^;]+);").unwrap();
        let cap = re
            .captures(src)
            .expect("plugin.ts must declare `export type PluginAuthFieldType`");
        let mut ts_types: Vec<String> = cap[1]
            .split('|')
            .map(|s| s.trim().trim_matches(['\'', '"']).to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts_types.sort();
        let mut rust_types: Vec<String> = ALLOWED_AUTH_FIELD_TYPES
            .iter()
            .map(|s| s.to_string())
            .collect();
        rust_types.sort();
        assert_eq!(
            ts_types, rust_types,
            "TS PluginAuthFieldType must match Rust ALLOWED_AUTH_FIELD_TYPES"
        );
    }

    #[test]
    fn compile_anchored_pattern_enforces_invariants() {
        // empty / oversized / uncompilable all rejected; valid compiles and
        // matches anchored (full-match only).
        assert!(compile_anchored_pattern("").unwrap_err().contains("empty"));
        let huge = "a".repeat(consts::PLUGIN_AUTH_FIELD_PATTERN_MAX_LEN + 1);
        assert!(compile_anchored_pattern(&huge)
            .unwrap_err()
            .contains("exceeds"));
        assert!(compile_anchored_pattern("(")
            .unwrap_err()
            .contains("invalid"));
        let re = compile_anchored_pattern("tok_[a-z]+").unwrap();
        assert!(re.is_match("tok_abc"));
        assert!(
            !re.is_match("x tok_abc"),
            "compile_anchored_pattern must wrap in ^(?:…)$ for full-match"
        );
    }

    #[test]
    fn test_token_dir_returns_correct_path() {
        // Isolated: build under a tempdir home instead of consts::data_dir().
        let tmp = tempfile::tempdir().unwrap();
        let result = token_dir_with_base(tmp.path(), "myproject", "example-plugin");
        let expected_suffix = std::path::Path::new(".speedwave/tokens/myproject/example-plugin");
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
                host_bridge: None,
                instructions: None,
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
                host_bridge: None,
                instructions: None,
            };
            let err = validate_manifest(&manifest, dir.path())
                .expect_err("slug colliding with built-in compose name must be rejected");
            let msg = err.to_string();
            assert!(
                msg.contains("built-in"),
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
            "LD_AUDIT",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "DYLD_FORCE_FLAT_NAMESPACE",
            "NODE_OPTIONS",
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "PATH",
            "HOME",
            "SHELL",
            "IFS",
            "BASH_ENV",
            "ENV",
            "PORT",
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
                host_bridge: None,
                instructions: None,
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

    // ── host_bridge manifest validation ─────────────────────────────────

    fn fixture_host_bridge_manifest_with(
        roles: HashMap<String, HostBridgeRoleAuth>,
        url_env: &str,
        token_env: &str,
        display_name: &str,
    ) -> HostBridgeManifest {
        HostBridgeManifest {
            url_env: url_env.to_string(),
            token_env: token_env.to_string(),
            roles,
            origin_policy: HostBridgeOriginPolicy::default(),
            max_frame_bytes: None,
            collision_policy: HostBridgeCollisionPolicy::default(),
            pending_slot_timeout_secs: None,
            display_name: display_name.to_string(),
            preferred_port: None,
            persistent_token: false,
        }
    }

    fn fixture_manifest_with_host_bridge(bridge: HostBridgeManifest) -> PluginManifest {
        PluginManifest {
            name: "test".to_string(),
            service_id: None,
            slug: "test-bridge".to_string(),
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
            host_bridge: Some(bridge),
            instructions: None,
        }
    }

    fn valid_roles() -> HashMap<String, HostBridgeRoleAuth> {
        HashMap::from([
            (
                "worker".to_string(),
                HostBridgeRoleAuth::Header {
                    name: "x-auth".to_string(),
                },
            ),
            (
                "plugin".to_string(),
                HostBridgeRoleAuth::QueryParam {
                    name: "token".to_string(),
                },
            ),
        ])
    }

    #[test]
    fn test_validate_manifest_accepts_valid_host_bridge() {
        let bridge = fixture_host_bridge_manifest_with(
            valid_roles(),
            "MY_BRIDGE_URL",
            "MY_BRIDGE_TOKEN",
            "My Bridge",
        );
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        validate_manifest(&manifest, tmp.path()).expect("valid host_bridge must pass");
    }

    #[test]
    fn test_validate_manifest_accepts_preferred_port_60123() {
        let mut bridge = fixture_host_bridge_manifest_with(valid_roles(), "X_URL", "X_TOKEN", "X");
        bridge.preferred_port = Some(60123);
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        validate_manifest(&manifest, tmp.path()).expect("preferred_port 60123 must pass");
    }

    #[test]
    fn test_plugin_state_dir_returns_plugin_state_path_for_slug() {
        // Isolated: exercise the path logic via the _for variant on a tempdir
        // so we never resolve consts::data_dir() / the real ~/.speedwave.
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path().join("plugins");
        let dir = plugin_state_dir_for(&plugins_dir, "my-plugin");
        assert!(
            dir.to_string_lossy().contains("plugin-state"),
            "expected 'plugin-state' in path, got {}",
            dir.display()
        );
        assert!(dir.ends_with("my-plugin"));
    }

    #[test]
    fn test_validate_manifest_accepts_preferred_port_1024() {
        let mut bridge = fixture_host_bridge_manifest_with(valid_roles(), "X_URL", "X_TOKEN", "X");
        bridge.preferred_port = Some(1024);
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        validate_manifest(&manifest, tmp.path()).expect("preferred_port 1024 boundary must pass");
    }

    #[test]
    fn test_validate_manifest_rejects_preferred_port_below_1024() {
        let mut bridge = fixture_host_bridge_manifest_with(valid_roles(), "X_URL", "X_TOKEN", "X");
        bridge.preferred_port = Some(80);
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("preferred_port 80 must be rejected");
        assert!(
            err.to_string().contains("> 1023"),
            "expected port-range rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_accepts_persistent_token_true() {
        let mut bridge = fixture_host_bridge_manifest_with(valid_roles(), "X_URL", "X_TOKEN", "X");
        bridge.persistent_token = true;
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        validate_manifest(&manifest, tmp.path()).expect("persistent_token true must pass");
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_empty_roles() {
        let bridge = fixture_host_bridge_manifest_with(HashMap::new(), "X_URL", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err =
            validate_manifest(&manifest, tmp.path()).expect_err("empty roles must be rejected");
        assert!(
            err.to_string().contains("at least one role"),
            "expected roles-empty rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_empty_display_name() {
        let bridge = fixture_host_bridge_manifest_with(valid_roles(), "X_URL", "X_TOKEN", "   ");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("blank display_name must be rejected");
        assert!(
            err.to_string().contains("display_name"),
            "expected display_name rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_reserved_url_env() {
        // PORT is in RESERVED_ENV_KEYS (auto-injected by Speedwave).
        let bridge = fixture_host_bridge_manifest_with(valid_roles(), "PORT", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("reserved url_env must be rejected");
        assert!(
            err.to_string().contains("reserved"),
            "expected reserved-key rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_reserved_token_env() {
        // LD_PRELOAD is a dangerous runtime hijack vector reserved by Speedwave.
        let bridge = fixture_host_bridge_manifest_with(valid_roles(), "X_URL", "LD_PRELOAD", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("reserved token_env must be rejected");
        assert!(
            err.to_string().contains("reserved"),
            "expected reserved-key rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_equal_url_and_token_env() {
        // Same env name on both fields would collide on the container env.
        let bridge =
            fixture_host_bridge_manifest_with(valid_roles(), "SAME_NAME", "SAME_NAME", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("identical url_env/token_env must be rejected");
        assert!(
            err.to_string().contains("must differ"),
            "expected differ rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_control_char_in_env_name() {
        let bridge =
            fixture_host_bridge_manifest_with(valid_roles(), "URL\nWITH_NEWLINE", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("control char in url_env must be rejected");
        assert!(
            err.to_string().contains("control"),
            "expected control-char rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_equal_sign_in_env_name() {
        let bridge = fixture_host_bridge_manifest_with(valid_roles(), "URL=oops", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err =
            validate_manifest(&manifest, tmp.path()).expect_err("'=' in url_env must be rejected");
        assert!(
            err.to_string().contains("'='"),
            "expected '=' rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_empty_role_auth_name() {
        let roles = HashMap::from([(
            "worker".to_string(),
            HostBridgeRoleAuth::Header {
                name: String::new(),
            },
        )]);
        let bridge = fixture_host_bridge_manifest_with(roles, "X_URL", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("empty auth scheme name must be rejected");
        assert!(
            err.to_string().contains("must not be empty"),
            "expected empty-name rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_control_char_in_role_auth_name() {
        let roles = HashMap::from([(
            "worker".to_string(),
            HostBridgeRoleAuth::QueryParam {
                name: "tok\0bad".to_string(),
            },
        )]);
        let bridge = fixture_host_bridge_manifest_with(roles, "X_URL", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("control char in auth scheme name must be rejected");
        assert!(
            err.to_string().contains("control character"),
            "expected control-char rejection, got: {err}"
        );
    }

    // ── host_bridge oversize edge cases ─────────────────────────────────

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_oversize_url_env() {
        let huge = "X".repeat(consts::PLUGIN_BRIDGE_ENV_NAME_MAX_LEN + 1);
        let bridge = fixture_host_bridge_manifest_with(valid_roles(), &huge, "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("oversize url_env must be rejected");
        assert!(
            err.to_string().contains("must not exceed"),
            "expected oversize rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_oversize_token_env() {
        let huge = "Y".repeat(consts::PLUGIN_BRIDGE_ENV_NAME_MAX_LEN + 1);
        let bridge = fixture_host_bridge_manifest_with(valid_roles(), "X_URL", &huge, "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("oversize token_env must be rejected");
        assert!(
            err.to_string().contains("must not exceed"),
            "expected oversize rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_oversize_display_name() {
        let huge = "D".repeat(consts::PLUGIN_BRIDGE_DISPLAY_NAME_MAX_LEN + 1);
        let bridge = fixture_host_bridge_manifest_with(valid_roles(), "X_URL", "X_TOKEN", &huge);
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("oversize display_name must be rejected");
        assert!(
            err.to_string().contains("display_name must not exceed"),
            "expected display_name oversize rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_oversize_role_name() {
        let huge_role = "r".repeat(consts::PLUGIN_BRIDGE_ROLE_NAME_MAX_LEN + 1);
        let roles = HashMap::from([(
            huge_role,
            HostBridgeRoleAuth::Header {
                name: "x-auth".to_string(),
            },
        )]);
        let bridge = fixture_host_bridge_manifest_with(roles, "X_URL", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("oversize role name must be rejected");
        assert!(
            err.to_string().contains("role name must not exceed"),
            "expected role-name oversize rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_oversize_auth_scheme_name() {
        let huge_name = "h".repeat(consts::PLUGIN_BRIDGE_AUTH_NAME_MAX_LEN + 1);
        let roles = HashMap::from([(
            "worker".to_string(),
            HostBridgeRoleAuth::Header { name: huge_name },
        )]);
        let bridge = fixture_host_bridge_manifest_with(roles, "X_URL", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err = validate_manifest(&manifest, tmp.path())
            .expect_err("oversize auth scheme name must be rejected");
        assert!(
            err.to_string().contains("auth scheme name must not exceed"),
            "expected auth-name oversize rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_host_bridge_with_too_many_roles() {
        let mut roles = HashMap::new();
        for i in 0..=consts::PLUGIN_BRIDGE_ROLES_MAX_COUNT {
            roles.insert(
                format!("role{i}"),
                HostBridgeRoleAuth::Header {
                    name: format!("x-auth-{i}"),
                },
            );
        }
        let bridge = fixture_host_bridge_manifest_with(roles, "X_URL", "X_TOKEN", "X");
        let manifest = fixture_manifest_with_host_bridge(bridge);
        let tmp = tempfile::tempdir().unwrap();
        let err =
            validate_manifest(&manifest, tmp.path()).expect_err("too many roles must be rejected");
        assert!(
            err.to_string().contains("must not exceed"),
            "expected roles-count rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_mem_limit_exceeding_cap() {
        // 999g (≈ 1 TiB) far exceeds PLUGIN_MEM_LIMIT_MAX_MIB.
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
            host_bridge: None,
            instructions: None,
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
            host_bridge: None,
            instructions: None,
        };
        let err = validate_manifest(&manifest, dir.path())
            .expect_err("cpu_limit beyond cap must be rejected");
        assert!(
            err.to_string().contains("exceeds maximum"),
            "expected upper-bound rejection, got: {err}"
        );
    }

    #[test]
    fn test_validate_manifest_rejects_non_positive_or_nonfinite_cpu_limit() {
        // "nan"/"inf" parse to NaN/inf; "0"/"-1" parse to non-positive
        // values. All four must be rejected by the
        // `!cores.is_finite() || cores <= 0.0` guard, not silently passed
        // through into `cpus: <value>` in the rendered compose.
        for bad in ["nan", "inf", "-inf", "0", "-1", "-0.5"] {
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
                cpu_limit: Some(bad.to_string()),
                requires_integrations: vec![],
                host_bridge: None,
                instructions: None,
            };
            let err =
                validate_manifest(&manifest, dir.path()).expect_err("cpu_limit must be rejected");
            assert!(
                err.to_string().contains("positive"),
                "expected positivity rejection for '{bad}', got: {err}"
            );
        }
    }

    #[test]
    fn test_validate_manifest_rejects_non_object_settings_schema() {
        // `settings_schema` is consumed by the Desktop UI as a JSON
        // Schema object. A non-object value (array, scalar, …) cannot
        // be a Draft-7 schema and would silently break the settings
        // form for the plugin. Reject at install.
        let dir = tempfile::tempdir().unwrap();
        for non_object in [
            serde_json::json!("not a schema"),
            serde_json::json!([{"type": "object"}]),
            serde_json::json!(42),
            serde_json::json!(null),
        ] {
            let manifest = PluginManifest {
                name: "Test".to_string(),
                service_id: None,
                slug: "test-schema".to_string(),
                version: "1.0.0".to_string(),
                description: "test".to_string(),
                port: None,
                image_tag: None,
                resources: vec![],
                token_mount: TokenMount::ReadOnly,
                auth_fields: vec![],
                settings_schema: Some(non_object.clone()),
                speedwave_compat: None,
                extra_env: None,
                mem_limit: None,
                cpu_limit: None,
                requires_integrations: vec![],
                host_bridge: None,
                instructions: None,
            };
            let err = validate_manifest(&manifest, dir.path())
                .expect_err("non-object settings_schema must be rejected");
            assert!(
                err.to_string()
                    .contains("settings_schema must be a JSON object"),
                "expected JSON-object rejection, got: {err} (input was {non_object:?})"
            );
        }
    }

    #[test]
    fn test_validate_manifest_rejects_oversized_settings_schema() {
        // 1 MiB pseudo-schema — 16x the cap. Should be rejected.
        let big_string = "x".repeat(1024 * 1024);
        let schema = serde_json::json!({
            "type": "object",
            "description": big_string,
        });
        let dir = tempfile::tempdir().unwrap();
        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: None,
            slug: "test-schema-big".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: Some(schema),
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
        };
        let err = validate_manifest(&manifest, dir.path())
            .expect_err("oversized settings_schema must be rejected");
        assert!(err.to_string().contains("exceeds"));
    }

    #[test]
    fn test_validate_manifest_accepts_valid_settings_schema() {
        // Sanity: an in-tree-style schema must still pass.
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "currency": {
                    "type": "string",
                    "enum": ["PLN", "EUR", "USD"]
                }
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: None,
            slug: "test-schema-ok".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: Some(schema),
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
        };
        validate_manifest(&manifest, dir.path()).expect("valid schema must pass");
    }

    #[test]
    fn test_parse_mem_limit_to_mib_units() {
        assert_eq!(parse_mem_limit_to_mib("1024m").unwrap(), 1024);
        assert_eq!(parse_mem_limit_to_mib("2g").unwrap(), 2048);
        assert_eq!(parse_mem_limit_to_mib("1G").unwrap(), 1024);
        assert_eq!(parse_mem_limit_to_mib("1024K").unwrap(), 1);
        // 512000 bare bytes → 0 MiB after integer division, but still
        // a real cap (non-zero n), so accepted.
        assert_eq!(parse_mem_limit_to_mib("512000").unwrap(), 0);
        assert!(parse_mem_limit_to_mib("").is_err());
        assert!(parse_mem_limit_to_mib("abc").is_err());
        assert!(parse_mem_limit_to_mib("1x").is_err());
        // Explicit zero means "no limit" in Docker — must be rejected
        // so a plugin can't bypass PLUGIN_MEM_LIMIT_MAX_MIB.
        assert!(parse_mem_limit_to_mib("0").is_err());
        assert!(parse_mem_limit_to_mib("0m").is_err());
        assert!(parse_mem_limit_to_mib("0g").is_err());
    }

    // --- build_pending_from_dir error accumulation tests ---

    /// Builds a mock runtime whose `build_image` always errors with "mock build failure".
    /// `image_exists` defaults to `false`; tests that need it `true` can override.
    fn failing_build_runtime() -> crate::runtime::LockedRuntime {
        let (rt, _) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_all_builds_failing("mock build failure")
            .build();
        rt
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

        let rt = failing_build_runtime();
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
        let _g = UnsignedBypassGuard::new();
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

        let rt = failing_build_runtime();
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
        let _g = UnsignedBypassGuard::new();
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

        let rt = failing_build_runtime();
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

        let rt = failing_build_runtime();
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

        let rt = failing_build_runtime();
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

    // --- ensure_plugin_images test helpers (delegating to MockRuntimeBuilder) ---

    /// Builds a mock with the given image tags marked as present. Successful
    /// builds insert the tag into the `image_exists` map (mirrors real-runtime
    /// semantics) so subsequent `image_exists` checks return `true` for that
    /// tag — letting tests assert exact build call counts.
    fn tracking_runtime(
        existing: &[&str],
    ) -> (
        crate::runtime::LockedRuntime,
        crate::runtime::mock_runtime::MockHandles,
    ) {
        let mut b = crate::runtime::mock_runtime::MockRuntimeBuilder::new();
        for tag in existing {
            b = b.with_image_exists(tag, true);
        }
        b.build()
    }

    /// Same as [`tracking_runtime`] but every `build_image` call fails with
    /// "mock build failure". Used for build-error accumulation tests.
    fn failing_tracking_runtime(
        existing: &[&str],
    ) -> (
        crate::runtime::LockedRuntime,
        crate::runtime::mock_runtime::MockHandles,
    ) {
        let mut b = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_all_builds_failing("mock build failure");
        for tag in existing {
            b = b.with_image_exists(tag, true);
        }
        b.build()
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
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "example-plugin", "1.4.6");

        let (rt, handle) = tracking_runtime(&[]); // no existing images
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], tmp.path()).unwrap();

        assert_eq!(
            handle.build_call_count(),
            1,
            "should build the missing image"
        );
        assert!(handle.was_built("speedwave-mcp-example-plugin:1.4.6"));
    }

    #[test]
    fn test_build_single_plugin_image_containerfile_path_has_separator() {
        // Regression: on Windows `prepare_build_context` returns a WSL path
        // (`/mnt/c/...`); building the Containerfile path with `PathBuf::join`
        // mangled it into `.../examplePluginContainerfile` (no separator). The
        // containerfile arg passed to `build_image` must always be
        // `<vm_root>/Containerfile`, separator intact, on every host OS.
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "example-plugin", "1.4.6");

        // Simulate the Windows case: prepare_build_context yields a WSL path.
        let wsl_root = std::path::PathBuf::from("/mnt/c/Users/u/.speedwave/plugins/example-plugin");
        let (rt, handle) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_prepare_build_context_root(wsl_root.clone())
            .build();
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], tmp.path()).unwrap();

        let calls = handle.build_calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "should build the image");
        let cf = &calls[0].containerfile;
        assert_eq!(
            cf, "/mnt/c/Users/u/.speedwave/plugins/example-plugin/Containerfile",
            "containerfile must be <vm_root>/Containerfile with separator, got: {cf}"
        );
        assert!(
            !cf.contains("examplePluginContainerfile"),
            "separator must not be dropped (Windows PathBuf::join bug), got: {cf}"
        );
        assert_eq!(
            calls[0].context_dir, "/mnt/c/Users/u/.speedwave/plugins/example-plugin",
            "context dir must be the WSL vm_root verbatim"
        );
    }

    #[test]
    fn test_ensure_plugin_images_skips_existing() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "example-plugin", "1.4.6");

        let (rt, handle) = tracking_runtime(&["speedwave-mcp-example-plugin:1.4.6"]); // image exists
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], tmp.path()).unwrap();

        assert_eq!(
            handle.build_call_count(),
            0,
            "should not rebuild existing image"
        );
    }

    #[test]
    fn test_ensure_plugin_images_skips_disabled_plugin() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "example-plugin", "1.4.6");

        let (rt, handle) = tracking_runtime(&[]); // no existing images
                                                  // enabled_service_ids is empty — example-plugin is disabled for this project
        ensure_plugin_images_from_dir(&rt, &[], tmp.path()).unwrap();

        assert_eq!(
            handle.build_call_count(),
            0,
            "disabled plugin should not be built"
        );
    }

    #[test]
    fn test_ensure_plugin_images_skips_resource_only_plugins() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_resource_only_plugin_dir(tmp.path(), "my-skills", "1.0.0");

        let (rt, handle) = tracking_runtime(&[]);
        // resource-only plugins have no service_id and no Containerfile
        ensure_plugin_images_from_dir(&rt, &["my-skills"], tmp.path()).unwrap();

        assert_eq!(
            handle.build_call_count(),
            0,
            "resource-only plugin has no image"
        );
    }

    #[test]
    fn test_ensure_plugin_images_handles_multiple_plugins_mixed_enabled() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0"); // enabled, missing image
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0"); // enabled, existing image
        make_mcp_plugin_dir(tmp.path(), "plugin-c", "1.0.0"); // disabled, missing image

        let (rt, handle) = tracking_runtime(&["speedwave-mcp-plugin-b:1.0.0"]); // B exists
        ensure_plugin_images_from_dir(&rt, &["plugin-a", "plugin-b"], tmp.path()).unwrap();

        assert_eq!(
            handle.build_call_count(),
            1,
            "only plugin-a should be built (plugin-b exists, plugin-c disabled)"
        );
        assert!(handle.was_built("speedwave-mcp-plugin-a:1.0.0"));
        assert!(!handle.was_built("speedwave-mcp-plugin-c:1.0.0"));
    }

    #[test]
    fn test_ensure_plugin_images_also_builds_pending_for_enabled() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "example-plugin", "1.4.6");
        // Add .image_pending marker
        std::fs::write(tmp.path().join("example-plugin").join(".image_pending"), "").unwrap();

        let (rt, handle) = tracking_runtime(&[]); // image missing
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], tmp.path()).unwrap();

        // Built exactly once: the pending pass builds it, then the second pass sees it via
        // image_exists() and skips. (TrackingRuntime.build_image now inserts into existing_images.)
        assert_eq!(
            handle.build_call_count(),
            1,
            "pending plugin image should be built exactly once"
        );
    }

    // --- Error path tests ---

    #[test]
    fn test_ensure_plugin_images_accumulates_build_errors() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0");
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0");

        let (rt, _handle) = failing_tracking_runtime(&[]); // build always fails
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
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0");
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0");

        let (rt, handle) = failing_tracking_runtime(&[]); // both fail
        let _ = ensure_plugin_images_from_dir(&rt, &["plugin-a", "plugin-b"], tmp.path());

        // Both should have been attempted despite first failure
        assert_eq!(
            handle.build_call_count(),
            2,
            "both plugins should be attempted"
        );
    }

    #[test]
    fn test_ensure_plugin_images_rejects_mcp_plugin_without_containerfile() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        // An MCP plugin (service_id present) with no Containerfile fails
        // `validate_manifest` inside the verified loader — `ensure_plugin_images`
        // now fails closed rather than warn-and-skip.
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

        let (rt, handle) = tracking_runtime(&[]);
        let err = ensure_plugin_images_from_dir(&rt, &["my-mcp"], tmp.path())
            .expect_err("MCP plugin without Containerfile must fail the verified loader");
        assert!(err.to_string().contains("Containerfile"));
        assert_eq!(handle.build_call_count(), 0);
    }

    #[test]
    fn test_ensure_plugin_images_image_exists_returns_err() {
        let _g = UnsignedBypassGuard::new();
        // image_exists returning Err should be treated as missing — attempt build
        // (which succeeds with the default builder), so the whole pass returns Ok.

        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "example-plugin", "1.0.0");

        let (rt, _handle) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_image_exists_error("runtime unavailable")
            .build();
        // image_exists returns Err → treated as missing → build attempted → succeeds
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], tmp.path()).unwrap();
    }

    // --- Edge cases ---

    #[test]
    fn test_ensure_plugin_images_empty_plugins_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let plugins_dir = tmp.path().join("plugins");
        std::fs::create_dir_all(&plugins_dir).unwrap();

        let (rt, handle) = tracking_runtime(&[]);
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], &plugins_dir).unwrap();
        assert_eq!(handle.build_call_count(), 0);
    }

    #[test]
    fn test_ensure_plugin_images_nonexistent_plugins_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent = tmp.path().join("does-not-exist");

        let (rt, handle) = tracking_runtime(&[]);
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], &nonexistent).unwrap();
        assert_eq!(handle.build_call_count(), 0);
    }

    #[test]
    fn test_ensure_plugin_images_rejects_invalid_manifest_json() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        // Plugin dir with invalid plugin.json — even with the unsigned
        // bypass active, the verified loader's manifest parse fails, so
        // the whole image-ensure pass must fail closed rather than
        // silently skip the bad plugin.
        let plugin_dir = tmp.path().join("bad-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("plugin.json"), "NOT VALID JSON").unwrap();

        let (rt, handle) = tracking_runtime(&[]);
        let err = ensure_plugin_images_from_dir(&rt, &["bad-plugin"], tmp.path())
            .expect_err("invalid manifest must fail the verified loader");
        assert!(err.to_string().contains("bad-plugin"));
        assert_eq!(
            handle.build_call_count(),
            0,
            "no build attempted on a failed load"
        );
    }

    #[test]
    fn test_ensure_plugin_images_custom_image_tag() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("example-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "example-plugin",
                "slug": "example-plugin",
                "service_id": "example-plugin",
                "version": "1.0.0",
                "image_tag": "custom-tag",
                "description": "test",
                "port": 4010
            }"#,
        )
        .unwrap();
        std::fs::write(plugin_dir.join("Containerfile"), "FROM scratch").unwrap();

        let (rt, handle) = tracking_runtime(&[]);
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], tmp.path()).unwrap();

        assert_eq!(handle.build_call_count(), 1);
        assert!(
            handle.was_built("speedwave-mcp-example-plugin:custom-tag"),
            "should use custom image_tag, got calls: {:?}",
            handle.build_tags()
        );
    }

    // --- Boundary / state tests ---

    #[test]
    fn test_ensure_plugin_images_pending_marker_cleared_after_build() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "example-plugin", "1.0.0");
        let pending = tmp.path().join("example-plugin").join(".image_pending");
        std::fs::write(&pending, "").unwrap();
        assert!(pending.exists(), "marker should exist before build");

        let (rt, _handle) = tracking_runtime(&[]); // image missing
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], tmp.path()).unwrap();

        assert!(
            !pending.exists(),
            "pending marker should be removed after successful build"
        );
    }

    #[test]
    fn test_ensure_plugin_images_image_exists_after_rebuild() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "example-plugin", "1.0.0");

        // First call: image missing → builds it
        let (rt, handle) = tracking_runtime(&[]);
        ensure_plugin_images_from_dir(&rt, &["example-plugin"], tmp.path()).unwrap();
        assert_eq!(handle.build_call_count(), 1, "first call should build");

        // Second call: image now exists (simulate by creating a runtime that knows about it)
        let (rt2, handle2) = tracking_runtime(&["speedwave-mcp-example-plugin:1.0.0"]);
        ensure_plugin_images_from_dir(&rt2, &["example-plugin"], tmp.path()).unwrap();
        assert_eq!(
            handle2.build_call_count(),
            0,
            "second call should skip build"
        );
    }

    // --- Critical interaction test: reconcile → restore_projects ---

    #[test]
    fn test_broken_plugin_does_not_block_unrelated_project_restore() {
        let _g = UnsignedBypassGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        make_mcp_plugin_dir(tmp.path(), "plugin-a", "1.0.0"); // will always fail to build
        make_mcp_plugin_dir(tmp.path(), "plugin-b", "1.0.0"); // will build successfully

        // Reconcile pass: union covers both enabled plugins; plugin-a fails but
        // the error is accumulated, not short-circuited.
        let (rt_failing, _) = failing_tracking_runtime(&[]);
        let union_result =
            ensure_plugin_images_from_dir(&rt_failing, &["plugin-a", "plugin-b"], tmp.path());
        assert!(
            union_result.is_err(),
            "reconcile-union should return error when plugin-a fails"
        );

        // Project using only plugin-b — succeeds (image already exists in this runtime).
        let (rt_b_exists, _) = tracking_runtime(&["speedwave-mcp-plugin-b:1.0.0"]);
        let project_b_result =
            ensure_plugin_images_from_dir(&rt_b_exists, &["plugin-b"], tmp.path());
        assert!(
            project_b_result.is_ok(),
            "project using only plugin-b should succeed: {:?}",
            project_b_result
        );

        // Project using only plugin-a — still fails.
        let (rt_a_missing, _) = failing_tracking_runtime(&[]);
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
            host_bridge: None,
            instructions: None,
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

//! Resolution and staging of bundled assets (build context, Node, binaries).

use crate::{build, consts};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Filename of the bundled manifest describing the shipped app version.
pub const BUNDLE_MANIFEST_FILE: &str = "bundle-manifest.json";
/// Filename of the persisted bundle reconciliation state.
pub const BUNDLE_STATE_FILE: &str = "bundle-state.json";

const REQUIRED_CLAUDE_RESOURCES: &[&str] = &[
    "CLAUDE.md",
    "settings.json",
    "statusline.sh",
    "output-styles/Speedwave.md",
];

/// Kind of a bundled asset, controlling how it is validated/staged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundledAssetKind {
    /// A regular file.
    File,
    /// A directory tree.
    Directory,
    /// A file that must be executable.
    ExecutableFile,
}

/// One asset shipped in the app bundle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BundledAssetSpec {
    /// Path relative to the bundle resources root.
    pub path: &'static str,
    /// Asset kind.
    pub kind: BundledAssetKind,
}

const COMMON_BUNDLED_ASSETS: &[BundledAssetSpec] = &[
    BundledAssetSpec {
        path: "build-context/containers",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "build-context/mcp-servers",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "mcp-os/os/dist/index.js",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "mcp-os/shared/dist",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "mcp-os/shared/package.json",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "mcp-os/shared/package-lock.json",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "mcp-os/shared/node_modules",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "mcp-os/os/node_modules/@speedwave/mcp-shared",
        kind: BundledAssetKind::Directory,
    },
    // `oauth` worker (ADR-060): host process like `mcp-os`, not in `build::IMAGES`.
    BundledAssetSpec {
        path: "oauth/oauth/dist/index.js",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "oauth/shared/dist",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "oauth/shared/package.json",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "oauth/shared/package-lock.json",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "oauth/shared/node_modules",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "oauth/oauth/node_modules/@speedwave/mcp-shared",
        kind: BundledAssetKind::Directory,
    },
];

const MACOS_BUNDLED_ASSETS: &[BundledAssetSpec] = &[
    BundledAssetSpec {
        path: "lima/bin/limactl",
        kind: BundledAssetKind::ExecutableFile,
    },
    BundledAssetSpec {
        path: "lima/share",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "nodejs/bin/node",
        kind: BundledAssetKind::ExecutableFile,
    },
    BundledAssetSpec {
        path: "cli/speedwave",
        kind: BundledAssetKind::ExecutableFile,
    },
    BundledAssetSpec {
        path: "reminders-cli",
        kind: BundledAssetKind::ExecutableFile,
    },
    BundledAssetSpec {
        path: "calendar-cli",
        kind: BundledAssetKind::ExecutableFile,
    },
    BundledAssetSpec {
        path: "mail-cli",
        kind: BundledAssetKind::ExecutableFile,
    },
    BundledAssetSpec {
        path: "notes-cli",
        kind: BundledAssetKind::ExecutableFile,
    },
    BundledAssetSpec {
        path: "audio-capture-cli",
        kind: BundledAssetKind::ExecutableFile,
    },
];

const WINDOWS_BUNDLED_ASSETS: &[BundledAssetSpec] = &[
    BundledAssetSpec {
        path: "wsl/nerdctl-full.tar.gz",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "wsl/ubuntu-rootfs.tar.gz",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "nodejs/node.exe",
        kind: BundledAssetKind::File,
    },
    BundledAssetSpec {
        path: "cli/speedwave.exe",
        kind: BundledAssetKind::File,
    },
];

/// Manifest of the currently shipped app bundle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleManifest {
    /// App version string.
    pub app_version: String,
    /// Reconcile id (app_version + image hashes + resources hash). Triggers
    /// resources sync + project restore; image rebuilds are per-image (ADR-072).
    pub bundle_id: String,
    /// Per-image build-input hash (image name → 16-char hex) used to tag images.
    /// One entry per `build::IMAGES`; empty ⇒ legacy pre-ADR-072, regenerated.
    #[serde(default)]
    pub image_hashes: std::collections::BTreeMap<String, String>,
    /// Hash of the claude-resources tree.
    pub claude_resources_hash: String,
}

impl BundleManifest {
    /// Build-input hash for image `name`; errors on names outside the catalogue.
    pub(crate) fn image_hash(&self, name: &str) -> anyhow::Result<&str> {
        self.image_hashes
            .get(name)
            .map(String::as_str)
            .ok_or_else(|| anyhow::anyhow!("no image hash for '{name}' in bundle manifest"))
    }

    /// Full image tag (`name:hash`) for image `name`.
    pub fn image_tag(&self, name: &str) -> anyhow::Result<String> {
        Ok(build::image_ref(name, self.image_hash(name)?))
    }

    /// Manifest mapping every catalogue image to `uniform_hash` — keeps legacy
    /// `name:test-bundle`-style tags working in tests.
    #[cfg(any(test, feature = "test-support"))]
    pub fn for_tests(uniform_hash: &str) -> Self {
        Self {
            app_version: "0.0.0-test".to_string(),
            bundle_id: uniform_hash.to_string(),
            image_hashes: build::IMAGES
                .iter()
                .map(|img| (img.name.to_string(), uniform_hash.to_string()))
                .collect(),
            claude_resources_hash: uniform_hash.to_string(),
        }
    }
}

/// Ordered stages of bundle reconciliation after an app upgrade.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BundleReconcilePhase {
    /// Reconciliation not yet started.
    Pending,
    /// Claude resources synced to the data dir.
    ResourcesSynced,
    /// Container images rebuilt.
    ImagesBuilt,
    /// Previously running projects restarted.
    ProjectsRestored,
    /// Reconciliation complete.
    #[default]
    Done,
}

/// Persisted reconciliation state across restarts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleState {
    /// Reconcile id currently applied, if any.
    pub applied_bundle_id: Option<String>,
    /// Per-image hashes currently applied; drives replaced-tag pruning.
    /// Empty on first run after migration from the single-id format.
    #[serde(default)]
    pub applied_image_hashes: std::collections::BTreeMap<String, String>,
    /// Current reconciliation phase.
    pub phase: BundleReconcilePhase,
    /// Projects to restart once reconciliation reaches that phase.
    pub pending_running_projects: Vec<String>,
    /// Last error encountered, if reconciliation failed.
    pub last_error: Option<String>,
}

impl BundleReconcilePhase {
    /// `true` if this phase precedes `other` in reconciliation order.
    pub fn is_before(self, other: Self) -> bool {
        self.order() < other.order()
    }

    fn order(self) -> u8 {
        match self {
            Self::Pending => 0,
            Self::ResourcesSynced => 1,
            Self::ImagesBuilt => 2,
            Self::ProjectsRestored => 3,
            Self::Done => 4,
        }
    }
}

/// Loads the bundle manifest from the resolved build root.
pub fn load_current_bundle_manifest() -> anyhow::Result<BundleManifest> {
    load_current_bundle_manifest_from(&build::resolve_build_root()?)
}

/// Env-free core of [`load_current_bundle_manifest`]: takes an explicit build
/// root instead of reading `SPEEDWAVE_RESOURCES_DIR` from env.
pub fn load_current_bundle_manifest_from(build_root: &Path) -> anyhow::Result<BundleManifest> {
    let manifest_path = build_root.join(BUNDLE_MANIFEST_FILE);
    if manifest_path.exists() {
        let data = std::fs::read_to_string(&manifest_path)?;
        let manifest: BundleManifest = serde_json::from_str(&data)?;
        // Pre-ADR-072 manifest (no per-image hashes) — regenerate from the tree.
        if !manifest.image_hashes.is_empty() {
            return Ok(manifest);
        }
    }
    generate_bundle_manifest(
        env!("CARGO_PKG_VERSION"),
        crate::defaults::CLAUDE_VERSION,
        build_root,
    )
}

/// Per-image hashes cover each image's declared `hash_inputs` + build args;
/// `claude_version` overrides the `CLAUDE_VERSION` build-arg value so callers
/// (desktop build.rs, CLI fallback, tests) control the pin. See ADR-072.
pub fn generate_bundle_manifest(
    app_version: &str,
    claude_version: &str,
    build_root: &Path,
) -> anyhow::Result<BundleManifest> {
    // Each distinct input is hashed once (mcp-servers/shared feeds every worker).
    let mut component_cache: std::collections::HashMap<&str, String> =
        std::collections::HashMap::new();
    let mut image_hashes = std::collections::BTreeMap::new();
    for img in build::IMAGES {
        let mut components: Vec<(&str, &str)> = Vec::with_capacity(img.hash_inputs.len());
        for input in img.hash_inputs {
            if !component_cache.contains_key(input) {
                let hash = digest_paths(&[(input, &build_root.join(input))])?;
                component_cache.insert(input, hash);
            }
        }
        for input in img.hash_inputs {
            components.push((input, component_cache[input].as_str()));
        }
        let effective_args: Vec<(&str, &str)> = img
            .build_args
            .iter()
            .map(|(k, v)| {
                (
                    *k,
                    if *k == "CLAUDE_VERSION" {
                        claude_version
                    } else {
                        *v
                    },
                )
            })
            .collect();
        image_hashes.insert(
            img.name.to_string(),
            image_content_hash(img.name, &effective_args, &components),
        );
    }

    let claude_resources_hash = digest_paths(&[(
        "claude-resources",
        &build_root.join("containers").join("claude-resources"),
    )])?;
    let bundle_id = reconcile_id(app_version, &image_hashes, &claude_resources_hash);

    Ok(BundleManifest {
        app_version: app_version.to_string(),
        bundle_id,
        image_hashes,
        claude_resources_hash,
    })
}

/// Pure hash of one image's build inputs: name + per-input component hashes +
/// effective build args. 16-char hex, used as the image tag suffix.
pub(crate) fn image_content_hash(
    name: &str,
    build_args: &[(&str, &str)],
    components: &[(&str, &str)],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update(b"\0");
    for (path, hash) in components {
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(hash.as_bytes());
        hasher.update(b"\0");
    }
    for (key, value) in build_args {
        hasher.update(key.as_bytes());
        hasher.update(b"=");
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    let mut hash = bytes_to_hex(&hasher.finalize());
    hash.truncate(16);
    hash
}

/// Reconcile id: app_version + sorted per-image hashes + resources hash.
/// app_version deliberately included — rationale in ADR-072.
fn reconcile_id(
    app_version: &str,
    image_hashes: &std::collections::BTreeMap<String, String>,
    claude_resources_hash: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(app_version.as_bytes());
    hasher.update(b"\0");
    for (name, hash) in image_hashes {
        hasher.update(name.as_bytes());
        hasher.update(b":");
        hasher.update(hash.as_bytes());
        hasher.update(b"\0");
    }
    hasher.update(claude_resources_hash.as_bytes());
    let mut id = bytes_to_hex(&hasher.finalize());
    id.truncate(16);
    id
}

/// Loads the persisted bundle state, defaulting if absent or unreadable.
pub fn load_bundle_state() -> BundleState {
    bundle_state_path()
        .ok()
        .and_then(|path| load_bundle_state_from(&path).ok())
        .unwrap_or_default()
}

/// Persists the bundle reconciliation state.
pub fn save_bundle_state(state: &BundleState) -> anyhow::Result<()> {
    let path = bundle_state_path()?;
    save_bundle_state_to(state, &path)
}

/// Atomically syncs claude-resources from the build root into the data dir.
pub fn sync_claude_resources(build_root: &Path) -> anyhow::Result<()> {
    let source = build_root.join("containers").join("claude-resources");
    validate_claude_resources(&source)?;

    let data_dir = consts::data_dir();
    std::fs::create_dir_all(data_dir)?;

    let target = data_dir.join("claude-resources");
    let staging = data_dir.join(format!("claude-resources.tmp-{}", uuid::Uuid::new_v4()));
    let backup = data_dir.join(format!("claude-resources.bak-{}", uuid::Uuid::new_v4()));

    copy_dir_recursive(&source, &staging)?;
    validate_claude_resources(&staging)?;

    if target.exists() {
        std::fs::rename(&target, &backup)?;
    }

    if let Err(err) = std::fs::rename(&staging, &target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(anyhow::Error::new(err));
    }

    if backup.exists() {
        if let Err(e) = std::fs::remove_dir_all(&backup) {
            log::warn!(
                "sync_claude_resources: failed to remove backup dir {}: {e}",
                backup.display()
            );
        }
    }

    Ok(())
}

/// Bundled assets required for `target_os` (`macos` | `windows`).
pub fn required_bundled_assets(target_os: &str) -> anyhow::Result<Vec<BundledAssetSpec>> {
    let mut assets = COMMON_BUNDLED_ASSETS.to_vec();
    match target_os {
        "macos" => assets.extend_from_slice(MACOS_BUNDLED_ASSETS),
        "windows" => assets.extend_from_slice(WINDOWS_BUNDLED_ASSETS),
        other => anyhow::bail!("unsupported target OS for bundled assets validation: {other}"),
    }
    Ok(assets)
}

/// Validates every required bundled asset exists at `resources_root`.
pub fn validate_bundled_runtime_assets(
    resources_root: &Path,
    target_os: &str,
    allow_stubs: bool,
) -> anyhow::Result<()> {
    for asset in required_bundled_assets(target_os)? {
        validate_bundled_asset(resources_root, asset, allow_stubs)?;
    }
    Ok(())
}

fn bundle_state_path() -> anyhow::Result<PathBuf> {
    Ok(consts::data_dir().join(BUNDLE_STATE_FILE))
}

fn load_bundle_state_from(path: &Path) -> anyhow::Result<BundleState> {
    let data = std::fs::read_to_string(path)?;
    serde_json::from_str(&data).map_err(anyhow::Error::from)
}

fn save_bundle_state_to(state: &BundleState, path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(state)?;
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(json.as_bytes())?;
        // fsync before rename — APFS/virtiofs can persist the rename before data blocks (torn write).
        crate::fs_perms::fsync_file_durable(&file)
            .map_err(|e| anyhow::anyhow!("fsync bundle-state before rename: {e}"))?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
fn sync_claude_resources_to(build_root: &Path, home: &Path) -> anyhow::Result<()> {
    let source = build_root.join("containers").join("claude-resources");
    validate_claude_resources(&source)?;

    let data_dir = home.join(consts::DATA_DIR);
    std::fs::create_dir_all(&data_dir)?;

    let target = data_dir.join("claude-resources");
    let staging = data_dir.join(format!("claude-resources.tmp-{}", uuid::Uuid::new_v4()));
    let backup = data_dir.join(format!("claude-resources.bak-{}", uuid::Uuid::new_v4()));

    copy_dir_recursive(&source, &staging)?;
    validate_claude_resources(&staging)?;

    if target.exists() {
        std::fs::rename(&target, &backup)?;
    }

    if let Err(err) = std::fs::rename(&staging, &target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(anyhow::Error::new(err));
    }

    if backup.exists() {
        if let Err(e) = std::fs::remove_dir_all(&backup) {
            log::warn!(
                "sync_claude_resources: failed to remove backup dir {}: {e}",
                backup.display()
            );
        }
    }

    Ok(())
}

fn validate_claude_resources(dir: &Path) -> anyhow::Result<()> {
    if !dir.is_dir() {
        anyhow::bail!("Claude resources directory not found at {}", dir.display());
    }
    for rel in REQUIRED_CLAUDE_RESOURCES {
        let path = dir.join(rel);
        if !path.exists() {
            anyhow::bail!("Missing required Claude resource: {}", path.display());
        }
    }
    Ok(())
}

fn validate_bundled_asset(
    resources_root: &Path,
    asset: BundledAssetSpec,
    allow_stubs: bool,
) -> anyhow::Result<()> {
    let path = resources_root.join(asset.path);
    match asset.kind {
        BundledAssetKind::File => {
            let meta = std::fs::metadata(&path)
                .map_err(|_| anyhow::anyhow!("Missing bundled asset file: {}", path.display()))?;
            if !meta.is_file() {
                anyhow::bail!("Bundled asset is not a file: {}", path.display());
            }
            if !allow_stubs && meta.len() == 0 {
                anyhow::bail!("Bundled asset file is empty: {}", path.display());
            }
        }
        BundledAssetKind::Directory => {
            if !path.is_dir() {
                anyhow::bail!("Missing bundled asset directory: {}", path.display());
            }
            if !allow_stubs && std::fs::read_dir(&path)?.next().is_none() {
                anyhow::bail!("Bundled asset directory is empty: {}", path.display());
            }
        }
        BundledAssetKind::ExecutableFile => {
            let meta = std::fs::metadata(&path).map_err(|_| {
                anyhow::anyhow!("Missing bundled executable asset: {}", path.display())
            })?;
            if !meta.is_file() {
                anyhow::bail!("Bundled executable asset is not a file: {}", path.display());
            }
            if !allow_stubs && meta.len() == 0 {
                anyhow::bail!("Bundled executable asset is empty: {}", path.display());
            }
            #[cfg(unix)]
            if !allow_stubs {
                use std::os::unix::fs::PermissionsExt;
                if meta.permissions().mode() & 0o111 == 0 {
                    anyhow::bail!(
                        "Bundled executable asset is not executable: {}",
                        path.display()
                    );
                }
            }
        }
    }
    Ok(())
}

fn digest_paths(paths: &[(&str, &Path)]) -> anyhow::Result<String> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for (prefix, path) in paths {
        collect_directory_entries(path, prefix, &mut entries)?;
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (rel, content) in entries {
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        hasher.update(&content);
    }
    Ok(bytes_to_hex(&hasher.finalize()))
}

fn collect_directory_entries(
    dir: &Path,
    prefix: &str,
    out: &mut Vec<(String, Vec<u8>)>,
) -> anyhow::Result<()> {
    if !dir.exists() {
        anyhow::bail!("Missing path for bundle digest: {}", dir.display());
    }
    // Reject symlinks: the copier dereferences them, changing content without changing the hash.
    if dir.is_symlink() {
        anyhow::bail!(
            "symlink not allowed in image hash inputs: {}",
            dir.display()
        );
    }
    if dir.is_file() {
        out.push((prefix.to_string(), std::fs::read(dir)?));
        return Ok(());
    }

    let mut children: Vec<PathBuf> = std::fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<_, _>>()?;
    children.sort();

    for child in children {
        // node_modules is not copied into the build context, so it is not image content.
        if child.is_dir() && child.file_name().is_some_and(|n| n == "node_modules") {
            continue;
        }
        // Reject symlinks: the copier dereferences them, changing content without changing the hash.
        if child.is_symlink() {
            anyhow::bail!(
                "symlink not allowed in image hash inputs: {}",
                child.display()
            );
        }
        let rel_name = child
            .strip_prefix(dir)
            .unwrap_or(&child)
            .to_string_lossy()
            .to_string();
        if child.is_dir() {
            collect_directory_entries(&child, &format!("{prefix}/{rel_name}"), out)?;
            continue;
        }
        let content = std::fs::read(&child)?;
        out.push((format!("{prefix}/{rel_name}"), content));
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
            // fsync each file — staging→target rename must not outlive the data (torn-write).
            let file = std::fs::File::open(&dst_path)
                .map_err(|e| anyhow::anyhow!("open {} for fsync: {e}", dst_path.display()))?;
            crate::fs_perms::fsync_file_durable(&file)
                .map_err(|e| anyhow::anyhow!("fsync {}: {e}", dst_path.display()))?;
        }
    }
    Ok(())
}

pub(crate) fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn digest_paths_rejects_top_level_symlinked_file_input() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real.sh");
        std::fs::write(&real, "x").unwrap();
        let link = tmp.path().join("link.sh");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let mut out = Vec::new();
        let err = collect_directory_entries(&link, "p", &mut out)
            .unwrap_err()
            .to_string();
        assert!(err.contains("symlink not allowed"), "got: {err}");
    }

    #[test]
    #[cfg(unix)]
    fn digest_paths_rejects_symlinked_hash_input() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("inputs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real.txt"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("real.txt"), dir.join("link.txt")).unwrap();
        let mut out = Vec::new();
        let err = collect_directory_entries(&dir, "p", &mut out)
            .unwrap_err()
            .to_string();
        assert!(err.contains("symlink not allowed"), "got: {err}");
    }

    #[test]
    fn collect_directory_entries_skips_node_modules_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("hub");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/index.ts"), "real").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "dep").unwrap();
        let mut out = Vec::new();
        collect_directory_entries(&dir, "p", &mut out).unwrap();
        let rels: Vec<&str> = out.iter().map(|(r, _)| r.as_str()).collect();
        assert!(rels.iter().any(|r| r.ends_with("src/index.ts")), "{rels:?}");
        assert!(
            !rels.iter().any(|r| r.contains("node_modules")),
            "node_modules must be excluded: {rels:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn collect_directory_entries_skips_node_modules_with_bin_symlink() {
        // node_modules/.bin/<tool> symlinks must be skipped, not bailed on.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("hub");
        std::fs::create_dir_all(dir.join("node_modules/.bin")).unwrap();
        let real = dir.join("node_modules/vitest/vitest.mjs");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, "x").unwrap();
        std::os::unix::fs::symlink(&real, dir.join("node_modules/.bin/vitest")).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        let mut out = Vec::new();
        let res = collect_directory_entries(&dir, "p", &mut out);
        assert!(
            res.is_ok(),
            "must not bail on node_modules symlinks: {res:?}"
        );
        assert!(out.iter().any(|(r, _)| r.ends_with("package.json")));
        assert!(!out.iter().any(|(r, _)| r.contains("node_modules")));
    }

    #[test]
    #[cfg(unix)]
    fn collect_directory_entries_skips_nested_node_modules() {
        // The skip applies at every recursion depth, not just the top level.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("hub");
        let nested = dir.join("packages/pkg/node_modules/.bin");
        std::fs::create_dir_all(&nested).unwrap();
        let real = dir.join("packages/pkg/node_modules/tool/tool.js");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, "x").unwrap();
        std::os::unix::fs::symlink(&real, nested.join("tool")).unwrap();
        std::fs::write(dir.join("packages/pkg/index.ts"), "real").unwrap();
        let mut out = Vec::new();
        collect_directory_entries(&dir, "p", &mut out).unwrap();
        assert!(out.iter().any(|(r, _)| r.ends_with("pkg/index.ts")));
        assert!(!out.iter().any(|(r, _)| r.contains("node_modules")));
    }

    #[test]
    #[cfg(unix)]
    fn node_modules_changes_do_not_alter_manifest_hash() {
        // node_modules is not image content; adding it must not change any image hash (ADR-072).
        let tmp = tempfile::tempdir().unwrap();
        write_build_tree(tmp.path());
        let before = generate_bundle_manifest("1.0.0", "2.0.0", tmp.path()).unwrap();
        let nm = tmp.path().join("mcp-servers/hub/node_modules/.bin");
        std::fs::create_dir_all(&nm).unwrap();
        let real = tmp
            .path()
            .join("mcp-servers/hub/node_modules/vitest/vitest.mjs");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, "x").unwrap();
        std::os::unix::fs::symlink(&real, nm.join("vitest")).unwrap();
        let after = generate_bundle_manifest("1.0.0", "2.0.0", tmp.path()).unwrap();
        assert_eq!(
            before.image_hashes, after.image_hashes,
            "node_modules must not affect image hashes"
        );
    }

    fn write_resource_tree(root: &Path) {
        std::fs::create_dir_all(root.join("containers/claude-resources/output-styles")).unwrap();
        std::fs::create_dir_all(root.join("mcp-servers/shared")).unwrap();
        std::fs::write(root.join("containers/Containerfile.claude"), "FROM test").unwrap();
        std::fs::write(root.join("mcp-servers/shared/package.json"), "{}").unwrap();
        std::fs::write(root.join("containers/claude-resources/CLAUDE.md"), "# docs").unwrap();
        std::fs::write(root.join("containers/claude-resources/settings.json"), "{}").unwrap();
        std::fs::write(
            root.join("containers/claude-resources/statusline.sh"),
            "#!/bin/sh",
        )
        .unwrap();
        std::fs::write(
            root.join("containers/claude-resources/output-styles/Speedwave.md"),
            "# style",
        )
        .unwrap();
    }

    /// Materializes every `hash_inputs` path of every catalogue image so
    /// `generate_bundle_manifest` can digest a synthetic build root.
    fn write_build_tree(root: &Path) {
        write_resource_tree(root);
        for img in build::IMAGES {
            for input in img.hash_inputs {
                let path = root.join(input);
                // Inputs with an extension are files; the rest are directories.
                if Path::new(input).extension().is_some() {
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent).unwrap();
                    }
                    if !path.exists() {
                        std::fs::write(&path, format!("stub for {input}")).unwrap();
                    }
                } else {
                    std::fs::create_dir_all(&path).unwrap();
                    let stub = path.join("src.ts");
                    if !stub.exists() {
                        std::fs::write(&stub, format!("content of {input}")).unwrap();
                    }
                }
            }
        }
    }

    /// Image names whose hash differs between two manifests.
    fn changed_images(a: &BundleManifest, b: &BundleManifest) -> Vec<String> {
        a.image_hashes
            .iter()
            .filter(|(name, hash)| b.image_hashes.get(*name) != Some(*hash))
            .map(|(name, _)| name.clone())
            .collect()
    }

    fn write_common_bundled_assets(root: &Path) {
        std::fs::create_dir_all(root.join("build-context/containers")).unwrap();
        std::fs::create_dir_all(root.join("build-context/mcp-servers")).unwrap();
        std::fs::create_dir_all(root.join("build-context/mcp-servers/shared")).unwrap();
        std::fs::create_dir_all(root.join("mcp-os/os/dist")).unwrap();
        std::fs::create_dir_all(root.join("mcp-os/shared/dist")).unwrap();
        std::fs::create_dir_all(root.join("mcp-os/shared/node_modules/pkg")).unwrap();
        std::fs::write(
            root.join("build-context/containers/Containerfile.claude"),
            "FROM test",
        )
        .unwrap();
        std::fs::write(
            root.join("build-context/mcp-servers/shared/package.json"),
            "{\"name\":\"shared\"}",
        )
        .unwrap();
        std::fs::write(root.join("mcp-os/os/dist/index.js"), "console.log('ok');").unwrap();
        std::fs::write(root.join("mcp-os/shared/dist/index.js"), "export {};").unwrap();
        std::fs::write(root.join("mcp-os/shared/package.json"), "{}").unwrap();
        std::fs::write(root.join("mcp-os/shared/package-lock.json"), "{}").unwrap();
        std::fs::write(
            root.join("mcp-os/shared/node_modules/pkg/index.js"),
            "module.exports = {};",
        )
        .unwrap();

        // Real directory copy (matches production bundle-build-context.sh behavior)
        let mcp_shared_dest = root.join("mcp-os/os/node_modules/@speedwave/mcp-shared");
        std::fs::create_dir_all(mcp_shared_dest.join("dist")).unwrap();
        std::fs::write(mcp_shared_dest.join("dist/index.js"), "export {};").unwrap();
        std::fs::write(mcp_shared_dest.join("package.json"), "{}").unwrap();
        std::fs::write(mcp_shared_dest.join("package-lock.json"), "{}").unwrap();

        // oauth worker — staged the same way as mcp-os (ADR-060).
        std::fs::create_dir_all(root.join("oauth/oauth/dist")).unwrap();
        std::fs::create_dir_all(root.join("oauth/shared/dist")).unwrap();
        std::fs::create_dir_all(root.join("oauth/shared/node_modules/pkg")).unwrap();
        std::fs::write(root.join("oauth/oauth/dist/index.js"), "console.log('ok');").unwrap();
        std::fs::write(root.join("oauth/shared/dist/index.js"), "export {};").unwrap();
        std::fs::write(root.join("oauth/shared/package.json"), "{}").unwrap();
        std::fs::write(root.join("oauth/shared/package-lock.json"), "{}").unwrap();
        std::fs::write(
            root.join("oauth/shared/node_modules/pkg/index.js"),
            "module.exports = {};",
        )
        .unwrap();
        let oa_shared_dest = root.join("oauth/oauth/node_modules/@speedwave/mcp-shared");
        std::fs::create_dir_all(oa_shared_dest.join("dist")).unwrap();
        std::fs::write(oa_shared_dest.join("dist/index.js"), "export {};").unwrap();
        std::fs::write(oa_shared_dest.join("package.json"), "{}").unwrap();
        std::fs::write(oa_shared_dest.join("package-lock.json"), "{}").unwrap();
    }

    #[cfg(unix)]
    fn write_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }

    #[cfg(not(unix))]
    fn write_executable(path: &Path) {
        std::fs::write(path, "binary").unwrap();
    }

    fn write_platform_bundled_assets(root: &Path, target_os: &str) {
        match target_os {
            "macos" => {
                std::fs::create_dir_all(root.join("lima/bin")).unwrap();
                std::fs::create_dir_all(root.join("lima/share")).unwrap();
                std::fs::create_dir_all(root.join("nodejs/bin")).unwrap();
                std::fs::create_dir_all(root.join("cli")).unwrap();
                write_executable(&root.join("lima/bin/limactl"));
                std::fs::write(root.join("lima/share/lima.yaml"), "images: []").unwrap();
                write_executable(&root.join("nodejs/bin/node"));
                write_executable(&root.join("cli/speedwave"));
                write_executable(&root.join("reminders-cli"));
                write_executable(&root.join("calendar-cli"));
                write_executable(&root.join("mail-cli"));
                write_executable(&root.join("notes-cli"));
                write_executable(&root.join("audio-capture-cli"));
            }
            "windows" => {
                std::fs::create_dir_all(root.join("wsl")).unwrap();
                std::fs::create_dir_all(root.join("cli")).unwrap();
                std::fs::create_dir_all(root.join("nodejs")).unwrap();
                std::fs::write(root.join("wsl/nerdctl-full.tar.gz"), "binary").unwrap();
                std::fs::write(root.join("wsl/ubuntu-rootfs.tar.gz"), "binary").unwrap();
                std::fs::write(root.join("nodejs/node.exe"), "binary").unwrap();
                std::fs::write(root.join("cli/speedwave.exe"), "binary").unwrap();
            }
            other => panic!("unexpected target os in test: {other}"),
        }
    }

    #[test]
    fn manifest_generation_is_deterministic() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());

        let a = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();
        let b = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();

        assert_eq!(a, b);
        assert_eq!(a.bundle_id.len(), 16);
        for img in build::IMAGES {
            let hash = a.image_hashes.get(img.name).expect("hash for every image");
            assert_eq!(hash.len(), 16, "16-char hash for {}", img.name);
        }
    }

    #[test]
    fn claude_input_change_rebuilds_only_claude() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());

        let before = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();
        std::fs::write(temp.path().join("containers/entrypoint.sh"), "changed").unwrap();
        let after = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();

        assert_eq!(
            changed_images(&before, &after),
            vec![build::IMAGE_CLAUDE.to_string()]
        );
        assert_ne!(before.bundle_id, after.bundle_id);
    }

    #[test]
    fn worker_input_change_is_isolated() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());

        let before = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();
        std::fs::write(temp.path().join("mcp-servers/slack/src.ts"), "changed").unwrap();
        let after = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();

        assert_eq!(
            changed_images(&before, &after),
            vec![build::IMAGE_MCP_SLACK.to_string()]
        );
    }

    #[test]
    fn shared_change_fans_out_to_all_workers_but_not_claude() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());

        let before = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();
        std::fs::write(temp.path().join("mcp-servers/shared/src.ts"), "changed").unwrap();
        let after = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();

        let changed = changed_images(&before, &after);
        assert!(!changed.contains(&build::IMAGE_CLAUDE.to_string()));
        assert!(!changed.contains(&build::IMAGE_MCP_PLAYWRIGHT.to_string()));
        for img in build::IMAGES {
            let is_shared_consumer = img.hash_inputs.contains(&"mcp-servers/shared");
            assert_eq!(
                changed.contains(&img.name.to_string()),
                is_shared_consumer,
                "shared change must rebuild exactly its consumers: {}",
                img.name
            );
        }
    }

    #[test]
    fn claude_version_changes_only_claude_hash() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());

        let before = generate_bundle_manifest("1.2.3", "2.1.143", temp.path()).unwrap();
        let after = generate_bundle_manifest("1.2.3", "2.1.153", temp.path()).unwrap();

        assert_eq!(
            changed_images(&before, &after),
            vec![build::IMAGE_CLAUDE.to_string()],
            "bumping CLAUDE_VERSION must rebuild only the claude image"
        );
        assert_ne!(before.bundle_id, after.bundle_id);
    }

    #[test]
    fn resources_change_alters_no_image_hash() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());

        let before = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();
        std::fs::write(
            temp.path().join("containers/claude-resources/CLAUDE.md"),
            "# changed",
        )
        .unwrap();
        let after = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();

        assert!(changed_images(&before, &after).is_empty());
        assert_ne!(before.claude_resources_hash, after.claude_resources_hash);
        assert_ne!(
            before.bundle_id, after.bundle_id,
            "resources change must trigger reconcile (sync + restore) without rebuilds"
        );
    }

    #[test]
    fn app_version_changes_only_bundle_id() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());

        let before = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap();
        let after = generate_bundle_manifest("1.2.4", "2.1.0", temp.path()).unwrap();

        assert_eq!(before.image_hashes, after.image_hashes);
        assert_ne!(
            before.bundle_id, after.bundle_id,
            "a release must trigger restore (render code lives in the binary) with 0 rebuilds"
        );
    }

    #[test]
    fn image_hash_and_tag_helpers() {
        let manifest = BundleManifest::for_tests("abc123");
        assert_eq!(manifest.image_hash(build::IMAGE_CLAUDE).unwrap(), "abc123");
        assert_eq!(
            manifest.image_tag(build::IMAGE_MCP_HUB).unwrap(),
            "speedwave-mcp-hub:abc123"
        );
        assert!(manifest.image_hash("speedwave-nonexistent").is_err());
    }

    #[test]
    fn for_tests_covers_every_catalogue_image() {
        let manifest = BundleManifest::for_tests("t1");
        for img in build::IMAGES {
            assert!(manifest.image_hashes.contains_key(img.name));
        }
    }

    #[test]
    fn missing_hash_input_fails_manifest_generation() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());
        std::fs::remove_file(temp.path().join("containers/entrypoint.sh")).unwrap();

        let err = generate_bundle_manifest("1.2.3", "2.1.0", temp.path()).unwrap_err();
        assert!(err.to_string().contains("Missing path for bundle digest"));
    }

    #[test]
    fn bundle_state_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bundle-state.json");
        let state = BundleState {
            applied_bundle_id: Some("abc123".to_string()),
            applied_image_hashes: std::collections::BTreeMap::from([
                ("speedwave-claude".to_string(), "h1".to_string()),
                ("speedwave-mcp-hub".to_string(), "h2".to_string()),
            ]),
            phase: BundleReconcilePhase::ImagesBuilt,
            pending_running_projects: vec!["alpha".to_string(), "beta".to_string()],
            last_error: Some("boom".to_string()),
        };

        save_bundle_state_to(&state, &path).unwrap();
        let loaded = load_bundle_state_from(&path).unwrap();
        assert_eq!(loaded, state);
    }

    #[test]
    fn legacy_state_file_parses_preserving_existing_fields() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bundle-state.json");
        // Pre-ADR-072 shape: no applied_image_hashes field.
        std::fs::write(
            &path,
            r#"{
                "applied_bundle_id": "old16charbundleid",
                "phase": "images_built",
                "pending_running_projects": ["alpha", "beta"],
                "last_error": "boom"
            }"#,
        )
        .unwrap();

        let loaded = load_bundle_state_from(&path).unwrap();
        assert_eq!(
            loaded.applied_bundle_id.as_deref(),
            Some("old16charbundleid")
        );
        assert!(loaded.applied_image_hashes.is_empty());
        assert_eq!(loaded.phase, BundleReconcilePhase::ImagesBuilt);
        assert_eq!(loaded.pending_running_projects, vec!["alpha", "beta"]);
        assert_eq!(loaded.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn new_state_file_readable_by_legacy_shape() {
        // Old releases deserialize the new file (serde ignores unknown fields).
        #[derive(Deserialize)]
        struct LegacyBundleState {
            applied_bundle_id: Option<String>,
            phase: BundleReconcilePhase,
            pending_running_projects: Vec<String>,
        }

        let state = BundleState {
            applied_bundle_id: Some("aggregate-id".to_string()),
            applied_image_hashes: std::collections::BTreeMap::from([(
                "speedwave-claude".to_string(),
                "h1".to_string(),
            )]),
            phase: BundleReconcilePhase::Done,
            pending_running_projects: vec!["alpha".to_string()],
            last_error: None,
        };
        let json = serde_json::to_string(&state).unwrap();
        let legacy: LegacyBundleState = serde_json::from_str(&json).unwrap();
        assert_eq!(legacy.applied_bundle_id.as_deref(), Some("aggregate-id"));
        assert_eq!(legacy.phase, BundleReconcilePhase::Done);
        assert_eq!(legacy.pending_running_projects, vec!["alpha"]);
    }

    #[test]
    fn legacy_manifest_json_is_regenerated() {
        let temp = tempfile::tempdir().unwrap();
        write_build_tree(temp.path());
        // Pre-ADR-072 manifest: no image_hashes field.
        std::fs::write(
            temp.path().join(BUNDLE_MANIFEST_FILE),
            r#"{
                "app_version": "0.9.0",
                "bundle_id": "legacy0123456789",
                "build_context_hash": "deadbeef",
                "claude_resources_hash": "cafebabe"
            }"#,
        )
        .unwrap();

        let manifest = load_current_bundle_manifest_from(temp.path()).unwrap();
        assert!(
            !manifest.image_hashes.is_empty(),
            "legacy manifest must be discarded and regenerated from the tree"
        );
        assert_ne!(manifest.bundle_id, "legacy0123456789");
    }

    #[test]
    fn sync_claude_resources_replaces_target_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let build_root = temp.path().join("build-root");
        write_resource_tree(&build_root);

        let target = home.join(consts::DATA_DIR).join("claude-resources");
        std::fs::create_dir_all(target.join("output-styles")).unwrap();
        std::fs::write(target.join("CLAUDE.md"), "old").unwrap();
        std::fs::write(target.join("settings.json"), "old").unwrap();
        std::fs::write(target.join("statusline.sh"), "old").unwrap();
        std::fs::write(target.join("output-styles/Speedwave.md"), "old").unwrap();

        sync_claude_resources_to(&build_root, &home).unwrap();

        let synced = std::fs::read_to_string(target.join("CLAUDE.md")).unwrap();
        assert_eq!(synced, "# docs");
    }

    #[test]
    fn sync_claude_resources_rejects_missing_required_file() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let build_root = temp.path().join("build-root");
        write_resource_tree(&build_root);
        std::fs::remove_file(build_root.join("containers/claude-resources/settings.json")).unwrap();

        let err = sync_claude_resources_to(&build_root, &home).unwrap_err();
        assert!(err.to_string().contains("Missing required Claude resource"));
    }

    #[test]
    fn required_bundled_assets_for_macos_include_notes_cli() {
        let assets = required_bundled_assets("macos").unwrap();
        assert!(assets.iter().any(|asset| asset.path == "notes-cli"));
        assert!(assets
            .iter()
            .any(|asset| asset.path == "mcp-os/os/dist/index.js"));
    }

    /// Drift guard: every signed macOS Mach-O (sign-bundled-binaries.sh
    /// SIGN_TARGETS / tauri.macos.conf.json bundle.resources) must also be a
    /// required bundled asset, or it ships unverified. audio-capture-cli was
    /// missing here while present in both other lists.
    #[test]
    fn required_bundled_assets_for_macos_include_audio_capture_cli() {
        let assets = required_bundled_assets("macos").unwrap();
        assert!(
            assets.iter().any(|asset| asset.path == "audio-capture-cli"),
            "audio-capture-cli must be a required macOS bundled asset"
        );
    }

    #[test]
    fn validate_bundled_runtime_assets_accepts_complete_macos_tree() {
        let temp = tempfile::tempdir().unwrap();
        write_common_bundled_assets(temp.path());
        write_platform_bundled_assets(temp.path(), "macos");

        validate_bundled_runtime_assets(temp.path(), "macos", false).unwrap();
    }

    #[test]
    fn validate_bundled_runtime_assets_rejects_missing_notes_cli() {
        let temp = tempfile::tempdir().unwrap();
        write_common_bundled_assets(temp.path());
        write_platform_bundled_assets(temp.path(), "macos");
        std::fs::remove_file(temp.path().join("notes-cli")).unwrap();

        let err = validate_bundled_runtime_assets(temp.path(), "macos", false).unwrap_err();
        assert!(err.to_string().contains("notes-cli"));
    }

    #[test]
    fn validate_bundled_runtime_assets_rejects_missing_audio_capture_cli() {
        let temp = tempfile::tempdir().unwrap();
        write_common_bundled_assets(temp.path());
        write_platform_bundled_assets(temp.path(), "macos");
        std::fs::remove_file(temp.path().join("audio-capture-cli")).unwrap();

        let err = validate_bundled_runtime_assets(temp.path(), "macos", false).unwrap_err();
        assert!(err.to_string().contains("audio-capture-cli"));
    }

    #[test]
    fn validate_bundled_runtime_assets_accepts_complete_windows_tree() {
        let temp = tempfile::tempdir().unwrap();
        write_common_bundled_assets(temp.path());
        write_platform_bundled_assets(temp.path(), "windows");

        validate_bundled_runtime_assets(temp.path(), "windows", false).unwrap();
    }

    #[test]
    fn validate_bundled_runtime_assets_allows_stub_files() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("build-context/containers")).unwrap();
        std::fs::create_dir_all(temp.path().join("build-context/mcp-servers")).unwrap();
        std::fs::create_dir_all(temp.path().join("mcp-os/os/dist")).unwrap();
        std::fs::create_dir_all(temp.path().join("mcp-os/shared/dist")).unwrap();
        std::fs::create_dir_all(temp.path().join("mcp-os/shared/node_modules")).unwrap();
        std::fs::create_dir_all(
            temp.path()
                .join("mcp-os/os/node_modules/@speedwave/mcp-shared"),
        )
        .unwrap();
        std::fs::create_dir_all(temp.path().join("lima/bin")).unwrap();
        std::fs::create_dir_all(temp.path().join("lima/share")).unwrap();
        std::fs::create_dir_all(temp.path().join("nodejs/bin")).unwrap();
        std::fs::create_dir_all(temp.path().join("cli")).unwrap();
        std::fs::write(temp.path().join("mcp-os/os/dist/index.js"), "").unwrap();
        std::fs::write(temp.path().join("mcp-os/shared/package.json"), "").unwrap();
        std::fs::write(temp.path().join("mcp-os/shared/package-lock.json"), "").unwrap();
        std::fs::create_dir_all(temp.path().join("oauth/oauth/dist")).unwrap();
        std::fs::create_dir_all(temp.path().join("oauth/shared/dist")).unwrap();
        std::fs::create_dir_all(temp.path().join("oauth/shared/node_modules")).unwrap();
        std::fs::create_dir_all(
            temp.path()
                .join("oauth/oauth/node_modules/@speedwave/mcp-shared"),
        )
        .unwrap();
        std::fs::write(temp.path().join("oauth/oauth/dist/index.js"), "").unwrap();
        std::fs::write(temp.path().join("oauth/shared/package.json"), "").unwrap();
        std::fs::write(temp.path().join("oauth/shared/package-lock.json"), "").unwrap();
        std::fs::write(temp.path().join("lima/bin/limactl"), "").unwrap();
        std::fs::write(temp.path().join("nodejs/bin/node"), "").unwrap();
        std::fs::write(temp.path().join("cli/speedwave"), "").unwrap();
        std::fs::write(temp.path().join("reminders-cli"), "").unwrap();
        std::fs::write(temp.path().join("calendar-cli"), "").unwrap();
        std::fs::write(temp.path().join("mail-cli"), "").unwrap();
        std::fs::write(temp.path().join("notes-cli"), "").unwrap();
        std::fs::write(temp.path().join("audio-capture-cli"), "").unwrap();

        validate_bundled_runtime_assets(temp.path(), "macos", true).unwrap();
    }

    #[test]
    fn validate_bundled_runtime_assets_rejects_missing_mcp_shared_dir() {
        let temp = tempfile::tempdir().unwrap();
        write_common_bundled_assets(temp.path());
        write_platform_bundled_assets(temp.path(), "macos");
        std::fs::remove_dir_all(temp.path().join("mcp-os/os/node_modules")).unwrap();

        let err = validate_bundled_runtime_assets(temp.path(), "macos", false).unwrap_err();
        assert!(err
            .to_string()
            .contains("mcp-os/os/node_modules/@speedwave/mcp-shared"));
    }

    #[cfg(unix)]
    #[test]
    fn save_bundle_state_sets_chmod_600() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bundle-state.json");
        let state = BundleState::default();
        save_bundle_state_to(&state, &path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "bundle-state.json should be 0o600, got {mode:#05o}"
        );
    }
}

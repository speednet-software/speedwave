use crate::{build, consts};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const BUNDLE_MANIFEST_FILE: &str = "bundle-manifest.json";
pub const BUNDLE_STATE_FILE: &str = "bundle-state.json";

const REQUIRED_CLAUDE_RESOURCES: &[&str] = &[
    "CLAUDE.md",
    "settings.json",
    "statusline.sh",
    "output-styles/Speedwave.md",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundledAssetKind {
    File,
    Directory,
    ExecutableFile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BundledAssetSpec {
    pub path: &'static str,
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
];

const LINUX_BUNDLED_ASSETS: &[BundledAssetSpec] = &[
    BundledAssetSpec {
        path: "nerdctl-full/bin",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "nerdctl-full/lib",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "nerdctl-full/libexec",
        kind: BundledAssetKind::Directory,
    },
    BundledAssetSpec {
        path: "nerdctl-full/share",
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleManifest {
    pub app_version: String,
    pub bundle_id: String,
    pub build_context_hash: String,
    pub claude_resources_hash: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BundleReconcilePhase {
    Pending,
    ResourcesSynced,
    ImagesBuilt,
    ProjectsRestored,
    #[default]
    Done,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleState {
    pub applied_bundle_id: Option<String>,
    pub phase: BundleReconcilePhase,
    pub pending_running_projects: Vec<String>,
    pub last_error: Option<String>,
}

impl BundleReconcilePhase {
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

pub fn load_current_bundle_manifest() -> anyhow::Result<BundleManifest> {
    let build_root = build::resolve_build_root()?;
    let manifest_path = build_root.join(BUNDLE_MANIFEST_FILE);
    if manifest_path.exists() {
        let data = std::fs::read_to_string(&manifest_path)?;
        return serde_json::from_str(&data).map_err(anyhow::Error::from);
    }
    generate_bundle_manifest(env!("CARGO_PKG_VERSION"), &build_root)
}

pub fn generate_bundle_manifest(
    app_version: &str,
    build_root: &Path,
) -> anyhow::Result<BundleManifest> {
    let build_context_hash = digest_paths(&[
        ("containers", &build_root.join("containers")),
        ("mcp-servers", &build_root.join("mcp-servers")),
    ])?;
    let claude_resources_hash = digest_paths(&[(
        "claude-resources",
        &build_root.join("containers").join("claude-resources"),
    )])?;

    let mut bundle_hasher = Sha256::new();
    bundle_hasher.update(app_version.as_bytes());
    bundle_hasher.update(b":");
    bundle_hasher.update(build_context_hash.as_bytes());
    bundle_hasher.update(b":");
    bundle_hasher.update(claude_resources_hash.as_bytes());
    let mut bundle_id = bytes_to_hex(&bundle_hasher.finalize());
    bundle_id.truncate(16);

    Ok(BundleManifest {
        app_version: app_version.to_string(),
        bundle_id,
        build_context_hash,
        claude_resources_hash,
    })
}

pub fn load_bundle_state() -> BundleState {
    bundle_state_path()
        .ok()
        .and_then(|path| load_bundle_state_from(&path).ok())
        .unwrap_or_default()
}

pub fn save_bundle_state(state: &BundleState) -> anyhow::Result<()> {
    let path = bundle_state_path()?;
    save_bundle_state_to(state, &path)
}

pub fn sync_claude_resources(build_root: &Path) -> anyhow::Result<()> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    sync_claude_resources_to(build_root, &home)
}

pub fn required_bundled_assets(target_os: &str) -> anyhow::Result<Vec<BundledAssetSpec>> {
    let mut assets = COMMON_BUNDLED_ASSETS.to_vec();
    match target_os {
        "macos" => assets.extend_from_slice(MACOS_BUNDLED_ASSETS),
        "linux" => assets.extend_from_slice(LINUX_BUNDLED_ASSETS),
        "windows" => assets.extend_from_slice(WINDOWS_BUNDLED_ASSETS),
        other => anyhow::bail!("unsupported target OS for bundled assets validation: {other}"),
    }
    Ok(assets)
}

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
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    Ok(bundle_state_path_with_home(&home))
}

fn bundle_state_path_with_home(home: &Path) -> PathBuf {
    home.join(consts::DATA_DIR).join(BUNDLE_STATE_FILE)
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
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

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
        anyhow::bail!("Missing directory for bundle digest: {}", dir.display());
    }

    let mut children: Vec<PathBuf> = std::fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<_, _>>()?;
    children.sort();

    for child in children {
        // Skip symlinks to prevent infinite recursion from circular links
        if child.is_symlink() {
            continue;
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
        }
    }
    Ok(())
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

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
            }
            "linux" => {
                std::fs::create_dir_all(root.join("nerdctl-full/bin")).unwrap();
                std::fs::create_dir_all(root.join("nerdctl-full/lib")).unwrap();
                std::fs::create_dir_all(root.join("nerdctl-full/libexec")).unwrap();
                std::fs::create_dir_all(root.join("nerdctl-full/share")).unwrap();
                std::fs::create_dir_all(root.join("nodejs/bin")).unwrap();
                std::fs::create_dir_all(root.join("cli")).unwrap();
                std::fs::write(root.join("nerdctl-full/bin/nerdctl"), "binary").unwrap();
                std::fs::write(root.join("nerdctl-full/lib/libfile"), "binary").unwrap();
                std::fs::write(root.join("nerdctl-full/libexec/helper"), "binary").unwrap();
                std::fs::write(root.join("nerdctl-full/share/readme"), "binary").unwrap();
                write_executable(&root.join("nodejs/bin/node"));
                write_executable(&root.join("cli/speedwave"));
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
        write_resource_tree(temp.path());

        let a = generate_bundle_manifest("1.2.3", temp.path()).unwrap();
        let b = generate_bundle_manifest("1.2.3", temp.path()).unwrap();

        assert_eq!(a, b);
        assert_eq!(a.bundle_id.len(), 16);
    }

    #[test]
    fn manifest_generation_changes_with_content() {
        let temp = tempfile::tempdir().unwrap();
        write_resource_tree(temp.path());

        let before = generate_bundle_manifest("1.2.3", temp.path()).unwrap();
        std::fs::write(
            temp.path().join("containers/Containerfile.claude"),
            "FROM changed",
        )
        .unwrap();
        let after = generate_bundle_manifest("1.2.3", temp.path()).unwrap();

        assert_ne!(before.bundle_id, after.bundle_id);
        assert_ne!(before.build_context_hash, after.build_context_hash);
    }

    #[test]
    fn bundle_state_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bundle-state.json");
        let state = BundleState {
            applied_bundle_id: Some("abc123".to_string()),
            phase: BundleReconcilePhase::ImagesBuilt,
            pending_running_projects: vec!["alpha".to_string(), "beta".to_string()],
            last_error: Some("boom".to_string()),
        };

        save_bundle_state_to(&state, &path).unwrap();
        let loaded = load_bundle_state_from(&path).unwrap();
        assert_eq!(loaded, state);
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
    fn validate_bundled_runtime_assets_accepts_complete_linux_tree() {
        let temp = tempfile::tempdir().unwrap();
        write_common_bundled_assets(temp.path());
        write_platform_bundled_assets(temp.path(), "linux");

        validate_bundled_runtime_assets(temp.path(), "linux", false).unwrap();
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
        std::fs::write(temp.path().join("lima/bin/limactl"), "").unwrap();
        std::fs::write(temp.path().join("nodejs/bin/node"), "").unwrap();
        std::fs::write(temp.path().join("cli/speedwave"), "").unwrap();
        std::fs::write(temp.path().join("reminders-cli"), "").unwrap();
        std::fs::write(temp.path().join("calendar-cli"), "").unwrap();
        std::fs::write(temp.path().join("mail-cli"), "").unwrap();
        std::fs::write(temp.path().join("notes-cli"), "").unwrap();

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
}

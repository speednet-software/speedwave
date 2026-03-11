use crate::runtime::ContainerRuntime;
use std::path::PathBuf;

/// A container image definition used by `build_all_images`.
pub struct ImageDef {
    /// Docker/OCI tag, e.g. `"speedwave-claude:latest"`.
    pub tag: &'static str,
    /// Context directory relative to the build root (as resolved by `resolve_build_root()`).
    pub context_dir: &'static str,
    /// Containerfile path relative to the build root.
    pub containerfile: &'static str,
}

/// SSOT for all container images — used by both Desktop (setup wizard) and the update flow.
///
/// All paths are relative to the build root returned by `resolve_build_root()`.
pub const IMAGES: &[ImageDef] = &[
    ImageDef {
        tag: "speedwave-claude:latest",
        context_dir: "containers",
        containerfile: "containers/Containerfile.claude",
    },
    ImageDef {
        tag: "speedwave-mcp-hub:latest",
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/hub/Containerfile",
    },
    ImageDef {
        tag: "speedwave-mcp-slack:latest",
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/slack/Dockerfile",
    },
    ImageDef {
        tag: "speedwave-mcp-sharepoint:latest",
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/sharepoint/Dockerfile",
    },
    ImageDef {
        tag: "speedwave-mcp-redmine:latest",
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/redmine/Dockerfile",
    },
    ImageDef {
        tag: "speedwave-mcp-gitlab:latest",
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/gitlab/Dockerfile",
    },
];

/// Resolves the root directory containing container build context (`containers/`, `mcp-servers/`).
///
/// Resolution order:
/// 1. `SPEEDWAVE_RESOURCES_DIR` env var → `<dir>/build-context/` (production — Tauri sets this)
/// 2. `~/.speedwave/resources-dir` marker file → `<dir>/build-context/` (CLI reads Desktop's marker)
/// 3. `CARGO_MANIFEST_DIR` parent chain (baked at compile time — works only in dev or when
///    source tree still exists at the compile-time path)
pub fn resolve_build_root() -> anyhow::Result<PathBuf> {
    resolve_build_root_with_home(dirs::home_dir())
}

/// Internal implementation that accepts an explicit home directory for testability.
fn resolve_build_root_with_home(home: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    // 1. SPEEDWAVE_RESOURCES_DIR/build-context/ (production — Tauri sets this)
    if let Ok(res) = std::env::var(crate::consts::BUNDLE_RESOURCES_ENV) {
        let bundled = PathBuf::from(&res).join("build-context");
        if bundled.join("containers").exists() {
            return Ok(bundled);
        }
        log::warn!(
            "{} set to '{}' but build-context/containers/ not found",
            crate::consts::BUNDLE_RESOURCES_ENV,
            res
        );
    }

    // 2. ~/.speedwave/resources-dir marker (written by Desktop app, read by CLI)
    if let Some(ref home) = home {
        if let Some(root) = resolve_from_marker(home) {
            return Ok(root);
        }
    }

    // 3. CARGO_MANIFEST_DIR parent chain (baked at compile time — dev only)
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());
    if let Some(ref root) = dev {
        if root.join("containers").exists() {
            return Ok(root.clone());
        }
    }

    anyhow::bail!(
        "Container build context not found. \
         Ensure Speedwave Desktop is installed or run from source tree."
    )
}

/// Resolves the path to the mcp-os `index.js` entry point.
///
/// Resolution order (same as `resolve_build_root`):
/// 1. `SPEEDWAVE_RESOURCES_DIR` env var → `<dir>/mcp-os/os/dist/index.js`
/// 2. `~/.speedwave/resources-dir` marker → `<dir>/mcp-os/os/dist/index.js`
/// 3. `CARGO_MANIFEST_DIR` parent chain → `<repo>/mcp-servers/os/dist/index.js`
pub fn resolve_mcp_os_script() -> Option<std::path::PathBuf> {
    resolve_mcp_os_script_with_home(dirs::home_dir())
}

/// Internal implementation that accepts an explicit home directory for testability.
fn resolve_mcp_os_script_with_home(home: Option<PathBuf>) -> Option<std::path::PathBuf> {
    // 1. SPEEDWAVE_RESOURCES_DIR (production — Tauri bundle)
    if let Ok(res) = std::env::var(crate::consts::BUNDLE_RESOURCES_ENV) {
        let p = PathBuf::from(&res)
            .join("mcp-os")
            .join("os")
            .join("dist")
            .join("index.js");
        if p.exists() {
            return Some(p);
        }
        log::warn!("mcp-os not found at bundled path: {}", p.display());
    }

    // 2. Marker file (CLI reads Desktop's resources path)
    if let Some(ref home) = home {
        let marker = home
            .join(crate::consts::DATA_DIR)
            .join(crate::consts::RESOURCES_MARKER);
        if let Ok(dir) = std::fs::read_to_string(&marker) {
            let p = PathBuf::from(dir.trim())
                .join("mcp-os")
                .join("os")
                .join("dist")
                .join("index.js");
            if p.is_absolute() && p.exists() {
                return Some(p);
            }
            log::warn!("mcp-os not found at marker path: {}", p.display());
        }
    }

    // 3. Dev fallback — path baked at compile time via env!(), validated at runtime
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|repo| repo.join("mcp-servers/os/dist/index.js"));
    match dev {
        Some(ref p) if p.exists() => dev,
        Some(ref p) => {
            log::warn!("mcp-os not found at dev path: {}", p.display());
            None
        }
        None => {
            log::warn!("mcp-os: could not determine dev path from CARGO_MANIFEST_DIR");
            None
        }
    }
}

/// Reads the `~/.speedwave/resources-dir` marker file and returns the build-context
/// path if the marker points to a valid directory containing `containers/`.
///
/// Consumer: called by `resolve_build_root()`. Writer: Desktop app `main.rs` on startup
/// via `write_resources_marker()`.
fn resolve_from_marker(home: &std::path::Path) -> Option<PathBuf> {
    let marker = home
        .join(crate::consts::DATA_DIR)
        .join(crate::consts::RESOURCES_MARKER);
    match std::fs::read_to_string(&marker) {
        Ok(dir) => {
            let path = PathBuf::from(dir.trim());
            if !path.is_absolute() {
                log::warn!(
                    "marker {} contains a relative path '{}', ignoring",
                    marker.display(),
                    path.display()
                );
                return None;
            }
            let bundled = path.join("build-context");
            if bundled.join("containers").exists() {
                Some(bundled)
            } else {
                log::warn!(
                    "marker {} points to {}, but containers/ not found",
                    marker.display(),
                    bundled.display()
                );
                None
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("could not read marker {}: {e}", marker.display());
            None
        }
    }
}

/// Writes the `~/.speedwave/resources-dir` marker file atomically.
///
/// Uses write-to-tmp + rename to prevent the CLI from reading a partial path.
/// Called by the Desktop app on startup so the CLI can locate bundled resources.
pub fn write_resources_marker(resources_dir: &std::path::Path) -> anyhow::Result<()> {
    write_resources_marker_to(
        resources_dir,
        &dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home directory"))?,
    )
}

/// Internal implementation that accepts an explicit home directory for testability.
fn write_resources_marker_to(
    resources_dir: &std::path::Path,
    home: &std::path::Path,
) -> anyhow::Result<()> {
    let marker_dir = home.join(crate::consts::DATA_DIR);
    let marker = marker_dir.join(crate::consts::RESOURCES_MARKER);
    std::fs::create_dir_all(&marker_dir)?;
    let tmp = marker_dir.join(format!("{}.tmp", crate::consts::RESOURCES_MARKER));
    std::fs::write(&tmp, resources_dir.to_string_lossy().as_bytes())?;
    std::fs::rename(&tmp, &marker)?;
    Ok(())
}

/// Rebuilds all container images from their Containerfiles.
///
/// Calls `runtime.prepare_build_context()` to translate the host build-root into
/// a path accessible by the container engine (e.g. copy into `~` for Lima VM,
/// convert `C:\` → `/mnt/c/` for WSL).
///
/// If the build fails with a containerd overlayfs snapshotter error
/// ("failed to rename: file exists"), automatically prunes dangling images and
/// build cache, then retries once. This is a known containerd bug
/// (containerd#11719, nerdctl#3420).
///
/// Returns the number of images successfully built.
pub fn build_all_images(runtime: &dyn ContainerRuntime) -> anyhow::Result<u32> {
    let root = resolve_build_root()?;
    let vm_root = runtime.prepare_build_context(&root)?;
    let needs_cleanup = vm_root != root;

    let result = try_build_all(runtime, &vm_root).or_else(|e| {
        if is_snapshotter_error(&e) {
            log::warn!("build failed with containerd snapshotter error, pruning and retrying: {e}");
            if let Err(prune_err) = runtime.system_prune() {
                log::warn!("system prune failed: {prune_err}");
            }
            try_build_all(runtime, &vm_root)
        } else {
            Err(e)
        }
    });

    // Clean up temporary build-cache on both success and failure
    if needs_cleanup && vm_root.exists() {
        if let Err(e) = std::fs::remove_dir_all(&vm_root) {
            log::warn!("failed to remove build cache {}: {e}", vm_root.display());
        }
    }

    result
}

/// Builds all images in sequence. Extracted so the retry logic in `build_all_images` can re-call it.
fn try_build_all(runtime: &dyn ContainerRuntime, vm_root: &std::path::Path) -> anyhow::Result<u32> {
    let total = IMAGES.len();
    let mut built = 0u32;
    log::info!(
        "build_all_images: building {total} images from {}",
        vm_root.display()
    );
    let root_str = vm_root.to_string_lossy();
    let root_str = root_str.trim_end_matches('/');
    for (i, img) in IMAGES.iter().enumerate() {
        log::info!(
            "build_all_images: [{}/{}] building {} (context={}, file={})",
            i + 1,
            total,
            img.tag,
            img.context_dir,
            img.containerfile
        );
        // Use string concatenation with "/" instead of PathBuf::join because vm_root
        // may be a WSL/Linux path (e.g. "/mnt/c/Speedwave/build-context") running on
        // a Windows host. PathBuf::join treats `/`-prefixed paths as absolute roots
        // on Windows, replacing the base entirely instead of appending.
        let abs_context = format!("{}/{}", root_str, img.context_dir);
        let abs_containerfile = format!("{}/{}", root_str, img.containerfile);
        runtime.build_image(img.tag, &abs_context, &abs_containerfile)?;
        built += 1;
        log::info!(
            "build_all_images: [{}/{}] {} built OK",
            i + 1,
            total,
            img.tag
        );
    }
    log::info!("build_all_images: all {total} images built successfully");
    Ok(built)
}

/// Returns `true` if the error looks like a containerd overlayfs snapshotter bug.
///
/// Iterates the full error chain (`err.chain()`) so that wrapped/context errors
/// are checked too — not just the top-level message.
///
/// Known error patterns from containerd (stable in Go source since 2023):
/// - `"apply layer error"` — wrapper from containerd's differ
/// - `"failed to prepare extraction snapshot"` — from snapshotter.Prepare()
/// - `"failed to rename"` + `"file exists"` — OS-level rename failure on stale snapshot
fn is_snapshotter_error(err: &anyhow::Error) -> bool {
    for cause in err.chain() {
        let msg = cause.to_string();
        if msg.contains("apply layer error")
            || msg.contains("failed to prepare extraction snapshot")
            || (msg.contains("failed to rename") && msg.contains("file exists"))
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::{Arc, Mutex};

    #[test]
    fn test_images_constant_has_entries() {
        assert!(!IMAGES.is_empty());
    }

    #[test]
    fn test_images_tags_are_latest() {
        for img in IMAGES {
            assert!(
                img.tag.ends_with(":latest"),
                "image tag '{}' should end with :latest",
                img.tag
            );
        }
    }

    #[test]
    fn test_images_containerfiles_exist() {
        let root = resolve_build_root().unwrap();
        for img in IMAGES {
            let path = root.join(img.containerfile);
            assert!(
                path.exists(),
                "Containerfile for '{}' not found at {}",
                img.tag,
                path.display()
            );
        }
    }

    #[test]
    fn test_images_context_dirs_exist() {
        let root = resolve_build_root().unwrap();
        for img in IMAGES {
            let path = root.join(img.context_dir);
            assert!(
                path.is_dir(),
                "context dir for '{}' not found at {}",
                img.tag,
                path.display()
            );
        }
    }

    #[test]
    fn test_resolve_build_root_dev_mode() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        // Pass None for home to skip marker file — avoids interference from real ~/.speedwave/
        let root = resolve_build_root_with_home(None).unwrap();
        assert!(root.join("Cargo.toml").exists());
        assert!(root.join("crates").is_dir());
        assert!(root.join("containers").is_dir());
    }

    #[test]
    fn test_resolve_build_root_with_home_none_falls_to_dev() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        let root = resolve_build_root_with_home(None).unwrap();
        assert!(root.join("containers").is_dir());
    }

    #[test]
    fn test_resolve_build_root_from_resources_env() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let bc = tmp.path().join("build-context").join("containers");
        std::fs::create_dir_all(&bc).unwrap();
        std::env::set_var(
            crate::consts::BUNDLE_RESOURCES_ENV,
            tmp.path().to_string_lossy().as_ref(),
        );
        let root = resolve_build_root().unwrap();
        assert_eq!(root, tmp.path().join("build-context"));
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_build_root_env_wins_over_marker() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();

        // Set up env var path
        let env_resources = tmp.path().join("env-resources");
        std::fs::create_dir_all(env_resources.join("build-context").join("containers")).unwrap();
        std::env::set_var(
            crate::consts::BUNDLE_RESOURCES_ENV,
            env_resources.to_string_lossy().as_ref(),
        );

        // Set up competing marker path
        let fake_home = tmp.path().join("home");
        let marker_resources = tmp.path().join("marker-resources");
        std::fs::create_dir_all(marker_resources.join("build-context").join("containers")).unwrap();
        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            marker_resources.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let root = resolve_build_root_with_home(Some(fake_home)).unwrap();
        assert_eq!(root, env_resources.join("build-context"));
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_build_root_fallback_when_no_build_context() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var(
            crate::consts::BUNDLE_RESOURCES_ENV,
            tmp.path().to_string_lossy().as_ref(),
        );
        // Falls back to dev (source tree) since bundled path doesn't have containers/
        let root = resolve_build_root_with_home(None).unwrap();
        assert!(root.join("containers").is_dir());
        assert!(root.join("Cargo.toml").exists());
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_from_marker_with_valid_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");

        std::fs::create_dir_all(fake_resources.join("build-context").join("containers")).unwrap();

        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            fake_resources.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let result = resolve_from_marker(&fake_home);
        assert_eq!(result, Some(fake_resources.join("build-context")));
    }

    #[test]
    fn test_resolve_from_marker_missing_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        std::fs::create_dir_all(&fake_home).unwrap();

        let result = resolve_from_marker(&fake_home);
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_from_marker_invalid_target() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");

        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            "/nonexistent/path",
        )
        .unwrap();

        let result = resolve_from_marker(&fake_home);
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_from_marker_rejects_relative_path() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");

        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            "relative/path",
        )
        .unwrap();

        let result = resolve_from_marker(&fake_home);
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_from_marker_with_trailing_whitespace() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");

        std::fs::create_dir_all(fake_resources.join("build-context").join("containers")).unwrap();

        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            format!("{}\n", fake_resources.to_string_lossy()),
        )
        .unwrap();

        let result = resolve_from_marker(&fake_home);
        assert_eq!(result, Some(fake_resources.join("build-context")));
    }

    #[test]
    fn test_resolve_build_root_with_home_uses_marker() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");

        std::fs::create_dir_all(fake_resources.join("build-context").join("containers")).unwrap();

        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            fake_resources.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let root = resolve_build_root_with_home(Some(fake_home)).unwrap();
        assert_eq!(root, fake_resources.join("build-context"));
    }

    #[test]
    fn test_resolve_build_root_marker_priority_over_dev() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");

        std::fs::create_dir_all(fake_resources.join("build-context").join("containers")).unwrap();

        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            fake_resources.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let root = resolve_build_root_with_home(Some(fake_home)).unwrap();
        assert_ne!(
            root,
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_path_buf()
        );
        assert_eq!(root, fake_resources.join("build-context"));
    }

    #[test]
    fn test_write_resources_marker_creates_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");

        std::fs::create_dir_all(fake_resources.join("build-context").join("containers")).unwrap();

        write_resources_marker_to(&fake_resources, &fake_home).unwrap();

        let result = resolve_from_marker(&fake_home);
        assert_eq!(result, Some(fake_resources.join("build-context")));
    }

    #[test]
    fn test_write_resources_marker_overwrites_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let old_resources = tmp.path().join("old-resources");
        let new_resources = tmp.path().join("new-resources");

        std::fs::create_dir_all(old_resources.join("build-context").join("containers")).unwrap();
        std::fs::create_dir_all(new_resources.join("build-context").join("containers")).unwrap();

        write_resources_marker_to(&old_resources, &fake_home).unwrap();
        write_resources_marker_to(&new_resources, &fake_home).unwrap();

        let result = resolve_from_marker(&fake_home);
        assert_eq!(result, Some(new_resources.join("build-context")));
    }

    #[test]
    fn test_write_resources_marker_no_stale_tmp() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");

        write_resources_marker_to(&fake_resources, &fake_home).unwrap();

        let tmp_marker = fake_home
            .join(crate::consts::DATA_DIR)
            .join(format!("{}.tmp", crate::consts::RESOURCES_MARKER));
        assert!(!tmp_marker.exists(), "stale .tmp file should not remain");
    }

    #[test]
    fn test_resolve_mcp_os_script_dev_mode() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        // In dev mode with None home, it falls through to CARGO_MANIFEST_DIR.
        // The script may or may not exist depending on whether mcp-os was built.
        let result = resolve_mcp_os_script_with_home(None);
        // Just verify it doesn't panic — existence depends on build state
        let _ = result;
    }

    #[test]
    fn test_resolve_mcp_os_script_from_env() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let script_path = tmp
            .path()
            .join("mcp-os")
            .join("os")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::write(&script_path, "// stub").unwrap();
        std::env::set_var(
            crate::consts::BUNDLE_RESOURCES_ENV,
            tmp.path().to_string_lossy().as_ref(),
        );
        let result = resolve_mcp_os_script_with_home(None);
        assert_eq!(result, Some(script_path));
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_mcp_os_script_from_marker() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");

        let script_path = fake_resources
            .join("mcp-os")
            .join("os")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::write(&script_path, "// stub").unwrap();

        write_resources_marker_to(&fake_resources, &fake_home).unwrap();

        let result = resolve_mcp_os_script_with_home(Some(fake_home));
        assert_eq!(result, Some(script_path));
    }

    #[test]
    fn test_images_count() {
        assert_eq!(IMAGES.len(), 6);
    }

    #[test]
    fn test_is_snapshotter_error_matches_apply_layer() {
        let err =
            anyhow::anyhow!("nerdctl failed: apply layer error for \"docker.io/library/img\"");
        assert!(is_snapshotter_error(&err));
    }

    #[test]
    fn test_is_snapshotter_error_matches_extraction_snapshot() {
        let err = anyhow::anyhow!(
            "failed to prepare extraction snapshot \"extract-123\": something went wrong"
        );
        assert!(is_snapshotter_error(&err));
    }

    #[test]
    fn test_is_snapshotter_error_matches_failed_rename_file_exists() {
        let err = anyhow::anyhow!(
            "failed to rename: rename /var/lib/containerd/snapshots/new-123 /var/lib/containerd/snapshots/2: file exists"
        );
        assert!(is_snapshotter_error(&err));
    }

    #[test]
    fn test_is_snapshotter_error_rejects_unrelated() {
        let err = anyhow::anyhow!("network timeout connecting to registry");
        assert!(!is_snapshotter_error(&err));
    }

    #[test]
    fn test_is_snapshotter_error_rejects_partial_rename() {
        // "failed to rename" alone (without "file exists") should NOT trigger retry
        let err = anyhow::anyhow!("failed to rename: permission denied");
        assert!(!is_snapshotter_error(&err));
    }

    #[test]
    fn test_is_snapshotter_error_matches_wrapped_error() {
        // The snapshotter error may be wrapped with .context() — chain iteration must find it
        let inner = anyhow::anyhow!("apply layer error for \"docker.io/library/img:latest\"");
        let wrapped = inner.context("nerdctl build failed for speedwave-claude:latest");
        assert!(
            is_snapshotter_error(&wrapped),
            "should detect snapshotter error in wrapped/chained error"
        );
    }

    #[test]
    fn test_is_snapshotter_error_matches_deeply_wrapped_error() {
        let inner = anyhow::anyhow!(
            "failed to rename: rename /var/lib/containerd/snapshots/new /var/lib/containerd/snapshots/2: file exists"
        );
        let mid = inner.context("failed to prepare extraction snapshot");
        let outer = mid.context("build_image failed");
        assert!(
            is_snapshotter_error(&outer),
            "should detect snapshotter error deep in the chain"
        );
    }

    #[test]
    fn test_is_snapshotter_error_rejects_wrapped_unrelated() {
        let inner = anyhow::anyhow!("connection refused");
        let wrapped = inner.context("nerdctl build failed");
        assert!(
            !is_snapshotter_error(&wrapped),
            "should not match unrelated wrapped error"
        );
    }

    #[test]
    fn test_build_all_images_calls_prepare_build_context() {
        use serde_json::Value;

        #[derive(Clone)]
        struct Call {
            tag: String,
            context_dir: String,
            containerfile: String,
        }

        struct MockRuntime {
            translated_root: PathBuf,
            build_calls: Arc<Mutex<Vec<Call>>>,
            prepare_called: Arc<Mutex<bool>>,
        }

        impl ContainerRuntime for MockRuntime {
            fn compose_up(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn compose_down(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<Value>> {
                Ok(vec![])
            }
            fn container_exec(&self, _: &str, _: &[&str]) -> Command {
                Command::new("true")
            }
            fn container_exec_piped(&self, _: &str, _: &[&str]) -> anyhow::Result<Command> {
                Ok(Command::new("true"))
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
                context_dir: &str,
                containerfile: &str,
            ) -> anyhow::Result<()> {
                self.build_calls.lock().unwrap().push(Call {
                    tag: tag.to_string(),
                    context_dir: context_dir.to_string(),
                    containerfile: containerfile.to_string(),
                });
                Ok(())
            }
            fn prepare_build_context(
                &self,
                _build_root: &std::path::Path,
            ) -> anyhow::Result<PathBuf> {
                *self.prepare_called.lock().unwrap() = true;
                Ok(self.translated_root.clone())
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

        let build_calls = Arc::new(Mutex::new(Vec::new()));
        let prepare_called = Arc::new(Mutex::new(false));
        let translated = PathBuf::from("/home/user/.speedwave/build-cache");

        let rt = MockRuntime {
            translated_root: translated.clone(),
            build_calls: Arc::clone(&build_calls),
            prepare_called: Arc::clone(&prepare_called),
        };

        // build_all_images resolves the real build root, then calls prepare_build_context.
        // Since our mock overrides prepare_build_context, the translated path should be used.
        let result = build_all_images(&rt);
        assert!(result.is_ok());

        assert!(
            *prepare_called.lock().unwrap(),
            "prepare_build_context should be called"
        );

        let calls = build_calls.lock().unwrap();
        assert_eq!(calls.len(), IMAGES.len());

        for (call, img) in calls.iter().zip(IMAGES.iter()) {
            assert_eq!(call.tag, img.tag);
            assert!(
                call.context_dir
                    .starts_with(&translated.to_string_lossy().to_string()),
                "context_dir should use translated root, got: {}",
                call.context_dir
            );
            assert!(
                call.containerfile
                    .starts_with(&translated.to_string_lossy().to_string()),
                "containerfile should use translated root, got: {}",
                call.containerfile
            );
        }
    }

    /// A mock runtime for testing retry-with-prune logic.
    ///
    /// Tracks all `build_image` and `system_prune` calls.
    /// Can be configured to fail on specific `build_image` call numbers.
    struct RetryMockRuntime {
        /// Path returned by `prepare_build_context`.
        build_root: PathBuf,
        /// Records all calls: "build:<tag>" for build_image, "system_prune" for system_prune.
        calls: Arc<Mutex<Vec<String>>>,
        /// Monotonically increasing counter for build_image invocations (1-based).
        build_call_counter: Arc<std::sync::atomic::AtomicU32>,
        /// Map from build_image call number → error message. If absent, the call succeeds.
        fail_on: std::collections::HashMap<u32, String>,
    }

    impl ContainerRuntime for RetryMockRuntime {
        fn compose_up(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_down(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
            Ok(vec![])
        }
        fn container_exec(&self, _: &str, _: &[&str]) -> Command {
            Command::new("true")
        }
        fn container_exec_piped(&self, _: &str, _: &[&str]) -> anyhow::Result<Command> {
            Ok(Command::new("true"))
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
        ) -> anyhow::Result<()> {
            let n = self
                .build_call_counter
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            self.calls.lock().unwrap().push(format!("build:{}", tag));
            if let Some(msg) = self.fail_on.get(&n) {
                anyhow::bail!("{}", msg);
            }
            Ok(())
        }
        fn prepare_build_context(&self, _build_root: &std::path::Path) -> anyhow::Result<PathBuf> {
            Ok(self.build_root.clone())
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
        fn system_prune(&self) -> anyhow::Result<()> {
            self.calls.lock().unwrap().push("system_prune".to_string());
            Ok(())
        }
    }

    /// Creates a temp directory with the minimum structure needed for
    /// `try_build_all` (Containerfiles for every IMAGES entry).
    fn create_fake_build_root() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        for img in IMAGES {
            let containerfile = root.join(img.containerfile);
            std::fs::create_dir_all(containerfile.parent().unwrap()).unwrap();
            std::fs::write(&containerfile, "FROM scratch").unwrap();
            std::fs::create_dir_all(root.join(img.context_dir)).unwrap();
        }
        (tmp, root)
    }

    #[test]
    fn test_retry_on_snapshotter_error() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let image_count = IMAGES.len() as u32;

        // Fail on the 4th build_image call with a snapshotter error.
        // First attempt: calls 1..=image_count, #4 fails.
        // Retry:         calls (image_count+1)..=(2*image_count), all succeed.
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            4,
            "apply layer error for \"docker.io/library/speedwave-mcp-sharepoint:latest\""
                .to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let rt = RetryMockRuntime {
            build_root,
            calls: Arc::clone(&calls),
            build_call_counter: Arc::clone(&counter),
            fail_on,
        };

        let result = try_build_all(&rt, &rt.build_root.clone()).or_else(|e| {
            if is_snapshotter_error(&e) {
                if let Err(prune_err) = rt.system_prune() {
                    log::warn!("system prune failed: {prune_err}");
                }
                try_build_all(&rt, &rt.build_root.clone())
            } else {
                Err(e)
            }
        });

        assert!(result.is_ok(), "retry should succeed, got: {:?}", result);
        assert_eq!(result.unwrap(), image_count);

        let recorded = calls.lock().unwrap();

        // system_prune called exactly once
        let prune_count = recorded.iter().filter(|c| *c == "system_prune").count();
        assert_eq!(prune_count, 1, "system_prune should be called once");

        // Total build_image calls: 4 (first attempt, fails on 4th) + image_count (retry)
        let build_count = recorded.iter().filter(|c| c.starts_with("build:")).count();
        assert_eq!(
            build_count,
            4 + image_count as usize,
            "expected 4 + {} build_image calls, got {}",
            image_count,
            build_count
        );
    }

    #[test]
    fn test_no_retry_on_generic_error() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));

        // Fail on 2nd call with a non-snapshotter error
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(2, "network timeout".to_string());

        let (_tmp, build_root) = create_fake_build_root();
        let rt = RetryMockRuntime {
            build_root,
            calls: Arc::clone(&calls),
            build_call_counter: Arc::clone(&counter),
            fail_on,
        };

        let result = try_build_all(&rt, &rt.build_root.clone()).or_else(|e| {
            if is_snapshotter_error(&e) {
                if let Err(prune_err) = rt.system_prune() {
                    log::warn!("system prune failed: {prune_err}");
                }
                try_build_all(&rt, &rt.build_root.clone())
            } else {
                Err(e)
            }
        });

        assert!(result.is_err(), "generic error should not be retried");
        assert!(
            result.unwrap_err().to_string().contains("network timeout"),
            "original error should propagate"
        );

        let recorded = calls.lock().unwrap();
        let prune_count = recorded.iter().filter(|c| *c == "system_prune").count();
        assert_eq!(
            prune_count, 0,
            "system_prune should NOT be called for generic errors"
        );
    }

    #[test]
    fn bundle_scripts_service_lists_are_in_sync() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();

        let sh_content = std::fs::read_to_string(repo_root.join("scripts/bundle-build-context.sh"))
            .expect("bundle-build-context.sh should exist");

        let ps1_content =
            std::fs::read_to_string(repo_root.join("scripts/bundle-build-context.ps1"))
                .expect("bundle-build-context.ps1 should exist");

        // Extract: MCP_SERVICES="shared hub slack sharepoint redmine gitlab"
        let sh_services: Vec<&str> = sh_content
            .lines()
            .find(|l| l.starts_with("MCP_SERVICES="))
            .expect("MCP_SERVICES= line should exist in .sh")
            .trim_start_matches("MCP_SERVICES=")
            .trim_matches('"')
            .split_whitespace()
            .collect();

        // Extract: $services = @('shared','hub','slack','sharepoint','redmine','gitlab')
        let ps1_line = ps1_content
            .lines()
            .find(|l| l.contains("$services = @("))
            .expect("$services = @(...) line should exist in .ps1");
        let ps1_services: Vec<&str> = ps1_line
            .split("@(")
            .nth(1)
            .unwrap()
            .trim_end_matches(')')
            .split(',')
            .map(|s| s.trim().trim_matches('\''))
            .collect();

        assert_eq!(
            sh_services, ps1_services,
            "bundle-build-context.sh MCP_SERVICES and bundle-build-context.ps1 $services \
             must list the same services in the same order"
        );
    }

    #[test]
    fn test_retry_fails_returns_retry_error() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let image_count = IMAGES.len() as u32;

        // First attempt: fail on call 3 with snapshotter error
        // Retry: fail on call (3 + image_count) with snapshotter error again
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            3,
            "apply layer error for \"docker.io/library/img:latest\"".to_string(),
        );
        fail_on.insert(
            3 + image_count,
            "failed to prepare extraction snapshot \"extract-456\": still broken".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let rt = RetryMockRuntime {
            build_root,
            calls: Arc::clone(&calls),
            build_call_counter: Arc::clone(&counter),
            fail_on,
        };

        let result = try_build_all(&rt, &rt.build_root.clone()).or_else(|e| {
            if is_snapshotter_error(&e) {
                if let Err(prune_err) = rt.system_prune() {
                    log::warn!("system prune failed: {prune_err}");
                }
                try_build_all(&rt, &rt.build_root.clone())
            } else {
                Err(e)
            }
        });

        assert!(result.is_err(), "second failure should be returned");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("failed to prepare extraction snapshot"),
            "should return the second (retry) error"
        );

        let recorded = calls.lock().unwrap();
        let prune_count = recorded.iter().filter(|c| *c == "system_prune").count();
        assert_eq!(prune_count, 1, "system_prune should be called once");
    }
}

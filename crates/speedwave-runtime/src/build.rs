use crate::{bundle, runtime::ContainerRuntime};
use std::path::PathBuf;

/// A container image definition used by `build_all_images`.
pub struct ImageDef {
    /// Docker/OCI repository name, e.g. `"speedwave-claude"`.
    pub name: &'static str,
    /// Context directory relative to the build root (as resolved by `resolve_build_root()`).
    pub context_dir: &'static str,
    /// Containerfile path relative to the build root.
    pub containerfile: &'static str,
    /// Build arguments passed as `--build-arg KEY=VAL` to the container engine.
    pub build_args: &'static [(&'static str, &'static str)],
}

/// SSOT for all container images — used by both Desktop (setup wizard) and the update flow.
///
/// All paths are relative to the build root returned by `resolve_build_root()`.
/// Build args for the Claude container — passes the pinned version to Containerfile.claude.
const CLAUDE_BUILD_ARGS: &[(&str, &str)] = &[("CLAUDE_VERSION", crate::defaults::CLAUDE_VERSION)];

pub const IMAGE_CLAUDE: &str = "speedwave-claude";
pub const IMAGE_MCP_HUB: &str = "speedwave-mcp-hub";
pub const IMAGE_MCP_SLACK: &str = "speedwave-mcp-slack";
pub const IMAGE_MCP_SHAREPOINT: &str = "speedwave-mcp-sharepoint";
pub const IMAGE_MCP_REDMINE: &str = "speedwave-mcp-redmine";
pub const IMAGE_MCP_GITLAB: &str = "speedwave-mcp-gitlab";

pub const IMAGES: &[ImageDef] = &[
    ImageDef {
        name: IMAGE_CLAUDE,
        context_dir: "containers",
        containerfile: "containers/Containerfile.claude",
        build_args: CLAUDE_BUILD_ARGS,
    },
    ImageDef {
        name: IMAGE_MCP_HUB,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/hub/Containerfile",
        build_args: &[],
    },
    ImageDef {
        name: IMAGE_MCP_SLACK,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/slack/Dockerfile",
        build_args: &[],
    },
    ImageDef {
        name: IMAGE_MCP_SHAREPOINT,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/sharepoint/Dockerfile",
        build_args: &[],
    },
    ImageDef {
        name: IMAGE_MCP_REDMINE,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/redmine/Dockerfile",
        build_args: &[],
    },
    ImageDef {
        name: IMAGE_MCP_GITLAB,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/gitlab/Dockerfile",
        build_args: &[],
    },
];

pub fn image_ref(name: &str, bundle_id: &str) -> String {
    format!("{name}:{bundle_id}")
}

/// Returns `true` if all expected built-in container images exist in the runtime.
///
/// Callers should call `rt.ensure_ready()` first — this function does not check
/// runtime readiness. Do **not** guard with `is_available()`: a stopped VM
/// returns `false` there but `ensure_ready()` can start it.
pub fn images_exist(rt: &dyn super::runtime::ContainerRuntime) -> bool {
    let manifest = match crate::bundle::load_current_bundle_manifest() {
        Ok(m) => m,
        Err(e) => {
            log::warn!("images_exist: cannot load bundle manifest: {e}");
            return false;
        }
    };
    IMAGES.iter().all(|img| {
        let tag = image_ref(img.name, &manifest.bundle_id);
        rt.image_exists(&tag).unwrap_or(false)
    })
}

/// Resolves the root directory containing container build context (`containers/`, `mcp-servers/`).
///
/// Resolution order:
/// 1. `SPEEDWAVE_RESOURCES_DIR` env var → `<dir>/build-context/` (production — Tauri sets this)
/// 2. `CARGO_MANIFEST_DIR` parent chain (baked at compile time — dev source tree)
/// 3. `~/.speedwave/resources-dir` marker file → `<dir>/build-context/` (CLI reads Desktop's marker)
///
/// Step 2 before 3 ensures `make dev` uses local sources instead of a stale
/// bundle path written by the installed app — same rationale as
/// `resolve_mcp_os_script_inner`.
pub fn resolve_build_root() -> anyhow::Result<PathBuf> {
    resolve_build_root_with_home(dirs::home_dir())
}

/// Accepts an explicit home directory for testability (existing pattern).
fn resolve_build_root_with_home(home: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());
    resolve_build_root_inner(home, dev_root)
}

/// Core resolution logic, separated for testability (`dev_root` can be overridden).
fn resolve_build_root_inner(
    home: Option<PathBuf>,
    dev_root: Option<PathBuf>,
) -> anyhow::Result<PathBuf> {
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

    // 2. Dev source tree — prefer local sources over marker so `make dev`
    //    picks up code changes instead of a stale installed bundle.
    if let Some(ref root) = dev_root {
        if root.join("containers").exists() {
            return Ok(root.clone());
        }
    }

    // 3. ~/.speedwave/resources-dir marker (written by Desktop app, read by CLI)
    if let Some(ref home) = home {
        if let Some(root) = resolve_from_marker(home) {
            return Ok(root);
        }
    }

    anyhow::bail!(
        "Container build context not found. \
         Ensure Speedwave Desktop is installed or run from source tree."
    )
}

/// Resolves the path to the mcp-os `index.js` entry point.
///
/// Resolution order:
/// 1. `SPEEDWAVE_RESOURCES_DIR` env var → `<dir>/mcp-os/os/dist/index.js`
/// 2. `CARGO_MANIFEST_DIR` source tree → `<repo>/mcp-servers/os/dist/index.js`
/// 3. `~/.speedwave/resources-dir` marker → `<dir>/mcp-os/os/dist/index.js`
///
/// Step 2 before 3 ensures `make dev` uses local sources (with hoisted
/// `node_modules`) instead of a stale bundle path written by the installed app.
pub fn resolve_mcp_os_script() -> Option<std::path::PathBuf> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|repo| repo.join("mcp-servers/os/dist/index.js"));
    resolve_mcp_os_script_inner(
        crate::consts::data_dir().parent().map(|p| p.to_path_buf()),
        dev,
    )
}

/// Internal implementation that accepts an explicit home directory for testability.
#[cfg(test)]
fn resolve_mcp_os_script_with_home(home: Option<PathBuf>) -> Option<std::path::PathBuf> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|repo| repo.join("mcp-servers/os/dist/index.js"));
    resolve_mcp_os_script_inner(home, dev)
}

/// Core resolution logic, separated for testability (dev_path can be overridden).
fn resolve_mcp_os_script_inner(
    home: Option<PathBuf>,
    dev_path: Option<PathBuf>,
) -> Option<std::path::PathBuf> {
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

    // 2. Dev source tree — prefer local sources over marker so `make dev`
    //    picks up hoisted node_modules from the workspace
    if let Some(ref p) = dev_path {
        if p.exists() {
            return dev_path;
        }
    }

    // 3. Marker file (CLI reads Desktop's resources path)
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

    if let Some(ref p) = dev_path {
        log::warn!("mcp-os not found at dev path: {}", p.display());
    }

    None
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
    let marker_dir = crate::consts::data_dir();
    let marker = marker_dir.join(crate::consts::RESOURCES_MARKER);
    std::fs::create_dir_all(marker_dir)?;
    let tmp = marker_dir.join(format!("{}.tmp", crate::consts::RESOURCES_MARKER));
    std::fs::write(&tmp, resources_dir.to_string_lossy().as_bytes())?;
    std::fs::rename(&tmp, &marker)?;
    Ok(())
}

/// Internal implementation that accepts an explicit home directory for testability.
#[cfg(test)]
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

/// Containerd overlayfs snapshotter corruption that survived a prune attempt.
///
/// Returned by `build_all_images` when:
/// 1. First build fails with a snapshotter error (e.g. "failed to rename: file exists")
/// 2. `system_prune` + retry also fails
///
/// The `Display` impl includes platform-specific restart commands so callers
/// can interpolate `{e}` directly without adding their own diagnostic hints.
#[derive(Debug)]
pub struct SnapshotterRecoveryFailed {
    pub inner: anyhow::Error,
}

impl std::fmt::Display for SnapshotterRecoveryFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Containerd snapshotter corrupted. Prune did not help (second build: {inner}).\n\
             Fix: {hint}",
            inner = self.inner,
            hint = platform_restart_hint(),
        )
    }
}

impl std::error::Error for SnapshotterRecoveryFailed {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.inner.as_ref())
    }
}

fn platform_restart_hint() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "systemctl --user restart containerd && systemctl --user restart buildkit"
    }
    #[cfg(target_os = "macos")]
    {
        "limactl shell speedwave -- sudo systemctl restart containerd && \
         limactl shell speedwave -- sudo systemctl restart buildkit; \
         limactl shell speedwave -- sudo buildctl debug workers"
    }
    #[cfg(target_os = "windows")]
    {
        "wsl.exe -d Speedwave -- systemctl restart containerd && \
         wsl.exe -d Speedwave -- systemctl restart buildkit"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        "restart containerd and buildkit manually"
    }
}

/// Rebuilds all container images from their Containerfiles.
///
/// Calls `runtime.prepare_build_context()` to translate the host build-root into
/// a path accessible by the container engine (e.g. copy into `~` for Lima VM,
/// convert `C:\` → `/mnt/c/` for WSL).
///
/// If the build fails with a containerd overlayfs snapshotter error
/// ("failed to rename: file exists"), automatically prunes dangling images and
/// build cache, then retries once. If the retry also fails, returns
/// `SnapshotterRecoveryFailed` so callers can decide whether to restart the
/// container engine (safe during setup) or propagate with diagnostics
/// (when containers are running).
///
/// This is a known containerd bug (containerd#11719, nerdctl#3420).
///
/// Returns the number of images successfully built.
pub fn build_all_images(runtime: &dyn ContainerRuntime) -> anyhow::Result<u32> {
    let manifest = bundle::load_current_bundle_manifest()?;
    build_all_images_for_bundle(runtime, &manifest.bundle_id)
}

/// Decide whether pruning a previous bundle's images is warranted.
///
/// Returns `Some(old_id)` only when the previously applied bundle exists and
/// differs from the new one. Fresh installs (`applied` is `None`) and
/// same-version rebuilds (`applied == new`) return `None`, so the caller
/// skips `prune_old_bundle_images` entirely in those cases.
pub fn should_prune_bundle<'a>(applied: Option<&'a str>, new_bundle_id: &str) -> Option<&'a str> {
    match applied {
        Some(old) if old != new_bundle_id => Some(old),
        _ => None,
    }
}

/// Remove images from a previous bundle to reclaim disk space.
pub fn prune_old_bundle_images(
    runtime: &dyn ContainerRuntime,
    old_bundle_id: &str,
) -> anyhow::Result<()> {
    let tags: Vec<String> = IMAGES
        .iter()
        .map(|img| image_ref(img.name, old_bundle_id))
        .collect();
    if tags.is_empty() {
        return Ok(());
    }
    log::info!(
        "Pruning {} images from old bundle {old_bundle_id}",
        tags.len()
    );
    runtime.remove_images(&tags)
}

pub fn build_all_images_for_bundle(
    runtime: &dyn ContainerRuntime,
    bundle_id: &str,
) -> anyhow::Result<u32> {
    let root = resolve_build_root()?;
    let vm_root = runtime.prepare_build_context(&root)?;
    let needs_cleanup = vm_root != root;

    let result = try_build_all(runtime, &vm_root, bundle_id).or_else(|first_err| {
        if is_snapshotter_error(&first_err) {
            log::warn!(
                "build failed with containerd snapshotter error, pruning and retrying: {first_err}"
            );
            if let Err(prune_err) = runtime.system_prune() {
                log::warn!("system prune failed: {prune_err}");
            }
            try_build_all(runtime, &vm_root, bundle_id).map_err(|second_err| {
                anyhow::Error::new(SnapshotterRecoveryFailed { inner: second_err })
            })
        } else if is_transient_build_error(&first_err) {
            log::warn!("build failed with transient error, retrying once: {first_err}");
            try_build_all(runtime, &vm_root, bundle_id)
        } else {
            Err(first_err)
        }
    });

    // Enrich final error with VM guidance if I/O related
    let result = result.map_err(|err| {
        if is_transient_build_error(&err) {
            err.context(
                "Image build failed due to an I/O error. If running inside a virtual machine \
                 (VMware, VirtualBox), try increasing VM memory to at least 8 GB and ensuring \
                 nested virtualization is enabled in VM settings.",
            )
        } else {
            err
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
fn try_build_all(
    runtime: &dyn ContainerRuntime,
    vm_root: &std::path::Path,
    bundle_id: &str,
) -> anyhow::Result<u32> {
    let total = IMAGES.len();
    let mut built = 0u32;
    log::info!(
        "build_all_images: building {total} images from {}",
        vm_root.display()
    );
    let root_str = vm_root.to_string_lossy();
    let root_str = root_str.trim_end_matches('/');
    for (i, img) in IMAGES.iter().enumerate() {
        let tag = image_ref(img.name, bundle_id);
        log::info!(
            "build_all_images: [{}/{}] building {} (context={}, file={})",
            i + 1,
            total,
            tag,
            img.context_dir,
            img.containerfile
        );
        // Use string concatenation with "/" instead of PathBuf::join because vm_root
        // may be a WSL/Linux path (e.g. "/mnt/c/Speedwave/build-context") running on
        // a Windows host. PathBuf::join treats `/`-prefixed paths as absolute roots
        // on Windows, replacing the base entirely instead of appending.
        let abs_context = format!("{}/{}", root_str, img.context_dir);
        let abs_containerfile = format!("{}/{}", root_str, img.containerfile);
        runtime.build_image(&tag, &abs_context, &abs_containerfile, img.build_args)?;
        built += 1;
        log::info!("build_all_images: [{}/{}] {} built OK", i + 1, total, tag);
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
        let msg = cause.to_string().to_ascii_lowercase();
        if msg.contains("apply layer error")
            || msg.contains("failed to prepare extraction snapshot")
            || (msg.contains("failed to rename") && msg.contains("file exists"))
        {
            return true;
        }
    }
    false
}

/// Returns `true` if the build error looks transient (I/O timeout, connection reset,
/// temporary unavailable). These may succeed on retry without any recovery action.
///
/// Uses case-insensitive matching because kernel/libc error messages vary in casing
/// across distros and locales.
fn is_transient_build_error(err: &anyhow::Error) -> bool {
    for cause in err.chain() {
        let msg = cause.to_string().to_ascii_lowercase();
        if msg.contains("i/o timeout")
            || msg.contains("input/output error")
            || msg.contains("connection reset")
            || msg.contains("temporary failure")
            || msg.contains("resource temporarily unavailable")
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
    fn test_image_names_are_unversioned() {
        for img in IMAGES {
            assert!(
                !img.name.contains(':'),
                "image name '{}' should not contain a tag suffix",
                img.name
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
                img.name,
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
                img.name,
                path.display()
            );
        }
    }

    /// Verifies that shell scripts COPY'd into Containerfile.claude have their
    /// shebang interpreter (`bash`) explicitly installed via `apt-get install`.
    ///
    /// node:24-bookworm-slim does NOT include bash — only dash (/bin/sh).
    /// If a COPY'd script uses `#!/bin/bash` but the Containerfile doesn't
    /// `apt-get install bash`, the build fails with "not found" at runtime.
    #[test]
    fn test_containerfile_claude_installs_bash_for_copied_scripts() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        let root = resolve_build_root_with_home(None).unwrap();
        let containerfile = std::fs::read_to_string(root.join("containers/Containerfile.claude"))
            .expect("Containerfile.claude should be readable");

        // Collect all COPY'd .sh scripts
        let copied_scripts: Vec<&str> = containerfile
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                trimmed.starts_with("COPY") && trimmed.contains(".sh")
            })
            .collect();
        assert!(
            !copied_scripts.is_empty(),
            "Containerfile.claude should COPY at least one .sh script"
        );

        // Read each script and check its shebang
        for line in &copied_scripts {
            // Extract source filename from COPY line (e.g. "COPY --chmod=755 install-claude.sh ...")
            let src = line
                .split_whitespace()
                .find(|s| s.ends_with(".sh"))
                .unwrap_or_else(|| panic!("cannot parse .sh source from COPY line: {line}"));

            let script_path = root.join("containers").join(src);
            let content = std::fs::read_to_string(&script_path)
                .unwrap_or_else(|_| panic!("cannot read COPY'd script: {}", script_path.display()));

            if let Some(shebang) = content.lines().next() {
                if shebang.contains("bash") {
                    assert!(
                        containerfile.contains("apt-get install") && containerfile.contains("bash"),
                        "Script {} uses #!/bin/bash but Containerfile.claude does not \
                         `apt-get install bash`. node:24-bookworm-slim has only dash.",
                        src
                    );
                }
            }
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
    fn test_resolve_build_root_env_wins_over_dev_and_marker() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();

        // Set up env var path
        let env_resources = tmp.path().join("env-resources");
        std::fs::create_dir_all(env_resources.join("build-context").join("containers")).unwrap();
        std::env::set_var(
            crate::consts::BUNDLE_RESOURCES_ENV,
            env_resources.to_string_lossy().as_ref(),
        );

        // Set up competing dev and marker paths
        let fake_home = tmp.path().join("home");
        let fake_dev = tmp.path().join("dev-root");
        let marker_resources = tmp.path().join("marker-resources");
        std::fs::create_dir_all(fake_dev.join("containers")).unwrap();
        std::fs::create_dir_all(marker_resources.join("build-context").join("containers")).unwrap();
        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            marker_resources.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let root = resolve_build_root_inner(Some(fake_home), Some(fake_dev)).unwrap();
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
    fn test_resolve_build_root_marker_used_when_no_dev() {
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

        let root = resolve_build_root_inner(Some(fake_home), None).unwrap();
        assert_eq!(root, fake_resources.join("build-context"));
    }

    #[test]
    fn test_resolve_build_root_dev_priority_over_marker() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_marker = tmp.path().join("marker-resources");
        let fake_dev = tmp.path().join("dev-root");

        // Both marker and dev have valid build-context
        std::fs::create_dir_all(fake_marker.join("build-context").join("containers")).unwrap();
        std::fs::create_dir_all(fake_dev.join("containers")).unwrap();

        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            fake_marker.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let root = resolve_build_root_inner(Some(fake_home), Some(fake_dev.clone())).unwrap();
        assert_eq!(root, fake_dev, "dev source tree should win over marker");
    }

    #[test]
    fn test_resolve_build_root_marker_fallback_when_dev_missing_containers() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_marker = tmp.path().join("marker-resources");
        let fake_dev = tmp.path().join("dev-root");

        // Dev exists but has no containers/ dir
        std::fs::create_dir_all(&fake_dev).unwrap();
        // Marker has valid build-context
        std::fs::create_dir_all(fake_marker.join("build-context").join("containers")).unwrap();

        let marker_dir = fake_home.join(crate::consts::DATA_DIR);
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join(crate::consts::RESOURCES_MARKER),
            fake_marker.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let root = resolve_build_root_inner(Some(fake_home), Some(fake_dev)).unwrap();
        assert_eq!(
            root,
            fake_marker.join("build-context"),
            "should fall back to marker when dev has no containers/"
        );
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
        let result = resolve_mcp_os_script_inner(None, None);
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

        // Pass None as dev_path to test marker fallback in isolation
        let result = resolve_mcp_os_script_inner(Some(fake_home), None);
        assert_eq!(result, Some(script_path));
    }

    #[test]
    fn test_resolve_mcp_os_script_dev_path_beats_marker() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");
        let fake_dev = tmp.path().join("dev-repo");

        // Set up marker script
        let marker_script = fake_resources
            .join("mcp-os")
            .join("os")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(marker_script.parent().unwrap()).unwrap();
        std::fs::write(&marker_script, "// marker").unwrap();
        write_resources_marker_to(&fake_resources, &fake_home).unwrap();

        // Set up dev script
        let dev_script = fake_dev.join("mcp-servers/os/dist/index.js");
        std::fs::create_dir_all(dev_script.parent().unwrap()).unwrap();
        std::fs::write(&dev_script, "// dev").unwrap();

        let result = resolve_mcp_os_script_inner(Some(fake_home), Some(dev_script.clone()));
        assert_eq!(result, Some(dev_script), "dev path should win over marker");
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
            build_args: Vec<(String, String)>,
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
                build_args: &[(&str, &str)],
            ) -> anyhow::Result<()> {
                self.build_calls.lock().unwrap().push(Call {
                    tag: tag.to_string(),
                    context_dir: context_dir.to_string(),
                    containerfile: containerfile.to_string(),
                    build_args: build_args
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
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
            fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
                Ok(true)
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
        let bundle_id = "test-bundle";
        let result = build_all_images_for_bundle(&rt, bundle_id);
        assert!(result.is_ok());

        assert!(
            *prepare_called.lock().unwrap(),
            "prepare_build_context should be called"
        );

        let calls = build_calls.lock().unwrap();
        assert_eq!(calls.len(), IMAGES.len());

        for (call, img) in calls.iter().zip(IMAGES.iter()) {
            assert_eq!(call.tag, image_ref(img.name, bundle_id));
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
            let expected_args: Vec<(String, String)> = img
                .build_args
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            assert_eq!(
                call.build_args, expected_args,
                "build_args for '{}' should match ImageDef",
                call.tag
            );
        }
    }

    #[test]
    fn test_claude_image_has_build_args() {
        let claude_img = IMAGES
            .iter()
            .find(|img| img.name.contains("claude"))
            .unwrap();
        assert_eq!(claude_img.build_args.len(), 1);
        assert_eq!(claude_img.build_args[0].0, "CLAUDE_VERSION");
        assert_eq!(claude_img.build_args[0].1, crate::defaults::CLAUDE_VERSION);
    }

    #[test]
    fn test_non_claude_images_have_no_build_args() {
        for img in IMAGES.iter().filter(|img| !img.name.contains("claude")) {
            assert!(
                img.build_args.is_empty(),
                "non-claude image '{}' should have empty build_args",
                img.name
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
            _build_args: &[(&str, &str)],
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
        fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
            Ok(true)
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

        let result = try_build_all(&rt, &rt.build_root.clone(), "test-bundle").or_else(|e| {
            if is_snapshotter_error(&e) {
                if let Err(prune_err) = rt.system_prune() {
                    log::warn!("system prune failed: {prune_err}");
                }
                try_build_all(&rt, &rt.build_root.clone(), "test-bundle")
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

        let result = try_build_all(&rt, &rt.build_root.clone(), "test-bundle").or_else(|e| {
            if is_snapshotter_error(&e) {
                if let Err(prune_err) = rt.system_prune() {
                    log::warn!("system prune failed: {prune_err}");
                }
                try_build_all(&rt, &rt.build_root.clone(), "test-bundle")
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

        let result = try_build_all(&rt, &rt.build_root.clone(), "test-bundle").or_else(|e| {
            if is_snapshotter_error(&e) {
                if let Err(prune_err) = rt.system_prune() {
                    log::warn!("system prune failed: {prune_err}");
                }
                try_build_all(&rt, &rt.build_root.clone(), "test-bundle")
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

    #[test]
    fn test_snapshotter_recovery_failed_downcast() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let image_count = IMAGES.len() as u32;

        // First attempt: fail on call 3 with snapshotter error
        // Retry: fail on call (3 + image_count) with a different error
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            3,
            "apply layer error for \"docker.io/library/img:latest\"".to_string(),
        );
        fail_on.insert(3 + image_count, "still broken after prune".to_string());

        let (_tmp, build_root) = create_fake_build_root();
        let rt = RetryMockRuntime {
            build_root,
            calls: Arc::clone(&calls),
            build_call_counter: Arc::clone(&counter),
            fail_on,
        };

        let result = build_all_images_for_bundle(&rt, "test-bundle");
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(
            err.downcast_ref::<SnapshotterRecoveryFailed>().is_some(),
            "should return SnapshotterRecoveryFailed, got: {err}"
        );
    }

    #[test]
    fn test_snapshotter_recovery_failed_source_preserves_chain() {
        let inner = anyhow::anyhow!("still broken");
        let recovery = SnapshotterRecoveryFailed { inner };
        let source = std::error::Error::source(&recovery);
        assert!(source.is_some(), "source() should return the inner error");
        assert!(
            source.unwrap().to_string().contains("still broken"),
            "source should preserve the inner error message"
        );
    }

    #[test]
    fn test_snapshotter_recovery_failed_display_contains_hint() {
        let inner = anyhow::anyhow!("build failed again");
        let recovery = SnapshotterRecoveryFailed { inner };
        let display = recovery.to_string();
        assert!(
            display.contains("Containerd snapshotter corrupted"),
            "Display should describe root cause, got: {display}"
        );
        assert!(
            display.contains("Prune did not help"),
            "Display should mention prune failure, got: {display}"
        );
        assert!(
            display.contains("build failed again"),
            "Display should contain inner error, got: {display}"
        );
        assert!(
            display.contains("Fix:"),
            "Display should contain platform-specific fix hint, got: {display}"
        );
    }

    #[test]
    fn test_build_all_images_non_snapshotter_error_not_wrapped() {
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

        let result = build_all_images_for_bundle(&rt, "test-bundle");
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(
            err.downcast_ref::<SnapshotterRecoveryFailed>().is_none(),
            "non-snapshotter error should NOT be wrapped as SnapshotterRecoveryFailed"
        );
        assert!(
            err.to_string().contains("network timeout"),
            "original error should propagate unchanged"
        );
    }

    // ── images_exist tests ─────────────────────────────────────────────

    mod images_exist_tests {
        use super::*;
        use crate::runtime::ContainerRuntime;
        use std::sync::Mutex;

        struct ImageCheckRuntime {
            missing_tags: Mutex<Vec<String>>,
        }

        impl ImageCheckRuntime {
            fn all_present() -> Self {
                Self {
                    missing_tags: Mutex::new(vec![]),
                }
            }

            fn with_missing(tags: Vec<&str>) -> Self {
                Self {
                    missing_tags: Mutex::new(tags.into_iter().map(String::from).collect()),
                }
            }
        }

        impl ContainerRuntime for ImageCheckRuntime {
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
                _: &str,
                _: &str,
                _: &str,
                _: &[(&str, &str)],
            ) -> anyhow::Result<()> {
                Ok(())
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
                let missing = self.missing_tags.lock().unwrap();
                Ok(!missing.iter().any(|t| tag.contains(t.as_str())))
            }
        }

        #[test]
        fn test_images_exist_returns_true_when_all_present() {
            let rt = ImageCheckRuntime::all_present();
            assert!(images_exist(&rt));
        }

        #[test]
        fn test_images_exist_returns_false_when_any_missing() {
            let rt = ImageCheckRuntime::with_missing(vec!["speedwave-claude"]);
            assert!(!images_exist(&rt));
        }
    }

    // -----------------------------------------------------------------------
    // Containerfile structural tests (Step 1)
    // -----------------------------------------------------------------------

    #[test]
    fn test_containerfile_claude_uses_apt_retries() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        let root = resolve_build_root_with_home(None).unwrap();
        let containerfile = std::fs::read_to_string(root.join("containers/Containerfile.claude"))
            .expect("Containerfile.claude should be readable");

        assert!(
            containerfile
                .lines()
                .any(|l| l.contains("apt-get update") && l.contains("Acquire::Retries")),
            "Containerfile.claude should use Acquire::Retries on apt-get update"
        );
    }

    #[test]
    fn test_containerfile_claude_uses_unsafe_io_for_install() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        let root = resolve_build_root_with_home(None).unwrap();
        let containerfile = std::fs::read_to_string(root.join("containers/Containerfile.claude"))
            .expect("Containerfile.claude should be readable");

        assert!(
            containerfile.contains("force-unsafe-io"),
            "Containerfile.claude should use --force-unsafe-io for apt-get install"
        );
    }

    // -----------------------------------------------------------------------
    // is_transient_build_error() tests (Step 2)
    // -----------------------------------------------------------------------

    #[test]
    fn test_is_transient_build_error_io_timeout() {
        let err = anyhow::anyhow!("nerdctl build failed: i/o timeout");
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_input_output_error() {
        let err = anyhow::anyhow!("dpkg: error processing: Input/output error");
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_connection_reset() {
        let err = anyhow::anyhow!("connection reset by peer");
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_temporary_failure() {
        let err = anyhow::anyhow!("Temporary failure resolving deb.debian.org");
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_memory_is_not_transient() {
        let err = anyhow::anyhow!("Cannot allocate memory");
        assert!(
            !is_transient_build_error(&err),
            "OOM is not transient — retry would waste time"
        );
    }

    #[test]
    fn test_is_transient_build_error_resource_unavailable() {
        let err = anyhow::anyhow!("Resource temporarily unavailable");
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_case_insensitive() {
        let err = anyhow::anyhow!("I/O TIMEOUT during build");
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_unrelated() {
        let err = anyhow::anyhow!("permission denied");
        assert!(!is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_empty() {
        let err = anyhow::anyhow!("");
        assert!(!is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_chain() {
        let inner = anyhow::anyhow!("input/output error");
        let outer = inner
            .context("nerdctl build failed")
            .context("build step 3/10");
        assert!(is_transient_build_error(&outer));
    }

    // -----------------------------------------------------------------------
    // is_snapshotter_error() Boy Scout case-insensitivity test
    // -----------------------------------------------------------------------

    #[test]
    fn test_is_snapshotter_error_case_insensitive() {
        let err = anyhow::anyhow!("Apply Layer Error");
        assert!(is_snapshotter_error(&err));
    }

    // -----------------------------------------------------------------------
    // Priority: snapshotter error takes precedence over transient
    // -----------------------------------------------------------------------

    #[test]
    fn test_snapshotter_error_takes_priority_over_transient() {
        // Error contains both a snapshotter pattern and a transient I/O pattern
        let err = anyhow::anyhow!("apply layer error: input/output error");
        assert!(
            is_snapshotter_error(&err),
            "is_snapshotter_error should match when both patterns present"
        );
    }

    // -----------------------------------------------------------------------
    // Error enrichment tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_build_error_enrichment_adds_vm_hint() {
        let err = anyhow::anyhow!("input/output error");
        let enriched = if is_transient_build_error(&err) {
            err.context(
                "Image build failed due to an I/O error. If running inside a virtual machine \
                 (VMware, VirtualBox), try increasing VM memory to at least 8 GB and ensuring \
                 nested virtualization is enabled in VM settings.",
            )
        } else {
            err
        };
        let msg = format!("{enriched:#}");
        assert!(
            msg.contains("virtual machine"),
            "enriched error should contain VM guidance, got: {msg}"
        );
    }

    #[test]
    fn test_build_error_enrichment_preserves_unrelated() {
        let err = anyhow::anyhow!("permission denied");
        let result = if is_transient_build_error(&err) {
            err.context("VM hint")
        } else {
            err
        };
        let msg = format!("{result:#}");
        assert!(
            !msg.contains("virtual machine"),
            "non-I/O error should not get VM hint, got: {msg}"
        );
    }

    #[test]
    fn test_build_error_enrichment_chain_wrapped() {
        let inner = anyhow::anyhow!("i/o timeout");
        let outer = inner.context("nerdctl build failed");
        let enriched = if is_transient_build_error(&outer) {
            outer.context(
                "Image build failed due to an I/O error. If running inside a virtual machine \
                 (VMware, VirtualBox), try increasing VM memory to at least 8 GB and ensuring \
                 nested virtualization is enabled in VM settings.",
            )
        } else {
            outer
        };
        let msg = format!("{enriched:#}");
        assert!(
            msg.contains("virtual machine"),
            "chain-wrapped I/O error should still get VM hint, got: {msg}"
        );
    }

    // ── prune_old_bundle_images tests ─────────────────────────────────────

    /// Minimal mock runtime that records remove_images calls.
    struct PruneMockRuntime {
        removed_tags: Arc<Mutex<Vec<String>>>,
    }

    impl PruneMockRuntime {
        fn new() -> Self {
            Self {
                removed_tags: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl ContainerRuntime for PruneMockRuntime {
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
        fn build_image(&self, _: &str, _: &str, _: &str, _: &[(&str, &str)]) -> anyhow::Result<()> {
            Ok(())
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
        fn remove_images(&self, tags: &[String]) -> anyhow::Result<()> {
            self.removed_tags.lock().unwrap().extend_from_slice(tags);
            Ok(())
        }
    }

    #[test]
    fn test_prune_old_bundle_images_generates_correct_tags() {
        let rt = PruneMockRuntime::new();
        prune_old_bundle_images(&rt, "abc123").unwrap();

        let removed = rt.removed_tags.lock().unwrap().clone();
        assert_eq!(
            removed.len(),
            IMAGES.len(),
            "should remove exactly {} tags (one per image)",
            IMAGES.len()
        );
        for (tag, img) in removed.iter().zip(IMAGES.iter()) {
            assert_eq!(
                tag,
                &image_ref(img.name, "abc123"),
                "tag should be <name>:abc123"
            );
        }
    }

    #[test]
    fn test_prune_old_bundle_images_same_id_still_works() {
        // The caller is responsible for guarding same-id; the function itself is correct either way.
        let rt = PruneMockRuntime::new();
        prune_old_bundle_images(&rt, "same123").unwrap();
        assert_eq!(rt.removed_tags.lock().unwrap().len(), IMAGES.len());
    }

    #[test]
    fn should_prune_bundle_returns_none_for_fresh_install() {
        assert_eq!(should_prune_bundle(None, "new-bundle-id"), None);
    }

    #[test]
    fn should_prune_bundle_returns_none_for_same_bundle() {
        assert_eq!(should_prune_bundle(Some("same-id"), "same-id"), None);
    }

    #[test]
    fn should_prune_bundle_returns_old_id_for_different_bundle() {
        assert_eq!(
            should_prune_bundle(Some("old-id"), "new-id"),
            Some("old-id")
        );
    }

    #[test]
    fn should_prune_bundle_handles_empty_strings() {
        // Empty applied id differs from non-empty new id — prune signalled.
        assert_eq!(should_prune_bundle(Some(""), "new-id"), Some(""));
        // Both empty (unexpected, but well-defined) — same-id path.
        assert_eq!(should_prune_bundle(Some(""), ""), None);
    }
}

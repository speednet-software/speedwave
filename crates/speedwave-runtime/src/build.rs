//! Container image build orchestration and SSOT image catalogue.

use crate::bundle;
use crate::config::ResolvedIntegrationsConfig;
use std::path::PathBuf;

/// A container image definition. Build set is selected per project via [`enabled_images`].
pub struct ImageDef {
    /// Docker/OCI repository name, e.g. `"speedwave-claude"`.
    pub name: &'static str,
    /// Context directory relative to the build root (as resolved by `resolve_build_root()`).
    pub context_dir: &'static str,
    /// Containerfile path relative to the build root.
    pub containerfile: &'static str,
    /// Build arguments passed as `--build-arg KEY=VAL` to the container engine.
    pub build_args: &'static [(&'static str, &'static str)],
    /// Paths (relative to build root; file or dir) feeding this image's
    /// build-input hash. Must cover the containerfile and every COPY/ADD
    /// source — enforced by `hash_inputs_cover_copy_sources` (ADR-072).
    pub hash_inputs: &'static [&'static str],
}

/// Prefix on every toggleable MCP worker image; the suffix is the integration
/// config key (`speedwave-mcp-slack` ↔ `slack`). Same naming rule as compose names.
const MCP_IMAGE_PREFIX: &str = "speedwave-mcp-";

/// SSOT for all container images — used by both Desktop (setup wizard) and the update flow.
///
/// All paths are relative to the build root returned by `resolve_build_root()`.
/// Build args for the Claude container — passes the pinned version to Containerfile.claude.
const CLAUDE_BUILD_ARGS: &[(&str, &str)] = &[("CLAUDE_VERSION", crate::defaults::CLAUDE_VERSION)];

/// Claude Code container image name.
pub const IMAGE_CLAUDE: &str = "speedwave-claude";
/// MCP hub image name.
pub const IMAGE_MCP_HUB: &str = "speedwave-mcp-hub";
/// Slack MCP worker image name.
pub const IMAGE_MCP_SLACK: &str = "speedwave-mcp-slack";
/// SharePoint MCP worker image name.
pub const IMAGE_MCP_SHAREPOINT: &str = "speedwave-mcp-sharepoint";
/// Redmine MCP worker image name.
pub const IMAGE_MCP_REDMINE: &str = "speedwave-mcp-redmine";
/// GitLab MCP worker image name.
pub const IMAGE_MCP_GITLAB: &str = "speedwave-mcp-gitlab";
/// GitHub MCP worker image name.
pub const IMAGE_MCP_GITHUB: &str = "speedwave-mcp-github";
/// Atlassian MCP worker image name.
pub const IMAGE_MCP_ATLASSIAN: &str = "speedwave-mcp-atlassian";
/// Office documents MCP worker image name.
pub const IMAGE_MCP_OFFICE: &str = "speedwave-mcp-office";
/// Playwright MCP worker image name.
pub const IMAGE_MCP_PLAYWRIGHT: &str = "speedwave-mcp-playwright";
/// Context7 MCP worker image name.
pub const IMAGE_MCP_CONTEXT7: &str = "speedwave-mcp-context7";

/// All container images built by Speedwave (SSOT, aligned with `bundle-build-context.sh`).
pub const IMAGES: &[ImageDef] = &[
    ImageDef {
        name: IMAGE_CLAUDE,
        context_dir: "containers",
        containerfile: "containers/Containerfile.claude",
        build_args: CLAUDE_BUILD_ARGS,
        // Explicit file list: containers/ also holds claude-resources/ (synced +
        // mounted, never baked) and compose.template.yml — neither may rebuild claude.
        hash_inputs: &[
            "containers/Containerfile.claude",
            "containers/entrypoint.sh",
            "containers/install-claude.sh",
            "containers/osc52-copy.sh",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_HUB,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/hub/Containerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/hub",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_SLACK,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/slack/Dockerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/slack",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_SHAREPOINT,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/sharepoint/Dockerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/sharepoint",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_REDMINE,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/redmine/Dockerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/redmine",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_GITLAB,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/gitlab/Dockerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/gitlab",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_GITHUB,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/github/Dockerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/github",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_ATLASSIAN,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/atlassian/Dockerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/atlassian",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_OFFICE,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/office/Dockerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/office",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
    ImageDef {
        name: IMAGE_MCP_PLAYWRIGHT,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/playwright/Containerfile",
        build_args: &[],
        // No COPY/ADD: base image pin + RUN layers live in the Containerfile.
        hash_inputs: &["mcp-servers/playwright"],
    },
    ImageDef {
        name: IMAGE_MCP_CONTEXT7,
        context_dir: "mcp-servers",
        containerfile: "mcp-servers/context7/Dockerfile",
        build_args: &[],
        hash_inputs: &[
            "mcp-servers/context7",
            "mcp-servers/shared",
            "mcp-servers/tsconfig.base.json",
        ],
    },
];

/// Build set for the given integrations: `claude` + `mcp-hub` always, plus the
/// worker image for each enabled built-in MCP service. Plugin images go through
/// `plugin::ensure_plugin_images`; the `os` worker has no image.
pub fn enabled_images(integrations: &ResolvedIntegrationsConfig) -> Vec<&'static ImageDef> {
    IMAGES
        .iter()
        .filter(|img| match img.name.strip_prefix(MCP_IMAGE_PREFIX) {
            None => true, // speedwave-claude — always built
            Some("hub") => true,
            Some(key) => integrations.is_service_enabled(key) == Some(true),
        })
        .collect()
}

/// `ImageDef` for a built-in MCP integration config key; test-only helper.
#[cfg(test)]
fn image_for_service_key(config_key: &str) -> Option<&'static ImageDef> {
    if config_key == "hub" {
        return None;
    }
    let target = format!("{MCP_IMAGE_PREFIX}{config_key}");
    IMAGES.iter().find(|img| img.name == target)
}

/// Used when `std::thread::available_parallelism()` cannot determine CPU count.
/// Conservative for nested-VM hosts where extra parallelism amplifies I/O
/// contention (see ADR-032).
const DEFAULT_BUILD_WORKER_FALLBACK: usize = 4;

/// How many times to retry a build that failed with a transient error
/// (I/O hiccup, DNS not yet settled after VM boot — see `is_transient_build_error`).
const TRANSIENT_BUILD_RETRIES: u32 = 2;

/// Base wait before the first transient retry; the Nth retry waits `BASE * N`.
/// Sized so the VM's `systemd-resolved` has time to fall back from EDNS0 to plain
/// UDP, while two attempts (3s + 6s) don't noticeably stall a genuinely-down network.
/// Near-zero under `cfg(test)` so retry-path tests don't actually sleep.
#[cfg(not(test))]
const TRANSIENT_BUILD_RETRY_BASE_DELAY: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(test)]
const TRANSIENT_BUILD_RETRY_BASE_DELAY: std::time::Duration = std::time::Duration::from_millis(1);

/// Tags an image name with its build-input hash (`name:hash`).
pub fn image_ref(name: &str, hash: &str) -> String {
    format!("{name}:{hash}")
}

/// In-process half of the global image-build lock. Cross-process half is the
/// `<data_dir>/build.lock` file — see [`with_build_lock`].
static BUILD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Serialises image builds + tag prunes across processes (Desktop reconcile,
/// CLI update, project switch). Outside compose locks per ADR-066; hold around
/// a build+prune sequence, never around `compose up`. Not reentrant (ADR-072).
pub fn with_build_lock<F, T>(f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    with_build_lock_in(crate::consts::data_dir(), f)
}

/// Testable variant of [`with_build_lock`] — lock-file root supplied explicitly.
pub fn with_build_lock_in<F, T>(data_dir: &std::path::Path, f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    crate::runtime::compose_locks::with_file_lock_in(&BUILD_LOCK, &data_dir.join("build.lock"), f)
}

/// `true` if every image that should exist for `integrations` is present —
/// only [`enabled_images`], since disabled integrations have no image under
/// lazy builds. Pass the union across projects when reconciling. Call
/// `rt.ensure_ready()` first; do not guard with `is_available()` (a stopped
/// VM is false there but `ensure_ready()` starts it).
pub fn images_exist(
    rt: &super::runtime::LockedRuntime,
    integrations: &ResolvedIntegrationsConfig,
) -> bool {
    let manifest = match crate::bundle::load_current_bundle_manifest() {
        Ok(m) => m,
        Err(e) => {
            log::warn!("images_exist: cannot load bundle manifest: {e}");
            return false;
        }
    };
    images_exist_with_manifest(rt, integrations, &manifest)
}

/// Core of [`images_exist`] taking an explicit manifest, so tests inject a build
/// root and never read `SPEEDWAVE_RESOURCES_DIR` or the production marker.
pub fn images_exist_with_manifest(
    rt: &super::runtime::LockedRuntime,
    integrations: &ResolvedIntegrationsConfig,
    manifest: &crate::bundle::BundleManifest,
) -> bool {
    enabled_images(integrations).iter().all(|img| {
        let Ok(tag) = manifest.image_tag(img.name) else {
            log::warn!("images_exist: no hash for {} in manifest", img.name);
            return false;
        };
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
    let dev = repo_dev_path("mcp-servers/os/dist/index.js");
    resolve_worker_script_inner(
        "mcp-os",
        &["mcp-os", "os", "dist", "index.js"],
        crate::consts::data_dir().parent().map(|p| p.to_path_buf()),
        dev,
    )
}

#[cfg(test)]
fn resolve_mcp_os_script_with_home(home: Option<PathBuf>) -> Option<std::path::PathBuf> {
    let dev = repo_dev_path("mcp-servers/os/dist/index.js");
    resolve_worker_script_inner("mcp-os", &["mcp-os", "os", "dist", "index.js"], home, dev)
}

/// Resolves the `host_exec` worker `index.js` (bundle → CARGO source → marker).
/// Mirrors [`resolve_mcp_os_script`]; ADR-054.
pub fn resolve_host_exec_script() -> Option<std::path::PathBuf> {
    let dev = repo_dev_path("mcp-servers/host_exec/dist/index.js");
    resolve_worker_script_inner(
        "host_exec",
        &["host_exec", "host_exec", "dist", "index.js"],
        crate::consts::data_dir().parent().map(|p| p.to_path_buf()),
        dev,
    )
}

#[cfg(test)]
fn resolve_host_exec_script_with_home(home: Option<PathBuf>) -> Option<std::path::PathBuf> {
    let dev = repo_dev_path("mcp-servers/host_exec/dist/index.js");
    resolve_worker_script_inner(
        "host_exec",
        &["host_exec", "host_exec", "dist", "index.js"],
        home,
        dev,
    )
}

/// Resolves the `oauth` worker `index.js` (bundle → CARGO source → marker).
/// Mirrors [`resolve_mcp_os_script`]; ADR-060.
pub fn resolve_oauth_script() -> Option<std::path::PathBuf> {
    let dev = repo_dev_path("mcp-servers/oauth/dist/index.js");
    resolve_worker_script_inner(
        "oauth",
        &["oauth", "oauth", "dist", "index.js"],
        crate::consts::data_dir().parent().map(|p| p.to_path_buf()),
        dev,
    )
}

/// Build a `<repo-root>/<rel>` path for the dev-tree fallback. `None` when out of tree.
fn repo_dev_path(rel: &str) -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|repo| repo.join(rel))
}

/// Test-only alias — implementation is `resolve_worker_script_inner`.
#[cfg(test)]
fn resolve_mcp_os_script_inner(
    home: Option<PathBuf>,
    dev_path: Option<PathBuf>,
) -> Option<std::path::PathBuf> {
    resolve_worker_script_inner(
        "mcp-os",
        &["mcp-os", "os", "dist", "index.js"],
        home,
        dev_path,
    )
}

/// Test-only alias — implementation is `resolve_worker_script_inner`.
#[cfg(test)]
fn resolve_host_exec_script_inner(
    home: Option<PathBuf>,
    dev_path: Option<PathBuf>,
) -> Option<std::path::PathBuf> {
    resolve_worker_script_inner(
        "host_exec",
        &["host_exec", "host_exec", "dist", "index.js"],
        home,
        dev_path,
    )
}

/// Resolve a host-side worker script via the three-tier fallback shared by all
/// bundled workers (`mcp-os`, `host_exec`, …): SPEEDWAVE_RESOURCES_DIR (bundle)
/// → repo source tree (`make dev`) → `~/.speedwave/resources-dir` marker (CLI).
/// `bundled_subpath` is the path *inside* the resources dir; `label` drives logs.
fn resolve_worker_script_inner(
    label: &str,
    bundled_subpath: &[&str],
    home: Option<PathBuf>,
    dev_path: Option<PathBuf>,
) -> Option<std::path::PathBuf> {
    let join_subpath = |base: PathBuf| -> PathBuf {
        let mut p = base;
        for seg in bundled_subpath {
            p = p.join(seg);
        }
        p
    };

    // 1. SPEEDWAVE_RESOURCES_DIR — production Tauri bundle.
    if let Ok(res) = std::env::var(crate::consts::BUNDLE_RESOURCES_ENV) {
        let p = join_subpath(PathBuf::from(&res));
        if p.exists() {
            return Some(p);
        }
        log::warn!("{label} not found at bundled path: {}", p.display());
    }

    // 2. Repo source tree — prefer local sources over the marker so `make dev`
    //    picks up hoisted node_modules from the workspace.
    if let Some(ref p) = dev_path {
        if p.exists() {
            return dev_path;
        }
    }

    // 3. Marker file — CLI reads Desktop's resources path.
    if let Some(ref home) = home {
        let marker = home
            .join(crate::consts::DATA_DIR)
            .join(crate::consts::RESOURCES_MARKER);
        if let Ok(dir) = std::fs::read_to_string(&marker) {
            let p = join_subpath(PathBuf::from(dir.trim()));
            if p.is_absolute() && p.exists() {
                return Some(p);
            }
            log::warn!("{label} not found at marker path: {}", p.display());
        }
    }

    if let Some(ref p) = dev_path {
        log::warn!("{label} not found at dev path: {}", p.display());
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
/// Returned by [`build_images_for_bundle`] when:
/// 1. First build fails with a snapshotter error (e.g. "failed to rename: file exists")
/// 2. `system_prune` + retry also fails
///
/// The `Display` impl includes platform-specific restart commands so callers
/// can interpolate `{e}` directly without adding their own diagnostic hints.
#[derive(Debug)]
pub struct SnapshotterRecoveryFailed {
    /// The underlying build error after prune-and-retry also failed.
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
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "restart containerd and buildkit manually"
    }
}

/// Builds `enabled_images(integrations)` for the current bundle, under the
/// build lock (callers — the setup wizard — never hold it already).
pub fn build_enabled_images(
    runtime: &crate::runtime::LockedRuntime,
    integrations: &ResolvedIntegrationsConfig,
) -> anyhow::Result<u32> {
    let manifest = bundle::load_current_bundle_manifest()?;
    with_build_lock(|| build_images_for_bundle(runtime, &enabled_images(integrations), &manifest))
}

/// [`build_missing_images`] under [`with_build_lock`] — the form host call
/// sites use, so the serialisation invariant can't be forgotten (ADR-072).
pub fn build_missing_images_locked(
    runtime: &crate::runtime::LockedRuntime,
    images: &[&ImageDef],
    manifest: &bundle::BundleManifest,
) -> anyhow::Result<u32> {
    with_build_lock(|| build_missing_images(runtime, images, manifest))
}

/// [`prune_orphan_current_bundle_images`] under [`with_build_lock`].
pub fn prune_orphan_current_bundle_images_locked(
    runtime: &crate::runtime::LockedRuntime,
    manifest: &bundle::BundleManifest,
    keep: &[&ImageDef],
) -> anyhow::Result<()> {
    with_build_lock(|| prune_orphan_current_bundle_images(runtime, manifest, keep))
}

/// Builds images from `images` whose per-image tag is absent. Returns count built.
pub fn build_missing_images(
    runtime: &crate::runtime::LockedRuntime,
    images: &[&ImageDef],
    manifest: &bundle::BundleManifest,
) -> anyhow::Result<u32> {
    let root = resolve_build_root()?;
    build_missing_images_in(runtime, images, manifest, &root)
}

/// Env-free core of [`build_missing_images`]: takes an explicit build root so
/// tests never read `SPEEDWAVE_RESOURCES_DIR` or the production `~/.speedwave`
/// marker.
pub fn build_missing_images_in(
    runtime: &crate::runtime::LockedRuntime,
    images: &[&ImageDef],
    manifest: &bundle::BundleManifest,
    root: &std::path::Path,
) -> anyhow::Result<u32> {
    let mut missing: Vec<&ImageDef> = Vec::new();
    for img in images.iter().copied() {
        let tag = manifest.image_tag(img.name)?;
        if !runtime.image_exists(&tag).unwrap_or(false) {
            missing.push(img);
        }
    }
    if missing.is_empty() {
        return Ok(0);
    }
    build_images_for_bundle_in(runtime, &missing, manifest, root)?;
    Ok(missing.len() as u32)
}

/// `Some(old_id)` only when the applied bundle exists and differs from `new_bundle_id`.
pub fn should_prune_bundle<'a>(applied: Option<&'a str>, new_bundle_id: &str) -> Option<&'a str> {
    match applied {
        Some(old) if old != new_bundle_id => Some(old),
        _ => None,
    }
}

/// Force-removes orphan tags for the current manifest — tags that exist in the
/// runtime but are not in `keep`. Filtered through `image_exists` so a fresh
/// setup that never built a worker doesn't spam `rmi: no such image` warnings.
pub fn prune_orphan_current_bundle_images(
    runtime: &crate::runtime::LockedRuntime,
    manifest: &bundle::BundleManifest,
    keep: &[&ImageDef],
) -> anyhow::Result<()> {
    let keep_names: std::collections::HashSet<&str> = keep.iter().map(|i| i.name).collect();
    let stale: Vec<String> = IMAGES
        .iter()
        .filter(|img| !keep_names.contains(img.name))
        .filter_map(|img| manifest.image_tag(img.name).ok())
        .filter(|tag| runtime.image_exists(tag).unwrap_or(false))
        .collect();
    if stale.is_empty() {
        return Ok(());
    }
    log::info!("Pruning {} orphan tag(s) for current bundle", stale.len());
    runtime.remove_images(&stale, true)?;
    Ok(())
}

/// Force-removes superseded per-image tags: for every image whose applied hash
/// differs from the manifest's, removes `name:old_hash`. Only touches tags from
/// this install's own applied history — never sweeps by repo name (ADR-072).
pub(crate) fn prune_replaced_images(
    runtime: &crate::runtime::LockedRuntime,
    applied_image_hashes: &std::collections::BTreeMap<String, String>,
    manifest: &bundle::BundleManifest,
) -> anyhow::Result<()> {
    let stale: Vec<String> = IMAGES
        .iter()
        .filter_map(|img| {
            let old = applied_image_hashes.get(img.name)?;
            let current = manifest.image_hashes.get(img.name);
            (Some(old) != current).then(|| image_ref(img.name, old))
        })
        .filter(|tag| runtime.image_exists(tag).unwrap_or(false))
        .collect();
    if stale.is_empty() {
        return Ok(());
    }
    log::info!("Pruning {} replaced image tag(s)", stale.len());
    runtime.remove_images(&stale, true)?;
    Ok(())
}

/// Warn-only post-restore prune under the build lock: per-image replaced tags,
/// plus one-time legacy single-id tags (pre-ADR-072 state without a map).
/// Callers MUST invoke only after new containers are confirmed running —
/// ordering pinned by `reconcile_prunes_old_images_after_full_restore`.
pub fn prune_superseded_images(
    runtime: &crate::runtime::LockedRuntime,
    applied_image_hashes: &std::collections::BTreeMap<String, String>,
    applied_bundle_id: Option<&str>,
    manifest: &bundle::BundleManifest,
) {
    let result = with_build_lock(|| {
        if let Err(e) = prune_replaced_images(runtime, applied_image_hashes, manifest) {
            log::warn!("Failed to prune replaced image tags: {e}");
        }
        // Legacy pre-ADR-072 state (no per-image map): the old tags share one
        // `name:<old_bundle_id>` suffix — prune them once on migration.
        if applied_image_hashes.is_empty() {
            if let Some(old_id) = should_prune_bundle(applied_bundle_id, &manifest.bundle_id) {
                if let Err(e) = prune_old_bundle_images(runtime, old_id) {
                    log::warn!("Failed to prune old bundle images: {e}");
                }
            }
        }
        Ok(())
    });
    if let Err(e) = result {
        log::warn!("Image prune skipped — build lock unavailable: {e}");
    }
}

/// Force-removes a pre-ADR-072 bundle's image tags (`name:<old_bundle_id>` for
/// every catalogue image) — one-time migration prune. `--force` is required
/// because stopped containers from the previous session block plain `rmi`.
pub fn prune_old_bundle_images(
    runtime: &crate::runtime::LockedRuntime,
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
    runtime.remove_images(&tags, true)?;
    Ok(())
}

/// Builds `images` for `manifest`'s per-image tags. Snapshotter/transient errors
/// retry internally (see `is_snapshotter_error` / `is_transient_build_error`).
pub fn build_images_for_bundle(
    runtime: &crate::runtime::LockedRuntime,
    images: &[&ImageDef],
    manifest: &bundle::BundleManifest,
) -> anyhow::Result<u32> {
    let root = resolve_build_root()?;
    build_images_for_bundle_in(runtime, images, manifest, &root)
}

/// Env-free core of [`build_images_for_bundle`]: takes an explicit build root so
/// tests never read `SPEEDWAVE_RESOURCES_DIR` or the production `~/.speedwave`
/// marker. The public no-arg shim resolves the root from env at the call site.
pub fn build_images_for_bundle_in(
    runtime: &crate::runtime::LockedRuntime,
    images: &[&ImageDef],
    manifest: &bundle::BundleManifest,
    root: &std::path::Path,
) -> anyhow::Result<u32> {
    let vm_root = runtime.prepare_build_context(root)?;
    let needs_cleanup = vm_root != root;

    let result = try_build_images(runtime, images, &vm_root, manifest).or_else(|first_err| {
        if is_disk_full_error(&first_err) {
            log::warn!(
                "build failed with disk-full error, pruning unused images and retrying: {first_err}"
            );
            if let Err(prune_err) = runtime.prune_unused_images() {
                log::warn!("prune_unused_images failed: {prune_err}");
            }
            // `nerdctl system prune` does not clear BuildKit cache-mounts; under
            // disk pressure the cache must go too (ADR-072 — sole cache-prune site).
            if let Err(prune_err) = runtime.prune_buildkit_cache() {
                log::warn!("prune_buildkit_cache failed: {prune_err}");
            }
            try_build_images(runtime, images, &vm_root, manifest)
        } else if is_snapshotter_error(&first_err) {
            log::warn!(
                "build failed with containerd snapshotter error, pruning and retrying: {first_err}"
            );
            if let Err(prune_err) = runtime.system_prune() {
                log::warn!("system prune failed: {prune_err}");
            }
            try_build_images(runtime, images, &vm_root, manifest).map_err(|second_err| {
                anyhow::Error::new(SnapshotterRecoveryFailed { inner: second_err })
            })
        } else if is_transient_build_error(&first_err) {
            // Transient — usually the boot-time DNS-fallback race (see
            // `is_transient_build_error`). A few seconds' wait lets the resolver
            // settle; two backed-off attempts cover a slow fallback.
            let mut last_err = first_err;
            for attempt in 1..=TRANSIENT_BUILD_RETRIES {
                let delay = TRANSIENT_BUILD_RETRY_BASE_DELAY * attempt;
                log::warn!(
                    "build failed with transient error, retrying in {}s (attempt {attempt}/{TRANSIENT_BUILD_RETRIES}): {last_err}",
                    delay.as_secs()
                );
                std::thread::sleep(delay);
                match try_build_images(runtime, images, &vm_root, manifest) {
                    Ok(n) => return Ok(n),
                    Err(e) => last_err = e,
                }
            }
            Err(last_err)
        } else {
            Err(first_err)
        }
    });

    // Enrich final error with actionable guidance
    let result = result.map_err(|err| {
        if is_disk_full_error(&err) {
            err.context(
                "Container VM disk full — aggressive prune already attempted but disk space \
                 is still insufficient. Free space in the Lima/WSL2 VM (delete unused projects \
                 in Speedwave, or restart Speedwave to retry auto-prune). Check usage with \
                 `df -h` inside the VM.",
            )
        } else if is_network_build_error(&err) {
            err.context(
                "Image build failed: the container VM could not reach a base-image registry \
                 (docker.io / mcr.microsoft.com). This is usually a network or DNS problem — \
                 a VPN with a low MTU, an offline host, or the VM's resolver not yet settled \
                 right after boot. Check your connection and retry; if it persists, restart \
                 Speedwave to reboot the VM.",
            )
        } else if is_transient_build_error(&err) {
            err.context(
                "Image build failed with a transient I/O error inside the container VM. \
                 Retry; if it persists, restart Speedwave. When running Speedwave inside \
                 another VM (VMware, VirtualBox), give that VM at least 8 GB RAM and enable \
                 nested virtualization.",
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

/// Builds `images` using a bounded worker pool. Extracted so the retry logic in
/// [`build_images_for_bundle`] can re-call it. Worker count bounded by CPU + image
/// count (ADR-032). Errors collected; propagate by priority: snapshotter > transient > first.
fn try_build_images(
    runtime: &crate::runtime::LockedRuntime,
    images: &[&ImageDef],
    vm_root: &std::path::Path,
    manifest: &bundle::BundleManifest,
) -> anyhow::Result<u32> {
    let total = images.len();
    if total == 0 {
        return Ok(0);
    }
    // Resolve every tag up front so a manifest gap fails before any worker spawns.
    let tags: Vec<String> = images
        .iter()
        .map(|img| manifest.image_tag(img.name))
        .collect::<anyhow::Result<_>>()?;
    let worker_count = match std::thread::available_parallelism() {
        Ok(n) => n.get().min(total),
        Err(e) => {
            log::warn!(
                "build_images: available_parallelism failed ({e}); using fallback of {DEFAULT_BUILD_WORKER_FALLBACK}"
            );
            DEFAULT_BUILD_WORKER_FALLBACK.min(total)
        }
    };
    let root_str = vm_root.to_string_lossy();
    let root_str = root_str.trim_end_matches('/');

    // Distribute indices across workers (ADR-032 §4); chunks.len() may be < worker_count.
    let indices: Vec<usize> = (0..total).collect();
    let chunks: Vec<&[usize]> = if worker_count == 0 {
        vec![]
    } else {
        indices.chunks(total.div_ceil(worker_count)).collect()
    };
    log::info!(
        "build_images: building {total} images from {} ({} parallel workers)",
        vm_root.display(),
        chunks.len()
    );

    // Per-worker results collected into a flat Vec; Mutex poison unreachable
    // (thread::scope re-panics on the calling thread if any worker panics).
    let results = std::sync::Mutex::new(Vec::<(usize, anyhow::Result<()>)>::with_capacity(total));

    std::thread::scope(|s| {
        for chunk in &chunks {
            s.spawn(|| {
                for &idx in *chunk {
                    let img = images[idx];
                    let tag = tags[idx].clone();
                    // vm_path_join, not PathBuf::join: vm_root may be a WSL/Linux
                    // path on Windows where PathBuf::join mangles /-rooted strings.
                    let abs_context = crate::engine_path::vm_path_join(root_str, img.context_dir);
                    let abs_containerfile =
                        crate::engine_path::vm_path_join(root_str, img.containerfile);
                    log::info!(
                        "build_images: [{}/{}] building {} (context={}, file={})",
                        idx + 1,
                        total,
                        tag,
                        img.context_dir,
                        img.containerfile
                    );
                    let res =
                        runtime.build_image(&tag, &abs_context, &abs_containerfile, img.build_args);
                    match &res {
                        Ok(()) => {
                            log::info!("build_images: [{}/{}] {} built OK", idx + 1, total, tag);
                        }
                        Err(err) => {
                            log::error!(
                                "build_images: [{}/{}] {} failed: {err:#}",
                                idx + 1,
                                total,
                                tag
                            );
                        }
                    }
                    results
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push((idx, res));
                }
            });
        }
    });

    let mut outcomes = results.into_inner().unwrap_or_else(|p| p.into_inner());

    // Sort by IMAGES index so the classifier picks the lowest-indexed error in each
    // priority class, independent of thread completion order. Without this sort,
    // "the first transient error" would mean "whichever worker happened to finish
    // first", which is non-deterministic across runs and breaks the doc claim below.
    outcomes.sort_by_key(|(idx, _)| *idx);

    // Single-pass classifier: snapshotter errors require system_prune before retry;
    // transient errors need only a plain retry. Priority: snapshotter > transient > first by index.
    // Overflow errors (beyond one per class) are logged immediately in the loop.
    let mut snapshotter: Option<(usize, anyhow::Error)> = None;
    let mut transient: Option<(usize, anyhow::Error)> = None;
    let mut first: Option<(usize, anyhow::Error)> = None;
    let mut total_errors: usize = 0;

    let also_failed = |idx: usize, e: &anyhow::Error| {
        log::error!(
            "build_images: [{}/{}] {} also failed (not selected for retry classification): {e:#}",
            idx + 1,
            total,
            images[idx].name
        );
    };

    for (idx, res) in outcomes {
        if let Err(e) = res {
            total_errors += 1;
            if is_snapshotter_error(&e) && snapshotter.is_none() {
                snapshotter = Some((idx, e));
            } else if is_transient_build_error(&e) && transient.is_none() {
                transient = Some((idx, e));
            } else if first.is_none() {
                first = Some((idx, e));
            } else {
                also_failed(idx, &e);
            }
        }
    }

    if total_errors == 0 {
        log::info!("build_images: all {total} images built successfully");
        return Ok(total as u32);
    }

    // Determine winner; log the non-winning classified slots.
    let chosen = if let Some((_, snap_err)) = snapshotter {
        if let Some((idx, ref e)) = transient {
            also_failed(idx, e);
        }
        if let Some((idx, ref e)) = first {
            also_failed(idx, e);
        }
        snap_err
    } else if let Some((_, trans_err)) = transient {
        if let Some((idx, ref e)) = first {
            also_failed(idx, e);
        }
        trans_err
    } else if let Some((_, e)) = first {
        e
    } else {
        // Unreachable: total_errors > 0 guarantees at least one error slot is filled.
        // Returning Err (not Ok) protects callers from acting on a broken build tree.
        return Err(anyhow::anyhow!(
            "internal bug: build_images recorded {total_errors} error(s) but no error slot was filled"
        ));
    };
    let additional = total_errors - 1;

    Err(if additional > 0 {
        chosen.context(format!(
            "additionally, {additional} other image build(s) failed — see logs"
        ))
    } else {
        chosen
    })
}

/// `true` if `err` mentions ENOSPC anywhere in its chain.
/// Recovery: `prune_unused_images` + retry. Covers cross-worktree image
/// accumulation that `prune_old_bundle_images` cannot see (it only knows this
/// worktree's last `applied_bundle_id`).
fn is_disk_full_error(err: &anyhow::Error) -> bool {
    for cause in err.chain() {
        let msg = cause.to_string().to_ascii_lowercase();
        if msg.contains("no space left on device") || msg.contains("enospc") {
            return true;
        }
    }
    false
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

/// Registry hostnames that our `FROM` lines reference. A DNS failure mentioning
/// one of these is the boot-time-resolver race (see `is_transient_build_error`),
/// not a user typo — so it's worth a retry. A DNS failure for some *other* host
/// is more likely a real misconfiguration and is left to fail fast.
const BASE_IMAGE_REGISTRY_HOSTS: &[&str] =
    &["registry-1.docker.io", "docker.io", "mcr.microsoft.com"];

/// Returns `true` if the build error looks transient (I/O timeout, connection reset,
/// temporary unavailable, or a DNS hiccup resolving a base-image registry). These may
/// succeed on retry without any recovery action.
///
/// The DNS cases matter for first runs behind a VPN: when the Lima VM boots, its
/// `systemd-resolved` initially tries `UDP+EDNS0`, whose large responses do not
/// survive a low-MTU tunnel (e.g. Tailscale's 1380). It takes a second or two to
/// detect that and fall back to plain UDP — but BuildKit fires its
/// `FROM <base-image>` metadata fetch inside that window, so the resolver returns
/// `SERVFAIL` (`server misbehaving` / `failed to resolve source metadata`) or even
/// `NXDOMAIN` (`no such host`) for `docker.io` / `mcr.microsoft.com`. A retry a few
/// seconds later hits the now-degraded resolver and succeeds. *All* DNS-shaped cases
/// are scoped to `BASE_IMAGE_REGISTRY_HOSTS` so a typo'd — or rogue — custom registry
/// URL fails fast instead of silently retrying (it could otherwise embed any of these
/// strings in its error body to force up to `TRANSIENT_BUILD_RETRIES` retries).
///
/// Uses case-insensitive matching because kernel/libc/BuildKit error messages vary
/// in casing across distros and locales.
fn is_transient_build_error(err: &anyhow::Error) -> bool {
    for cause in err.chain() {
        let msg = cause.to_string().to_ascii_lowercase();
        if msg.contains("i/o timeout")
            || msg.contains("input/output error")
            || msg.contains("connection reset")
            || msg.contains("temporary failure")
            || msg.contains("resource temporarily unavailable")
            // DNS hiccups (SERVFAIL / NXDOMAIN / dial-lookup) are transient only when
            // they name one of our base-image registries — see the doc above.
            || (is_dns_shaped(&msg) && mentions_base_image_registry(&msg))
        {
            return true;
        }
    }
    false
}

/// `true` if `msg` (already lowercased) mentions one of [`BASE_IMAGE_REGISTRY_HOSTS`].
fn mentions_base_image_registry(msg: &str) -> bool {
    BASE_IMAGE_REGISTRY_HOSTS.iter().any(|h| msg.contains(h))
}

/// `true` if `msg` (already lowercased) is a DNS-resolution failure (SERVFAIL /
/// NXDOMAIN / dial-lookup). Caller scopes it to base-image registries.
fn is_dns_shaped(msg: &str) -> bool {
    msg.contains("server misbehaving")
        || msg.contains("failed to resolve source metadata")
        || msg.contains("no such host")
        || (msg.contains("dial tcp") && msg.contains("lookup"))
}

/// `true` if a transient build error is network/DNS-shaped (vs. a local I/O stall).
/// Lets the enrichment pick guidance that matches the actual cause instead of always
/// blaming VM memory — the DNS-resolver race names a base-image registry.
fn is_network_build_error(err: &anyhow::Error) -> bool {
    for cause in err.chain() {
        let msg = cause.to_string().to_ascii_lowercase();
        // Both branches are scoped to a base-image registry: the network
        // enrichment names docker.io / mcr.microsoft.com, so a reset during an
        // apt layer (registry not involved) must NOT route here.
        if (is_dns_shaped(&msg) || msg.contains("connection reset"))
            && mentions_base_image_registry(&msg)
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

    /// All built-in images as a slice — the pre-lazy-build "build everything" set.
    fn all_images() -> Vec<&'static ImageDef> {
        IMAGES.iter().collect()
    }

    /// Integrations config with every built-in MCP service enabled — so
    /// `enabled_images` yields the full `IMAGES` list (used by tests that
    /// predate lazy builds).
    fn all_enabled() -> ResolvedIntegrationsConfig {
        ResolvedIntegrationsConfig {
            slack: true,
            sharepoint: true,
            redmine: true,
            gitlab: true,
            github: true,
            atlassian: true,
            playwright: true,
            ..ResolvedIntegrationsConfig::default()
        }
    }

    /// Builds the full `IMAGES` set, mirroring the old `build_all_images_for_bundle`.
    /// Takes an explicit build root so no test reads `SPEEDWAVE_RESOURCES_DIR` or
    /// the production `~/.speedwave` marker.
    fn build_all_for_bundle(
        rt: &crate::runtime::LockedRuntime,
        bundle_id: &str,
        root: &std::path::Path,
    ) -> anyhow::Result<u32> {
        let manifest = crate::bundle::BundleManifest::for_tests(bundle_id);
        build_images_for_bundle_in(rt, &all_images(), &manifest, root)
    }

    /// Runs the worker pool over the full `IMAGES` set (old `try_build_all`).
    fn try_build_all(
        rt: &crate::runtime::LockedRuntime,
        vm_root: &std::path::Path,
        bundle_id: &str,
    ) -> anyhow::Result<u32> {
        let manifest = crate::bundle::BundleManifest::for_tests(bundle_id);
        try_build_images(rt, &all_images(), vm_root, &manifest)
    }

    #[test]
    fn test_images_constant_has_entries() {
        assert!(!IMAGES.is_empty());
    }

    /// Repo checkout root — hash-input honesty tests run against real sources.
    fn repo_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn hash_inputs_exist_in_repo() {
        for img in IMAGES {
            assert!(
                !img.hash_inputs.is_empty(),
                "{}: hash_inputs must not be empty",
                img.name
            );
            for input in img.hash_inputs {
                assert!(
                    repo_root().join(input).exists(),
                    "{}: declared hash input '{input}' does not exist in the repo",
                    img.name
                );
            }
        }
    }

    /// Anti-under-rebuild guard (ADR-072): every COPY/ADD source in every
    /// Containerfile must be covered by that image's `hash_inputs`, else a
    /// source change would not change the image hash and ship stale code.
    #[test]
    fn every_base_image_is_digest_pinned() {
        // Retained BuildKit cache (ADR-072) freezes whatever base was first
        // pulled; a floating tag would silently diverge between users and
        // never receive upstream security patches. Every external FROM must
        // carry an @sha256 digest; bumping a base is a deliberate edit.
        let root = repo_root();
        let mut violations = Vec::new();
        for img in IMAGES {
            let containerfile = root.join(img.containerfile);
            let content = std::fs::read_to_string(&containerfile)
                .unwrap_or_else(|e| panic!("read {}: {e}", containerfile.display()));
            for line in content.lines() {
                let line = line.trim();
                let Some(rest) = line.strip_prefix("FROM ") else {
                    continue;
                };
                let image_ref = rest.split_whitespace().next().unwrap_or("");
                // Internal stage references (FROM builder) carry no registry path.
                let external = image_ref.contains('/') || image_ref.contains(':');
                if external && !image_ref.contains("@sha256:") {
                    violations.push(format!("{}: {line}", img.containerfile));
                }
            }
        }
        assert!(
            violations.is_empty(),
            "unpinned base images:\n{}",
            violations.join("\n")
        );
    }

    #[test]
    fn hash_inputs_cover_copy_sources() {
        for img in IMAGES {
            let content = std::fs::read_to_string(repo_root().join(img.containerfile))
                .unwrap_or_else(|e| panic!("{}: cannot read containerfile: {e}", img.name));
            let mut sources: Vec<String> = vec![img.containerfile.to_string()];
            for line in content.lines() {
                let line = line.trim();
                let Some(rest) = line
                    .strip_prefix("COPY ")
                    .or_else(|| line.strip_prefix("ADD "))
                else {
                    continue;
                };
                let tokens: Vec<&str> = rest.split_whitespace().collect();
                // `--from=` copies move stage-internal artifacts, not context files.
                if tokens.iter().any(|t| t.starts_with("--from=")) {
                    continue;
                }
                let args: Vec<&str> = tokens
                    .into_iter()
                    .filter(|t| !t.starts_with("--"))
                    .collect();
                if args.len() < 2 {
                    continue;
                }
                for src in &args[..args.len() - 1] {
                    let src = src.trim_start_matches("./");
                    sources.push(format!("{}/{src}", img.context_dir));
                }
            }
            for src in sources {
                let covered = img
                    .hash_inputs
                    .iter()
                    .any(|input| src == *input || src.starts_with(&format!("{input}/")));
                assert!(
                    covered,
                    "{}: COPY/ADD source '{src}' is not covered by hash_inputs {:?}",
                    img.name, img.hash_inputs
                );
            }
        }
    }

    /// Structural pin (ADR-072): every host-facing build/prune entry point
    /// must hold the build lock — a forgotten wrapper reintroduces the race.
    #[test]
    fn build_entry_points_hold_build_lock() {
        let source = include_str!("build.rs");
        for fn_name in [
            "fn build_enabled_images(",
            "fn build_missing_images_locked(",
            "fn prune_orphan_current_bundle_images_locked(",
            "fn prune_superseded_images(",
        ] {
            let start = source
                .find(fn_name)
                .unwrap_or_else(|| panic!("{fn_name} must exist in build.rs"));
            let body = &source[start..(start + 1200).min(source.len())];
            assert!(
                body.contains("with_build_lock"),
                "{fn_name} must run under with_build_lock"
            );
        }
    }

    #[test]
    fn claude_hash_inputs_exclude_resources_and_template() {
        // claude-resources are synced + mounted (never baked into the image);
        // the compose template is embedded in the binary. Neither may rebuild claude.
        let claude = IMAGES.iter().find(|i| i.name == IMAGE_CLAUDE).unwrap();
        for input in claude.hash_inputs {
            assert!(
                !input.starts_with("containers/claude-resources"),
                "claude hash input '{input}' must not cover claude-resources"
            );
            assert_ne!(*input, "containers/compose.template.yml");
        }
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
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        // None home → dev source tree, never the production ~/.speedwave marker.
        let root = resolve_build_root_with_home(None).unwrap();
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
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        // None home → dev source tree, never the production ~/.speedwave marker.
        let root = resolve_build_root_with_home(None).unwrap();
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
    fn test_all_bundled_shell_scripts_use_lf_line_endings() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        let root = resolve_build_root_with_home(None).unwrap();
        let containers = root.join("containers");
        assert!(containers.is_dir(), "containers/ not found");

        let mut stack: Vec<std::path::PathBuf> = vec![containers];

        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("read_dir") {
                let entry = entry.expect("read_dir entry");
                let path = entry.path();
                let file_type = entry.file_type().expect("file_type");

                if file_type.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !file_type.is_file() || path.extension().and_then(|s| s.to_str()) != Some("sh") {
                    continue;
                }

                let bytes = std::fs::read(&path).expect("read file");
                assert!(!bytes.contains(&b'\r'), "{} contains CR", path.display());
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
    fn test_resolve_host_exec_script_dev_mode() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
        // In dev mode with None home, it falls through to CARGO_MANIFEST_DIR.
        // The worker dist may or may not exist depending on whether host_exec
        // was built; just verify it doesn't panic.
        let result = resolve_host_exec_script_with_home(None);
        let _ = result;
    }

    #[test]
    fn test_resolve_host_exec_script_from_env() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let script_path = tmp
            .path()
            .join("host_exec")
            .join("host_exec")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::write(&script_path, "// stub").unwrap();
        std::env::set_var(
            crate::consts::BUNDLE_RESOURCES_ENV,
            tmp.path().to_string_lossy().as_ref(),
        );
        let result = resolve_host_exec_script_inner(None, None);
        assert_eq!(result, Some(script_path));
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_host_exec_script_from_marker() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");

        let script_path = fake_resources
            .join("host_exec")
            .join("host_exec")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::write(&script_path, "// stub").unwrap();

        write_resources_marker_to(&fake_resources, &fake_home).unwrap();

        // Pass None as dev_path to test marker fallback in isolation
        let result = resolve_host_exec_script_inner(Some(fake_home), None);
        assert_eq!(result, Some(script_path));
    }

    #[test]
    fn test_resolve_host_exec_script_dev_path_beats_marker() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let fake_resources = tmp.path().join("fake-resources");
        let fake_dev = tmp.path().join("dev-repo");

        let marker_script = fake_resources
            .join("host_exec")
            .join("host_exec")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(marker_script.parent().unwrap()).unwrap();
        std::fs::write(&marker_script, "// marker").unwrap();
        write_resources_marker_to(&fake_resources, &fake_home).unwrap();

        let dev_script = fake_dev.join("mcp-servers/host_exec/dist/index.js");
        std::fs::create_dir_all(dev_script.parent().unwrap()).unwrap();
        std::fs::write(&dev_script, "// dev").unwrap();

        let result = resolve_host_exec_script_inner(Some(fake_home), Some(dev_script.clone()));
        assert_eq!(result, Some(dev_script), "dev path should win over marker");
    }

    #[test]
    fn test_resolve_host_exec_script_none_when_nothing_present() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var(crate::consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home"); // no marker file
        let dev_path = tmp.path().join("dev/mcp-servers/host_exec/dist/index.js"); // does not exist

        let result = resolve_host_exec_script_inner(Some(fake_home), Some(dev_path));
        assert_eq!(result, None);
    }

    #[test]
    fn test_images_count() {
        // Catalogue size, not build behaviour — the build set is filtered per
        // project by `enabled_images`. Bump this when adding a built-in worker.
        assert_eq!(IMAGES.len(), 11);
    }

    #[test]
    fn test_enabled_images_minimal_when_nothing_enabled() {
        let names: Vec<&str> = enabled_images(&ResolvedIntegrationsConfig::default())
            .iter()
            .map(|i| i.name)
            .collect();
        assert_eq!(names, vec![IMAGE_CLAUDE, IMAGE_MCP_HUB]);
    }

    #[test]
    fn test_enabled_images_includes_enabled_workers_only() {
        let cfg = ResolvedIntegrationsConfig {
            slack: true,
            playwright: true,
            ..ResolvedIntegrationsConfig::default()
        };
        let names: Vec<&str> = enabled_images(&cfg).iter().map(|i| i.name).collect();
        assert_eq!(
            names,
            vec![
                IMAGE_CLAUDE,
                IMAGE_MCP_HUB,
                IMAGE_MCP_SLACK,
                IMAGE_MCP_PLAYWRIGHT
            ]
        );
    }

    #[test]
    fn test_enabled_images_ignores_plugins() {
        let mut cfg = ResolvedIntegrationsConfig::default();
        cfg.plugins.insert("example-plugin".to_string(), true);
        let names: Vec<&str> = enabled_images(&cfg).iter().map(|i| i.name).collect();
        assert_eq!(names, vec![IMAGE_CLAUDE, IMAGE_MCP_HUB]);
    }

    #[test]
    fn test_every_worker_image_maps_to_a_toggleable_service() {
        // SSOT tie: every non-claude/mcp-hub image name's `speedwave-mcp-<key>`
        // suffix must be a known integration config key, so `enabled_images`
        // can never silently drop (or keep) a worker.
        for img in IMAGES {
            let Some(suffix) = img.name.strip_prefix(MCP_IMAGE_PREFIX) else {
                assert_eq!(
                    img.name, IMAGE_CLAUDE,
                    "only speedwave-claude lacks the prefix"
                );
                continue;
            };
            if suffix == "hub" {
                continue;
            }
            assert!(
                crate::consts::TOGGLEABLE_MCP_SERVICES
                    .iter()
                    .any(|s| s.config_key == suffix),
                "image '{}' has no matching TOGGLEABLE_MCP_SERVICES entry for key '{suffix}'",
                img.name
            );
        }
    }

    #[test]
    fn test_image_for_service_key() {
        assert_eq!(
            image_for_service_key("slack").map(|i| i.name),
            Some(IMAGE_MCP_SLACK)
        );
        assert!(image_for_service_key("os").is_none());
        assert!(image_for_service_key("claude").is_none());
        assert!(image_for_service_key("hub").is_none());
        assert!(image_for_service_key("nonsense").is_none());
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
        use crate::runtime::mock_runtime::MockRuntimeBuilder;
        use std::sync::atomic::Ordering;

        let translated = PathBuf::from("/home/user/.speedwave/build-cache");

        let (rt, handles) = MockRuntimeBuilder::new()
            .with_prepare_build_context_root(translated.clone())
            .build();

        // Explicit fake build root keeps the test off SPEEDWAVE_RESOURCES_DIR and
        // the production marker; the mock returns the translated path regardless.
        let (_tmp, root) = create_fake_build_root();
        let bundle_id = "test-bundle";
        let result = build_all_for_bundle(&rt, bundle_id, &root);
        assert!(result.is_ok());

        assert!(
            handles.prepare_build_context_calls.load(Ordering::SeqCst),
            "prepare_build_context should be called"
        );

        let calls = handles.build_calls.lock().unwrap();
        assert_eq!(calls.len(), IMAGES.len(), "one build per image");

        let mut tags: Vec<&str> = calls.iter().map(|c| c.tag.as_str()).collect();
        tags.sort();
        let mut expected: Vec<String> = IMAGES
            .iter()
            .map(|img| image_ref(img.name, bundle_id))
            .collect();
        expected.sort();
        let expected_refs: Vec<&str> = expected.iter().map(String::as_str).collect();
        assert_eq!(tags, expected_refs, "each image built exactly once");

        for img in IMAGES {
            let tag = image_ref(img.name, bundle_id);
            let call = calls
                .iter()
                .find(|c| c.tag == tag)
                .unwrap_or_else(|| panic!("no build call recorded for {tag}"));
            let translated_str = translated.to_string_lossy().to_string();
            assert!(
                call.context_dir.starts_with(&translated_str),
                "context_dir for {tag}: {}",
                call.context_dir
            );
            assert!(
                call.containerfile.starts_with(&translated_str),
                "containerfile for {tag}: {}",
                call.containerfile
            );
            let expected_args: Vec<(String, String)> = img
                .build_args
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            assert_eq!(call.build_args, expected_args, "build_args for {tag}");
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

    /// Build a `MockRuntimeBuilder` configured for retry-with-prune tests:
    /// `prepare_build_context` returns `build_root`, and `build_image(tag)`
    /// fails on the (tag, attempt) pairs listed in `fail_on` (keyed as
    /// `"{tag}:{attempt}"`, mirroring the old `RetryMockRuntime` contract).
    fn retry_mock(
        build_root: PathBuf,
        fail_on: std::collections::HashMap<String, String>,
    ) -> (
        crate::runtime::LockedRuntime,
        crate::runtime::mock_runtime::MockHandles,
    ) {
        let mut b = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_prepare_build_context_root(build_root);
        for (key, msg) in fail_on {
            let (tag, attempt_str) = key
                .rsplit_once(':')
                .expect("fail_on key must be tag:attempt");
            let attempt: u32 = attempt_str.parse().expect("fail_on attempt must be u32");
            b = b.with_build_error_for_attempt(tag, attempt, &msg);
        }
        b.build()
    }

    /// Number of `system_prune` calls recorded on the handles.
    fn count_prunes(handles: &crate::runtime::mock_runtime::MockHandles) -> usize {
        handles
            .prune_calls
            .lock()
            .unwrap()
            .iter()
            .filter(|p| **p == "system")
            .count()
    }

    /// Number of `prune_unused_images` calls recorded on the handles.
    fn count_unused_prunes(handles: &crate::runtime::mock_runtime::MockHandles) -> usize {
        handles
            .prune_calls
            .lock()
            .unwrap()
            .iter()
            .filter(|p| **p == "unused")
            .count()
    }

    /// Number of `build_image` calls recorded on the handles.
    fn count_builds(handles: &crate::runtime::mock_runtime::MockHandles) -> usize {
        handles.build_call_count()
    }

    /// Number of `build_image` calls for the given tag.
    fn count_builds_for(handles: &crate::runtime::mock_runtime::MockHandles, tag: &str) -> usize {
        handles
            .build_calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.tag == tag)
            .count()
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

    /// Build a mock with `image_exists(tag) = true` for any tag whose image
    /// name contains one of the `present` substrings. Mirrors the old
    /// `LazyBuildMock` contract: tags whose name matches one of `present`
    /// resolve to true; everything else resolves to false.
    fn lazy_build_mock(
        build_root: PathBuf,
        present: Vec<&str>,
    ) -> (
        crate::runtime::LockedRuntime,
        crate::runtime::mock_runtime::MockHandles,
    ) {
        // `images_exist`-style queries pass the full bundle-suffixed tag; the
        // substring check `tag.contains(image_name)` is the legal-equivalent
        // of the old `LazyBuildMock` lookup. We layer one "present" substring
        // per requested image name on top of `image_exists_default(false)`.
        let mut b = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_prepare_build_context_root(build_root);
        // Seed each image name as a "present" override via per-(name, bundle)
        // entries — but builder's exact-match table can't substring. Instead,
        // we use the inverse: default false (so absent images report false),
        // and explicitly seed every IMAGES name across the bundle ids these
        // tests use. Since the test only uses bundle id "b1", that's enough.
        for img in IMAGES {
            if present.iter().any(|p| img.name.contains(p)) {
                let tag = image_ref(img.name, "b1");
                b = b.with_image_exists(&tag, true);
            }
        }
        b.build()
    }

    #[test]
    fn test_build_images_for_bundle_builds_only_the_given_slice() {
        let (_tmp, root) = create_fake_build_root();
        let cfg = ResolvedIntegrationsConfig {
            github: true,
            ..ResolvedIntegrationsConfig::default()
        };
        let (rt, handles) = lazy_build_mock(root.clone(), vec![]);
        let manifest = crate::bundle::BundleManifest::for_tests("b1");
        let n = build_images_for_bundle_in(&rt, &enabled_images(&cfg), &manifest, &root).unwrap();
        assert_eq!(n, 3);
        let mut built = handles.build_tags();
        built.sort();
        assert_eq!(
            built,
            vec![
                image_ref(IMAGE_CLAUDE, "b1"),
                image_ref(IMAGE_MCP_GITHUB, "b1"),
                image_ref(IMAGE_MCP_HUB, "b1"),
            ]
        );
    }

    #[test]
    fn test_build_missing_images_skips_present() {
        let (_tmp, root) = create_fake_build_root();
        // claude + mcp-hub already present; mcp-playwright missing.
        let (rt, handles) = lazy_build_mock(root.clone(), vec![IMAGE_CLAUDE, IMAGE_MCP_HUB]);
        let images: Vec<&ImageDef> = vec![
            image_for_service_key("playwright").unwrap(),
            IMAGES.iter().find(|i| i.name == IMAGE_CLAUDE).unwrap(),
            IMAGES.iter().find(|i| i.name == IMAGE_MCP_HUB).unwrap(),
        ];
        let manifest = crate::bundle::BundleManifest::for_tests("b1");
        let n = build_missing_images_in(&rt, &images, &manifest, &root).unwrap();
        assert_eq!(n, 1, "only the missing playwright image is built");
        assert_eq!(
            handles.build_tags(),
            vec![image_ref(IMAGE_MCP_PLAYWRIGHT, "b1")]
        );
    }

    #[test]
    fn test_build_missing_images_noop_when_all_present() {
        let (_tmp, root) = create_fake_build_root();
        let (rt, handles) = lazy_build_mock(root.clone(), vec![IMAGE_CLAUDE, IMAGE_MCP_HUB]);
        let images: Vec<&ImageDef> = all_images()
            .into_iter()
            .filter(|i| i.name == IMAGE_CLAUDE || i.name == IMAGE_MCP_HUB)
            .collect();
        let manifest = crate::bundle::BundleManifest::for_tests("b1");
        let n = build_missing_images_in(&rt, &images, &manifest, &root).unwrap();
        assert_eq!(n, 0);
        assert!(handles.build_tags().is_empty());
    }

    #[test]
    fn test_retry_on_snapshotter_error() {
        let image_count = IMAGES.len() as u32;

        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_MCP_SHAREPOINT, "test-bundle")),
            "apply layer error for \"docker.io/library/speedwave-mcp-sharepoint:latest\""
                .to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);

        assert!(result.is_ok(), "retry should succeed, got: {:?}", result);
        assert_eq!(result.unwrap(), image_count);

        assert_eq!(
            count_prunes(&handles),
            1,
            "system_prune should be called once"
        );

        let build_count = count_builds(&handles);
        assert_eq!(
            build_count,
            2 * image_count as usize,
            "expected {} build_image calls (full first + full retry), got {}",
            2 * image_count,
            build_count
        );

        // Every image must be built exactly twice (once per attempt).
        for img in IMAGES.iter() {
            let tag = image_ref(img.name, "test-bundle");
            let per_tag = count_builds_for(&handles, &tag);
            assert_eq!(
                per_tag, 2,
                "image {tag} should be built exactly twice (first + retry)"
            );
        }
    }

    #[test]
    fn test_retry_on_disk_full_error() {
        // Disk-full on first attempt triggers prune_unused_images + retry.
        let image_count = IMAGES.len() as u32;

        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_MCP_OFFICE, "test-bundle")),
            "failed to extract layer sha256:abc: write /var/lib/containerd/...: \
             no space left on device"
                .to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);
        assert!(result.is_ok(), "retry should succeed, got: {:?}", result);
        assert_eq!(result.unwrap(), image_count);

        assert_eq!(
            count_unused_prunes(&handles),
            1,
            "prune_unused_images must be called exactly once for disk-full recovery"
        );
        assert_eq!(
            count_buildkit_prunes(&handles),
            1,
            "disk-full recovery is the sole BuildKit cache-prune site (ADR-072) — \
             `nerdctl system prune` does not clear cache-mounts"
        );
        assert_eq!(
            count_prunes(&handles),
            0,
            "system_prune (snapshotter recovery) must NOT be called on disk-full path"
        );
    }

    #[test]
    fn test_disk_full_unrecovered_gets_friendly_error() {
        // Disk-full on attempts 1 AND 2 → prune attempted, build still fails,
        // and the user-facing message must mention disk space (not "VM memory").
        let mut fail_on = std::collections::HashMap::new();
        for attempt in 1..=2 {
            fail_on.insert(
                format!("{}:{attempt}", image_ref(IMAGE_MCP_OFFICE, "test-bundle")),
                "no space left on device".to_string(),
            );
        }

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, _handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);
        assert!(result.is_err(), "double disk-full must propagate");

        let msg = format!("{:#}", result.unwrap_err());
        assert!(
            msg.contains("disk space is still insufficient"),
            "error must mention insufficient disk space, got: {msg}"
        );
        assert!(
            !msg.contains("VM memory") && !msg.contains("nested virtualization"),
            "error must NOT show the VM-memory hint for disk-full, got: {msg}"
        );
    }

    #[test]
    fn test_is_disk_full_error_matches_enospc() {
        assert!(is_disk_full_error(&anyhow::anyhow!(
            "no space left on device"
        )));
        assert!(is_disk_full_error(&anyhow::anyhow!("ENOSPC")));
        assert!(is_disk_full_error(&anyhow::anyhow!(
            "failed to extract layer: write /var/lib/containerd/...: No Space Left On Device"
        )));
    }

    #[test]
    fn test_is_disk_full_error_rejects_unrelated() {
        assert!(!is_disk_full_error(&anyhow::anyhow!("i/o timeout")));
        assert!(!is_disk_full_error(&anyhow::anyhow!("apply layer error")));
        assert!(!is_disk_full_error(&anyhow::anyhow!("permission denied")));
    }

    #[test]
    fn test_is_disk_full_error_matches_wrapped() {
        let inner = anyhow::anyhow!("no space left on device");
        let outer = inner.context("nerdctl build failed");
        assert!(is_disk_full_error(&outer));
    }

    #[test]
    fn test_no_retry_on_generic_error() {
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_MCP_HUB, "test-bundle")),
            "network timeout".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);

        assert!(result.is_err(), "generic error should not be retried");
        assert!(
            result.unwrap_err().to_string().contains("network timeout"),
            "original error should propagate"
        );

        assert_eq!(
            count_prunes(&handles),
            0,
            "system_prune should NOT be called for generic errors"
        );
        assert_eq!(
            count_builds(&handles),
            IMAGES.len(),
            "all workers in the first attempt run to completion even when one fails"
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

        // Extract: MCP_SERVICES="shared hub slack sharepoint redmine gitlab github playwright"
        let sh_services: Vec<&str> = sh_content
            .lines()
            .find(|l| l.starts_with("MCP_SERVICES="))
            .expect("MCP_SERVICES= line should exist in .sh")
            .trim_start_matches("MCP_SERVICES=")
            .trim_matches('"')
            .split_whitespace()
            .collect();

        // Extract: $services = @('shared','hub','slack','sharepoint','redmine','gitlab','github','playwright')
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
        let failing_tag = image_ref(IMAGE_MCP_REDMINE, "test-bundle");

        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", failing_tag),
            "apply layer error for \"docker.io/library/img:latest\"".to_string(),
        );
        fail_on.insert(
            format!("{}:2", failing_tag),
            "failed to prepare extraction snapshot \"extract-456\": still broken".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);

        assert!(result.is_err(), "second failure should be returned");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("failed to prepare extraction snapshot"),
            "should return the second (retry) error"
        );

        assert_eq!(
            count_prunes(&handles),
            1,
            "system_prune should be called once"
        );
    }

    #[test]
    fn test_snapshotter_recovery_failed_downcast() {
        let failing_tag = image_ref(IMAGE_CLAUDE, "test-bundle");

        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", failing_tag),
            "apply layer error for \"docker.io/library/img:latest\"".to_string(),
        );
        fail_on.insert(
            format!("{}:2", failing_tag),
            "still broken after prune".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, _handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);
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
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_MCP_GITLAB, "test-bundle")),
            "network timeout".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, _handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);
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
        use crate::runtime::mock_runtime::MockRuntimeBuilder;

        /// `image_exists(tag)` returns `true` unless `tag` contains one of
        /// `missing_name_substrings`. Mirrors the old `ImageCheckRuntime`
        /// substring contract for `images_exist`, which queries by a runtime-
        /// computed bundle id we cannot enumerate up front.
        fn image_check_mock(missing_name_substrings: &[&str]) -> crate::runtime::LockedRuntime {
            let mut b = MockRuntimeBuilder::new().with_image_exists_default(true);
            for s in missing_name_substrings {
                b = b.with_image_missing_substring(s);
            }
            let (rt, _) = b.build();
            rt
        }

        /// Synthetic manifest so `images_exist_with_manifest` never reads
        /// `SPEEDWAVE_RESOURCES_DIR` or the production `~/.speedwave` marker. The
        /// hash is irrelevant — the mock matches on the image name substring.
        fn fake_manifest() -> crate::bundle::BundleManifest {
            crate::bundle::BundleManifest::for_tests("testbundle")
        }

        #[test]
        fn test_images_exist_returns_true_when_all_present() {
            let rt = image_check_mock(&[]);
            assert!(images_exist_with_manifest(
                &rt,
                &all_enabled(),
                &fake_manifest()
            ));
        }

        #[test]
        fn test_images_exist_returns_false_when_any_missing() {
            let rt = image_check_mock(&["speedwave-claude"]);
            assert!(!images_exist_with_manifest(
                &rt,
                &all_enabled(),
                &fake_manifest()
            ));
        }

        #[test]
        fn test_images_exist_ignores_disabled_integration_images() {
            // playwright image absent, but nothing enables playwright → still true.
            let rt = image_check_mock(&[IMAGE_MCP_PLAYWRIGHT]);
            let cfg = ResolvedIntegrationsConfig {
                slack: true,
                ..ResolvedIntegrationsConfig::default()
            };
            assert!(images_exist_with_manifest(&rt, &cfg, &fake_manifest()));
        }

        #[test]
        fn test_images_exist_false_when_an_enabled_worker_image_missing() {
            let rt = image_check_mock(&[IMAGE_MCP_SLACK]);
            let cfg = ResolvedIntegrationsConfig {
                slack: true,
                ..ResolvedIntegrationsConfig::default()
            };
            assert!(!images_exist_with_manifest(&rt, &cfg, &fake_manifest()));
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
    fn test_connection_reset_at_registry_is_network() {
        // Reset while pulling a base image → network enrichment is accurate.
        let err =
            anyhow::anyhow!("failed to copy: connection reset by peer (registry-1.docker.io)");
        assert!(is_network_build_error(&err));
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_connection_reset_off_registry_is_not_network() {
        // Reset during an apt layer (no base-image registry) must NOT route to
        // the network message that names docker.io / mcr.microsoft.com.
        let err = anyhow::anyhow!("apt: connection reset by peer (deb.debian.org)");
        assert!(!is_network_build_error(&err));
        assert!(is_transient_build_error(&err), "still transient → retried");
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
    // is_transient_build_error() — DNS hiccup while pulling a base image
    // (VM's systemd-resolved still falling back from EDNS0 right after boot;
    // BuildKit's `FROM <image>` metadata fetch lands in that window).
    // -----------------------------------------------------------------------

    #[test]
    fn test_is_transient_build_error_dns_server_misbehaving() {
        // The exact BuildKit error seen on first run behind a VPN.
        let err = anyhow::anyhow!(
            "failed to do request: Head \"https://registry-1.docker.io/v2/library/node/manifests/24-alpine\": dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: server misbehaving"
        );
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_dns_resolve_source_metadata() {
        let err = anyhow::anyhow!(
            "node:24-alpine: failed to resolve source metadata for docker.io/library/node:24-alpine"
        );
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_dns_no_such_host() {
        let err = anyhow::anyhow!("dial tcp: lookup mcr.microsoft.com: no such host");
        assert!(is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_dial_tcp_lookup_chain() {
        let inner =
            anyhow::anyhow!("dial tcp: lookup registry-1.docker.io on 192.168.5.2:53: i/o timeout");
        let outer = inner
            .context("failed to do request")
            .context("nerdctl build failed");
        assert!(is_transient_build_error(&outer));
    }

    #[test]
    fn test_is_transient_build_error_plain_dial_tcp_without_lookup_is_not_transient() {
        // A bare `dial tcp` without a DNS lookup (e.g. connection refused to a fixed IP)
        // is not the DNS-fallback race; don't widen the net unnecessarily.
        let err = anyhow::anyhow!("dial tcp 10.0.0.5:443: connect: connection refused");
        assert!(!is_transient_build_error(&err));
    }

    #[test]
    fn test_is_transient_build_error_dns_for_unknown_registry_is_not_transient() {
        // NXDOMAIN / dial-lookup failure for a host that is NOT one of our base-image
        // registries — most likely a typo'd custom registry URL. Should fail fast, not
        // silently retry (the host scoping in `is_transient_build_error`).
        let nxdomain = anyhow::anyhow!("dial tcp: lookup myregistry.example.com: no such host");
        assert!(!is_transient_build_error(&nxdomain));
        let dial_lookup =
            anyhow::anyhow!("dial tcp: lookup ghcr.io on 127.0.0.53:53: server can't find ghcr.io");
        // `ghcr.io` isn't in BASE_IMAGE_REGISTRY_HOSTS — a DNS-shaped error for it fails fast
        // regardless of which DNS-failure string it carries.
        assert!(!is_transient_build_error(&dial_lookup));
    }

    #[test]
    fn test_is_transient_build_error_servfail_for_known_registry_is_transient() {
        // SERVFAIL-shaped errors that DO name a base-image registry are the boot-time
        // resolver race — transient.
        let servfail = anyhow::anyhow!(
            "Head \"https://registry-1.docker.io/v2/\": dial tcp: lookup registry-1.docker.io: server misbehaving"
        );
        assert!(is_transient_build_error(&servfail));
        let no_metadata = anyhow::anyhow!(
            "node:24-alpine: failed to resolve source metadata for docker.io/library/node"
        );
        assert!(is_transient_build_error(&no_metadata));
    }

    #[test]
    fn test_is_transient_build_error_servfail_for_unknown_host_is_not_transient() {
        // SERVFAIL / "failed to resolve source metadata" for a host that is NOT a base-image
        // registry must fail fast — a rogue or typo'd custom registry could otherwise embed
        // these strings to force retries.
        let servfail = anyhow::anyhow!("Head \"https://example.invalid/v2/\": server misbehaving");
        assert!(!is_transient_build_error(&servfail));
        let no_metadata = anyhow::anyhow!("foo:bar: failed to resolve source metadata for foo/bar");
        assert!(!is_transient_build_error(&no_metadata));
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

    /// A DNS-resolver-race failure naming a base-image registry is network-shaped,
    /// so the enrichment must NOT blame VM memory.
    #[test]
    fn test_dns_registry_error_is_network_not_io() {
        let err = anyhow::anyhow!(
            "failed to do request: Head \"https://registry-1.docker.io/v2/library/node/manifests/24-alpine\": \
             dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: server misbehaving"
        );
        assert!(
            is_network_build_error(&err),
            "DNS failure for a base-image registry must classify as network"
        );
        assert!(
            is_transient_build_error(&err),
            "and still be transient (so it is retried)"
        );
    }

    /// A plain local I/O stall is transient but NOT network-shaped, so it keeps the
    /// VM/RAM guidance.
    #[test]
    fn test_io_timeout_is_transient_but_not_network() {
        let err = anyhow::anyhow!("input/output error");
        assert!(is_transient_build_error(&err));
        assert!(
            !is_network_build_error(&err),
            "a bare I/O error names no registry, so it is not network-shaped"
        );
    }

    /// A DNS failure for a host that is NOT one of our base-image registries is
    /// neither network-classified (could be a typo'd custom registry) nor retried.
    #[test]
    fn test_dns_for_unknown_host_is_not_network() {
        let err = anyhow::anyhow!(
            "dial tcp: lookup evil.example.com on 127.0.0.53:53: server misbehaving"
        );
        assert!(!is_network_build_error(&err));
        assert!(!is_transient_build_error(&err));
    }

    /// Chain-wrapped network errors are still classified through the full cause chain.
    #[test]
    fn test_network_error_chain_wrapped() {
        let inner = anyhow::anyhow!(
            "failed to resolve source metadata for docker.io/library/node:24-alpine"
        );
        let outer = inner.context("nerdctl build failed");
        assert!(is_network_build_error(&outer));
    }

    /// An unrelated error (permission denied) is neither network nor transient.
    #[test]
    fn test_unrelated_error_is_neither() {
        let err = anyhow::anyhow!("permission denied");
        assert!(!is_network_build_error(&err));
        assert!(!is_transient_build_error(&err));
    }

    // ── prune_old_bundle_images tests ─────────────────────────────────────

    /// Minimal mock runtime that records remove_images and prune_buildkit_cache calls.
    /// Flatten the recorded `remove_images` calls into a single `Vec<String>`
    /// of removed tags (the old `PruneMockRuntime::removed_tags` shape).
    fn collect_removed_tags(handles: &crate::runtime::mock_runtime::MockHandles) -> Vec<String> {
        handles
            .remove_images_calls
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(tags, _)| tags.clone())
            .collect()
    }

    /// Number of `prune_buildkit_cache` calls recorded on the handles.
    fn count_buildkit_prunes(handles: &crate::runtime::mock_runtime::MockHandles) -> usize {
        handles
            .prune_calls
            .lock()
            .unwrap()
            .iter()
            .filter(|p| **p == "buildkit")
            .count()
    }

    #[test]
    fn test_prune_old_bundle_images_generates_correct_tags() {
        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();
        prune_old_bundle_images(&rt, "abc123").unwrap();

        let removed = collect_removed_tags(&handles);
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
        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();
        prune_old_bundle_images(&rt, "same123").unwrap();
        assert_eq!(collect_removed_tags(&handles).len(), IMAGES.len());
    }

    #[test]
    fn test_prune_orphan_current_bundle_keeps_enabled_only() {
        let cfg = ResolvedIntegrationsConfig {
            slack: true,
            ..ResolvedIntegrationsConfig::default()
        };
        let keep = enabled_images(&cfg);
        let mut builder = crate::runtime::mock_runtime::MockRuntimeBuilder::new();
        for img in IMAGES {
            builder = builder.with_image_exists(&image_ref(img.name, "cur123"), true);
        }
        let (rt, handles) = builder.build();
        prune_orphan_current_bundle_images(
            &rt,
            &crate::bundle::BundleManifest::for_tests("cur123"),
            &keep,
        )
        .unwrap();
        let removed = collect_removed_tags(&handles);
        // Removed = IMAGES \ {claude, mcp-hub, mcp-slack} = 6 tags.
        assert_eq!(removed.len(), IMAGES.len() - keep.len());
        for tag in &removed {
            assert!(tag.ends_with(":cur123"));
            assert!(!tag.contains("claude"));
            assert!(!tag.contains("mcp-hub"));
            assert!(!tag.contains("mcp-slack"));
        }
    }

    #[test]
    fn test_prune_orphan_current_bundle_noop_when_all_kept() {
        let keep: Vec<&ImageDef> = IMAGES.iter().collect();
        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();
        prune_orphan_current_bundle_images(
            &rt,
            &crate::bundle::BundleManifest::for_tests("cur123"),
            &keep,
        )
        .unwrap();
        assert!(collect_removed_tags(&handles).is_empty());
    }

    #[test]
    fn test_prune_old_bundle_images_keeps_buildkit_cache() {
        // ADR-072: routine pruning must NOT clear the BuildKit cache — apt/npm
        // layers are reused across updates. Cache is pruned only under disk
        // pressure (see test_retry_on_disk_full_error).
        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();
        prune_old_bundle_images(&rt, "abc123").unwrap();

        assert_eq!(
            count_buildkit_prunes(&handles),
            0,
            "prune_buildkit_cache must not run in the routine prune path"
        );
    }

    #[test]
    fn test_prune_replaced_images_removes_exactly_changed_hashes() {
        let manifest = crate::bundle::BundleManifest::for_tests("new1");
        let mut applied: std::collections::BTreeMap<String, String> = manifest
            .image_hashes
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        // Two images previously applied with different hashes; rest unchanged.
        applied.insert(IMAGE_CLAUDE.to_string(), "old1".to_string());
        applied.insert(IMAGE_MCP_SLACK.to_string(), "old2".to_string());

        let mut builder = crate::runtime::mock_runtime::MockRuntimeBuilder::new();
        builder = builder
            .with_image_exists(&image_ref(IMAGE_CLAUDE, "old1"), true)
            .with_image_exists(&image_ref(IMAGE_MCP_SLACK, "old2"), true);
        let (rt, handles) = builder.build();

        prune_replaced_images(&rt, &applied, &manifest).unwrap();

        let mut removed = collect_removed_tags(&handles);
        removed.sort();
        assert_eq!(
            removed,
            vec![
                image_ref(IMAGE_CLAUDE, "old1"),
                image_ref(IMAGE_MCP_SLACK, "old2"),
            ]
        );
        assert_eq!(count_buildkit_prunes(&handles), 0);
    }

    #[test]
    fn test_prune_replaced_images_noop_when_hashes_unchanged() {
        let manifest = crate::bundle::BundleManifest::for_tests("same");
        let applied = manifest.image_hashes.clone();
        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();
        prune_replaced_images(&rt, &applied, &manifest).unwrap();
        assert!(collect_removed_tags(&handles).is_empty());
    }

    #[test]
    fn test_prune_replaced_images_never_touches_current_tags() {
        // Adversarial: applied hash differs, but the OLD tag equals another
        // image's CURRENT tag must never happen by construction (tags embed the
        // image name); verify removal list contains only `name:old_hash` pairs.
        let manifest = crate::bundle::BundleManifest::for_tests("cur");
        let mut applied = manifest.image_hashes.clone();
        applied.insert(IMAGE_MCP_HUB.to_string(), "old".to_string());
        let (rt, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_image_exists(&image_ref(IMAGE_MCP_HUB, "old"), true)
            .build();
        prune_replaced_images(&rt, &applied, &manifest).unwrap();
        let removed = collect_removed_tags(&handles);
        assert_eq!(removed, vec![image_ref(IMAGE_MCP_HUB, "old")]);
        assert!(!removed.contains(&image_ref(IMAGE_MCP_HUB, "cur")));
    }

    #[test]
    fn test_prune_replaced_images_rmi_failure_propagates_to_warn_only_callers() {
        // remove_images error propagates; callers (maybe_prune_previous_bundle,
        // reconcile) downgrade it to a warning — pin the Err here.
        let manifest = crate::bundle::BundleManifest::for_tests("new1");
        let mut applied = manifest.image_hashes.clone();
        applied.insert(IMAGE_CLAUDE.to_string(), "old1".to_string());
        let (rt, _handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_image_exists(&image_ref(IMAGE_CLAUDE, "old1"), true)
            .with_remove_images_error("rmi failed")
            .build();
        assert!(prune_replaced_images(&rt, &applied, &manifest).is_err());
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

    // ── parallel build tests ─────────────────────────────────────────────────

    #[test]
    fn test_parallel_build_returns_earliest_indexed_error() {
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_MCP_SLACK, "test-bundle")),
            "i/o timeout slack".to_string(),
        );
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_MCP_GITLAB, "test-bundle")),
            "i/o timeout gitlab".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = try_build_all(&rt, &build_root, "test-bundle");
        assert!(result.is_err());
        let err = result.unwrap_err();
        // Use {:#} to print the full chain; the chosen slack error is wrapped by a
        // context message because multiple errors occurred.
        let msg = format!("{err:#}");
        // Both errors are transient. After sorting outcomes by IMAGES index, the
        // lowest-indexed transient error wins deterministically. Slack (index 2)
        // beats GitLab (index 5).
        assert!(
            msg.contains("slack"),
            "expected earliest-indexed transient error (slack) to win, got: {msg}"
        );
        assert!(
            !msg.contains("i/o timeout gitlab"),
            "gitlab's specific error should not be the chosen one, got: {msg}"
        );
        // The context wrapper must be present because 2 images failed.
        assert!(
            msg.contains("additionally, 1 other image build(s) failed"),
            "multi-failure context must be appended to the error chain, got: {msg}"
        );
        assert_eq!(
            count_builds(&handles),
            IMAGES.len(),
            "all workers finish even when some fail"
        );
    }

    #[test]
    fn test_parallel_build_all_succeed() {
        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), std::collections::HashMap::new());

        let result = try_build_all(&rt, &build_root, "test-bundle");
        assert_eq!(result.unwrap(), IMAGES.len() as u32);

        assert_eq!(count_builds(&handles), IMAGES.len());
        for img in IMAGES {
            let tag = image_ref(img.name, "test-bundle");
            assert_eq!(
                count_builds_for(&handles, &tag),
                1,
                "image {tag} should be built exactly once"
            );
        }
    }

    #[test]
    fn test_parallel_build_repeated_correct_result() {
        for _ in 0..5 {
            let (_tmp, build_root) = create_fake_build_root();
            let (rt, _handles) = retry_mock(build_root.clone(), std::collections::HashMap::new());
            let result = try_build_all(&rt, &build_root, "test-bundle");
            assert_eq!(result.unwrap(), IMAGES.len() as u32);
        }
    }

    #[test]
    fn test_parallel_build_transient_error_retries_without_prune() {
        // Injects exactly one transient failure (attempt 1), so the first retry succeeds —
        // see `test_parallel_build_dns_error_retries_then_succeeds_on_second_attempt` for the
        // path where it takes more than one retry (TRANSIENT_BUILD_RETRIES = 2).
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_MCP_HUB, "test-bundle")),
            "i/o timeout".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);
        assert_eq!(result.unwrap(), IMAGES.len() as u32);

        assert_eq!(
            count_prunes(&handles),
            0,
            "transient retry must NOT trigger prune"
        );
        assert_eq!(
            count_builds(&handles),
            2 * IMAGES.len(),
            "full first attempt (with one transient failure) + full retry"
        );
    }

    #[test]
    fn test_parallel_build_dns_error_retries_then_succeeds_on_second_attempt() {
        // The DNS-fallback race: attempts 1 AND 2 fail with `server misbehaving`,
        // attempt 3 succeeds (resolver has settled). Exercises the >1 retry path.
        let mut fail_on = std::collections::HashMap::new();
        let tag = image_ref(IMAGE_MCP_GITHUB, "test-bundle");
        fail_on.insert(
            format!("{tag}:1"),
            "failed to do request: dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: server misbehaving".to_string(),
        );
        fail_on.insert(
            format!("{tag}:2"),
            "node:24-alpine: failed to resolve source metadata for docker.io/library/node:24-alpine".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);
        assert_eq!(
            result.unwrap(),
            IMAGES.len() as u32,
            "should succeed on the third (second-retry) attempt"
        );

        assert_eq!(
            count_prunes(&handles),
            0,
            "DNS retry must NOT trigger prune"
        );
        assert_eq!(
            count_builds(&handles),
            3 * IMAGES.len(),
            "first attempt + 2 retries (all images rebuilt each time)"
        );
    }

    #[test]
    fn test_parallel_build_dns_error_exhausts_retries_and_fails() {
        // All three attempts (1 + TRANSIENT_BUILD_RETRIES) fail with a DNS error.
        let mut fail_on = std::collections::HashMap::new();
        let tag = image_ref(IMAGE_MCP_GITHUB, "test-bundle");
        for attempt in 1..=(TRANSIENT_BUILD_RETRIES + 1) {
            fail_on.insert(
                format!("{tag}:{attempt}"),
                "dial tcp: lookup registry-1.docker.io: no such host".to_string(),
            );
        }

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);
        assert!(result.is_err(), "exhausting retries must surface the error");
        let msg = format!("{:#}", result.unwrap_err());
        assert!(
            msg.contains("no such host"),
            "final error should carry the DNS failure, got: {msg}"
        );

        assert_eq!(
            count_prunes(&handles),
            0,
            "DNS retry must NOT trigger prune"
        );
        assert_eq!(
            count_builds(&handles),
            (TRANSIENT_BUILD_RETRIES as usize + 1) * IMAGES.len(),
            "first attempt + all retries, every image each time"
        );
    }

    #[test]
    fn test_parallel_build_prefers_snapshotter_error_for_retry_classification() {
        let mut fail_on = std::collections::HashMap::new();
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_CLAUDE, "test-bundle")),
            "i/o timeout during claude build".to_string(),
        );
        fail_on.insert(
            format!("{}:1", image_ref(IMAGE_MCP_REDMINE, "test-bundle")),
            "apply layer error for \"docker.io/library/redmine:latest\"".to_string(),
        );

        let (_tmp, build_root) = create_fake_build_root();
        let (rt, handles) = retry_mock(build_root.clone(), fail_on);

        let result = build_all_for_bundle(&rt, "test-bundle", &build_root);
        assert_eq!(
            result.unwrap(),
            IMAGES.len() as u32,
            "retry after prune must succeed"
        );

        assert_eq!(
            count_prunes(&handles),
            1,
            "snapshotter error must win classification → prune runs, not just transient retry"
        );
    }

    #[test]
    fn test_parallel_build_worker_panic_propagates() {
        // `std::thread::scope` re-panics on the calling thread when a spawned thread
        // panics, so a panicking `build_image` will propagate out of `try_build_all`.
        // This verifies that worker panics are not silently swallowed.
        let (_tmp, build_root) = create_fake_build_root();
        let (rt, _handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_prepare_build_context_root(build_root.clone())
            .with_build_panic_for("speedwave-mcp-slack")
            .build();
        // std::thread::scope re-panics on the calling thread when any spawned thread
        // panics — wrap in catch_unwind here at the test boundary only.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            try_build_all(&rt, &build_root, "test-bundle")
        }));
        assert!(
            result.is_err(),
            "worker panic must propagate out of try_build_all"
        );
    }
}

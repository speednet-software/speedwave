//! Per-server Custom MCP npm images: the content-addressed tag computed from the pinned lock
//! inputs, the build from `Containerfile.npm.template`, and the prune of superseded tags.

use super::effective::{resolve_for_project, EffectiveCustomMcp};
use super::model::{CustomMcpLock, CustomMcpSource, ManagedCustomMcpConfig};
use super::paths::{self, ServerSubdir};
use crate::runtime::LockedRuntime;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::Path;

/// Version of the server image template; a lock pinned for another version needs a new approval.
pub const SERVER_TEMPLATE_VERSION: u32 = 1;

const IMAGE_REPOSITORY_PREFIX: &str = "speedwave-mcp-custom-";
const TEMPLATE_INPUT: &str = "mcp-servers/custom-launcher/Containerfile.npm.template";
const LAUNCHER_INPUTS: &[&str] = &[
    "mcp-servers/tsconfig.base.json",
    "mcp-servers/custom-launcher/package.json",
    "mcp-servers/custom-launcher/tsconfig.json",
    "mcp-servers/custom-launcher/src",
    TEMPLATE_INPUT,
];
const CONTEXT_ROOT: &str = "mcp-servers/";
const SERVER_INSTALL_DIR: &str = "/opt/spw/server/node_modules";
const TAG_DIGEST_DOMAIN: &str = "speedwave-custom-mcp-image-v1";
const MAX_TAG_BASE_CHARS: usize = 100;
const APPLIED_TAGS_FILE: &str = ".image-tags";

/// The build-dir files and the generated `entry.json` a server image is built from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerImageInputs {
    /// Generated `package.json`.
    pub package_json: String,
    /// Resolver `.npmrc`.
    pub npmrc: String,
    /// Speedwave-generated `package-lock.json`.
    pub lockfile: String,
    /// Launcher entry file (`{command, args}`).
    pub entry_json: String,
}

#[derive(Serialize)]
struct LauncherEntry<'a> {
    command: &'a str,
    args: Vec<String>,
}

/// Image repository of server `name`: `speedwave-mcp-custom-<name>`.
pub fn image_repository(name: &str) -> String {
    format!("{IMAGE_REPOSITORY_PREFIX}{name}")
}

/// `true` when `tag` is an image of server `name`'s own repository.
pub fn is_server_image_tag(name: &str, tag: &str) -> bool {
    tag.strip_prefix(&image_repository(name))
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(|t| {
            !t.is_empty()
                && t.len() <= 128
                && t.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        })
}

fn bin_relative_path(raw: &str) -> anyhow::Result<String> {
    let trimmed = raw.strip_prefix("./").unwrap_or(raw);
    let segments: Vec<&str> = trimmed.split('/').collect();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(char::is_control)
        || segments
            .iter()
            .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        anyhow::bail!("the package bin path {raw:?} is not a plain relative path");
    }
    Ok(trimmed.to_string())
}

fn select_bin(package: &str, bin: &Value) -> anyhow::Result<String> {
    if let Some(path) = bin.as_str() {
        return bin_relative_path(path);
    }
    let map = bin
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("{package} declares no usable bin"))?;
    let unscoped = package.rsplit('/').next().unwrap_or(package);
    let chosen = match map.get(unscoped) {
        Some(path) => path,
        None if map.len() == 1 => map.values().next().unwrap_or(&Value::Null),
        None => anyhow::bail!(
            "{package} declares several bins and none is named {unscoped}: {}",
            map.keys().cloned().collect::<Vec<_>>().join(", ")
        ),
    };
    bin_relative_path(
        chosen
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("{package} declares a bin that is not a path"))?,
    )
}

/// The launcher `entry.json` for `package`: `node` running the package's bin (from the lockfile)
/// with the approved arguments appended.
pub fn entry_json(lockfile: &str, package: &str, args: &[String]) -> anyhow::Result<String> {
    let lock: Value = serde_json::from_str(lockfile)
        .map_err(|e| anyhow::anyhow!("package-lock.json is not JSON: {e}"))?;
    let bin = lock
        .get("packages")
        .and_then(|p| p.get(format!("node_modules/{package}")))
        .and_then(|e| e.get("bin"))
        .ok_or_else(|| anyhow::anyhow!("{package} declares no bin in package-lock.json"))?;
    let script = format!(
        "{SERVER_INSTALL_DIR}/{package}/{}",
        select_bin(package, bin)?
    );
    let mut entry_args = vec![script];
    entry_args.extend(args.iter().cloned());
    Ok(serde_json::to_string(&LauncherEntry {
        command: "node",
        args: entry_args,
    })?)
}

fn sha256_hex(bytes: &[u8]) -> String {
    crate::bundle::bytes_to_hex(&Sha256::digest(bytes))
}

fn read_build_file(dir: &Path, file: &str) -> anyhow::Result<String> {
    crate::fs_perms::read_regular_file_no_follow(&dir.join(file))
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .ok_or_else(|| anyhow::anyhow!("{file} is missing from {}", dir.display()))
}

/// Reads the approved resolver output of server `name` (`<name>/build/`); see
/// [`read_image_inputs_in`].
pub fn read_image_inputs(
    data_dir: &Path,
    project: &str,
    name: &str,
    lock: &CustomMcpLock,
) -> anyhow::Result<ServerImageInputs> {
    let dir = paths::subdir_in(data_dir, project, name, ServerSubdir::Build)?;
    read_image_inputs_in(&dir, name, lock)
}

/// Reads the resolver output of server `name` in `dir` (its `build/` or a review's staging dir)
/// and derives `entry.json`. Refuses a lockfile whose sha256 is not `lock.lockfile_sha256`.
pub fn read_image_inputs_in(
    dir: &Path,
    name: &str,
    lock: &CustomMcpLock,
) -> anyhow::Result<ServerImageInputs> {
    let lockfile = read_build_file(dir, "package-lock.json")?;
    if sha256_hex(lockfile.as_bytes()) != lock.lockfile_sha256 {
        anyhow::bail!(
            "refusing to build the image of custom MCP server {name}: its package-lock.json \
             changed since it was approved; review and approve the server again"
        );
    }
    Ok(ServerImageInputs {
        package_json: read_build_file(dir, "package.json")?,
        npmrc: read_build_file(dir, ".npmrc")?,
        entry_json: entry_json(&lockfile, &lock.package, &lock.args)?,
        lockfile,
    })
}

/// Digest of the launcher sources and the image template under `build_root`.
pub fn launcher_digest(build_root: &Path) -> anyhow::Result<String> {
    let mut hasher = Sha256::new();
    for (path, content) in crate::bundle::read_build_inputs(build_root, LAUNCHER_INPUTS)? {
        hasher.update(path.as_bytes());
        hasher.update([0u8]);
        hasher.update(&content);
    }
    Ok(crate::bundle::bytes_to_hex(&hasher.finalize()))
}

fn tag_base(version: &str) -> String {
    version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '-'
            }
        })
        .take(MAX_TAG_BASE_CHARS)
        .collect()
}

/// Content-addressed tag of server `name`: `speedwave-mcp-custom-<name>:<version>-<digest16>`,
/// the digest over the template version, every image input and the launcher digest.
pub fn image_tag_for(
    name: &str,
    version: &str,
    template_version: u32,
    inputs: &ServerImageInputs,
    launcher_digest: &str,
) -> String {
    let mut hasher = Sha256::new();
    let template_version = template_version.to_string();
    for part in [
        TAG_DIGEST_DOMAIN,
        name,
        version,
        template_version.as_str(),
        inputs.package_json.as_str(),
        inputs.npmrc.as_str(),
        inputs.lockfile.as_str(),
        inputs.entry_json.as_str(),
        launcher_digest,
    ] {
        hasher.update(part.len().to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = crate::bundle::bytes_to_hex(&hasher.finalize());
    format!(
        "{}:{}-{}",
        image_repository(name),
        tag_base(version),
        &digest[..16]
    )
}

/// The tag server `name` builds to from the resolver output in `dir` and the launcher under
/// `build_root`; the path never enters the tag, so a review's staging dir gives the tag its
/// `build/` gives after approval. What the Desktop records as `lock.image_tag` at approval.
pub fn image_tag_for_dir(
    dir: &Path,
    build_root: &Path,
    name: &str,
    lock: &CustomMcpLock,
) -> anyhow::Result<String> {
    let inputs = read_image_inputs_in(dir, name, lock)?;
    Ok(image_tag_for(
        name,
        &lock.version,
        lock.template_version,
        &inputs,
        &launcher_digest(build_root)?,
    ))
}

fn write_context_file(root: &Path, rel: &str, content: &[u8]) -> anyhow::Result<()> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)
        .map_err(|e| anyhow::anyhow!("failed to stage {}: {e}", path.display()))
}

/// Stages the build context of server `name` in a fresh `<name>/image/`: the template as
/// `Containerfile`, the launcher sources, and `server/{package.json,package-lock.json,entry.json}`.
pub fn stage_context(
    data_dir: &Path,
    build_root: &Path,
    project: &str,
    name: &str,
    inputs: &ServerImageInputs,
) -> anyhow::Result<std::path::PathBuf> {
    let dir = paths::subdir_in(data_dir, project, name, ServerSubdir::Image)?;
    if std::fs::symlink_metadata(&dir).is_ok() {
        std::fs::remove_dir_all(&dir)?;
    }
    let dir = paths::ensure_subdir_in(data_dir, project, name, ServerSubdir::Image)?;
    for (path, content) in crate::bundle::read_build_inputs(build_root, LAUNCHER_INPUTS)? {
        let rel = if path == TEMPLATE_INPUT {
            "Containerfile"
        } else {
            path.strip_prefix(CONTEXT_ROOT)
                .ok_or_else(|| anyhow::anyhow!("launcher input {path} is outside {CONTEXT_ROOT}"))?
        };
        write_context_file(&dir, rel, &content)?;
    }
    for (file, content) in [
        ("server/package.json", &inputs.package_json),
        ("server/package-lock.json", &inputs.lockfile),
        ("server/entry.json", &inputs.entry_json),
    ] {
        write_context_file(&dir, file, content.as_bytes())?;
    }
    Ok(dir)
}

fn applied_tags_path(data_dir: &Path, project: &str) -> anyhow::Result<std::path::PathBuf> {
    Ok(paths::project_dir_in(data_dir, project)?.join(APPLIED_TAGS_FILE))
}

fn read_applied_tags(data_dir: &Path, project: &str) -> anyhow::Result<Vec<String>> {
    let text = crate::fs_perms::read_regular_file_no_follow(&applied_tags_path(data_dir, project)?)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .unwrap_or_default();
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|t| t.starts_with(IMAGE_REPOSITORY_PREFIX) && !t.contains(char::is_whitespace))
        .map(str::to_string)
        .collect())
}

fn write_applied_tags(data_dir: &Path, project: &str, tags: &[String]) -> anyhow::Result<()> {
    let mut sorted = tags.to_vec();
    sorted.sort();
    sorted.dedup();
    let path = applied_tags_path(data_dir, project)?;
    if let Some(parent) = path.parent() {
        crate::fs_perms::ensure_owner_only_dir(parent)?;
    }
    let mut text = sorted.join("\n");
    text.push('\n');
    crate::fs_perms::write_restricted_file_atomic(&path, &text)
}

fn record_applied_tag(data_dir: &Path, project: &str, tag: &str) -> anyhow::Result<()> {
    let mut tags = read_applied_tags(data_dir, project)?;
    if tags.iter().any(|t| t == tag) {
        return Ok(());
    }
    tags.push(tag.to_string());
    write_applied_tags(data_dir, project, &tags)
}

fn build_server_image_locked(
    rt: &LockedRuntime,
    data_dir: &Path,
    build_root: &Path,
    project: &str,
    name: &str,
    lock: &CustomMcpLock,
) -> anyhow::Result<()> {
    if lock.template_version != SERVER_TEMPLATE_VERSION {
        anyhow::bail!(
            "custom MCP server {name} was approved for image template {} but this Speedwave \
             builds template {SERVER_TEMPLATE_VERSION}; review and approve the server again",
            lock.template_version
        );
    }
    let inputs = read_image_inputs(data_dir, project, name, lock)?;
    let tag = image_tag_for(
        name,
        &lock.version,
        lock.template_version,
        &inputs,
        &launcher_digest(build_root)?,
    );
    if tag != lock.image_tag {
        anyhow::bail!(
            "refusing to build custom MCP server {name}: its inputs give image {tag}, not the \
             approved {}; review and approve the server again",
            lock.image_tag
        );
    }
    let context = stage_context(data_dir, build_root, project, name, &inputs)?;
    let result = build_staged(rt, &context, &tag);
    if let Err(e) = std::fs::remove_dir_all(&context) {
        log::warn!(
            "failed to remove the build context {}: {e}",
            context.display()
        );
    }
    result?;
    record_applied_tag(data_dir, project, &tag)
}

fn build_staged(rt: &LockedRuntime, context: &Path, tag: &str) -> anyhow::Result<()> {
    let vm_root = rt.prepare_build_context(context)?;
    let root = vm_root.to_string_lossy();
    let root = root.trim_end_matches('/');
    let containerfile = crate::engine_path::vm_path_join(root, "Containerfile");
    log::info!("building custom MCP server image {tag}");
    let result =
        crate::build::with_build_recovery(rt, || rt.build_image(tag, root, &containerfile, &[]));
    if vm_root != context && vm_root.exists() {
        if let Err(e) = std::fs::remove_dir_all(&vm_root) {
            log::warn!(
                "failed to remove the build cache {}: {e}",
                vm_root.display()
            );
        }
    }
    result
}

fn npm_lock(server: &EffectiveCustomMcp) -> Option<&CustomMcpLock> {
    match &server.source {
        CustomMcpSource::Npm { lock } => Some(lock),
        CustomMcpSource::Host { .. } => None,
    }
}

/// Builds the image of every npm server in `servers` that is missing from the engine.
pub fn ensure_custom_images(
    rt: &LockedRuntime,
    data_dir: &Path,
    project: &str,
    servers: &[EffectiveCustomMcp],
) -> anyhow::Result<()> {
    if servers.iter().all(|s| npm_lock(s).is_none()) {
        return Ok(());
    }
    let build_root = crate::build::resolve_build_root()?;
    ensure_custom_images_in(rt, data_dir, &build_root, project, servers)
}

/// [`ensure_custom_images`] with explicit data dir and build root. A tag outside the server's own
/// repository is refused before the engine is asked; build errors are collected per server.
pub fn ensure_custom_images_in(
    rt: &LockedRuntime,
    data_dir: &Path,
    build_root: &Path,
    project: &str,
    servers: &[EffectiveCustomMcp],
) -> anyhow::Result<()> {
    let mut errors = Vec::new();
    for server in servers {
        let Some(lock) = npm_lock(server) else {
            continue;
        };
        if !is_server_image_tag(&server.name, &lock.image_tag) {
            errors.push(format!(
                "custom MCP server {}: image {:?} is not in its repository {}",
                server.name,
                lock.image_tag,
                image_repository(&server.name)
            ));
            continue;
        }
        if rt.image_exists(&lock.image_tag).unwrap_or(false) {
            let recorded = crate::build::with_build_lock_in(data_dir, || {
                record_applied_tag(data_dir, project, &lock.image_tag)
            });
            if let Err(e) = recorded {
                log::warn!("failed to record image {}: {e:#}", lock.image_tag);
            }
            continue;
        }
        let built = crate::build::with_build_lock_in(data_dir, || {
            build_server_image_locked(rt, data_dir, build_root, project, &server.name, lock)
        });
        if let Err(e) = built {
            errors.push(format!("custom MCP server {}: {e:#}", server.name));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(
            "Some custom MCP server images failed to build:\n{}",
            errors.join("\n")
        )
    }
}

/// Removes this project's recorded server images that no server in `keep` runs on, under the
/// build lock; only tags this install built are touched, never a repository sweep, and never
/// a tag another project still runs or records. An unreadable MDM policy prunes nothing.
pub fn prune_custom_images(
    rt: &LockedRuntime,
    project: &str,
    keep: &[EffectiveCustomMcp],
) -> anyhow::Result<()> {
    let managed = crate::managed_config::load_managed_config()
        .map_err(|e| {
            anyhow::anyhow!("the organization policy is unreadable, nothing is pruned: {e:#}")
        })?
        .and_then(|m| m.custom_mcp);
    prune_custom_images_in(
        rt,
        crate::consts::data_dir(),
        project,
        keep,
        managed.as_ref(),
    )
}

/// The server images in use outside `project`'s record: the approved tag of every effective npm
/// server of every project in the user config, and the record of every other project.
fn tags_in_use_elsewhere(
    data_dir: &Path,
    project: &str,
    managed: Option<&ManagedCustomMcpConfig>,
) -> anyhow::Result<BTreeSet<String>> {
    let user_config = crate::config::load_user_config_from(&data_dir.join("config.json"))
        .map_err(|e| anyhow::anyhow!("the user config is unreadable, nothing is pruned: {e:#}"))?;
    let mut tags: BTreeSet<String> = user_config
        .projects
        .iter()
        .flat_map(|p| resolve_for_project(&user_config, &p.name, managed).effective)
        .filter_map(|server| npm_lock(&server).map(|lock| lock.image_tag.clone()))
        .collect();
    let root = paths::state_root_in(data_dir);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(tags),
        Err(e) => anyhow::bail!("cannot list {}: {e}", root.display()),
    };
    for entry in entries {
        let entry = entry?;
        let Some(other) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if other == project
            || !entry.file_type()?.is_dir()
            || crate::validation::validate_project_name(&other).is_err()
        {
            continue;
        }
        tags.extend(read_applied_tags(data_dir, &other)?);
    }
    Ok(tags)
}

/// [`prune_custom_images`] with an explicit data dir (the user config is its `config.json`)
/// and MDM `custom_mcp` policy.
pub fn prune_custom_images_in(
    rt: &LockedRuntime,
    data_dir: &Path,
    project: &str,
    keep: &[EffectiveCustomMcp],
    managed: Option<&ManagedCustomMcpConfig>,
) -> anyhow::Result<()> {
    crate::build::with_build_lock_in(data_dir, || {
        let recorded = read_applied_tags(data_dir, project)?;
        let (mut kept, stale): (Vec<String>, Vec<String>) = recorded.into_iter().partition(|tag| {
            keep.iter()
                .filter_map(npm_lock)
                .any(|lock| lock.image_tag == *tag)
        });
        if stale.is_empty() {
            return Ok(());
        }
        let in_use = tags_in_use_elsewhere(data_dir, project, managed)?;
        let mut present = Vec::new();
        for tag in stale.into_iter().filter(|tag| !in_use.contains(tag)) {
            match rt.image_exists(&tag) {
                Ok(true) => present.push(tag),
                Ok(false) => {}
                Err(e) => {
                    log::warn!("cannot tell whether image {tag} exists, keeping it recorded: {e}");
                    kept.push(tag);
                }
            }
        }
        if !present.is_empty() {
            log::info!("pruning {} superseded custom MCP image(s)", present.len());
            rt.remove_images(&present, true)?;
        }
        write_applied_tags(data_dir, project, &kept)
    })
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
pub(crate) mod tests {
    use super::*;
    use crate::custom_mcp::effective::resolve_effective;
    use crate::custom_mcp::model::CustomMcpEntry;
    use crate::custom_mcp::policy::tests::{approved, npm_entry};
    use crate::runtime::mock_runtime::MockRuntimeBuilder;
    use std::collections::BTreeMap;

    const LOCKFILE: &str = r#"{
  "name": "build",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {"dependencies": {"figma-developer-mcp": "0.6.1"}},
    "node_modules/figma-developer-mcp": {
      "version": "0.6.1",
      "integrity": "sha512-AAAA",
      "bin": {"figma-developer-mcp": "dist/cli.js", "figma-helper": "dist/helper.js"}
    }
  }
}"#;

    fn repo_root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn inputs() -> ServerImageInputs {
        ServerImageInputs {
            package_json: "{\"private\":true}".to_string(),
            npmrc: crate::custom_mcp::npm_resolve::resolver_npmrc(),
            lockfile: LOCKFILE.to_string(),
            entry_json: entry_json(LOCKFILE, "figma-developer-mcp", &["--stdio".to_string()])
                .unwrap(),
        }
    }

    pub(crate) fn stage_build_dir(data_dir: &Path, project: &str, name: &str) {
        let dir = paths::ensure_subdir_in(data_dir, project, name, ServerSubdir::Build).unwrap();
        for (file, content) in [
            ("package-lock.json", LOCKFILE.to_string()),
            ("package.json", "{\"private\":true}".to_string()),
            (".npmrc", crate::custom_mcp::npm_resolve::resolver_npmrc()),
        ] {
            crate::fs_perms::write_restricted_file_atomic(&dir.join(file), &content).unwrap();
        }
    }

    pub(crate) fn pinned_entry(data_dir: &Path, project: &str, name: &str) -> CustomMcpEntry {
        stage_build_dir(data_dir, project, name);
        let mut entry = npm_entry();
        if let CustomMcpSource::Npm { lock } = &mut entry.source {
            lock.lockfile_sha256 = sha256_hex(LOCKFILE.as_bytes());
            let build = paths::subdir_in(data_dir, project, name, ServerSubdir::Build).unwrap();
            lock.image_tag = image_tag_for_dir(&build, &repo_root(), name, lock).unwrap();
        }
        approved(entry)
    }

    fn effective(entries: Vec<(&str, CustomMcpEntry)>) -> Vec<EffectiveCustomMcp> {
        let map: BTreeMap<String, CustomMcpEntry> = entries
            .into_iter()
            .map(|(n, e)| (n.to_string(), e))
            .collect();
        resolve_effective(&map, true, None).effective
    }

    fn tag_of(server: &EffectiveCustomMcp) -> String {
        npm_lock(server).unwrap().image_tag.clone()
    }

    #[test]
    fn entry_json_runs_the_bin_named_after_the_package() {
        let entry = entry_json(LOCKFILE, "figma-developer-mcp", &["--stdio".to_string()]).unwrap();
        assert_eq!(
            entry,
            r#"{"command":"node","args":["/opt/spw/server/node_modules/figma-developer-mcp/dist/cli.js","--stdio"]}"#
        );
    }

    #[test]
    fn entry_json_takes_a_single_bin_or_a_string_bin() {
        let single = r#"{"packages":{"node_modules/@acme/mcp":{"bin":{"other":"./bin/x.js"}}}}"#;
        assert!(entry_json(single, "@acme/mcp", &[])
            .unwrap()
            .contains("/opt/spw/server/node_modules/@acme/mcp/bin/x.js"));
        let scoped = r#"{"packages":{"node_modules/@acme/mcp":{"bin":{"mcp":"a.js","z":"b.js"}}}}"#;
        assert!(entry_json(scoped, "@acme/mcp", &[])
            .unwrap()
            .ends_with("@acme/mcp/a.js\"]}"));
        let string = r#"{"packages":{"node_modules/x":{"bin":"cli.js"}}}"#;
        assert!(entry_json(string, "x", &[]).unwrap().contains("x/cli.js"));
    }

    #[test]
    fn entry_json_refuses_ambiguous_missing_or_escaping_bins() {
        let two = r#"{"packages":{"node_modules/x":{"bin":{"a":"a.js","b":"b.js"}}}}"#;
        assert!(entry_json(two, "x", &[])
            .unwrap_err()
            .to_string()
            .contains("several bins"));
        let none = r#"{"packages":{"node_modules/x":{}}}"#;
        assert!(entry_json(none, "x", &[]).is_err());
        for bad in [
            "../../etc/passwd",
            "/abs.js",
            "a//b.js",
            "a\\b.js",
            "",
            "./",
        ] {
            let lock = format!(
                r#"{{"packages":{{"node_modules/x":{{"bin":{{"x":"{}"}}}}}}}}"#,
                bad.replace('\\', "\\\\")
            );
            assert!(entry_json(&lock, "x", &[]).is_err(), "{bad:?}");
        }
        assert!(entry_json("not json", "x", &[]).is_err());
    }

    #[test]
    fn image_tag_is_stable_and_shaped() {
        let a = image_tag_for("figma", "0.6.1", 1, &inputs(), "launcher");
        let b = image_tag_for("figma", "0.6.1", 1, &inputs(), "launcher");
        assert_eq!(a, b);
        let (repo, tag) = a.split_once(':').unwrap();
        assert_eq!(repo, "speedwave-mcp-custom-figma");
        let (base, digest) = tag.rsplit_once('-').unwrap();
        assert_eq!(base, "0.6.1");
        assert_eq!(digest.len(), 16);
        assert!(is_server_image_tag("figma", &a));
    }

    #[test]
    fn image_tag_changes_with_every_input() {
        let base = image_tag_for("figma", "0.6.1", 1, &inputs(), "launcher");
        let mut variants = vec![
            image_tag_for("figma2", "0.6.1", 1, &inputs(), "launcher"),
            image_tag_for("figma", "0.6.2", 1, &inputs(), "launcher"),
            image_tag_for("figma", "0.6.1", 2, &inputs(), "launcher"),
            image_tag_for("figma", "0.6.1", 1, &inputs(), "launcher2"),
        ];
        for field in 0..4 {
            let mut changed = inputs();
            match field {
                0 => changed.package_json.push(' '),
                1 => changed.npmrc.push('\n'),
                2 => changed.lockfile.push(' '),
                _ => changed.entry_json.push(' '),
            }
            variants.push(image_tag_for("figma", "0.6.1", 1, &changed, "launcher"));
        }
        for v in &variants {
            assert_ne!(*v, base);
        }
    }

    #[test]
    fn image_tag_sanitizes_and_bounds_the_version() {
        let tag = image_tag_for("figma", "1.0.0-rc.1+build.5", 1, &inputs(), "l");
        assert!(tag.contains(":1.0.0-rc.1-build.5-"), "{tag}");
        assert!(is_server_image_tag("figma", &tag));
        let long = format!("1.0.0-{}", "a".repeat(300));
        let tag = image_tag_for("figma", &long, 1, &inputs(), "l");
        let suffix = tag.split_once(':').unwrap().1;
        assert_eq!(suffix.len(), MAX_TAG_BASE_CHARS + 17);
        assert!(is_server_image_tag("figma", &tag));
    }

    #[test]
    fn server_image_tags_stay_in_their_repository() {
        assert!(!is_server_image_tag("figma", "speedwave-claude:abc"));
        assert!(!is_server_image_tag(
            "figma",
            "speedwave-mcp-custom-figmax:1"
        ));
        assert!(!is_server_image_tag("figma", "speedwave-mcp-custom-figma:"));
        assert!(!is_server_image_tag(
            "figma",
            "speedwave-mcp-custom-figma:a b"
        ));
        assert!(!is_server_image_tag(
            "figma",
            "speedwave-mcp-custom-guard:abc"
        ));
    }

    #[test]
    fn launcher_digest_covers_the_template_copy_sources() {
        let template = std::fs::read_to_string(repo_root().join(TEMPLATE_INPUT)).unwrap();
        for line in template.lines().filter(|l| l.starts_with("COPY ")) {
            if line.contains("--from=") {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            for src in &parts[1..parts.len() - 1] {
                let covered = src.starts_with("server/")
                    || LAUNCHER_INPUTS
                        .iter()
                        .filter_map(|i| i.strip_prefix(CONTEXT_ROOT))
                        .any(|i| *src == i || src.starts_with(&format!("{i}/")));
                assert!(covered, "template COPY source {src} is not staged");
            }
        }
        assert_eq!(launcher_digest(&repo_root()).unwrap().len(), 64);
    }

    #[test]
    fn stage_context_lays_out_what_the_template_copies() {
        let data = tempfile::tempdir().unwrap();
        let dir = stage_context(data.path(), &repo_root(), "acme", "figma", &inputs()).unwrap();
        for file in [
            "Containerfile",
            "tsconfig.base.json",
            "custom-launcher/package.json",
            "custom-launcher/tsconfig.json",
            "custom-launcher/src/index.ts",
            "server/package.json",
            "server/package-lock.json",
            "server/entry.json",
        ] {
            assert!(dir.join(file).is_file(), "{file}");
        }
        assert!(!dir.join("custom-launcher/test").exists());
        let template = std::fs::read(repo_root().join(TEMPLATE_INPUT)).unwrap();
        assert_eq!(std::fs::read(dir.join("Containerfile")).unwrap(), template);
        std::fs::write(dir.join("stale"), "x").unwrap();
        let again = stage_context(data.path(), &repo_root(), "acme", "figma", &inputs()).unwrap();
        assert!(!again.join("stale").exists());
    }

    #[test]
    fn missing_image_is_built_once_with_the_approved_tag() {
        let data = tempfile::tempdir().unwrap();
        let servers = effective(vec![("figma", pinned_entry(data.path(), "acme", "figma"))]);
        let tag = tag_of(&servers[0]);
        let (rt, handles) = MockRuntimeBuilder::new().build();
        ensure_custom_images_in(&rt, data.path(), &repo_root(), "acme", &servers).unwrap();
        assert_eq!(handles.build_tags(), vec![tag.clone()]);
        assert!(
            !paths::subdir_in(data.path(), "acme", "figma", ServerSubdir::Image)
                .unwrap()
                .exists()
        );
        assert_eq!(read_applied_tags(data.path(), "acme").unwrap(), vec![tag]);
    }

    #[test]
    fn present_image_is_not_rebuilt() {
        let data = tempfile::tempdir().unwrap();
        let servers = effective(vec![("figma", pinned_entry(data.path(), "acme", "figma"))]);
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists(&tag_of(&servers[0]), true)
            .build();
        ensure_custom_images_in(&rt, data.path(), &repo_root(), "acme", &servers).unwrap();
        assert_eq!(handles.build_call_count(), 0);
    }

    #[test]
    fn host_servers_need_no_image() {
        let data = tempfile::tempdir().unwrap();
        let mut entry = npm_entry();
        entry.source = CustomMcpSource::Host {
            port: 3845,
            path: "/mcp".to_string(),
        };
        let servers = effective(vec![("desk", approved(entry))]);
        let (rt, handles) = MockRuntimeBuilder::new().build();
        ensure_custom_images_in(
            &rt,
            data.path(),
            Path::new("/nonexistent"),
            "acme",
            &servers,
        )
        .unwrap();
        assert_eq!(handles.build_call_count(), 0);
    }

    #[test]
    fn tampered_lockfile_refuses_the_build() {
        let data = tempfile::tempdir().unwrap();
        let servers = effective(vec![("figma", pinned_entry(data.path(), "acme", "figma"))]);
        let build = paths::subdir_in(data.path(), "acme", "figma", ServerSubdir::Build).unwrap();
        std::fs::write(
            build.join("package-lock.json"),
            LOCKFILE.replace("0.6.1", "9.9.9"),
        )
        .unwrap();
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let err = ensure_custom_images_in(&rt, data.path(), &repo_root(), "acme", &servers)
            .unwrap_err()
            .to_string();
        assert!(err.contains("changed since it was approved"), "{err}");
        assert_eq!(handles.build_call_count(), 0);
    }

    #[test]
    fn tampered_npmrc_refuses_the_build() {
        let data = tempfile::tempdir().unwrap();
        let servers = effective(vec![("figma", pinned_entry(data.path(), "acme", "figma"))]);
        let build = paths::subdir_in(data.path(), "acme", "figma", ServerSubdir::Build).unwrap();
        std::fs::write(build.join(".npmrc"), "registry=https://evil.example/\n").unwrap();
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let err = ensure_custom_images_in(&rt, data.path(), &repo_root(), "acme", &servers)
            .unwrap_err()
            .to_string();
        assert!(err.contains("not the approved"), "{err}");
        assert_eq!(handles.build_call_count(), 0);
    }

    #[test]
    fn foreign_image_tag_is_refused_without_asking_the_engine() {
        let data = tempfile::tempdir().unwrap();
        let mut entry = npm_entry();
        if let CustomMcpSource::Npm { lock } = &mut entry.source {
            lock.image_tag = "speedwave-claude:0123456789abcdef".to_string();
        }
        let servers = effective(vec![("figma", approved(entry))]);
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists_default(true)
            .build();
        let err = ensure_custom_images_in(&rt, data.path(), &repo_root(), "acme", &servers)
            .unwrap_err()
            .to_string();
        assert!(err.contains("not in its repository"), "{err}");
        assert_eq!(handles.build_call_count(), 0);
    }

    #[test]
    fn other_template_version_needs_a_new_approval() {
        let data = tempfile::tempdir().unwrap();
        let mut entry = pinned_entry(data.path(), "acme", "figma");
        if let CustomMcpSource::Npm { lock } = &mut entry.source {
            lock.template_version = SERVER_TEMPLATE_VERSION + 1;
        }
        let servers = effective(vec![("figma", approved(entry))]);
        let (rt, _) = MockRuntimeBuilder::new().build();
        let err = ensure_custom_images_in(&rt, data.path(), &repo_root(), "acme", &servers)
            .unwrap_err()
            .to_string();
        assert!(err.contains("image template"), "{err}");
    }

    #[test]
    fn failed_build_is_reported_and_cleans_the_context() {
        let data = tempfile::tempdir().unwrap();
        let servers = effective(vec![("figma", pinned_entry(data.path(), "acme", "figma"))]);
        let (rt, _) = MockRuntimeBuilder::new()
            .with_all_builds_failing("boom")
            .build();
        let err = ensure_custom_images_in(&rt, data.path(), &repo_root(), "acme", &servers)
            .unwrap_err()
            .to_string();
        assert!(err.contains("figma") && err.contains("boom"), "{err}");
        assert!(
            !paths::subdir_in(data.path(), "acme", "figma", ServerSubdir::Image)
                .unwrap()
                .exists()
        );
        assert!(read_applied_tags(data.path(), "acme").unwrap().is_empty());
    }

    #[test]
    fn prune_removes_only_recorded_tags_no_server_runs_on() {
        let data = tempfile::tempdir().unwrap();
        let servers = effective(vec![("figma", pinned_entry(data.path(), "acme", "figma"))]);
        let live = tag_of(&servers[0]);
        let old = "speedwave-mcp-custom-figma:0.6.0-0000000000000000".to_string();
        write_applied_tags(data.path(), "acme", &[live.clone(), old.clone()]).unwrap();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists_default(true)
            .build();
        prune_custom_images_in(&rt, data.path(), "acme", &servers, None).unwrap();
        let calls = handles.remove_images_calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, vec![old]);
        assert_eq!(read_applied_tags(data.path(), "acme").unwrap(), vec![live]);
    }

    #[test]
    fn prune_without_servers_removes_every_recorded_tag_and_ignores_foreign_lines() {
        let data = tempfile::tempdir().unwrap();
        let path = applied_tags_path(data.path(), "acme").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "speedwave-mcp-custom-a:1-0000000000000000\nspeedwave-claude:x\n",
        )
        .unwrap();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists_default(true)
            .build();
        prune_custom_images_in(&rt, data.path(), "acme", &[], None).unwrap();
        let calls = handles.remove_images_calls.lock().unwrap().clone();
        assert_eq!(
            calls[0].0,
            vec!["speedwave-mcp-custom-a:1-0000000000000000".to_string()]
        );
        assert!(read_applied_tags(data.path(), "acme").unwrap().is_empty());
    }

    #[test]
    fn prune_with_nothing_recorded_touches_nothing() {
        let data = tempfile::tempdir().unwrap();
        let (rt, handles) = MockRuntimeBuilder::new().build();
        prune_custom_images_in(&rt, data.path(), "acme", &[], None).unwrap();
        assert!(handles.remove_images_calls.lock().unwrap().is_empty());
    }

    fn write_user_config(data_dir: &Path, projects: Vec<(&str, Vec<(&str, CustomMcpEntry)>)>) {
        let mut user: crate::config::SpeedwaveUserConfig = serde_json::from_value(
            serde_json::json!({
                "projects": projects
                    .iter()
                    .map(|(name, _)| serde_json::json!({"name": name, "dir": format!("/tmp/{name}")}))
                    .collect::<Vec<_>>()
            }),
        )
        .unwrap();
        for (project, (_, servers)) in user.projects.iter_mut().zip(projects) {
            project.custom_mcp = Some(
                servers
                    .into_iter()
                    .map(|(n, e)| (n.to_string(), e))
                    .collect(),
            );
        }
        user.ui = Some(crate::config::UiPrefsConfig {
            beta_enabled: Some(true),
        });
        crate::config::save_user_config_to(&user, &data_dir.join("config.json")).unwrap();
    }

    fn removed(handles: &crate::runtime::mock_runtime::MockHandles) -> Vec<String> {
        handles
            .remove_images_calls
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(tags, _)| tags.clone())
            .collect()
    }

    #[test]
    fn prune_keeps_a_tag_another_project_runs_and_drops_it_from_this_record() {
        let data = tempfile::tempdir().unwrap();
        let in_a = pinned_entry(data.path(), "a", "figma");
        let in_b = pinned_entry(data.path(), "b", "figma");
        let tag = tag_of(&effective(vec![("figma", in_a)])[0]);
        assert_eq!(tag, tag_of(&effective(vec![("figma", in_b.clone())])[0]));
        write_user_config(
            data.path(),
            vec![("a", vec![]), ("b", vec![("figma", in_b)])],
        );
        write_applied_tags(data.path(), "a", std::slice::from_ref(&tag)).unwrap();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists_default(true)
            .build();
        prune_custom_images_in(&rt, data.path(), "a", &[], None).unwrap();
        assert!(removed(&handles).is_empty());
        assert!(read_applied_tags(data.path(), "a").unwrap().is_empty());
    }

    #[test]
    fn prune_keeps_a_tag_another_project_records() {
        let data = tempfile::tempdir().unwrap();
        let tag = "speedwave-mcp-custom-figma:0.6.1-0000000000000000".to_string();
        write_applied_tags(data.path(), "a", std::slice::from_ref(&tag)).unwrap();
        write_applied_tags(data.path(), "b", std::slice::from_ref(&tag)).unwrap();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists_default(true)
            .build();
        prune_custom_images_in(&rt, data.path(), "a", &[], None).unwrap();
        assert!(removed(&handles).is_empty());
        assert_eq!(read_applied_tags(data.path(), "b").unwrap(), vec![tag]);
    }

    #[test]
    fn prune_removes_a_tag_only_this_project_used() {
        let data = tempfile::tempdir().unwrap();
        let in_a = pinned_entry(data.path(), "a", "figma");
        let other = pinned_entry(data.path(), "b", "desk");
        let tag = tag_of(&effective(vec![("figma", in_a)])[0]);
        write_user_config(
            data.path(),
            vec![("a", vec![]), ("b", vec![("desk", other.clone())])],
        );
        write_applied_tags(data.path(), "a", std::slice::from_ref(&tag)).unwrap();
        write_applied_tags(
            data.path(),
            "b",
            &[tag_of(&effective(vec![("desk", other)])[0])],
        )
        .unwrap();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists_default(true)
            .build();
        prune_custom_images_in(&rt, data.path(), "a", &[], None).unwrap();
        assert_eq!(removed(&handles), vec![tag]);
        assert!(read_applied_tags(data.path(), "a").unwrap().is_empty());
    }

    #[test]
    fn a_server_the_policy_turns_off_elsewhere_no_longer_keeps_the_tag() {
        let data = tempfile::tempdir().unwrap();
        let in_b = pinned_entry(data.path(), "b", "figma");
        let tag = tag_of(&effective(vec![("figma", in_b.clone())])[0]);
        write_user_config(data.path(), vec![("b", vec![("figma", in_b)])]);
        write_applied_tags(data.path(), "a", std::slice::from_ref(&tag)).unwrap();
        let off = crate::custom_mcp::effective::unreadable_managed_policy();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists_default(true)
            .build();
        prune_custom_images_in(&rt, data.path(), "a", &[], Some(&off)).unwrap();
        assert_eq!(removed(&handles), vec![tag]);
    }

    #[test]
    fn an_unreadable_user_config_prunes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let tag = "speedwave-mcp-custom-figma:0.6.1-0000000000000000".to_string();
        write_applied_tags(data.path(), "a", std::slice::from_ref(&tag)).unwrap();
        std::fs::write(data.path().join("config.json"), "{not json").unwrap();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_image_exists_default(true)
            .build();
        let err = prune_custom_images_in(&rt, data.path(), "a", &[], None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("nothing is pruned"), "{err}");
        assert!(removed(&handles).is_empty());
        assert_eq!(read_applied_tags(data.path(), "a").unwrap(), vec![tag]);
    }

    #[test]
    fn a_present_image_is_recorded_under_the_build_lock() {
        let source = include_str!("build.rs");
        let present = source
            .find("if rt.image_exists(&lock.image_tag).unwrap_or(false) {")
            .unwrap();
        let branch = &source[present..present + 400];
        let lock = branch.find("with_build_lock_in(data_dir, ||").unwrap();
        let record = branch.find("record_applied_tag(data_dir, project").unwrap();
        assert!(lock < record, "{branch}");
        let data = tempfile::tempdir().unwrap();
        let servers = effective(vec![("figma", pinned_entry(data.path(), "acme", "figma"))]);
        let (rt, _) = MockRuntimeBuilder::new()
            .with_image_exists(&tag_of(&servers[0]), true)
            .build();
        ensure_custom_images_in(&rt, data.path(), &repo_root(), "acme", &servers).unwrap();
        assert_eq!(
            read_applied_tags(data.path(), "acme").unwrap(),
            vec![tag_of(&servers[0])]
        );
        assert!(data.path().join("build.lock").exists());
    }
}

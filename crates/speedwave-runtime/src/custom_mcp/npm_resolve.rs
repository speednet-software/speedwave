//! npm lockfile resolver: pins an exact npm package into a Speedwave-generated
//! `package-lock.json` inside a one-shot node container, then reads what the review screen shows.

use super::model::{self, ManagedCustomMcpConfig};
use super::paths::{self, ServerSubdir};
use crate::consts;
use crate::runtime::{LockedRuntime, OneshotMount, OneshotNetwork, OneshotSpec};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

/// The `.npmrc` every resolver run uses; a repository's own `.npmrc` is never read.
pub fn resolver_npmrc() -> String {
    format!(
        "registry={}\nignore-scripts=true\naudit=false\nfund=false\n",
        consts::CUSTOM_MCP_NPM_REGISTRY
    )
}

const LOCKFILE: &str = "package-lock.json";
const MAX_LOCKFILE_BYTES: u64 = 64 * 1024 * 1024;

/// What to pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NpmResolveRequest<'a> {
    /// Project the server belongs to.
    pub project: &'a str,
    /// Custom MCP server name.
    pub name: &'a str,
    /// npm package name.
    pub package: &'a str,
    /// Exact version.
    pub version: &'a str,
}

/// A pinned package and the facts the review screen shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NpmResolution {
    /// Package name.
    pub package: String,
    /// Exact version.
    pub version: String,
    /// `sha512-…` integrity of the package tarball.
    pub integrity: String,
    /// Hex sha256 of the generated `package-lock.json`.
    pub lockfile_sha256: String,
    /// Packages in the tree besides the requested one.
    pub dependency_count: usize,
    /// License the package declares, if any.
    pub license: Option<String>,
    /// Packages with install scripts; always empty on success (any such package fails resolution).
    pub has_install_script_packages: Vec<String>,
    /// `--before` cut-off the tree was resolved with (RFC 3339, UTC).
    pub before_date: String,
}

/// Validates a request and the MDM policy before anything runs: npm name, exact version, server
/// and project names, the feature switch and `allowed_scopes`.
pub fn validate_request(
    request: &NpmResolveRequest<'_>,
    managed: Option<&ManagedCustomMcpConfig>,
) -> anyhow::Result<()> {
    crate::validation::validate_project_name(request.project)?;
    model::validate_server_name(request.name)?;
    if !model::is_npm_package_name(request.package)? {
        anyhow::bail!("{:?} is not a valid npm package name", request.package);
    }
    model::validate_exact_version(request.version)?;
    if managed.and_then(|m| m.enabled) == Some(false) {
        anyhow::bail!("your organization has disabled Custom MCP servers");
    }
    if let Some(scopes) = managed.and_then(|m| m.allowed_scopes.as_ref()) {
        let allowed = model::npm_scope(request.package)
            .is_some_and(|scope| scopes.iter().any(|s| s == scope));
        if !allowed {
            anyhow::bail!(
                "your organization allows packages only from the scopes {}",
                scopes.join(", ")
            );
        }
    }
    Ok(())
}

fn release_age_days(managed: Option<&ManagedCustomMcpConfig>) -> u32 {
    managed
        .and_then(|m| m.min_release_age_days)
        .unwrap_or(consts::CUSTOM_MCP_DEFAULT_MIN_RELEASE_AGE_DAYS)
}

/// The `--before` cut-off: `now` minus the MDM minimum release age (default
/// [`consts::CUSTOM_MCP_DEFAULT_MIN_RELEASE_AGE_DAYS`]).
pub fn before_date(
    now: chrono::DateTime<chrono::Utc>,
    managed: Option<&ManagedCustomMcpConfig>,
) -> String {
    (now - chrono::Duration::days(i64::from(release_age_days(managed))))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn package_json(package: &str, version: &str) -> anyhow::Result<String> {
    let mut deps = serde_json::Map::new();
    deps.insert(package.to_string(), Value::String(version.to_string()));
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "private": true,
        "dependencies": deps,
    }))?)
}

fn clear_dir(dir: &Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Stages the review's own `<data_dir>/custom-mcp/<project>/<name>/previews/<id>/` from scratch:
/// every previous file removed, then a generated `package.json` and [`resolver_npmrc`]. Another
/// review of the same name, and the approved `build/`, are never touched. Returns the directory.
pub fn stage_preview_dir(
    data_dir: &Path,
    request: &NpmResolveRequest<'_>,
    preview_id: &str,
) -> anyhow::Result<std::path::PathBuf> {
    let dir = paths::ensure_preview_dir_in(data_dir, request.project, request.name, preview_id)?;
    clear_dir(&dir)?;
    crate::fs_perms::write_restricted_file_atomic(
        &dir.join("package.json"),
        &package_json(request.package, request.version)?,
    )?;
    crate::fs_perms::write_restricted_file_atomic(&dir.join(".npmrc"), &resolver_npmrc())?;
    Ok(dir)
}

/// The resolver container: digest-pinned node image, the build dir at `/out`, npm with
/// `--package-lock-only --ignore-scripts --before=<before>`, cache and HOME on `/tmp`.
pub fn resolver_spec(build_dir: &Path, before: &str) -> OneshotSpec {
    let before_flag = format!("--before={before}");
    let mut spec = OneshotSpec::new(
        consts::CUSTOM_MCP_RESOLVER_IMAGE,
        &[
            "npm",
            "install",
            "--package-lock-only",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            &before_flag,
        ],
        crate::resources::CUSTOM_MCP_RESOLVER_RESOURCES,
        consts::CUSTOM_MCP_RESOLVE_TIMEOUT,
    );
    spec.workdir = Some("/out".to_string());
    spec.mounts.push(OneshotMount {
        host: build_dir.to_path_buf(),
        target: "/out".to_string(),
        read_only: false,
    });
    spec.env = vec![
        ("HOME".to_string(), "/tmp".to_string()),
        ("npm_config_cache".to_string(), "/tmp/.npm".to_string()),
        (
            "npm_config_update_notifier".to_string(),
            "false".to_string(),
        ),
    ];
    spec.network = OneshotNetwork::Bridge;
    spec
}

fn npm_failure(package: &str, version: &str, days: u32, text: &str) -> String {
    use super::failure::{failure, NPM_FAILED, NPM_NETWORK, NPM_NOT_FOUND, NPM_VERSION};
    if text.contains("ETARGET") || text.contains("notarget") {
        return failure(
            NPM_VERSION,
            &format!(
                "Version {version} of {package} cannot be used: it was published less than {days} days ago or it does not exist. Choose an older exact version"
            ),
            text,
        );
    }
    if text.contains("E404") || text.contains("404 Not Found") {
        return failure(
            NPM_NOT_FOUND,
            &format!("The package {package} was not found on the npm registry. Check its name"),
            text,
        );
    }
    let unreachable = [
        "ENOTFOUND",
        "EAI_AGAIN",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "ECONNRESET",
    ];
    if unreachable.iter().any(|code| text.contains(code)) {
        return failure(
            NPM_NETWORK,
            "The npm registry could not be reached. Check the internet connection and try again",
            text,
        );
    }
    failure(
        NPM_FAILED,
        &format!("npm could not look up {package}@{version}"),
        text,
    )
}

/// Name of the package an npm v3 lockfile key describes (`node_modules/a/node_modules/@s/b` → `@s/b`).
fn package_name_of(key: &str, entry: &Value) -> String {
    if let Some(name) = entry.get("name").and_then(Value::as_str) {
        return name.to_string();
    }
    key.rsplit_once("node_modules/")
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| key.to_string())
}

/// Parses a lockfileVersion 3 `package-lock.json` for `package@version`. Fails on another
/// lockfile version, a missing root or package entry, a version mismatch, a missing sha512
/// integrity on the package, and any entry with `hasInstallScript` (naming every such package).
pub fn parse_lockfile(text: &str, package: &str, version: &str) -> anyhow::Result<NpmResolution> {
    let lock: Value = serde_json::from_str(text)
        .map_err(|e| anyhow::anyhow!("package-lock.json is not JSON: {e}"))?;
    if lock.get("lockfileVersion").and_then(Value::as_u64) != Some(3) {
        anyhow::bail!("package-lock.json must be lockfileVersion 3");
    }
    let packages = lock
        .get("packages")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("package-lock.json has no packages map"))?;
    if !packages.get("").is_some_and(Value::is_object) {
        anyhow::bail!("package-lock.json has no root package entry");
    }
    let key = format!("node_modules/{package}");
    let entry = packages
        .get(&key)
        .ok_or_else(|| anyhow::anyhow!("package-lock.json does not contain {package}"))?;
    let locked_version = entry.get("version").and_then(Value::as_str).unwrap_or("");
    if locked_version != version {
        anyhow::bail!("package-lock.json pins {package}@{locked_version}, not {version}");
    }
    let integrity = entry
        .get("integrity")
        .and_then(Value::as_str)
        .and_then(|i| i.split_whitespace().find(|t| model::is_sha512_integrity(t)))
        .ok_or_else(|| {
            anyhow::anyhow!("{package}@{version} has no sha512 integrity in the lockfile")
        })?
        .to_string();
    let mut install_scripts: Vec<String> = packages
        .iter()
        .filter(|(_, e)| e.get("hasInstallScript").and_then(Value::as_bool) == Some(true))
        .map(|(k, e)| package_name_of(k, e))
        .collect();
    install_scripts.sort();
    install_scripts.dedup();
    if !install_scripts.is_empty() {
        anyhow::bail!(
            "{package}@{version} cannot be used: these packages run install scripts: {}",
            install_scripts.join(", ")
        );
    }
    let license = entry
        .get("license")
        .and_then(Value::as_str)
        .map(str::to_string);
    let dependency_count = packages
        .keys()
        .filter(|k| !k.is_empty() && **k != key)
        .count();
    Ok(NpmResolution {
        package: package.to_string(),
        version: version.to_string(),
        integrity,
        lockfile_sha256: crate::bundle::bytes_to_hex(&Sha256::digest(text.as_bytes())),
        dependency_count,
        license,
        has_install_script_packages: Vec::new(),
        before_date: String::new(),
    })
}

/// Resolves `package@version` into a Speedwave-generated lockfile in the review's staging dir
/// ([`stage_preview_dir`]): validate, stage, run the resolver container, parse. A failure removes
/// the staging dir. The repository's lockfile and `.npmrc` are never read; the run has full
/// internet (accepted in ADR plan D11).
pub fn resolve_npm_lock(
    rt: &LockedRuntime,
    data_dir: &Path,
    request: &NpmResolveRequest<'_>,
    preview_id: &str,
    managed: Option<&ManagedCustomMcpConfig>,
    now: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<NpmResolution> {
    validate_request(request, managed)?;
    paths::preview_dir_in(data_dir, request.project, request.name, preview_id)?;
    let resolved = resolve_into_preview(rt, data_dir, request, preview_id, managed, now);
    if resolved.is_err() {
        discard_preview(data_dir, request.project, request.name, preview_id);
    }
    resolved
}

/// Removes the staging dir of one review; a missing dir is fine, any other failure is logged.
pub fn discard_preview(data_dir: &Path, project: &str, name: &str, preview_id: &str) {
    let Ok(dir) = paths::preview_dir_in(data_dir, project, name, preview_id) else {
        return;
    };
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "could not remove the review staging dir {}: {e}",
                dir.display()
            );
        }
    }
}

/// Approval of review `preview_id`: its staging dir replaces `<name>/build/` in one rename, and
/// every other pending review of `name` is dropped (the name is taken from now on).
pub fn promote_preview(
    data_dir: &Path,
    project: &str,
    name: &str,
    preview_id: &str,
) -> anyhow::Result<std::path::PathBuf> {
    let staged = paths::preview_dir_in(data_dir, project, name, preview_id)?;
    match std::fs::symlink_metadata(&staged) {
        Ok(meta) if meta.is_dir() => {}
        _ => anyhow::bail!(
            "the reviewed build files of custom MCP server {name} are gone; review it again"
        ),
    }
    let build = paths::ensure_subdir_in(data_dir, project, name, ServerSubdir::Build)?;
    std::fs::remove_dir_all(&build)?;
    std::fs::rename(&staged, &build)?;
    let previews = paths::subdir_in(data_dir, project, name, ServerSubdir::Previews)?;
    if let Err(e) = std::fs::remove_dir_all(&previews) {
        log::warn!(
            "could not remove the other reviews of {name} in {}: {e}",
            previews.display()
        );
    }
    Ok(build)
}

fn resolve_into_preview(
    rt: &LockedRuntime,
    data_dir: &Path,
    request: &NpmResolveRequest<'_>,
    preview_id: &str,
    managed: Option<&ManagedCustomMcpConfig>,
    now: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<NpmResolution> {
    let before = before_date(now, managed);
    let dir = stage_preview_dir(data_dir, request, preview_id)?;
    rt.run_oneshot(&resolver_spec(&dir, &before)).map_err(|e| {
        anyhow::anyhow!(npm_failure(
            request.package,
            request.version,
            release_age_days(managed),
            &format!("{e:#}")
        ))
    })?;
    let lockfile = dir.join(LOCKFILE);
    match std::fs::symlink_metadata(&lockfile) {
        Ok(meta) if meta.len() > MAX_LOCKFILE_BYTES => {
            anyhow::bail!("package-lock.json is larger than {MAX_LOCKFILE_BYTES} bytes")
        }
        _ => {}
    }
    let text = crate::fs_perms::read_regular_file_no_follow(&lockfile)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .ok_or_else(|| anyhow::anyhow!("npm finished without writing package-lock.json"))?;
    let mut resolution = parse_lockfile(&text, request.package, request.version)?;
    resolution.before_date = before;
    Ok(resolution)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::runtime::mock_runtime::MockRuntimeBuilder;
    use std::sync::Arc;

    const PREVIEW: &str = "123e4567-e89b-12d3-a456-426614174000";

    const INTEGRITY: &str = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

    fn request() -> NpmResolveRequest<'static> {
        NpmResolveRequest {
            project: "acme",
            name: "figma",
            package: "figma-developer-mcp",
            version: "0.6.1",
        }
    }

    fn lockfile(package: &str, extra: Value) -> String {
        let mut packages = serde_json::json!({
            "": {"dependencies": {package: "0.6.1"}},
            format!("node_modules/{package}"): {
                "version": "0.6.1",
                "resolved": "https://registry.npmjs.org/x/-/x-0.6.1.tgz",
                "integrity": INTEGRITY,
                "license": "MIT"
            },
            "node_modules/zod": {"version": "3.23.8", "integrity": INTEGRITY, "license": "MIT"},
            "node_modules/a/node_modules/@s/b": {"version": "1.0.0", "integrity": INTEGRITY}
        });
        if let (Some(target), Some(add)) = (packages.as_object_mut(), extra.as_object()) {
            for (k, v) in add {
                target.insert(k.clone(), v.clone());
            }
        }
        serde_json::to_string_pretty(&serde_json::json!({
            "name": "out",
            "lockfileVersion": 3,
            "requires": true,
            "packages": packages
        }))
        .unwrap()
    }

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-10-08T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn resolver_image_is_the_server_template_base() {
        let template =
            include_str!("../../../../mcp-servers/custom-launcher/Containerfile.npm.template");
        assert!(
            template
                .lines()
                .any(|l| l.trim() == format!("FROM {}", consts::CUSTOM_MCP_RESOLVER_IMAGE)),
            "the resolver must run the npm of the image that later runs npm ci"
        );
        assert!(consts::CUSTOM_MCP_RESOLVER_IMAGE.contains("@sha256:"));
    }

    #[test]
    fn resolver_npmrc_pins_the_public_registry_and_disables_scripts() {
        assert_eq!(
            resolver_npmrc(),
            "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n"
        );
    }

    #[test]
    fn parses_a_v3_lockfile() {
        let text = lockfile("figma-developer-mcp", Value::Null);
        let r = parse_lockfile(&text, "figma-developer-mcp", "0.6.1").unwrap();
        assert_eq!(r.integrity, INTEGRITY);
        assert_eq!(r.dependency_count, 2);
        assert_eq!(r.license.as_deref(), Some("MIT"));
        assert_eq!(
            r.lockfile_sha256,
            crate::bundle::bytes_to_hex(&Sha256::digest(text.as_bytes()))
        );
        assert!(r.has_install_script_packages.is_empty());
    }

    #[test]
    fn parses_a_scoped_package_and_a_multi_hash_integrity() {
        let text = lockfile("@acme/mcp", Value::Null);
        let r = parse_lockfile(&text, "@acme/mcp", "0.6.1").unwrap();
        assert_eq!(r.package, "@acme/mcp");
        assert_eq!(r.dependency_count, 2);
        let multi = lockfile(
            "x",
            serde_json::json!({"node_modules/x": {"version": "0.6.1", "integrity": format!("sha1-abc= {INTEGRITY}")}}),
        );
        assert_eq!(
            parse_lockfile(&multi, "x", "0.6.1").unwrap().integrity,
            INTEGRITY
        );
        let no_license = lockfile(
            "x",
            serde_json::json!({"node_modules/x": {"version": "0.6.1", "integrity": INTEGRITY}}),
        );
        assert_eq!(
            parse_lockfile(&no_license, "x", "0.6.1").unwrap().license,
            None
        );
    }

    #[test]
    fn install_scripts_anywhere_in_the_tree_are_refused_by_name() {
        let text = lockfile(
            "x",
            serde_json::json!({
                "node_modules/esbuild": {"version": "0.20.0", "integrity": INTEGRITY, "hasInstallScript": true},
                "node_modules/a/node_modules/@s/b": {"version": "1.0.0", "integrity": INTEGRITY, "hasInstallScript": true},
                "node_modules/c": {"version": "1.0.0", "hasInstallScript": false}
            }),
        );
        let err = parse_lockfile(&text, "x", "0.6.1").unwrap_err().to_string();
        assert!(err.contains("@s/b, esbuild"), "{err}");
        assert!(!err.contains(", c"), "{err}");
    }

    #[test]
    fn malformed_lockfiles_are_rejected() {
        let missing_integrity = lockfile(
            "x",
            serde_json::json!({"node_modules/x": {"version": "0.6.1"}}),
        );
        let sha1_only = lockfile(
            "x",
            serde_json::json!({"node_modules/x": {"version": "0.6.1", "integrity": "sha1-abc="}}),
        );
        let other_version = lockfile(
            "x",
            serde_json::json!({"node_modules/x": {"version": "0.7.0", "integrity": INTEGRITY}}),
        );
        let v2 =
            lockfile("x", Value::Null).replace("\"lockfileVersion\": 3", "\"lockfileVersion\": 2");
        let no_root = lockfile("x", Value::Null).replace("\"\": {", "\"nope\": {");
        for (what, text, package) in [
            ("missing integrity", missing_integrity.as_str(), "x"),
            ("sha1 only", sha1_only.as_str(), "x"),
            ("version mismatch", other_version.as_str(), "x"),
            ("lockfile v2", v2.as_str(), "x"),
            ("no root", no_root.as_str(), "x"),
            ("absent package", lockfile("x", Value::Null).as_str(), "y"),
            ("not json", "{", "x"),
            ("no packages", r#"{"lockfileVersion":3}"#, "x"),
        ] {
            assert!(parse_lockfile(text, package, "0.6.1").is_err(), "{what}");
        }
    }

    #[test]
    fn invalid_requests_fail_before_anything_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let bad = [
            NpmResolveRequest {
                package: "Bad",
                ..request()
            },
            NpmResolveRequest {
                package: "../evil",
                ..request()
            },
            NpmResolveRequest {
                version: "^0.6.1",
                ..request()
            },
            NpmResolveRequest {
                version: "latest",
                ..request()
            },
            NpmResolveRequest {
                version: "0.6",
                ..request()
            },
            NpmResolveRequest {
                name: "figma-up",
                ..request()
            },
            NpmResolveRequest {
                project: "../x",
                ..request()
            },
        ];
        for req in bad {
            assert!(
                resolve_npm_lock(&rt, tmp.path(), &req, PREVIEW, None, now()).is_err(),
                "{req:?}"
            );
        }
        assert!(handles.oneshot_specs().is_empty());
        assert!(!tmp.path().join("custom-mcp").exists());
    }

    #[test]
    fn managed_policy_is_enforced_before_anything_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let off = ManagedCustomMcpConfig {
            enabled: Some(false),
            ..Default::default()
        };
        assert!(resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, Some(&off), now()).is_err());
        let scoped = ManagedCustomMcpConfig {
            allowed_scopes: Some(vec!["@acme".into()]),
            ..Default::default()
        };
        let err = resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, Some(&scoped), now())
            .unwrap_err();
        assert!(err.to_string().contains("@acme"), "{err}");
        assert!(handles.oneshot_specs().is_empty());
        assert!(validate_request(
            &NpmResolveRequest {
                package: "@acme/mcp",
                ..request()
            },
            Some(&scoped)
        )
        .is_ok());
    }

    #[test]
    fn before_date_honours_the_managed_minimum_age() {
        assert_eq!(before_date(now(), None), "2026-10-01T12:00:00.000Z");
        let managed = ManagedCustomMcpConfig {
            min_release_age_days: Some(30),
            ..Default::default()
        };
        assert_eq!(
            before_date(now(), Some(&managed)),
            "2026-09-08T12:00:00.000Z"
        );
        let zero = ManagedCustomMcpConfig {
            min_release_age_days: Some(0),
            ..Default::default()
        };
        assert_eq!(before_date(now(), Some(&zero)), "2026-10-08T12:00:00.000Z");
    }

    #[test]
    fn resolves_end_to_end_through_the_recorded_oneshot() {
        let tmp = tempfile::tempdir().unwrap();
        let approved = tmp.path().join("custom-mcp/acme/figma/build");
        std::fs::create_dir_all(&approved).unwrap();
        std::fs::write(approved.join("package-lock.json"), "{\"approved\":true}").unwrap();
        let build = tmp
            .path()
            .join(format!("custom-mcp/acme/figma/previews/{PREVIEW}"));
        std::fs::create_dir_all(build.join("node_modules/stale")).unwrap();
        std::fs::write(build.join("package-lock.json"), "{\"stale\":true}").unwrap();
        std::fs::write(build.join(".npmrc"), "registry=https://evil.example/\n").unwrap();
        let text = lockfile("figma-developer-mcp", Value::Null);
        let lock_text = text.clone();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_oneshot_handler(Arc::new(move |spec: &OneshotSpec| {
                let out = &spec.mounts[0].host;
                assert!(!out.join("package-lock.json").exists(), "stale lockfile must be gone");
                assert!(!out.join("node_modules").exists());
                assert_eq!(std::fs::read_to_string(out.join(".npmrc")).unwrap(), resolver_npmrc());
                let pkg: Value =
                    serde_json::from_str(&std::fs::read_to_string(out.join("package.json")).unwrap())
                        .unwrap();
                assert_eq!(
                    pkg,
                    serde_json::json!({"private": true, "dependencies": {"figma-developer-mcp": "0.6.1"}})
                );
                std::fs::write(out.join("package-lock.json"), &lock_text).unwrap();
                Ok(String::new())
            }))
            .build();
        let r = resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, None, now()).unwrap();
        assert_eq!(r.integrity, INTEGRITY);
        assert_eq!(r.before_date, "2026-10-01T12:00:00.000Z");
        assert_eq!(
            r.lockfile_sha256,
            crate::bundle::bytes_to_hex(&Sha256::digest(text.as_bytes()))
        );

        let specs = handles.oneshot_specs();
        assert_eq!(specs.len(), 1);
        let spec = &specs[0];
        assert_eq!(spec.image, consts::CUSTOM_MCP_RESOLVER_IMAGE);
        assert_eq!(
            spec.argv,
            vec![
                "npm",
                "install",
                "--package-lock-only",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--before=2026-10-01T12:00:00.000Z"
            ]
        );
        assert_eq!(
            spec.mounts,
            vec![OneshotMount {
                host: build.clone(),
                target: "/out".into(),
                read_only: false
            }]
        );
        assert_eq!(spec.workdir.as_deref(), Some("/out"));
        assert_eq!(spec.network, OneshotNetwork::Bridge);
        assert_eq!(
            spec.resources,
            crate::resources::CUSTOM_MCP_RESOLVER_RESOURCES
        );
        assert_eq!(spec.timeout, consts::CUSTOM_MCP_RESOLVE_TIMEOUT);
        assert!(spec.env.contains(&("HOME".into(), "/tmp".into())));
        assert!(spec.name.starts_with("spw-oneshot-"));
        assert!(build.join("package-lock.json").is_file());
        assert_eq!(
            std::fs::read_to_string(approved.join("package-lock.json")).unwrap(),
            "{\"approved\":true}",
            "a review never touches the approved build files"
        );
    }

    fn resolver_writing(text: String) -> LockedRuntime {
        MockRuntimeBuilder::new()
            .with_oneshot_handler(Arc::new(move |spec: &OneshotSpec| {
                std::fs::write(spec.mounts[0].host.join(LOCKFILE), &text).unwrap();
                Ok(String::new())
            }))
            .build()
            .0
    }

    fn staged_lockfile(data_dir: &Path, id: &str) -> String {
        let dir = paths::preview_dir_in(data_dir, "acme", "figma", id).unwrap();
        std::fs::read_to_string(dir.join(LOCKFILE)).unwrap()
    }

    #[test]
    fn two_reviews_of_one_name_stage_apart_and_the_approved_one_becomes_build() {
        let tmp = tempfile::tempdir().unwrap();
        let first = lockfile("figma-developer-mcp", Value::Null);
        let second = lockfile(
            "figma-developer-mcp",
            serde_json::json!({"node_modules/extra": {"version": "1.0.0", "integrity": INTEGRITY}}),
        );
        let other = "0f0f0f0f-e89b-12d3-a456-426614174000";
        resolve_npm_lock(
            &resolver_writing(first.clone()),
            tmp.path(),
            &request(),
            PREVIEW,
            None,
            now(),
        )
        .unwrap();
        resolve_npm_lock(
            &resolver_writing(second.clone()),
            tmp.path(),
            &request(),
            other,
            None,
            now(),
        )
        .unwrap();
        assert_eq!(staged_lockfile(tmp.path(), PREVIEW), first);
        assert_eq!(staged_lockfile(tmp.path(), other), second);

        let stale_build =
            paths::ensure_subdir_in(tmp.path(), "acme", "figma", ServerSubdir::Build).unwrap();
        std::fs::write(stale_build.join(LOCKFILE), "{\"removed\":true}").unwrap();
        let build = promote_preview(tmp.path(), "acme", "figma", PREVIEW).unwrap();
        assert_eq!(build, stale_build);
        assert_eq!(
            std::fs::read_to_string(build.join(LOCKFILE)).unwrap(),
            first
        );
        assert_eq!(
            std::fs::read_to_string(build.join(".npmrc")).unwrap(),
            resolver_npmrc()
        );
        assert!(
            !paths::subdir_in(tmp.path(), "acme", "figma", ServerSubdir::Previews)
                .unwrap()
                .exists()
        );
        let err = promote_preview(tmp.path(), "acme", "figma", other)
            .unwrap_err()
            .to_string();
        assert!(err.contains("review it again"), "{err}");
        assert_eq!(
            std::fs::read_to_string(build.join(LOCKFILE)).unwrap(),
            first
        );
    }

    #[test]
    fn a_failed_resolution_removes_only_its_own_staging_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let kept = "0f0f0f0f-e89b-12d3-a456-426614174000";
        resolve_npm_lock(
            &resolver_writing(lockfile("figma-developer-mcp", Value::Null)),
            tmp.path(),
            &request(),
            kept,
            None,
            now(),
        )
        .unwrap();
        let (rt, _) = MockRuntimeBuilder::new().build();
        assert!(resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, None, now()).is_err());
        assert!(!paths::preview_dir_in(tmp.path(), "acme", "figma", PREVIEW)
            .unwrap()
            .exists());
        assert!(paths::preview_dir_in(tmp.path(), "acme", "figma", kept)
            .unwrap()
            .join(LOCKFILE)
            .is_file());
        discard_preview(tmp.path(), "acme", "figma", kept);
        assert!(!paths::preview_dir_in(tmp.path(), "acme", "figma", kept)
            .unwrap()
            .exists());
        discard_preview(tmp.path(), "acme", "figma", kept);
        discard_preview(tmp.path(), "acme", "figma", "../escape");
    }

    #[test]
    fn an_invalid_review_id_fails_before_anything_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, handles) = MockRuntimeBuilder::new().build();
        for bad in ["", "../x", "A-1"] {
            assert!(resolve_npm_lock(&rt, tmp.path(), &request(), bad, None, now()).is_err());
            assert!(promote_preview(tmp.path(), "acme", "figma", bad).is_err());
        }
        assert!(handles.oneshot_specs().is_empty());
        assert!(!tmp.path().join("custom-mcp").exists());
    }

    fn failed_resolution_text(raw: &'static str) -> String {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _) = MockRuntimeBuilder::new()
            .with_oneshot_handler(Arc::new(move |_: &OneshotSpec| anyhow::bail!("{raw}")))
            .build();
        resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, None, now())
            .unwrap_err()
            .to_string()
    }

    #[test]
    fn a_missing_package_is_explained_with_a_code_and_no_npm_output() {
        let err = failed_resolution_text(
            "npm ERR! 404 Not Found - GET https://registry.npmjs.org/figma-developer-mcp",
        );
        assert_eq!(
            err,
            "The package figma-developer-mcp was not found on the npm registry. Check its name (CMCP-NPM-NOT-FOUND). Details are in the Speedwave log."
        );
    }

    #[test]
    fn a_version_inside_the_release_age_window_is_explained() {
        let err = failed_resolution_text(
            "npm error code ETARGET\nnpm error notarget No matching version found for figma-developer-mcp@0.6.1 with a date before 10/7/2026",
        );
        assert_eq!(
            err,
            "Version 0.6.1 of figma-developer-mcp cannot be used: it was published less than 7 days ago or it does not exist. Choose an older exact version (CMCP-NPM-VERSION). Details are in the Speedwave log."
        );
    }

    #[test]
    fn the_release_age_in_the_message_follows_the_managed_minimum() {
        let tmp = tempfile::tempdir().unwrap();
        let managed = ManagedCustomMcpConfig {
            min_release_age_days: Some(30),
            ..Default::default()
        };
        let (rt, _) = MockRuntimeBuilder::new()
            .with_oneshot_handler(Arc::new(|_: &OneshotSpec| {
                anyhow::bail!("npm error code ETARGET")
            }))
            .build();
        let err = resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, Some(&managed), now())
            .unwrap_err()
            .to_string();
        assert!(err.contains("less than 30 days ago"), "{err}");
    }

    #[test]
    fn an_unreachable_registry_is_explained() {
        let err =
            failed_resolution_text("npm error code EAI_AGAIN\nnpm error network request failed");
        assert!(
            err.starts_with("The npm registry could not be reached."),
            "{err}"
        );
        assert!(err.contains("(CMCP-NPM-NETWORK)"), "{err}");
    }

    #[test]
    fn an_unknown_npm_failure_never_shows_the_npm_output() {
        let err = failed_resolution_text("npm error EACCES permission denied, mkdir '/root/.npm'");
        assert_eq!(
            err,
            "npm could not look up figma-developer-mcp@0.6.1 (CMCP-NPM-FAILED). Details are in the Speedwave log."
        );
        assert!(!err.contains("EACCES"), "{err}");
    }

    #[test]
    fn a_run_that_writes_no_lockfile_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _) = MockRuntimeBuilder::new().build();
        let err = resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, None, now()).unwrap_err();
        assert!(err.to_string().contains("without writing"), "{err}");
    }

    #[test]
    fn install_scripts_found_after_the_run_fail_resolution() {
        let tmp = tempfile::tempdir().unwrap();
        let text = lockfile(
            "figma-developer-mcp",
            serde_json::json!({"node_modules/sharp": {"version": "0.33.0", "integrity": INTEGRITY, "hasInstallScript": true}}),
        );
        let (rt, _) = MockRuntimeBuilder::new()
            .with_oneshot_handler(Arc::new(move |spec: &OneshotSpec| {
                std::fs::write(spec.mounts[0].host.join("package-lock.json"), &text).unwrap();
                Ok(String::new())
            }))
            .build();
        let err = resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, None, now()).unwrap_err();
        assert!(err.to_string().contains("sharp"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_lockfile_is_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.json");
        std::fs::write(&outside, lockfile("figma-developer-mcp", Value::Null)).unwrap();
        let target = outside.clone();
        let (rt, _) = MockRuntimeBuilder::new()
            .with_oneshot_handler(Arc::new(move |spec: &OneshotSpec| {
                std::os::unix::fs::symlink(&target, spec.mounts[0].host.join("package-lock.json"))
                    .unwrap();
                Ok(String::new())
            }))
            .build();
        assert!(resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, None, now()).is_err());
    }

    #[test]
    fn the_run_is_refused_during_engine_teardown() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_engine_teardown_check(|| true)
            .build();
        assert!(resolve_npm_lock(&rt, tmp.path(), &request(), PREVIEW, None, now()).is_err());
        assert!(handles.oneshot_specs().is_empty());
    }
}

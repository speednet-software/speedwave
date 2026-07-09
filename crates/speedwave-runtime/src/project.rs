//! Per-project registration, data-dir layout, and isolation setup.

use crate::{compose, config, runtime, validation};
use std::path::Path;

/// Best-effort cleanup of project directories created by `init_project_dirs_in`.
/// Used for rollback when a later step of `add_project` fails.
pub fn cleanup_project_dirs(project: &str) {
    cleanup_project_dirs_in(project, crate::consts::data_dir());
}

/// Best-effort cleanup of project directories under a given data directory.
/// Subdir set mirrors fs_security's per-project list — when adding state under data_dir/<sub>/<project>/, add it here too.
fn cleanup_project_dirs_in(project: &str, data_dir: &Path) {
    for sub in &[
        "tokens",
        "compose",
        "context",
        crate::consts::CLAUDE_HOME_SUBDIR,
        "secrets",
        "snapshots",
        "usage",
        crate::consts::OAUTH_SUBDIR,
        // Legacy: retired host_exec state (pre-removal releases) goes with the project.
        crate::legacy_token_cleanup::LEGACY_HOST_EXEC_SUBDIR,
    ] {
        let dir = data_dir.join(sub).join(project);
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "cleanup_project_dirs: failed to remove '{}': {e}",
                    dir.display()
                );
            }
        }
    }
}

/// Creates project directories under a given data directory with restrictive
/// `0o700` permissions on Unix.
fn init_project_dirs_in(project: &str, data_dir: &Path) -> anyhow::Result<()> {
    validation::validate_project_name(project)?;
    let tokens_root = data_dir.join("tokens").join(project);
    let mut dirs_to_create = vec![
        data_dir.join("compose").join(project),
        data_dir.join("context").join(project),
        data_dir
            .join(crate::consts::CLAUDE_HOME_SUBDIR)
            .join(project),
    ];
    // One token dir per credential-bearing service, derived from the SSOT in consts.rs.
    for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
        if !svc.credential_files.is_empty() {
            dirs_to_create.push(tokens_root.join(svc.config_key));
        }
    }
    for dir in &dirs_to_create {
        create_dir_all_secure(dir)?;
    }
    Ok(())
}

/// `create_dir_all` that applies mode `0o700` to each directory level it
/// creates on Unix; already-existing directories keep their permissions.
fn create_dir_all_secure(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Saves the rendered compose YAML under a given data directory.
fn save_compose_in(project: &str, yaml: &str, data_dir: &Path) -> anyhow::Result<()> {
    let path = data_dir.join("compose").join(project).join("compose.yml");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, yaml)?;
    Ok(())
}

/// Registers a new project under an inter-process config lock: validate first,
/// then commit side-effects; a late write failure rolls back created dirs.
pub fn add_project(name: &str, dir: &str) -> anyhow::Result<()> {
    config::with_config_lock(|| add_project_inner(name, dir))
}

fn add_project_inner(name: &str, dir: &str) -> anyhow::Result<()> {
    let data_dir = crate::consts::data_dir();
    add_project_with_data_dir(name, dir, data_dir)
}

/// Core implementation of project registration, parameterized by `data_dir`
/// so that tests can redirect all I/O to a temporary directory without
/// modifying process-global state (e.g. `HOME`).
fn add_project_with_data_dir(name: &str, dir: &str, data_dir: &Path) -> anyhow::Result<()> {
    // ── Phase 1a: dir-class validation (canonical path + existence check) ──

    validation::validate_project_name(name)?;

    let dir_path = Path::new(dir);
    if !dir_path.is_absolute() {
        anyhow::bail!("Project directory must be an absolute path: {}", dir);
    }

    // WSL UNC: bypass canonicalize (undocumented behavior on Windows — see ADR-064).
    let (canonical, canonical_str) = match runtime::wsl::is_wsl_unc_path(dir) {
        Some(info) => {
            if !info.is_runtime_distro() {
                anyhow::bail!(crate::consts::wsl_other_distro_msg(&info.distro));
            }
            // Reject the distro root via the dedicated helper.
            let translated = format!("/{}", info.rest);
            if runtime::wsl::is_root_path(Path::new(&translated)) {
                anyhow::bail!(
                    "Cannot use the WSL distribution root '{}' as a project directory. \
                     Choose a subdirectory like \\\\wsl.localhost\\{}\\projects\\<name>.",
                    dir,
                    crate::consts::wsl_distro_name()
                );
            }
            if !std::fs::metadata(dir_path)
                .map(|m| m.is_dir())
                .unwrap_or(false)
            {
                anyhow::bail!(
                    "Project directory does not exist or is not a directory: {}",
                    dir
                );
            }
            (dir_path.to_path_buf(), dir.to_string())
        }
        None => {
            let canonical = std::fs::canonicalize(dir_path)?;
            if !canonical.is_dir() {
                anyhow::bail!(
                    "Project directory does not exist or is not a directory: {}",
                    canonical.display()
                );
            }
            // Store without `\\?\`: config.json feeds UI/scripts, not just the engine.
            let lossy = canonical.to_string_lossy();
            let canonical_str =
                crate::engine_path::strip_extended_length_prefix(&lossy).to_string();
            let canonical = std::path::PathBuf::from(&canonical_str);
            (canonical, canonical_str)
        }
    };

    add_project_with_validated_dir(name, canonical, canonical_str, data_dir)
}

/// Phase 1b + 2: duplicate/compose/config pipeline, converged for both UNC and drive-letter paths.
fn add_project_with_validated_dir(
    name: &str,
    canonical: std::path::PathBuf,
    canonical_str: String,
    data_dir: &Path,
) -> anyhow::Result<()> {
    let config_path = data_dir.join("config.json");
    let mut user_config = config::load_user_config_from(&config_path)?;

    // Duplicate name check
    if user_config.find_project(name).is_some() {
        anyhow::bail!("Project '{}' already exists", name);
    }

    // Duplicate path check: exact-string fast path (catches UNC, which canonicalize
    // can't resolve), then canonicalize fallback for drive-letter/Unix paths.
    if let Some(existing) = user_config.projects.iter().find(|p| {
        if p.dir == canonical_str {
            return true;
        }
        std::fs::canonicalize(&p.dir)
            .map(|c| c == canonical)
            .unwrap_or(false)
    }) {
        anyhow::bail!(
            "Directory already registered as project '{}'",
            existing.name
        );
    }

    // Dirs left by a pre-fix removal or crash must not leak into a re-added
    // project of the same name (stale usage/costs, stale OAuth credentials).
    cleanup_project_dirs_in(name, data_dir);

    // Build new entry
    let entry = config::ProjectUserEntry {
        name: name.to_string(),
        dir: canonical_str.clone(),
        claude: None,
        integrations: None,
        plugin_settings: None,
        policy: None,
    };

    user_config.projects.push(entry);
    user_config.active_project = Some(name.to_string());

    // Resolve config and render compose (still no I/O). A brand-new project
    // has no LLM provider yet — that is a valid, first-class state (the
    // Desktop "no_provider" screen), so registration must not fail just
    // because compose can't route an LLM yet; `start_containers` renders
    // compose again once a provider is chosen.
    let (resolved, integrations) = config::resolve_project_config(&canonical, &user_config, name);
    let yaml = if resolved.llm.is_unconfigured() {
        None
    } else {
        let rt = runtime::detect_runtime();
        let rt_ref: Option<&runtime::LockedRuntime> =
            if rt.is_available() { Some(&rt) } else { None };
        // Reconstruct host-bridge env from disk (ADR-074) so project-add never
        // renders a worker without an already-configured bridge's env vars.
        let host_bridges = compose::host_bridges_from_disk();
        Some(compose::render_compose(
            name,
            &canonical_str,
            &resolved,
            &integrations,
            rt_ref,
            &host_bridges,
        )?)
    };

    // ── Phase 2: commit (all writes) ─────────────────────────────────────

    init_project_dirs_in(name, data_dir)?;

    if let Err(e) = config::save_user_config_to(&user_config, &config_path) {
        cleanup_project_dirs_in(name, data_dir);
        return Err(e);
    }

    if let Some(yaml) = yaml {
        if let Err(e) = save_compose_in(name, &yaml, data_dir) {
            cleanup_project_dirs_in(name, data_dir);
            return Err(e);
        }
    }

    Ok(())
}

/// Sentinel prefix on the error message when the caller tried to remove the active project.
/// Stable string — UI may match on it to surface a tailored toast.
pub const REMOVE_ACTIVE_PROJECT_ERR_PREFIX: &str = "active_project_removal: ";

/// Unregisters a project and cleans its Speedwave-managed dirs. Source tree on disk is not touched.
pub fn remove_project(name: &str) -> anyhow::Result<()> {
    config::with_config_lock(|| remove_project_with_data_dir(name, crate::consts::data_dir()))
}

fn remove_project_with_data_dir(name: &str, data_dir: &Path) -> anyhow::Result<()> {
    validation::validate_project_name(name)?;

    let config_path = data_dir.join("config.json");
    let mut user_config = config::load_user_config_from(&config_path)?;

    if user_config.active_project.as_deref() == Some(name) {
        anyhow::bail!(
            "{}Cannot remove the active project '{}'. Switch to a different project first.",
            REMOVE_ACTIVE_PROJECT_ERR_PREFIX,
            name
        );
    }

    let pos = user_config
        .projects
        .iter()
        .position(|p| p.name == name)
        .ok_or_else(|| anyhow::anyhow!("Project '{}' not found", name))?;

    user_config.projects.remove(pos);

    // Cleanup before save: a crash here leaves an entry without dirs (benign,
    // reconcile-tolerated), never credential dirs without an entry.
    cleanup_project_dirs_in(name, data_dir);
    config::save_user_config_to(&user_config, &config_path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::config::{save_user_config_to, SpeedwaveUserConfig};

    #[test]
    fn add_project_reconstructs_host_bridges() {
        // Structural guard (ADR-074): project-add must feed disk-reconstructed
        // host bridges into render_compose, not an empty list.
        let source = include_str!("project.rs");
        // Anchor on the inner fn that holds the calls, not the outer wrapper,
        // else the slice passes by file-order accident and misses a regression.
        let fn_start = source
            .find("fn add_project_with_validated_dir(")
            .expect("add_project_with_validated_dir must exist in project.rs");
        let fn_body = &source[fn_start..];
        let build_pos = fn_body.find("host_bridges_from_disk()");
        let render_pos = fn_body
            .find("render_compose(")
            .expect("render_compose call must exist in add_project_with_validated_dir");
        assert!(
            build_pos.is_some_and(|b| b < render_pos),
            "add_project_with_validated_dir must build host_bridges_from_disk() before render_compose"
        );
        let empty_default = format!("HostBridgesInfo::{}()", "default");
        assert!(
            !fn_body[..render_pos].contains(&empty_default),
            "add_project_with_validated_dir must not pass an empty HostBridgesInfo to render_compose"
        );
        // Also assert the call site actually receives &host_bridges as its
        // argument (guards a default passed *inside* the render_compose args).
        let call = &fn_body[render_pos..];
        let call_end = call
            .find(';')
            .expect("render_compose statement must end with ;");
        assert!(
            call[..call_end].contains("&host_bridges"),
            "render_compose must receive &host_bridges, not an inline default"
        );
    }

    #[test]
    fn rejects_invalid_project_name() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let project_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&project_dir).unwrap();
        let dir = std::fs::canonicalize(&project_dir)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let result = add_project_with_data_dir("", &dir, &data_dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
    }

    #[test]
    fn rejects_relative_path() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let result = add_project_with_data_dir("myproject", "relative/path", &data_dir);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("absolute"),
            "should mention 'absolute'"
        );
    }

    #[test]
    fn rejects_nonexistent_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let result = add_project_with_data_dir(
            "myproject",
            "/nonexistent/path/that/does/not/exist",
            &data_dir,
        );
        assert!(result.is_err());
    }

    /// A brand-new project has no LLM provider chosen yet — that must not
    /// block registration (the "no_provider" state is first-class); compose
    /// generation is deferred to `start_containers`.
    #[test]
    fn add_project_succeeds_without_llm_provider_and_defers_compose() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let project_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&project_dir).unwrap();
        let dir = std::fs::canonicalize(&project_dir)
            .unwrap()
            .to_string_lossy()
            .to_string();

        add_project_with_data_dir("myproject", &dir, &data_dir).unwrap();

        let cfg = config::load_user_config_from(&data_dir.join("config.json")).unwrap();
        assert!(cfg.find_project("myproject").is_some());
        assert_eq!(cfg.active_project.as_deref(), Some("myproject"));
        assert!(
            !data_dir
                .join("compose")
                .join("myproject")
                .join("compose.yml")
                .exists(),
            "compose.yml must not be written before a provider is chosen"
        );
        assert!(data_dir.join("compose").join("myproject").is_dir());
    }

    #[test]
    fn cleanup_project_dirs_is_safe_on_missing_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        // Should not panic or error even when dirs don't exist
        cleanup_project_dirs_in("nonexistent-test-project-xyz", &data_dir);
    }

    /// Newly-created project directories must already be `0o700` so
    /// `fs_security::ensure_data_dir_permissions` does not have to chmod
    /// them on every launch (it logs a `[WARN]` per fix-up).
    #[cfg(unix)]
    #[test]
    fn init_project_dirs_creates_with_mode_0o700() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        init_project_dirs_in("modecheck", &data_dir).unwrap();

        let mut dirs = vec![
            data_dir.join("compose").join("modecheck"),
            data_dir.join("context").join("modecheck"),
            data_dir
                .join(crate::consts::CLAUDE_HOME_SUBDIR)
                .join("modecheck"),
        ];
        // One token dir per credential-bearing service — same SSOT-derived set as
        // init_project_dirs_in. (At minimum: slack, sharepoint, redmine, gitlab, github, atlassian.)
        for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
            if !svc.credential_files.is_empty() {
                dirs.push(
                    data_dir
                        .join("tokens")
                        .join("modecheck")
                        .join(svc.config_key),
                );
            }
        }
        assert!(
            dirs.iter().any(|d| d.ends_with("modecheck/github")),
            "github token dir must be among the created dirs"
        );
        assert!(
            dirs.iter().any(|d| d.ends_with("modecheck/atlassian")),
            "atlassian token dir must be among the created dirs"
        );
        for dir in &dirs {
            let mode = std::fs::metadata(dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode,
                0o700,
                "{} created with {:#05o}, expected 0o700",
                dir.display(),
                mode
            );
        }
    }

    /// Pre-existing directories with looser permissions are left intact —
    /// `create_dir_all_secure` must not chmod existing trees.
    #[cfg(unix)]
    #[test]
    fn create_dir_all_secure_leaves_existing_dir_perms_alone() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("preexisting");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Re-running create_dir_all_secure on an existing dir is a no-op for permissions.
        create_dir_all_secure(&parent).unwrap();
        let mode = std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o755,
            "create_dir_all_secure must not chmod existing dirs"
        );
    }

    #[test]
    fn duplicate_name_detected() {
        let tmp = tempfile::tempdir().unwrap();

        // Register a project dir
        let project_dir = tmp.path().join("existing-dir");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical_dir = std::fs::canonicalize(&project_dir).unwrap();

        // Seed config with a project named "existing"
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let config = SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "existing".to_string(),
                dir: canonical_dir.to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
            }],
            active_project: Some("existing".to_string()),
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        save_user_config_to(&config, &data_dir.join("config.json")).unwrap();

        // Use a different dir for the duplicate-name attempt
        let other_dir = tmp.path().join("other-dir");
        std::fs::create_dir_all(&other_dir).unwrap();
        let canonical_other = std::fs::canonicalize(&other_dir).unwrap();

        let result =
            add_project_with_data_dir("existing", &canonical_other.to_string_lossy(), &data_dir);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("already exists"),
            "expected 'already exists' error, got: {err}"
        );
    }

    #[test]
    fn add_project_precleans_stale_dirs_from_same_name() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let project_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&project_dir).unwrap();
        let dir = std::fs::canonicalize(&project_dir)
            .unwrap()
            .to_string_lossy()
            .to_string();

        // Seed stale artifacts left by a pre-fix removal or crash for this name.
        let usage_file = data_dir
            .join("usage")
            .join("stale-project")
            .join("proxy")
            .join("usage.jsonl");
        std::fs::create_dir_all(usage_file.parent().unwrap()).unwrap();
        std::fs::write(&usage_file, b"{}").unwrap();
        let claude_home_file = data_dir
            .join(crate::consts::CLAUDE_HOME_SUBDIR)
            .join("stale-project")
            .join("x");
        std::fs::create_dir_all(claude_home_file.parent().unwrap()).unwrap();
        std::fs::write(&claude_home_file, b"stale").unwrap();

        add_project_with_data_dir("stale-project", &dir, &data_dir).unwrap();

        assert!(
            !usage_file.exists(),
            "stale usage artifact must be pre-cleaned before re-adding the same name"
        );
        assert!(
            !claude_home_file.exists(),
            "stale claude-home artifact must be pre-cleaned before re-adding the same name"
        );
    }

    #[test]
    fn duplicate_name_add_does_not_delete_existing_project_dirs() {
        let tmp = tempfile::tempdir().unwrap();

        let project_dir = tmp.path().join("existing-dir");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical_dir = std::fs::canonicalize(&project_dir).unwrap();

        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let config = SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "existing".to_string(),
                dir: canonical_dir.to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
            }],
            active_project: Some("existing".to_string()),
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        save_user_config_to(&config, &data_dir.join("config.json")).unwrap();

        // Seed artifacts belonging to the ALREADY-registered project "existing".
        let usage_file = data_dir
            .join("usage")
            .join("existing")
            .join("proxy")
            .join("usage.jsonl");
        std::fs::create_dir_all(usage_file.parent().unwrap()).unwrap();
        std::fs::write(&usage_file, b"{}").unwrap();
        let claude_home_file = data_dir
            .join(crate::consts::CLAUDE_HOME_SUBDIR)
            .join("existing")
            .join("x");
        std::fs::create_dir_all(claude_home_file.parent().unwrap()).unwrap();
        std::fs::write(&claude_home_file, b"keep-me").unwrap();

        let other_dir = tmp.path().join("other-dir");
        std::fs::create_dir_all(&other_dir).unwrap();
        let canonical_other = std::fs::canonicalize(&other_dir).unwrap();

        let result =
            add_project_with_data_dir("existing", &canonical_other.to_string_lossy(), &data_dir);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("already exists"),
            "expected 'already exists' error, got: {err}"
        );

        assert!(
            usage_file.exists(),
            "duplicate-name add must NOT delete the existing project's usage artifacts"
        );
        assert!(
            claude_home_file.exists(),
            "duplicate-name add must NOT delete the existing project's claude-home artifacts"
        );
    }

    #[test]
    fn duplicate_path_detected() {
        let tmp = tempfile::tempdir().unwrap();

        // Register a project dir
        let project_dir = tmp.path().join("shared-dir");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical_dir = std::fs::canonicalize(&project_dir).unwrap();

        // Seed config with a project at that path
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let config = SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "first".to_string(),
                dir: canonical_dir.to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        save_user_config_to(&config, &data_dir.join("config.json")).unwrap();

        let result =
            add_project_with_data_dir("second", &canonical_dir.to_string_lossy(), &data_dir);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("already registered"),
            "expected 'already registered' error, got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rollback_cleans_up_dirs_on_config_save_failure() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();

        // Create a project directory
        let project_dir = tmp.path().join("myproject-dir");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical_dir = std::fs::canonicalize(&project_dir).unwrap();

        // A read-only data_dir blocks save_user_config_to's atomic write, exercising the rollback path.
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        for sub in &["compose", "context", crate::consts::CLAUDE_HOME_SUBDIR] {
            std::fs::create_dir_all(data_dir.join(sub)).unwrap();
        }
        // Token dirs nest one level deeper (tokens/<project>/<svc>); pre-create
        // through the project level so only the service leaf is created inside.
        std::fs::create_dir_all(data_dir.join("tokens").join("rollback-test")).unwrap();

        let mut perms = std::fs::metadata(&data_dir).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&data_dir, perms).unwrap();

        let result =
            add_project_with_data_dir("rollback-test", &canonical_dir.to_string_lossy(), &data_dir);

        // Restore write perms so cleanup/asserts and tempdir drop can proceed.
        let mut restore = std::fs::metadata(&data_dir).unwrap().permissions();
        restore.set_mode(0o755);
        std::fs::set_permissions(&data_dir, restore).unwrap();

        assert!(
            result.is_err(),
            "should fail because config write is blocked"
        );

        // Verify rollback: per-project directories should have been cleaned up
        // (their writable parents survive — only the <project> leaf is removed).
        for sub in &[
            "tokens",
            "compose",
            "context",
            crate::consts::CLAUDE_HOME_SUBDIR,
        ] {
            let dir = data_dir.join(sub).join("rollback-test");
            assert!(
                !dir.exists(),
                "rollback should have removed '{}' but it still exists",
                dir.display()
            );
        }
    }

    #[test]
    fn with_config_lock_serializes_access() {
        use std::sync::{Arc, Barrier};

        let barrier = Arc::new(Barrier::new(2));
        let counter = Arc::new(std::sync::Mutex::new(0u32));

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let b = Arc::clone(&barrier);
                let c = Arc::clone(&counter);
                std::thread::spawn(move || {
                    b.wait();
                    config::with_config_lock(|| {
                        let mut val = c.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
                        *val += 1;
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }

        let final_val = *counter.lock().unwrap();
        assert_eq!(final_val, 2, "both threads should have incremented");
    }

    // ──────────────────────────────────────────────────────────────────────
    // WSL UNC path handling — Windows-only branch in add_project_with_data_dir.
    // `Path::is_absolute` returns false for `\\...` on Unix, so the early
    // `must be an absolute path` check would short-circuit before reaching
    // our UNC classification. On Windows, `\\wsl.localhost\...` IS absolute.
    // ──────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_wsl_unc_other_distro_with_helpful_message() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let result = add_project_with_data_dir(
            "myproject",
            r"\\wsl.localhost\Ubuntu\home\luke\foo",
            &data_dir,
        );
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Ubuntu"),
            "should mention other distro, got: {err}"
        );
        assert!(
            err.contains(crate::consts::wsl_distro_name()),
            "should mention runtime distro, got: {err}"
        );
        assert!(
            err.contains("Copy-Item"),
            "should suggest PowerShell Copy-Item, got: {err}"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_wsl_unc_bare_root_distro() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let result =
            add_project_with_data_dir("myproject", r"\\wsl.localhost\Speedwave\", &data_dir);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("WSL distribution root"),
            "should reject root with explicit message, got: {err}"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_wsl_unc_bare_root_no_trailing_slash() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let result =
            add_project_with_data_dir("myproject", r"\\wsl.localhost\Speedwave", &data_dir);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("WSL distribution root"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_wsl_unc_runtime_distro_nonexistent_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        // Runtime distro but the subdirectory does not exist — metadata()
        // returns Err, our branch bails with "does not exist".
        let result = add_project_with_data_dir(
            "myproject",
            r"\\wsl.localhost\Speedwave\projects\definitely-not-a-real-folder-xyz",
            &data_dir,
        );
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("does not exist"),
            "should report missing dir, got: {err}"
        );
    }

    /// On Unix, `Path::is_absolute()` is `false` for `\\wsl.localhost\...`, so
    /// the early `is_absolute` bail catches it before the UNC dispatch fires.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn add_project_unc_rejected_on_unix_via_absolute_check() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let result = add_project_with_data_dir(
            "unix-unc",
            r"\\wsl.localhost\Speedwave\projects\foo",
            &data_dir,
        );
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("absolute path"),
            "expected 'absolute path' bail on Unix for UNC input, got: {err}"
        );
        // The UNC dispatch must NOT have fired (no "WSL distribution" or
        // "Malformed WSL UNC" in the error — that would mean we reached
        // the UNC branch on a non-Windows host).
        assert!(
            !err.contains("WSL distribution"),
            "UNC dispatch must not fire on Unix, got: {err}"
        );
        assert!(
            !err.contains("Malformed WSL UNC"),
            "UNC dispatch must not fire on Unix, got: {err}"
        );
    }

    /// Verifies the UNC dispatch routes runtime-distro inputs to the WSL UNC
    /// branch, not canonicalize: a missing subdir bails with the raw UNC string.
    #[cfg(target_os = "windows")]
    #[test]
    fn add_project_dispatch_routes_unc_through_metadata_not_canonicalize() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let unc_input = r"\\wsl.localhost\Speedwave\projects\nonexistent-dispatch-test-xyz-abc-123";
        let result = add_project_with_data_dir("dispatch-test", unc_input, &data_dir);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("does not exist or is not a directory"),
            "expected UNC-branch 'does not exist' bail, got: {err}"
        );
        // The UNC branch echoes the raw `dir` argument verbatim in the bail
        // message (canonicalize branch would print a canonicalized form).
        assert!(
            err.contains(unc_input),
            "error should echo the raw UNC input (proving canonicalize was \
             skipped), got: {err}"
        );
    }

    /// Happy path for a UNC-style stored `dir`: feeds
    /// `add_project_with_validated_dir` a tempdir-backed canonical PathBuf plus
    /// a `\\wsl.localhost\...` canonical string and asserts Phase 1b+2 succeed.
    #[test]
    fn add_project_with_validated_dir_accepts_unc_style_canonical() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical = std::fs::canonicalize(&project_dir).unwrap();
        // Use a synthetic UNC-style string for the stored `dir` field — this
        // is what we'd persist on Windows for `\\wsl.localhost\Speedwave\projects\foo`.
        let unc_canonical_str = format!(
            r"\\wsl.localhost\{}\projects\foo",
            crate::consts::wsl_distro_name()
        );

        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let result = add_project_with_validated_dir(
            "luke-helm",
            canonical.clone(),
            unc_canonical_str.clone(),
            &data_dir,
        );
        // Avoid `{result:?}`: anyhow chains may carry upstream strings CodeQL flags as cleartext logging.
        if let Err(e) = &result {
            panic!("registration must succeed: {}", e);
        }

        // Verify config persisted with the UNC-style dir string.
        let cfg = config::load_user_config_from(&data_dir.join("config.json")).unwrap();
        let entry = cfg
            .find_project("luke-helm")
            .expect("project must be registered");
        assert_eq!(entry.dir, unc_canonical_str);
        assert_eq!(cfg.active_project.as_deref(), Some("luke-helm"));

        // No LLM provider was ever chosen for this fixture — compose.yml is
        // deferred to `start_containers` (a fresh project is a valid,
        // provider-less state; see `add_project_with_validated_dir`).
        let compose_path = data_dir
            .join("compose")
            .join("luke-helm")
            .join("compose.yml");
        assert!(
            !compose_path.exists(),
            "compose.yml must not be written before a provider is chosen, found {compose_path:?}"
        );

        // Verify project dirs initialized (compose dir + claude-home dir).
        assert!(data_dir.join("compose").join("luke-helm").is_dir());
        assert!(data_dir
            .join(crate::consts::CLAUDE_HOME_SUBDIR)
            .join("luke-helm")
            .is_dir());
    }

    // -- remove_project tests --

    #[test]
    fn remove_project_happy_path() {
        let tmp = tempfile::tempdir().unwrap();
        let dir_a = tmp.path().join("a");
        let dir_b = tmp.path().join("b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        let canon_a = std::fs::canonicalize(&dir_a).unwrap();
        let canon_b = std::fs::canonicalize(&dir_b).unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        add_project_with_validated_dir(
            "alpha",
            canon_a.clone(),
            canon_a.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();
        add_project_with_validated_dir(
            "beta",
            canon_b.clone(),
            canon_b.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();

        // Seed long-lived per-project dirs alongside the ones add_project created.
        for sub in &[
            "secrets",
            "snapshots",
            crate::consts::OAUTH_SUBDIR,
            crate::legacy_token_cleanup::LEGACY_HOST_EXEC_SUBDIR,
        ] {
            let d = data_dir.join(sub).join("alpha");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("secret"), b"x").unwrap();
        }

        remove_project_with_data_dir("alpha", &data_dir).unwrap();

        let cfg = config::load_user_config_from(&data_dir.join("config.json")).unwrap();
        assert!(cfg.find_project("alpha").is_none());
        assert_eq!(cfg.active_project.as_deref(), Some("beta"));
        for sub in &[
            "tokens",
            "compose",
            "context",
            crate::consts::CLAUDE_HOME_SUBDIR,
            "secrets",
            "snapshots",
            crate::consts::OAUTH_SUBDIR,
            crate::legacy_token_cleanup::LEGACY_HOST_EXEC_SUBDIR,
        ] {
            assert!(
                !data_dir.join(sub).join("alpha").exists(),
                "subdir '{sub}/alpha' must be cleaned up"
            );
        }
        assert!(dir_a.exists(), "user's source tree must NOT be deleted");
    }

    #[test]
    fn remove_project_removes_usage_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let pd = tmp.path().join("proj");
        std::fs::create_dir_all(&pd).unwrap();
        let canonical = std::fs::canonicalize(&pd).unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        add_project_with_validated_dir(
            "first",
            canonical.clone(),
            canonical.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();
        let other_dir = tmp.path().join("other");
        std::fs::create_dir_all(&other_dir).unwrap();
        let canon_other = std::fs::canonicalize(&other_dir).unwrap();
        add_project_with_validated_dir(
            "second",
            canon_other.clone(),
            canon_other.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();

        let usage_dir = data_dir.join("usage").join("first").join("proxy");
        std::fs::create_dir_all(&usage_dir).unwrap();
        std::fs::write(usage_dir.join("usage.jsonl"), b"{}").unwrap();
        std::fs::write(usage_dir.join("cost-cache.jsonl"), b"{}").unwrap();

        remove_project_with_data_dir("first", &data_dir).unwrap();

        assert!(
            !data_dir.join("usage").join("first").exists(),
            "usage/first must be removed on project removal"
        );
    }

    #[test]
    fn remove_project_removes_legacy_host_exec_dir_preserving_siblings() {
        // Cleanup must scope to <project> even for the legacy host-exec tree:
        // another project's leftovers stay behind for the startup sweep.
        let tmp = tempfile::tempdir().unwrap();
        let dir_a = tmp.path().join("a");
        let dir_b = tmp.path().join("b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        let canon_a = std::fs::canonicalize(&dir_a).unwrap();
        let canon_b = std::fs::canonicalize(&dir_b).unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        add_project_with_validated_dir(
            "alpha",
            canon_a.clone(),
            canon_a.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();
        add_project_with_validated_dir(
            "beta",
            canon_b.clone(),
            canon_b.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();

        let he_root = data_dir.join(crate::legacy_token_cleanup::LEGACY_HOST_EXEC_SUBDIR);
        for project in ["alpha", "beta"] {
            let d = he_root.join(project);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("auth-token"), b"tok").unwrap();
        }

        remove_project_with_data_dir("alpha", &data_dir).unwrap();

        assert!(!he_root.join("alpha").exists(), "alpha leftovers removed");
        assert!(
            he_root.join("beta").join("auth-token").exists(),
            "beta leftovers preserved"
        );
    }

    #[test]
    fn remove_project_rejects_active() {
        let tmp = tempfile::tempdir().unwrap();
        let pd = tmp.path().join("proj");
        std::fs::create_dir_all(&pd).unwrap();
        let canonical = std::fs::canonicalize(&pd).unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        add_project_with_validated_dir(
            "only",
            canonical.clone(),
            canonical.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();

        let result = remove_project_with_data_dir("only", &data_dir);
        let err = result.unwrap_err().to_string();
        assert!(err.starts_with(REMOVE_ACTIVE_PROJECT_ERR_PREFIX));
        let cfg = config::load_user_config_from(&data_dir.join("config.json")).unwrap();
        assert!(cfg.find_project("only").is_some());
        assert_eq!(cfg.active_project.as_deref(), Some("only"));
    }

    #[test]
    fn remove_project_rejects_invalid_name() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let result = remove_project_with_data_dir("../escape", &data_dir);
        assert!(result.is_err());
    }

    #[test]
    fn remove_project_missing_errors() {
        // Exercises the "populated config, name not in list" branch — distinct
        // from "missing config.json" which load_user_config_from treats as default.
        let tmp = tempfile::tempdir().unwrap();
        let pd = tmp.path().join("real");
        std::fs::create_dir_all(&pd).unwrap();
        let canonical = std::fs::canonicalize(&pd).unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        add_project_with_validated_dir(
            "real",
            canonical.clone(),
            canonical.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();

        let result = remove_project_with_data_dir("ghost", &data_dir);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("not found"),
            "expected 'not found', got: {err}"
        );
        // Sanity: the real project must remain untouched.
        let cfg = config::load_user_config_from(&data_dir.join("config.json")).unwrap();
        assert!(cfg.find_project("real").is_some());
    }

    #[test]
    fn remove_project_preserves_other_active_project() {
        let tmp = tempfile::tempdir().unwrap();
        let dir_a = tmp.path().join("a");
        let dir_b = tmp.path().join("b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        let canon_a = std::fs::canonicalize(&dir_a).unwrap();
        let canon_b = std::fs::canonicalize(&dir_b).unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        add_project_with_validated_dir(
            "first",
            canon_a.clone(),
            canon_a.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();
        add_project_with_validated_dir(
            "second",
            canon_b.clone(),
            canon_b.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();
        // After two adds, `second` is active.
        let cfg = config::load_user_config_from(&data_dir.join("config.json")).unwrap();
        assert_eq!(cfg.active_project.as_deref(), Some("second"));

        // Removing the non-active project must leave active_project intact.
        remove_project_with_data_dir("first", &data_dir).unwrap();
        let cfg = config::load_user_config_from(&data_dir.join("config.json")).unwrap();
        assert!(cfg.find_project("first").is_none());
        assert_eq!(cfg.active_project.as_deref(), Some("second"));
        assert!(data_dir.join("compose").join("second").exists());
    }

    #[test]
    fn remove_project_cleans_dirs_before_saving_config() {
        // Structural guard: a crash between the two ops must leave orphaned
        // config entries (harmless, reconcile-tolerated), never orphaned
        // credential-bearing dirs with no config entry (invisible, never cleaned).
        let source = include_str!("project.rs");
        let fn_start = source
            .find("fn remove_project_with_data_dir(")
            .expect("remove_project_with_data_dir must exist in project.rs");
        let fn_body = &source[fn_start..];
        let fn_end = fn_body
            .find("\n}\n")
            .expect("remove_project_with_data_dir must have a closing brace");
        let fn_body = &fn_body[..fn_end];

        let cleanup_pos = fn_body
            .find("cleanup_project_dirs_in(")
            .expect("cleanup_project_dirs_in call must exist in remove_project_with_data_dir");
        let save_pos = fn_body
            .find("save_user_config_to(")
            .expect("save_user_config_to call must exist in remove_project_with_data_dir");
        assert!(
            cleanup_pos < save_pos,
            "cleanup_project_dirs_in must run BEFORE save_user_config_to in remove_project_with_data_dir"
        );
    }

    #[cfg(unix)]
    #[test]
    fn remove_project_config_save_failure_still_cleans_dirs_and_keeps_entry() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let pd = tmp.path().join("proj");
        std::fs::create_dir_all(&pd).unwrap();
        let canonical = std::fs::canonicalize(&pd).unwrap();
        let other_dir = tmp.path().join("other");
        std::fs::create_dir_all(&other_dir).unwrap();
        let canon_other = std::fs::canonicalize(&other_dir).unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        // Active-project check requires a different active project so removal
        // of "victim" is not rejected outright.
        add_project_with_validated_dir(
            "victim",
            canonical.clone(),
            canonical.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();
        add_project_with_validated_dir(
            "keeper",
            canon_other.clone(),
            canon_other.to_string_lossy().to_string(),
            &data_dir,
        )
        .unwrap();

        let tokens_dir = data_dir.join("tokens").join("victim");
        std::fs::create_dir_all(&tokens_dir).unwrap();
        std::fs::write(tokens_dir.join("secret"), b"tok").unwrap();

        // Block save_user_config_to's atomic write by making the data_dir read-only.
        let mut perms = std::fs::metadata(&data_dir).unwrap().permissions();
        perms.set_mode(0o500);
        std::fs::set_permissions(&data_dir, perms).unwrap();

        let result = remove_project_with_data_dir("victim", &data_dir);

        // Restore write perms so asserts/reload/tempdir drop can proceed.
        let mut restore = std::fs::metadata(&data_dir).unwrap().permissions();
        restore.set_mode(0o700);
        std::fs::set_permissions(&data_dir, restore).unwrap();

        assert!(
            result.is_err(),
            "should fail because config write is blocked"
        );

        assert!(
            !tokens_dir.exists(),
            "cleanup must have run before the failed save (crash window converges to benign state)"
        );

        let cfg = config::load_user_config_from(&data_dir.join("config.json")).unwrap();
        assert!(
            cfg.find_project("victim").is_some(),
            "config entry must still be present since save never completed"
        );
    }

    #[test]
    fn duplicate_unc_path_detected_via_exact_string() {
        // Covers the exact-string fast path for UNC paths, which canonicalize cannot resolve.
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical = std::fs::canonicalize(&project_dir).unwrap();
        let unc_str = format!(
            r"\\wsl.localhost\{}\projects\foo",
            crate::consts::wsl_distro_name()
        );

        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        // First registration must succeed.
        if let Err(e) =
            add_project_with_validated_dir("first", canonical.clone(), unc_str.clone(), &data_dir)
        {
            panic!("first registration must succeed: {e}");
        }

        // Second registration with the same UNC string must hit the fast path.
        let result = add_project_with_validated_dir("second", canonical, unc_str, &data_dir);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("already registered"),
            "expected 'already registered' error, got: {err}"
        );
    }
}

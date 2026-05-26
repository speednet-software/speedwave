use crate::{compose, config, runtime, validation};
use std::path::Path;

/// Best-effort cleanup of project directories created by `init_project_dirs_in`.
/// Used for rollback when a later step of `add_project` fails.
pub fn cleanup_project_dirs(project: &str) {
    cleanup_project_dirs_in(project, crate::consts::data_dir());
}

/// Best-effort cleanup of project directories under a given data directory.
fn cleanup_project_dirs_in(project: &str, data_dir: &Path) {
    for sub in &[
        "tokens",
        "compose",
        "context",
        crate::consts::CLAUDE_HOME_SUBDIR,
    ] {
        let dir = data_dir.join(sub).join(project);
        if dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                log::warn!(
                    "cleanup_project_dirs: failed to remove '{}': {e}",
                    dir.display()
                );
            }
        }
    }
}

/// Creates project directories under a given data directory.
///
/// Directories are created directly with restrictive `0o700` permissions on
/// Unix so that `fs_security::ensure_data_dir_permissions` does not have to
/// chmod them on every app launch (the post-fix runs as a `[WARN]` and is
/// purely a recovery path for tampered or pre-existing trees).
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
    // One token dir per credential-bearing service — derived from the SSOT so adding a
    // service is a single edit in consts.rs (services with no `credential_files`, e.g.
    // playwright, get no token dir).
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

/// `create_dir_all` that applies mode `0o700` to every directory level it
/// creates on Unix. `DirBuilder::recursive(true)` skips already-existing
/// directories (their permissions are left intact and reconciled by
/// `fs_security::ensure_data_dir_permissions`). On Windows, ACLs are
/// inherited from the parent — Windows ignores Unix mode bits.
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

/// Registers a new project with transactional semantics: validate everything
/// first, then commit all side-effects.  If a late write fails, previously
/// created directories are cleaned up.
///
/// The entire operation is wrapped in an inter-process file lock so that
/// concurrent CLI and Desktop invocations cannot corrupt `config.json`.
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
            // Defense-in-depth: reject root via the dedicated helper so any
            // future change to `is_wsl_unc_path` trailing-slash normalization
            // does not silently re-open this hole.
            let translated = format!("/{}", info.rest);
            if runtime::wsl::is_root_path(Path::new(&translated)) {
                anyhow::bail!(
                    "Cannot use the WSL distribution root '{}' as a project directory. \
                     Choose a subdirectory like \\\\wsl.localhost\\{}\\projects\\<name>.",
                    dir,
                    crate::consts::WSL_DISTRO_NAME
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
            let canonical_str = canonical.to_string_lossy().to_string();
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

    // Build new entry
    let entry = config::ProjectUserEntry {
        name: name.to_string(),
        dir: canonical_str.clone(),
        claude: None,
        integrations: None,
        plugin_settings: None,
    };

    user_config.projects.push(entry);
    user_config.active_project = Some(name.to_string());

    // Resolve config and render compose (still no I/O)
    let (resolved, integrations) = config::resolve_project_config(&canonical, &user_config, name);
    let rt = runtime::detect_runtime();
    let rt_ref: Option<&runtime::LockedRuntime> = if rt.is_available() { Some(&rt) } else { None };
    let yaml = compose::render_compose(
        name,
        &canonical_str,
        &resolved,
        &integrations,
        rt_ref,
        &compose::HostBridgesInfo::default(),
    )?;

    // ── Phase 2: commit (all writes) ─────────────────────────────────────

    init_project_dirs_in(name, data_dir)?;

    if let Err(e) = config::save_user_config_to(&user_config, &config_path) {
        cleanup_project_dirs_in(name, data_dir);
        return Err(e);
    }

    if let Err(e) = save_compose_in(name, &yaml, data_dir) {
        cleanup_project_dirs_in(name, data_dir);
        return Err(e);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::config::{save_user_config_to, SpeedwaveUserConfig};

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
    /// `fs_security::ensure_data_dir_permissions` is the SSOT for fixing
    /// those, and `create_dir_all_secure` must not silently widen its scope
    /// to chmod existing trees (that would race with the security check).
    #[cfg(unix)]
    #[test]
    fn create_dir_all_secure_leaves_existing_dir_perms_alone() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("preexisting");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Re-running create_dir_all_secure on an existing dir is a no-op
        // for permissions (DirBuilder::recursive matches Rust's
        // create_dir_all semantics).
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
            }],
            active_project: Some("existing".to_string()),
            selected_ide: None,
            transcription: None,
            ui: None,
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
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
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

    #[test]
    fn rollback_cleans_up_dirs_on_config_save_failure() {
        let tmp = tempfile::tempdir().unwrap();

        // Create a project directory
        let project_dir = tmp.path().join("myproject-dir");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical_dir = std::fs::canonicalize(&project_dir).unwrap();

        // Create data_dir without a config.json (load returns default).
        // Pre-create config.json.tmp as a directory so that
        // save_user_config_to fails on std::fs::write (EISDIR) after
        // init_project_dirs_in has already created the project dirs.
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::create_dir_all(data_dir.join("config.json.tmp")).unwrap();

        let result =
            add_project_with_data_dir("rollback-test", &canonical_dir.to_string_lossy(), &data_dir);
        assert!(
            result.is_err(),
            "should fail because config write is blocked"
        );

        // Verify rollback: project directories should have been cleaned up
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
            err.contains("Speedwave"),
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

    /// Cross-platform sanity check: on Unix, `Path::is_absolute()` returns
    /// `false` for `\\wsl.localhost\...` (backslash is not a separator),
    /// so the early `is_absolute` bail catches it BEFORE the UNC dispatch
    /// can fire. This documents that the UNC branch is genuinely
    /// Windows-specific — the Windows-only test below covers the dispatch
    /// itself, and this test ensures non-Windows hosts surface a clean
    /// error (not a confusing UNC bail) for the same input.
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

    /// Verifies the UNC dispatch in `add_project_with_data_dir` actually
    /// routes to the WSL UNC branch (not canonicalize) for runtime-distro
    /// inputs. We can't test full success without a live Speedwave WSL
    /// distro (that's E2E territory), but we CAN assert the dispatch
    /// reaches the metadata existence check by feeding a runtime-distro
    /// UNC path that points to a non-existent subdir: the bail message
    /// ("does not exist or is not a directory") with the raw UNC string
    /// (NOT a canonicalized form) proves the UNC branch handled it.
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

    /// End-to-end happy path for the WSL UNC branch — registers a project whose
    /// canonical path is a `\\wsl.localhost\Speedwave\projects\...` UNC string.
    /// Cross-platform: simulates the post-validation state by feeding
    /// `add_project_with_validated_dir` directly with a tempdir backing the
    /// canonical PathBuf and a UNC-style canonical string. Verifies that
    /// Phase 1b+2 (duplicate checks, compose render, config save, dir init)
    /// work correctly for UNC-style stored paths — the same state Łukasz's
    /// project would land in after a successful Windows UNC registration.
    #[test]
    fn add_project_with_validated_dir_accepts_unc_style_canonical() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical = std::fs::canonicalize(&project_dir).unwrap();
        // Use a synthetic UNC-style string for the stored `dir` field — this
        // is what we'd persist on Windows for `\\wsl.localhost\Speedwave\projects\foo`.
        let unc_canonical_str = r"\\wsl.localhost\Speedwave\projects\foo".to_string();

        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let result = add_project_with_validated_dir(
            "luke-helm",
            canonical.clone(),
            unc_canonical_str.clone(),
            &data_dir,
        );
        // Avoid `{result:?}` in the assert message: anyhow::Error chains may
        // include strings from upstream errors (apply_oauth_config /
        // init_secrets_dir trace through the same anyhow::Error type),
        // which CodeQL flags as cleartext logging of sensitive information
        // even when those code paths are not reached in this test.
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

        // Verify compose file written.
        let compose_path = data_dir
            .join("compose")
            .join("luke-helm")
            .join("compose.yml");
        assert!(
            compose_path.exists(),
            "compose.yml must be written at {compose_path:?}"
        );

        // Verify project dirs initialized (compose dir + claude-home dir).
        assert!(data_dir.join("compose").join("luke-helm").is_dir());
        assert!(data_dir
            .join(crate::consts::CLAUDE_HOME_SUBDIR)
            .join("luke-helm")
            .is_dir());
    }

    #[test]
    fn duplicate_unc_path_detected_via_exact_string() {
        // Covers the exact-string fast path added for UNC paths (project.rs:177).
        // canonicalize cannot resolve UNC strings on non-Windows hosts, so
        // the fast path is the only mechanism that catches this duplicate.
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical = std::fs::canonicalize(&project_dir).unwrap();
        let unc_str = r"\\wsl.localhost\Speedwave\projects\foo".to_string();

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

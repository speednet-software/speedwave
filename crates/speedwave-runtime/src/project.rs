use crate::{compose, config, runtime, validation};
use std::path::Path;

/// Best-effort cleanup of project directories created by `init_project_dirs_in`.
/// Used for rollback when a later step of `add_project` fails.
pub fn cleanup_project_dirs(project: &str) {
    cleanup_project_dirs_in(project, crate::consts::data_dir());
}

/// Best-effort cleanup of project directories under a given data directory.
fn cleanup_project_dirs_in(project: &str, data_dir: &Path) {
    for sub in &["tokens", "compose", "context", "claude-home"] {
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
fn init_project_dirs_in(project: &str, data_dir: &Path) -> anyhow::Result<()> {
    validation::validate_project_name(project)?;
    let dirs_to_create = [
        data_dir.join("tokens").join(project).join("slack"),
        data_dir.join("tokens").join(project).join("sharepoint"),
        data_dir.join("tokens").join(project).join("redmine"),
        data_dir.join("tokens").join(project).join("gitlab"),
        data_dir.join("compose").join(project),
        data_dir.join("context").join(project),
        data_dir.join("claude-home").join(project),
    ];
    for dir in &dirs_to_create {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
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
    // ── Phase 1: validate and build in-memory (zero side-effects) ────────

    validation::validate_project_name(name)?;

    let dir_path = Path::new(dir);
    if !dir_path.is_absolute() {
        anyhow::bail!("Project directory must be an absolute path: {}", dir);
    }

    let canonical = std::fs::canonicalize(dir_path)?;
    if !canonical.is_dir() {
        anyhow::bail!(
            "Project directory does not exist or is not a directory: {}",
            canonical.display()
        );
    }

    let canonical_str = canonical.to_string_lossy().to_string();

    let config_path = data_dir.join("config.json");
    let mut user_config = config::load_user_config_from(&config_path)?;

    // Duplicate name check
    if user_config.find_project(name).is_some() {
        anyhow::bail!("Project '{}' already exists", name);
    }

    // Duplicate path check (canonicalize stored paths for backward compat)
    if let Some(existing) = user_config.projects.iter().find(|p| {
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
    let rt_ref: Option<&dyn crate::runtime::ContainerRuntime> =
        if rt.is_available() { Some(&*rt) } else { None };
    let yaml = compose::render_compose(name, &canonical_str, &resolved, &integrations, rt_ref)?;

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
            log_level: None,
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
            log_level: None,
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
        for sub in &["tokens", "compose", "context", "claude-home"] {
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
}

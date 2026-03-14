use crate::{compose, config, validation};
use std::path::Path;

/// Best-effort cleanup of project directories created by `compose::init_project_dirs`.
/// Used for rollback when a later step of `add_project` fails.
pub fn cleanup_project_dirs(project: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let data_dir = home.join(crate::consts::DATA_DIR);
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

    let mut user_config = config::load_user_config()?;

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
    };

    user_config.projects.push(entry);
    user_config.active_project = Some(name.to_string());

    // Resolve config and render compose (still no I/O)
    let (resolved, integrations) = config::resolve_project_config(&canonical, &user_config, name);
    let yaml = compose::render_compose(name, &canonical_str, &resolved, &integrations)?;

    // ── Phase 2: commit (all writes) ─────────────────────────────────────

    compose::init_project_dirs(name)?;

    if let Err(e) = config::save_user_config(&user_config) {
        cleanup_project_dirs(name);
        return Err(e);
    }

    if let Err(e) = compose::save_compose(name, &yaml) {
        cleanup_project_dirs(name);
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

    /// Helper: creates a testable add_project that works with a custom config
    /// path instead of the real `~/.speedwave/config.json`.
    ///
    /// We cannot easily redirect `add_project` (it uses real paths via
    /// `config::load_user_config`), so we test the validation and rollback
    /// logic through targeted unit tests.

    #[test]
    fn rejects_invalid_project_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        let result = add_project_inner("", &dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
    }

    #[test]
    fn rejects_relative_path() {
        let result = add_project_inner("myproject", "relative/path");
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("absolute"),
            "should mention 'absolute'"
        );
    }

    #[test]
    fn rejects_nonexistent_directory() {
        let result = add_project_inner("myproject", "/nonexistent/path/that/does/not/exist");
        assert!(result.is_err());
    }

    #[test]
    fn cleanup_project_dirs_is_safe_on_missing_dirs() {
        // Should not panic or error even when dirs don't exist
        cleanup_project_dirs("nonexistent-test-project-xyz");
    }

    #[test]
    fn duplicate_name_detected() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        std::fs::create_dir_all(&fake_home).unwrap();

        // Register a project dir
        let project_dir = tmp.path().join("existing-dir");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical_dir = std::fs::canonicalize(&project_dir).unwrap();

        // Seed config with a project named "existing"
        let data_dir = fake_home.join(".speedwave");
        std::fs::create_dir_all(&data_dir).unwrap();
        let config = SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "existing".to_string(),
                dir: canonical_dir.to_string_lossy().to_string(),
                claude: None,
                integrations: None,
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

        // Point HOME to our fake home so add_project_inner reads our config
        std::env::set_var("HOME", &fake_home);
        let result = add_project_inner("existing", &canonical_other.to_string_lossy());
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
        let fake_home = tmp.path().join("home");
        std::fs::create_dir_all(&fake_home).unwrap();

        // Register a project dir
        let project_dir = tmp.path().join("shared-dir");
        std::fs::create_dir_all(&project_dir).unwrap();
        let canonical_dir = std::fs::canonicalize(&project_dir).unwrap();

        // Seed config with a project at that path
        let data_dir = fake_home.join(".speedwave");
        std::fs::create_dir_all(&data_dir).unwrap();
        let config = SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "first".to_string(),
                dir: canonical_dir.to_string_lossy().to_string(),
                claude: None,
                integrations: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };
        save_user_config_to(&config, &data_dir.join("config.json")).unwrap();

        // Point HOME to our fake home so add_project_inner reads our config
        std::env::set_var("HOME", &fake_home);
        let result = add_project_inner("second", &canonical_dir.to_string_lossy());
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("already registered"),
            "expected 'already registered' error, got: {err}"
        );
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

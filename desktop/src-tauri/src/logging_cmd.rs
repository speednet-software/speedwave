// Log level commands and log cleanup utilities.

use speedwave_runtime::config;

pub(crate) fn parse_log_level(s: &str) -> Option<log::LevelFilter> {
    match s.to_lowercase().as_str() {
        "error" => Some(log::LevelFilter::Error),
        "warn" => Some(log::LevelFilter::Warn),
        "info" => Some(log::LevelFilter::Info),
        "debug" => Some(log::LevelFilter::Debug),
        "trace" => Some(log::LevelFilter::Trace),
        _ => None,
    }
}

#[tauri::command]
pub(crate) fn set_log_level(level: String) -> Result<(), String> {
    let filter = parse_log_level(&level).ok_or_else(|| format!("Invalid log level: {level}"))?;
    log::info!("Log level changed to {level}");
    log::set_max_level(filter);
    if let Err(e) = persist_log_level(&level) {
        log::warn!("Failed to persist log level: {e}");
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_log_level() -> String {
    log::max_level().to_string()
}

fn persist_log_level(level: &str) -> anyhow::Result<()> {
    config::with_config_lock(|| {
        let mut config = config::load_user_config()?;
        config.log_level = Some(level.to_lowercase());
        config::save_user_config(&config)
    })
}

/// Removes old rotated log files, keeping at most `max_files` recent ones.
pub(crate) fn cleanup_old_logs(max_files: usize) {
    let log_dir = match dirs::home_dir() {
        Some(h) => {
            if cfg!(target_os = "macos") {
                h.join("Library/Logs/pl.speedwave.desktop")
            } else {
                h.join(".local/share/pl.speedwave.desktop/logs")
            }
        }
        None => return,
    };

    cleanup_log_dir(&log_dir, max_files);
}

/// Core logic for log cleanup — operates on an arbitrary directory.
///
/// Keeps the `max_files` most-recently-modified `.log` files in `log_dir` and
/// deletes the rest.  Non-`.log` files are never touched.
pub(crate) fn cleanup_log_dir(log_dir: &std::path::Path, max_files: usize) {
    let entries = match std::fs::read_dir(log_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut log_files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "log")
                .unwrap_or(false)
        })
        .filter_map(|e| {
            e.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| (e.path(), t))
        })
        .collect();

    if log_files.len() <= max_files {
        return;
    }

    // Sort by modification time, newest first
    log_files.sort_by(|a, b| b.1.cmp(&a.1));

    // Remove the oldest files beyond the limit
    for (path, _) in log_files.iter().skip(max_files) {
        if let Err(e) = std::fs::remove_file(path) {
            log::warn!("failed to remove old log file {}: {e}", path.display());
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- set_log_level / get_log_level tests --
    //
    // These functions mutate global state (`log::set_max_level`), so we
    // serialize all log-level tests through a single mutex.

    static LOG_LEVEL_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn set_log_level_accepts_error() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("error".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_accepts_warn() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("warn".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_accepts_info() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("info".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_accepts_debug() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("debug".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_accepts_trace() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("trace".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_case_insensitive_uppercase() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("ERROR".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_case_insensitive_mixed() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("Info".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_case_insensitive_debug_upper() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("DEBUG".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_rejects_invalid() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        let err = set_log_level("verbose".to_string()).unwrap_err();
        assert!(
            err.contains("verbose"),
            "error should contain the invalid value"
        );
    }

    #[test]
    fn set_log_level_rejects_empty_string() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level(String::new()).is_err());
    }

    #[test]
    fn get_log_level_returns_non_empty() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        let level = get_log_level();
        assert!(!level.is_empty(), "log level string should not be empty");
    }

    #[test]
    fn set_then_get_log_level_round_trip() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        set_log_level("debug".to_string()).unwrap();
        let level = get_log_level();
        assert_eq!(level, "DEBUG");
    }

    #[test]
    fn set_log_level_off_returns_error() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(
            set_log_level("off".to_string()).is_err(),
            "\"off\" is not a valid log level and should be rejected"
        );
    }

    #[test]
    fn set_log_level_whitespace_padded_returns_error() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(
            set_log_level("  debug  ".to_string()).is_err(),
            "whitespace-padded input should be rejected (no trimming)"
        );
    }

    #[test]
    fn set_log_level_multi_step_round_trip() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        set_log_level("trace".to_string()).unwrap();
        set_log_level("error".to_string()).unwrap();
        let level = get_log_level();
        assert_eq!(level, "ERROR");
    }

    // -- cleanup_log_dir tests --

    /// Helper: create a `.log` file inside `dir` with the given name.
    fn create_log_file(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::File::create(&p).unwrap();
        p
    }

    /// Helper: create a `.log` file and set its modification time to a specific
    /// epoch-based timestamp.  Uses `File::set_modified` (stable since Rust 1.75)
    /// instead of `thread::sleep` for deterministic ordering in tests.
    fn create_log_file_with_mtime(
        dir: &std::path::Path,
        name: &str,
        epoch_secs: u64,
    ) -> std::path::PathBuf {
        let p = dir.join(name);
        let f = std::fs::File::create(&p).unwrap();
        let mtime = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(epoch_secs);
        f.set_modified(mtime).unwrap();
        p
    }

    #[test]
    fn cleanup_log_dir_fewer_than_limit_deletes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        create_log_file(tmp.path(), "a.log");
        create_log_file(tmp.path(), "b.log");

        cleanup_log_dir(tmp.path(), 5);

        let count = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(count, 2, "no files should be deleted when under the limit");
    }

    #[test]
    fn cleanup_log_dir_exactly_at_limit_deletes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..3 {
            create_log_file_with_mtime(tmp.path(), &format!("file{i}.log"), 1_000_000 + i * 100);
        }

        cleanup_log_dir(tmp.path(), 3);

        let count = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(count, 3, "no files should be deleted at exactly the limit");
    }

    #[test]
    fn cleanup_log_dir_over_limit_deletes_oldest() {
        let tmp = tempfile::tempdir().unwrap();
        // Create 6 files with deterministic, well-separated mtimes.
        // file0 is oldest (epoch 1 000 000), file5 is newest (epoch 1 000 500).
        let mut created = Vec::new();
        for i in 0u64..6 {
            let p = create_log_file_with_mtime(
                tmp.path(),
                &format!("file{i}.log"),
                1_000_000 + i * 100,
            );
            created.push(p);
        }

        cleanup_log_dir(tmp.path(), 3);

        // The 3 newest files (file3, file4, file5) must survive.
        for p in &created[3..] {
            assert!(p.exists(), "newest file {} should survive", p.display());
        }
        // The 3 oldest files (file0, file1, file2) must be deleted.
        for p in &created[..3] {
            assert!(!p.exists(), "oldest file {} should be deleted", p.display());
        }

        let remaining_count = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .count();
        assert_eq!(
            remaining_count, 3,
            "should keep exactly 3 files, got {remaining_count}"
        );
    }

    #[test]
    fn cleanup_log_dir_ignores_non_log_files() {
        let tmp = tempfile::tempdir().unwrap();
        // 4 .log files (over the limit of 2) plus 3 .txt files
        for i in 0u64..4 {
            create_log_file_with_mtime(tmp.path(), &format!("file{i}.log"), 1_000_000 + i * 100);
        }
        for i in 0..3 {
            let p = tmp.path().join(format!("notes{i}.txt"));
            std::fs::File::create(&p).unwrap();
        }

        cleanup_log_dir(tmp.path(), 2);

        let log_count = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "log").unwrap_or(false))
            .count();
        let txt_count = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "txt").unwrap_or(false))
            .count();

        assert_eq!(log_count, 2, "should keep exactly 2 .log files");
        assert_eq!(txt_count, 3, "all .txt files should remain untouched");
    }

    #[test]
    fn cleanup_log_dir_nonexistent_directory_does_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does_not_exist");
        // Should return silently — no panic, no error.
        cleanup_log_dir(&missing, 5);
    }

    #[test]
    fn cleanup_log_dir_max_zero_deletes_all_log_files() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..4 {
            create_log_file(tmp.path(), &format!("file{i}.log"));
        }
        // Also add a non-log file that must survive
        let txt = tmp.path().join("keep.txt");
        std::fs::File::create(&txt).unwrap();

        cleanup_log_dir(tmp.path(), 0);

        let log_count = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "log").unwrap_or(false))
            .count();
        assert_eq!(log_count, 0, "max_files=0 should delete all .log files");
        assert!(txt.exists(), ".txt file should not be deleted");
    }

    #[test]
    fn cleanup_log_dir_mixed_extensions_only_counts_log() {
        let tmp = tempfile::tempdir().unwrap();
        // 2 .log files + 5 .txt files — limit is 3, so nothing should be deleted
        // because only .log files are counted and 2 < 3.
        create_log_file(tmp.path(), "a.log");
        create_log_file(tmp.path(), "b.log");
        for i in 0..5 {
            let p = tmp.path().join(format!("data{i}.txt"));
            std::fs::File::create(&p).unwrap();
        }

        cleanup_log_dir(tmp.path(), 3);

        let total = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(
            total, 7,
            "nothing should be deleted — only 2 .log files exist, under limit of 3"
        );
    }

    #[test]
    fn cleanup_log_dir_empty_directory() {
        let tmp = tempfile::tempdir().unwrap();
        // 0 .log files, max_files=5 — should not panic.
        cleanup_log_dir(tmp.path(), 5);

        let count = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(count, 0, "empty directory should stay empty");
    }

    #[test]
    fn cleanup_log_dir_ignores_subdirectories() {
        let tmp = tempfile::tempdir().unwrap();
        // Create 2 .log files directly in the directory.
        create_log_file_with_mtime(tmp.path(), "old.log", 1_000_000);
        create_log_file_with_mtime(tmp.path(), "new.log", 2_000_000);

        // Create a subdirectory containing a .log file — cleanup must ignore it.
        let subdir = tmp.path().join("nested");
        std::fs::create_dir(&subdir).unwrap();
        create_log_file(&subdir, "inner.log");

        cleanup_log_dir(tmp.path(), 1);

        // Only "new.log" (newest) should survive at the top level.
        assert!(
            tmp.path().join("new.log").exists(),
            "newest top-level .log should survive"
        );
        assert!(
            !tmp.path().join("old.log").exists(),
            "oldest top-level .log should be deleted"
        );
        // The subdirectory and its .log file must be untouched.
        assert!(subdir.exists(), "subdirectory should not be deleted");
        assert!(
            subdir.join("inner.log").exists(),
            ".log file inside subdirectory should not be deleted"
        );
    }
}

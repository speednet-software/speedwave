//! The one entry point for migrations of the data directory. The CLI and Desktop call [`run_all`]
//! first on every start, before anything reads the config or a secret.

mod legacy_files;

use std::path::Path;

use speedwave_runtime::fs_perms::with_file_lock_in;

const LOCK_FILE: &str = "migrations.lock";

const MIGRATIONS: &[Migration] = &[legacy_files::MIGRATION];

struct Migration {
    name: &'static str,
    run: fn(&Path) -> Result<(), String>,
}

/// Names, never values, of the migrations one [`run_all`] call ran.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Migrations that finished without an error, in the order they ran.
    pub executed: Vec<&'static str>,
    /// Migrations that reported an error; the migrations after them still ran.
    pub failed: Vec<&'static str>,
}

impl std::fmt::Display for MigrationReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "executed {:?}, failed {:?}", self.executed, self.failed)
    }
}

/// The whole run could not start.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum MigrationError {
    /// The exclusive lock `<data_dir>/migrations.lock` could not be taken.
    #[error("cannot take the migrations lock: {0}")]
    Lock(String),
}

/// Runs every migration under an exclusive lock on `<data_dir>/migrations.lock`. A caller that
/// finds the lock taken waits for it and then runs every migration again; each migration
/// recognises finished work by the state of the files.
pub fn run_all(data_dir: &Path) -> Result<MigrationReport, MigrationError> {
    if !data_dir.is_dir() {
        return Ok(MigrationReport::default());
    }
    with_file_lock_in(&data_dir.join(LOCK_FILE), || {
        Ok(run_steps(data_dir, MIGRATIONS))
    })
    .map_err(|e| MigrationError::Lock(format!("{e:#}")))
}

fn run_steps(data_dir: &Path, steps: &[Migration]) -> MigrationReport {
    let mut report = MigrationReport::default();
    for step in steps {
        match (step.run)(data_dir) {
            Ok(()) => report.executed.push(step.name),
            Err(reason) => {
                log::warn!("migration {} failed: {reason}", step.name);
                report.failed.push(step.name);
            }
        }
    }
    report
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn succeeds(_: &Path) -> Result<(), String> {
        Ok(())
    }

    fn fails(_: &Path) -> Result<(), String> {
        Err("2 paths could not be removed".to_string())
    }

    #[test]
    fn run_all_removes_a_legacy_file_and_reports_the_step_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("mcp-os-port");
        std::fs::write(&legacy, "SECRET-VALUE").unwrap();

        let report = run_all(tmp.path()).unwrap();

        assert_eq!(report.executed, vec!["legacy_files"]);
        assert!(report.failed.is_empty());
        assert!(!legacy.exists());
        assert!(!format!("{report:?}").contains("SECRET-VALUE"));
    }

    #[test]
    fn the_report_displays_step_names_only() {
        let report = MigrationReport {
            executed: vec!["first"],
            failed: vec!["second", "third"],
        };

        assert_eq!(
            report.to_string(),
            r#"executed ["first"], failed ["second", "third"]"#
        );
    }

    #[test]
    fn run_all_takes_its_lock_at_the_root_of_the_data_dir() {
        let tmp = tempfile::tempdir().unwrap();

        run_all(tmp.path()).unwrap();

        assert!(tmp.path().join("migrations.lock").is_file());
    }

    #[test]
    fn run_all_runs_again_after_a_finished_run() {
        let tmp = tempfile::tempdir().unwrap();
        run_all(tmp.path()).unwrap();
        std::fs::write(tmp.path().join("mcp-os-pid"), "1").unwrap();

        let report = run_all(tmp.path()).unwrap();

        assert_eq!(report.executed, vec!["legacy_files"]);
        assert!(!tmp.path().join("mcp-os-pid").exists());
    }

    #[test]
    fn run_all_leaves_files_outside_the_list_alone() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.json"), "{}").unwrap();

        run_all(tmp.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.path().join("config.json")).unwrap(),
            "{}"
        );
    }

    #[test]
    fn run_all_does_nothing_when_the_data_dir_does_not_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("absent");

        let report = run_all(&missing).unwrap();

        assert_eq!(report, MigrationReport::default());
        assert!(!missing.exists());
    }

    #[test]
    fn run_all_fails_when_the_lock_cannot_be_taken() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("migrations.lock")).unwrap();
        let legacy = tmp.path().join("mcp-os-port");
        std::fs::write(&legacy, "1").unwrap();

        let err = run_all(tmp.path()).unwrap_err();

        assert!(matches!(err, MigrationError::Lock(_)));
        assert!(err
            .to_string()
            .starts_with("cannot take the migrations lock"));
        assert!(legacy.exists(), "no migration may run without the lock");
    }

    #[test]
    fn a_failed_step_is_reported_and_the_steps_after_it_still_run() {
        let tmp = tempfile::tempdir().unwrap();
        let steps = [
            Migration {
                name: "first",
                run: succeeds,
            },
            Migration {
                name: "second",
                run: fails,
            },
            Migration {
                name: "third",
                run: succeeds,
            },
        ];

        let report = run_steps(tmp.path(), &steps);

        assert_eq!(report.executed, vec!["first", "third"]);
        assert_eq!(report.failed, vec!["second"]);
    }

    #[test]
    fn a_second_caller_waits_for_the_lock_and_then_runs_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let legacy = data_dir.join("mcp-os-port");
        std::fs::write(&legacy, "1").unwrap();
        let released = Arc::new(AtomicBool::new(false));
        let (locked_tx, locked_rx) = mpsc::channel();
        let holder = {
            let lock_path = data_dir.join(LOCK_FILE);
            let released = Arc::clone(&released);
            std::thread::spawn(move || {
                with_file_lock_in(&lock_path, || {
                    locked_tx.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(300));
                    released.store(true, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap();
            })
        };
        locked_rx.recv().unwrap();

        let report = run_all(&data_dir).unwrap();

        assert!(
            released.load(Ordering::SeqCst),
            "run_all returned while another holder still owned the lock"
        );
        assert_eq!(report.executed, vec!["legacy_files"]);
        assert!(!legacy.exists());
        holder.join().unwrap();
    }

    #[test]
    fn concurrent_callers_all_finish_without_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        for project in ["alpha", "beta", "gamma"] {
            let dir = data_dir.join("tokens").join(project).join("sharepoint");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("refresh_token"), "old").unwrap();
        }
        let barrier = Arc::new(std::sync::Barrier::new(4));

        let handles: Vec<_> = (0..4)
            .map(|_| {
                let data_dir = data_dir.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    run_all(&data_dir)
                })
            })
            .collect();

        for handle in handles {
            let report = handle.join().unwrap().unwrap();
            assert_eq!(report.executed, vec!["legacy_files"]);
            assert!(report.failed.is_empty());
        }
        for project in ["alpha", "beta", "gamma"] {
            let token = data_dir.join("tokens").join(project).join("sharepoint");
            assert!(!token.join("refresh_token").exists());
        }
    }
}

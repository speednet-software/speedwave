//! The project's paste directory, `<project>/<DATA_DIR>/pastes/`, written by Desktop chat and the
//! CLI clipboard watcher and read by the claude container (ADR-065, ADR-094).

use crate::consts::DATA_DIR;
use crate::pinned_dir::PinnedDir;
use std::io::Write;
use std::path::Path;

/// Name of the paste directory under the project's `DATA_DIR`.
pub const PASTES_DIR: &str = "pastes";

const GITIGNORE: &str = ".gitignore";

const GITIGNORE_CONTENT: &[u8] = b"*\n";

/// Opens the paste directory beneath `project_dir` without following a link the container may
/// have planted, and gives it a `.gitignore` that keeps pasted files out of the user's repository.
pub fn open_pastes_dir(project_dir: &Path) -> Result<PinnedDir, String> {
    let dir = PinnedDir::open_beneath(project_dir, &[DATA_DIR, PASTES_DIR])?;
    if std::fs::symlink_metadata(dir.path().join(GITIGNORE)).is_err() {
        let written = dir.create_new_file(GITIGNORE).and_then(|mut file| {
            file.write_all(GITIGNORE_CONTENT)
                .map_err(|e| format!("failed to write {GITIGNORE}: {e}"))
        });
        if let Err(e) = written {
            log::warn!(
                "pasted files in {} are not kept out of git: {e}",
                dir.path().display()
            );
        }
    }
    Ok(dir)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;

    #[test]
    fn opening_creates_the_directory_with_a_gitignore_that_ignores_everything() {
        let tmp = tempfile::tempdir().unwrap();

        let dir = open_pastes_dir(tmp.path()).unwrap();

        assert_eq!(dir.path(), tmp.path().join(DATA_DIR).join(PASTES_DIR));
        assert_eq!(
            std::fs::read(dir.path().join(GITIGNORE)).unwrap(),
            GITIGNORE_CONTENT
        );
    }

    #[test]
    fn an_existing_gitignore_is_left_as_it_is() {
        let tmp = tempfile::tempdir().unwrap();
        let pastes = tmp.path().join(DATA_DIR).join(PASTES_DIR);
        std::fs::create_dir_all(&pastes).unwrap();
        std::fs::write(pastes.join(GITIGNORE), "!keep.png\n").unwrap();

        open_pastes_dir(tmp.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(pastes.join(GITIGNORE)).unwrap(),
            "!keep.png\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_paste_directory_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(project.join(DATA_DIR)).unwrap();
        std::os::unix::fs::symlink(&outside, project.join(DATA_DIR).join(PASTES_DIR)).unwrap();

        assert!(open_pastes_dir(&project).is_err());

        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }
}

//! A directory opened beneath a trusted root without following a symlink or junction, and held
//! so the container cannot swap it for a link while the host writes in it (ADR-094 decision 9).

use std::fs::File;
use std::path::{Path, PathBuf};

/// Directory opened by [`PinnedDir::open_beneath`], held for as long as the value lives.
pub struct PinnedDir {
    path: PathBuf,
    #[cfg(unix)]
    fd: rustix::fd::OwnedFd,
    #[cfg(windows)]
    _components: Vec<File>,
}

impl PinnedDir {
    /// Opens `root` joined with `components`, creating a missing component, and refuses a
    /// component that is a symlink, a junction or not a directory. `root` itself is trusted.
    pub fn open_beneath(root: &Path, components: &[&str]) -> Result<Self, String> {
        for component in components {
            check_name(component)?;
        }
        imp::open_beneath(root, components)
    }

    /// Path of the directory.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Creates `name` as a new owner-only file; fails when anything, a symlink included, already
    /// exists at `name`.
    pub fn create_new_file(&self, name: &str) -> Result<File, String> {
        check_name(name)?;
        imp::create_new_file(self, name)
    }

    /// Removes the file `name`; a name that does not exist is not an error.
    pub fn remove_file(&self, name: &str) -> Result<(), String> {
        check_name(name)?;
        imp::remove_file(self, name)
    }

    /// Makes `file`, written as `from`, durable under the name `to`, replacing an existing `to`.
    pub fn persist(&self, file: File, from: &str, to: &str) -> Result<(), String> {
        check_name(from)?;
        check_name(to)?;
        crate::fs_perms::fsync_file_durable(&file)
            .map_err(|e| format!("failed to sync {}: {e}", self.path.join(from).display()))?;
        drop(file);
        imp::rename(self, from, to)?;
        imp::sync(self);
        Ok(())
    }
}

fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("not a single path component: '{name}'"));
    }
    Ok(())
}

#[cfg(unix)]
mod imp {
    use super::PinnedDir;
    use rustix::fs::{AtFlags, Mode, OFlags, CWD};
    use rustix::io::Errno;
    use std::fs::File;
    use std::path::Path;

    pub(super) fn open_beneath(root: &Path, components: &[&str]) -> Result<PinnedDir, String> {
        let mut fd = rustix::fs::openat(
            CWD,
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| {
            format!(
                "cannot open {}: {}",
                root.display(),
                std::io::Error::from(e)
            )
        })?;
        let mut path = root.to_path_buf();
        for &component in components {
            path.push(component);
            match rustix::fs::mkdirat(&fd, component, Mode::RWXU | Mode::RWXG | Mode::RWXO) {
                Ok(()) | Err(Errno::EXIST) => {}
                Err(e) => {
                    return Err(format!(
                        "cannot create {}: {}",
                        path.display(),
                        std::io::Error::from(e)
                    ))
                }
            }
            fd = rustix::fs::openat(
                &fd,
                component,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|e| match e {
                Errno::LOOP | Errno::NOTDIR => format!(
                    "refusing {}: not a plain directory (a symlink or another file type)",
                    path.display()
                ),
                e => format!(
                    "cannot open {}: {}",
                    path.display(),
                    std::io::Error::from(e)
                ),
            })?;
        }
        Ok(PinnedDir { path, fd })
    }

    pub(super) fn create_new_file(dir: &PinnedDir, name: &str) -> Result<File, String> {
        let owner_rw = Mode::RUSR | Mode::WUSR;
        let fd = rustix::fs::openat(
            &dir.fd,
            name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            owner_rw,
        )
        .map_err(|e| {
            format!(
                "failed to create {}: {}",
                dir.path.join(name).display(),
                std::io::Error::from(e)
            )
        })?;
        if let Err(e) = rustix::fs::fchmod(&fd, owner_rw) {
            drop(fd);
            let _ = rustix::fs::unlinkat(&dir.fd, name, AtFlags::empty());
            return Err(format!(
                "failed to restrict {}: {}",
                dir.path.join(name).display(),
                std::io::Error::from(e)
            ));
        }
        Ok(File::from(fd))
    }

    pub(super) fn remove_file(dir: &PinnedDir, name: &str) -> Result<(), String> {
        match rustix::fs::unlinkat(&dir.fd, name, AtFlags::empty()) {
            Ok(()) | Err(Errno::NOENT) => Ok(()),
            Err(e) => Err(format!(
                "failed to remove {}: {}",
                dir.path.join(name).display(),
                std::io::Error::from(e)
            )),
        }
    }

    pub(super) fn rename(dir: &PinnedDir, from: &str, to: &str) -> Result<(), String> {
        rustix::fs::renameat(&dir.fd, from, &dir.fd, to).map_err(|e| {
            format!(
                "failed to rename {} to {}: {}",
                dir.path.join(from).display(),
                dir.path.join(to).display(),
                std::io::Error::from(e)
            )
        })
    }

    pub(super) fn sync(dir: &PinnedDir) {
        let _ = rustix::fs::fsync(&dir.fd);
    }
}

#[cfg(windows)]
mod imp {
    use super::PinnedDir;
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    pub(super) fn open_beneath(root: &Path, components: &[&str]) -> Result<PinnedDir, String> {
        let mut path = root.to_path_buf();
        let mut chain = Vec::with_capacity(components.len());
        for &component in components {
            path.push(component);
            match std::fs::create_dir(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
            }
            chain.push(open_plain_dir(&path)?);
        }
        Ok(PinnedDir {
            path,
            _components: chain,
        })
    }

    fn open_plain_dir(path: &Path) -> Result<File, String> {
        let dir = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        let file_type = dir
            .metadata()
            .map_err(|e| format!("cannot stat {}: {e}", path.display()))?
            .file_type();
        if file_type.is_symlink() || !file_type.is_dir() {
            return Err(format!(
                "refusing {}: not a plain directory (a symlink, a junction or another file type)",
                path.display()
            ));
        }
        Ok(dir)
    }

    pub(super) fn create_new_file(dir: &PinnedDir, name: &str) -> Result<File, String> {
        let path = dir.path.join(name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .map_err(|e| format!("failed to create {}: {e}", path.display()))?;
        if let Err(e) = crate::fs_perms::set_owner_only(&path) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(format!("failed to restrict {}: {e}", path.display()));
        }
        Ok(file)
    }

    pub(super) fn remove_file(dir: &PinnedDir, name: &str) -> Result<(), String> {
        let path = dir.path.join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("failed to remove {}: {e}", path.display())),
        }
    }

    pub(super) fn rename(dir: &PinnedDir, from: &str, to: &str) -> Result<(), String> {
        let (from, to) = (dir.path.join(from), dir.path.join(to));
        std::fs::rename(&from, &to).map_err(|e| {
            format!(
                "failed to rename {} to {}: {e}",
                from.display(),
                to.display()
            )
        })
    }

    pub(super) fn sync(_dir: &PinnedDir) {}
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn open_beneath_creates_missing_components_and_reports_their_path() {
        let tmp = tempfile::tempdir().unwrap();

        let dir = PinnedDir::open_beneath(tmp.path(), &[".speedwave", "pastes"]).unwrap();

        assert_eq!(dir.path(), tmp.path().join(".speedwave").join("pastes"));
        assert!(dir.path().is_dir());
    }

    #[test]
    fn open_beneath_reuses_existing_directories() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a").join("b")).unwrap();
        std::fs::write(tmp.path().join("a").join("b").join("kept.txt"), "x").unwrap();

        let dir = PinnedDir::open_beneath(tmp.path(), &["a", "b"]).unwrap();

        assert_eq!(std::fs::read(dir.path().join("kept.txt")).unwrap(), b"x");
    }

    #[test]
    fn open_beneath_refuses_a_component_that_is_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a"), "not a dir").unwrap();

        let err = PinnedDir::open_beneath(tmp.path(), &["a", "b"])
            .err()
            .expect("a file component must be refused");

        assert!(err.contains("refusing"), "{err}");
        assert!(!tmp.path().join("a").is_dir());
    }

    #[test]
    fn names_with_a_separator_or_a_dot_component_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["", ".", "..", "a/b", "a\\b", "../x"] {
            assert!(
                PinnedDir::open_beneath(tmp.path(), &[bad]).is_err(),
                "component '{bad}' must be refused"
            );
        }
        let dir = PinnedDir::open_beneath(tmp.path(), &["ok"]).unwrap();
        for bad in ["", ".", "..", "x/y", "x\\y"] {
            assert!(
                dir.create_new_file(bad).is_err(),
                "name '{bad}' must be refused"
            );
            assert!(
                dir.remove_file(bad).is_err(),
                "name '{bad}' must be refused"
            );
        }
    }

    #[test]
    fn create_new_file_writes_an_owner_only_file_and_refuses_an_existing_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = PinnedDir::open_beneath(tmp.path(), &["pastes"]).unwrap();

        let mut file = dir.create_new_file("a.txt").unwrap();
        file.write_all(b"hello").unwrap();
        drop(file);

        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(), b"hello");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("a.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
        }
        assert!(dir.create_new_file("a.txt").is_err());
        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(), b"hello");
    }

    #[test]
    fn persist_moves_the_file_to_its_final_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = PinnedDir::open_beneath(tmp.path(), &["pastes"]).unwrap();
        let mut file = dir.create_new_file("x.part").unwrap();
        file.write_all(b"payload").unwrap();

        dir.persist(file, "x.part", "x.bin").unwrap();

        assert!(!dir.path().join("x.part").exists());
        assert_eq!(std::fs::read(dir.path().join("x.bin")).unwrap(), b"payload");
    }

    #[test]
    fn persist_reports_a_failed_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = PinnedDir::open_beneath(tmp.path(), &["pastes"]).unwrap();
        let file = dir.create_new_file("x.part").unwrap();
        std::fs::create_dir(dir.path().join("x.bin")).unwrap();
        std::fs::write(dir.path().join("x.bin").join("inside"), "x").unwrap();

        let err = dir.persist(file, "x.part", "x.bin").unwrap_err();

        assert!(err.contains("failed to rename"), "{err}");
        assert!(dir.path().join("x.part").is_file());
    }

    #[test]
    fn remove_file_removes_and_ignores_a_missing_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = PinnedDir::open_beneath(tmp.path(), &["pastes"]).unwrap();
        drop(dir.create_new_file("gone.txt").unwrap());

        dir.remove_file("gone.txt").unwrap();
        dir.remove_file("gone.txt").unwrap();

        assert!(!dir.path().join("gone.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn open_beneath_refuses_a_symlinked_component() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir_all(root.join(".speedwave")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".speedwave").join("pastes")).unwrap();

        let err = PinnedDir::open_beneath(&root, &[".speedwave", "pastes"])
            .err()
            .expect("a symlinked component must be refused");

        assert!(err.contains("refusing"), "{err}");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn create_new_file_refuses_a_symlink_planted_at_the_name() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target.txt");
        std::fs::write(&target, "untouched").unwrap();
        let dir = PinnedDir::open_beneath(tmp.path(), &["pastes"]).unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("planted.txt")).unwrap();

        assert!(dir.create_new_file("planted.txt").is_err());

        assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_swapped_for_a_symlink_after_opening_is_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let dir = PinnedDir::open_beneath(&root, &["pastes"]).unwrap();
        std::fs::rename(root.join("pastes"), root.join("moved")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("pastes")).unwrap();

        let mut file = dir.create_new_file("x.part").unwrap();
        file.write_all(b"payload").unwrap();
        dir.persist(file, "x.part", "x.bin").unwrap();
        dir.remove_file("x.bin").unwrap();
        drop(dir.create_new_file("kept.bin").unwrap());

        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        assert!(root.join("moved").join("kept.bin").is_file());
    }

    #[cfg(windows)]
    fn plant_junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .status()
            .expect("cmd /C mklink /J must spawn");
        assert!(status.success(), "junction creation must succeed");
        assert!(std::fs::symlink_metadata(link)
            .expect("junction must exist")
            .file_type()
            .is_symlink());
    }

    #[cfg(windows)]
    #[test]
    fn open_beneath_refuses_a_junctioned_component() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir_all(root.join(".speedwave")).unwrap();
        plant_junction(&root.join(".speedwave").join("pastes"), &outside);

        let err = PinnedDir::open_beneath(&root, &[".speedwave", "pastes"])
            .err()
            .expect("a junctioned component must be refused");

        assert!(err.contains("refusing"), "{err}");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn a_pinned_directory_cannot_be_renamed_or_removed_while_open() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let dir = PinnedDir::open_beneath(&root, &[".speedwave", "pastes"]).unwrap();

        assert!(std::fs::rename(root.join(".speedwave"), root.join("moved")).is_err());
        assert!(std::fs::rename(dir.path(), root.join(".speedwave").join("moved")).is_err());
        drop(dir.create_new_file("x.bin").unwrap());

        drop(dir);
        std::fs::rename(root.join(".speedwave"), root.join("moved")).unwrap();
        assert!(root.join("moved").join("pastes").join("x.bin").is_file());
    }
}

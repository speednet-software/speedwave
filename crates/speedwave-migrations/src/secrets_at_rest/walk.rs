use std::path::{Path, PathBuf};

use speedwave_runtime::fs_perms::read_regular_file_no_follow;
use speedwave_runtime::secret_store::SecretName;
use speedwave_runtime::validation::validate_project_name;

use super::Run;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Dir,
    File,
}

pub(super) struct Entry {
    pub(super) name: String,
    pub(super) path: PathBuf,
}

pub(super) enum Plain {
    Absent,
    Blank,
    Value(String),
    NotRegular,
    Unreadable,
}

pub(super) fn read_plain(path: &Path) -> Plain {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Plain::NotRegular,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Plain::Absent,
        Err(_) => return Plain::Unreadable,
    }
    match read_regular_file_no_follow(path) {
        Ok(Some(text)) if text.trim().is_empty() => Plain::Blank,
        Ok(Some(text)) => Plain::Value(text),
        Ok(None) => Plain::Absent,
        Err(_) => Plain::Unreadable,
    }
}

impl Run<'_> {
    pub(super) fn entries(&mut self, dir: &Path, kind: Kind) -> Vec<Entry> {
        let read = match std::fs::read_dir(dir) {
            Ok(read) => read,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(_) => {
                self.unlisted += 1;
                return Vec::new();
            }
        };
        let mut found = Vec::new();
        for entry in read {
            let Ok(entry) = entry else {
                self.unlisted += 1;
                continue;
            };
            let matches_kind = entry.file_type().is_ok_and(|file_type| match kind {
                Kind::Dir => file_type.is_dir(),
                Kind::File => file_type.is_file(),
            });
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if matches_kind {
                found.push(Entry {
                    name: name.to_owned(),
                    path: entry.path(),
                });
            }
        }
        found.sort_by(|a, b| a.name.cmp(&b.name));
        found
    }

    pub(super) fn project_dirs(&mut self, base: &str) -> Vec<Entry> {
        let dir = self.data_dir.join(base);
        self.entries(&dir, Kind::Dir)
            .into_iter()
            .filter(|entry| validate_project_name(&entry.name).is_ok())
            .collect()
    }

    pub(super) fn move_file(
        &mut self,
        path: &Path,
        name: Option<SecretName>,
        project: &str,
        service: &str,
    ) {
        match read_plain(path) {
            Plain::Absent => {}
            Plain::NotRegular => self.skipped += 1,
            Plain::Unreadable => self.fail_integration(project, service),
            Plain::Blank => self.remove_plain(path, project, service),
            Plain::Value(value) => {
                let Some(name) = name else {
                    self.skipped += 1;
                    return;
                };
                if self.store_secret(&name, &value) {
                    self.migrated += 1;
                    self.remove_plain(path, project, service);
                } else {
                    self.fail_integration(project, service);
                }
            }
        }
    }

    fn remove_plain(&mut self, path: &Path, project: &str, service: &str) {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => self.fail_integration(project, service),
        }
    }
}

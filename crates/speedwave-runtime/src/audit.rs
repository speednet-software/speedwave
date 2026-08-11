//! PII audit-directory path helper: `<data_dir>/audit/<project>/`, mounted `:rw`
//! into `proxy` and `mcp-hub` (mirrors `pii_policy`'s layout; writers land in F3/F4).

use std::path::{Path, PathBuf};

/// `<data_dir>/audit/<project>/`. Caller validates `project` as a safe component.
pub fn audit_dir_in(data_dir: &Path, project: &str) -> PathBuf {
    data_dir.join("audit").join(project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_dir_in_is_scoped_under_data_dir_and_project() {
        let data_dir = Path::new("/fake/.speedwave");
        let dir = audit_dir_in(data_dir, "proj");
        assert_eq!(dir, Path::new("/fake/.speedwave/audit/proj"));
    }

    #[test]
    fn audit_dir_in_differs_per_project() {
        let data_dir = Path::new("/fake/.speedwave");
        assert_ne!(
            audit_dir_in(data_dir, "proj-a"),
            audit_dir_in(data_dir, "proj-b")
        );
    }
}

//! On-disk layout of per-project Custom MCP state: `<data_dir>/custom-mcp/<project>/<name>/`
//! with `guard/`, `egress/`, `build/`, `image/` and `previews/<id>/`, every level owner-only.

use super::model;
use crate::consts;
use std::path::{Path, PathBuf};

/// Per-server subdirectory, each mounted or used on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerSubdir {
    /// Guard policy (`/policy:ro` in the guard).
    Guard,
    /// Egress allowlist (`/config:ro` in the egress proxy).
    Egress,
    /// Resolver output of the approved npm review, the input of every image build.
    Build,
    /// Server image build context, staged per build and removed afterwards.
    Image,
    /// One `<id>/` per pending npm review (`/out` in the one-shot resolver), moved to `build/`
    /// when that review is approved.
    Previews,
}

impl ServerSubdir {
    fn dir_name(self) -> &'static str {
        match self {
            Self::Guard => "guard",
            Self::Egress => "egress",
            Self::Build => "build",
            Self::Image => "image",
            Self::Previews => "previews",
        }
    }
}

/// `<data_dir>/custom-mcp`.
pub fn state_root_in(data_dir: &Path) -> PathBuf {
    data_dir.join(consts::CUSTOM_MCP_STATE_DIR)
}

/// `<data_dir>/custom-mcp/<project>`; validates the project name.
pub fn project_dir_in(data_dir: &Path, project: &str) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    Ok(state_root_in(data_dir).join(project))
}

/// `<data_dir>/custom-mcp/<project>/<name>`; validates both names.
pub fn server_dir_in(data_dir: &Path, project: &str, name: &str) -> anyhow::Result<PathBuf> {
    model::validate_server_name(name)?;
    Ok(project_dir_in(data_dir, project)?.join(name))
}

/// Directory name of server `name`'s relay state: `relay-<name>`.
pub fn relay_dir_name(name: &str) -> String {
    format!("{}{name}", consts::CUSTOM_RELAY_SERVER_DIR_PREFIX)
}

/// The server a `relay-<name>` directory name belongs to, when it is one with a valid name.
pub fn server_of_relay_dir(dir_name: &str) -> Option<&str> {
    dir_name
        .strip_prefix(consts::CUSTOM_RELAY_SERVER_DIR_PREFIX)
        .filter(|name| model::validate_server_name(name).is_ok())
}

/// `<data_dir>/custom-mcp/<project>/relay-<name>`: the relay endpoint and bearer of one host
/// server; validates both names.
pub fn relay_dir_in(data_dir: &Path, project: &str, name: &str) -> anyhow::Result<PathBuf> {
    model::validate_server_name(name)?;
    Ok(project_dir_in(data_dir, project)?.join(relay_dir_name(name)))
}

/// `<data_dir>/custom-mcp/<project>/relay`: the Desktop relay's lock files, written by the
/// Desktop and read by the CLI; validates the project name.
pub fn relay_lock_dir_in(data_dir: &Path, project: &str) -> anyhow::Result<PathBuf> {
    Ok(project_dir_in(data_dir, project)?.join(consts::CUSTOM_RELAY_LOCK_DIR))
}

/// `<data_dir>/custom-mcp/<project>/<name>/<sub>`; validates both names.
pub fn subdir_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    sub: ServerSubdir,
) -> anyhow::Result<PathBuf> {
    Ok(server_dir_in(data_dir, project, name)?.join(sub.dir_name()))
}

const MAX_PREVIEW_ID_CHARS: usize = 64;

fn validate_preview_id(id: &str) -> anyhow::Result<()> {
    let valid = !id.is_empty()
        && id.len() <= MAX_PREVIEW_ID_CHARS
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-');
    if !valid {
        anyhow::bail!("invalid custom MCP review id {id:?}");
    }
    Ok(())
}

/// `<data_dir>/custom-mcp/<project>/<name>/previews/<id>`: the resolver staging of one pending
/// npm review; validates both names and the id (lowercase hex and `-`, at most 64 characters).
pub fn preview_dir_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    preview_id: &str,
) -> anyhow::Result<PathBuf> {
    validate_preview_id(preview_id)?;
    Ok(subdir_in(data_dir, project, name, ServerSubdir::Previews)?.join(preview_id))
}

fn ensure_private_dir(path: &Path) -> anyhow::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            anyhow::bail!("refusing to use {}: it is a symlink", path.display())
        }
        Ok(meta) if !meta.is_dir() => {
            anyhow::bail!("refusing to use {}: it is not a directory", path.display())
        }
        _ => crate::fs_perms::ensure_owner_only_dir(path),
    }
}

/// Creates every level from `<data_dir>/custom-mcp` down to `<sub>` owner-only (0o700 / owner
/// DACL), refusing a symlink or non-directory at any level, and returns the subdirectory.
pub fn ensure_subdir_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    sub: ServerSubdir,
) -> anyhow::Result<PathBuf> {
    let root = state_root_in(data_dir);
    let project_dir = project_dir_in(data_dir, project)?;
    let server_dir = server_dir_in(data_dir, project, name)?;
    let target = subdir_in(data_dir, project, name, sub)?;
    for dir in [&root, &project_dir, &server_dir, &target] {
        ensure_private_dir(dir)?;
    }
    Ok(target)
}

/// Creates [`preview_dir_in`] and every level above it owner-only, refusing a symlink or
/// non-directory at any level.
pub fn ensure_preview_dir_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    preview_id: &str,
) -> anyhow::Result<PathBuf> {
    let target = preview_dir_in(data_dir, project, name, preview_id)?;
    ensure_subdir_in(data_dir, project, name, ServerSubdir::Previews)?;
    ensure_private_dir(&target)?;
    Ok(target)
}

/// Creates `<data_dir>/custom-mcp/<project>/relay-<name>` and its parents owner-only, refusing a
/// symlink or non-directory at any level, so a host guard never mounts a missing source.
pub fn ensure_relay_dir_in(data_dir: &Path, project: &str, name: &str) -> anyhow::Result<PathBuf> {
    let target = relay_dir_in(data_dir, project, name)?;
    for dir in [
        &state_root_in(data_dir),
        &project_dir_in(data_dir, project)?,
        &target,
    ] {
        ensure_private_dir(dir)?;
    }
    Ok(target)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    #[test]
    fn layout_nests_under_the_state_dir() {
        let d = Path::new("/data");
        assert_eq!(state_root_in(d), d.join("custom-mcp"));
        assert_eq!(
            subdir_in(d, "acme", "figma", ServerSubdir::Guard).unwrap(),
            d.join("custom-mcp")
                .join("acme")
                .join("figma")
                .join("guard")
        );
        assert!(subdir_in(d, "acme", "figma", ServerSubdir::Egress)
            .unwrap()
            .ends_with("egress"));
        assert!(subdir_in(d, "acme", "figma", ServerSubdir::Build)
            .unwrap()
            .ends_with("build"));
        assert!(subdir_in(d, "acme", "figma", ServerSubdir::Image)
            .unwrap()
            .ends_with("image"));
        assert_eq!(
            preview_dir_in(d, "acme", "figma", "0f3c-9a").unwrap(),
            d.join("custom-mcp")
                .join("acme")
                .join("figma")
                .join("previews")
                .join("0f3c-9a")
        );
    }

    #[test]
    fn preview_ids_are_refused_unless_lowercase_hex_and_hyphens() {
        let d = Path::new("/data");
        let id = "123e4567-e89b-12d3-a456-426614174000";
        assert!(preview_dir_in(d, "acme", "figma", id).is_ok());
        assert!(preview_dir_in(d, "acme", "figma", &"a".repeat(64)).is_ok());
        for bad in [
            "",
            "..",
            "../x",
            "a/b",
            "A1",
            "g1",
            "a\\b",
            "żółw",
            &"a".repeat(65),
        ] {
            assert!(preview_dir_in(d, "acme", "figma", bad).is_err(), "{bad:?}");
        }
        assert!(preview_dir_in(d, "acme", "../x", id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_preview_dir_creates_every_level_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = ensure_preview_dir_in(tmp.path(), "acme", "figma", "ab-12").unwrap();
        for level in [
            tmp.path().join("custom-mcp/acme/figma/previews"),
            dir.clone(),
        ] {
            let mode = std::fs::metadata(&level).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", level.display());
        }
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            elsewhere.path(),
            tmp.path().join("custom-mcp/acme/figma/previews/cd-34"),
        )
        .unwrap();
        assert!(ensure_preview_dir_in(tmp.path(), "acme", "figma", "cd-34").is_err());
    }

    #[test]
    fn relay_dirs_sit_next_to_the_server_dirs() {
        let d = Path::new("/data");
        assert_eq!(
            relay_dir_in(d, "acme", "desk").unwrap(),
            d.join("custom-mcp").join("acme").join("relay-desk")
        );
        assert!(relay_dir_in(d, "acme", "../x").is_err());
        assert!(relay_dir_in(d, "../x", "desk").is_err());
        assert_eq!(server_of_relay_dir("relay-desk"), Some("desk"));
        assert_eq!(server_of_relay_dir(&relay_dir_name("figma")), Some("figma"));
        for not_a_relay in ["desk", "relay-", "relay-Desk", "relay-relay-x", "relay"] {
            assert_eq!(server_of_relay_dir(not_a_relay), None, "{not_a_relay}");
        }
    }

    #[test]
    fn the_relay_lock_dir_sits_in_the_project_state_dir() {
        let d = Path::new("/data");
        assert_eq!(
            relay_lock_dir_in(d, "acme").unwrap(),
            d.join("custom-mcp").join("acme").join("relay")
        );
        assert!(relay_lock_dir_in(d, "../x").is_err());
        assert!(relay_lock_dir_in(d, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_relay_dir_creates_it_owner_only_and_refuses_a_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = ensure_relay_dir_in(tmp.path(), "acme", "desk").unwrap();
        assert_eq!(dir, tmp.path().join("custom-mcp/acme/relay-desk"));
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        assert!(ensure_relay_dir_in(tmp.path(), "acme", "desk").is_ok());
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            elsewhere.path(),
            tmp.path().join("custom-mcp/acme/relay-pen"),
        )
        .unwrap();
        assert!(ensure_relay_dir_in(tmp.path(), "acme", "pen").is_err());
        assert!(ensure_relay_dir_in(tmp.path(), "acme", "../x").is_err());
    }

    #[test]
    fn traversal_names_are_rejected() {
        let d = Path::new("/data");
        assert!(server_dir_in(d, "../etc", "figma").is_err());
        assert!(server_dir_in(d, "acme", "../x").is_err());
        assert!(server_dir_in(d, "acme", "Figma").is_err());
        assert!(project_dir_in(d, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_creates_every_level_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = ensure_subdir_in(tmp.path(), "acme", "figma", ServerSubdir::Guard).unwrap();
        for level in [
            tmp.path().join("custom-mcp"),
            tmp.path().join("custom-mcp/acme"),
            tmp.path().join("custom-mcp/acme/figma"),
            dir.clone(),
        ] {
            let mode = std::fs::metadata(&level).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", level.display());
        }
        assert!(ensure_subdir_in(tmp.path(), "acme", "figma", ServerSubdir::Guard).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_refuses_a_symlinked_level() {
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("custom-mcp/acme")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), tmp.path().join("custom-mcp/acme/figma"))
            .unwrap();
        let err = ensure_subdir_in(tmp.path(), "acme", "figma", ServerSubdir::Guard)
            .unwrap_err()
            .to_string();
        assert!(err.contains("symlink"), "{err}");
        assert!(!elsewhere.path().join("guard").exists());
    }

    #[test]
    fn ensure_refuses_a_file_in_place_of_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("custom-mcp")).unwrap();
        std::fs::write(tmp.path().join("custom-mcp/acme"), "x").unwrap();
        assert!(ensure_subdir_in(tmp.path(), "acme", "figma", ServerSubdir::Build).is_err());
    }
}

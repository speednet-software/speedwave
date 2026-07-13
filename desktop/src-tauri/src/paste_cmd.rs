//! Save a pasted image to `<project>/.speedwave/pastes/` so Claude reads
//! it by path (see ADR-065).

use serde::Serialize;
use speedwave_runtime::config;
use speedwave_runtime::consts::DATA_DIR;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// `<project>/<DATA_DIR>/pastes` — composed from SSOT so a rename of the
/// data-dir literal stays in sync without a separate alignment entry.
pub(crate) static PASTES_SUBDIR: LazyLock<String> = LazyLock::new(|| format!("{DATA_DIR}/pastes"));

/// Defence-in-depth host-side cap. Renderer enforces a stricter 3 MB cap post-resample
/// (`MAX_IMAGE_BYTES`); this catches a malicious renderer or future caller bypassing it.
const MAX_PASTE_BYTES: usize = 10 * 1024 * 1024;

fn extension_for(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// Verifies `bytes` starts with the magic for the declared `media_type`.
/// Cheap defence against arbitrary blobs sneaking in under a known MIME.
fn validate_magic(media_type: &str, bytes: &[u8]) -> Result<(), String> {
    let ok = match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "bytes do not match declared media type: {media_type}"
        ))
    }
}

#[derive(Serialize, Debug)]
pub struct SavedPaste {
    /// `/workspace/...` — what the in-container claude sees.
    pub container_path: String,
    pub host_path: String,
    pub filename: String,
}

/// Breaks timestamp ties on multi-file drops.
static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[tauri::command]
pub async fn save_pasted_image(
    project: String,
    media_type: String,
    bytes: Vec<u8>,
) -> Result<SavedPaste, String> {
    tokio::task::spawn_blocking(move || save_blocking(&project, &media_type, &bytes))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn save_blocking(project: &str, media_type: &str, bytes: &[u8]) -> Result<SavedPaste, String> {
    let project_dir = resolve_project_dir(project)?;
    let saved = save_to_dir(&project_dir, media_type, bytes)?;
    log::info!(
        "save_pasted_image: project={project}, host={}, container={}, bytes={}",
        saved.host_path,
        saved.container_path,
        bytes.len()
    );
    Ok(saved)
}

/// Shared write path used by `save_blocking` (prod) and `save_blocking_at` (tests).
fn save_to_dir(project_dir: &Path, media_type: &str, bytes: &[u8]) -> Result<SavedPaste, String> {
    let extension =
        extension_for(media_type).ok_or_else(|| format!("unsupported media type: {media_type}"))?;
    if bytes.len() > MAX_PASTE_BYTES {
        return Err(format!(
            "paste too large: {} bytes exceeds {} byte cap",
            bytes.len(),
            MAX_PASTE_BYTES
        ));
    }
    validate_magic(media_type, bytes)?;

    let subdir = PASTES_SUBDIR.as_str();
    let pastes_dir = project_dir.join(subdir);
    std::fs::create_dir_all(&pastes_dir)
        .map_err(|e| format!("failed to create {}: {e}", pastes_dir.display()))?;

    let filename = generate_filename(extension);
    let host_path = pastes_dir.join(&filename);
    std::fs::write(&host_path, bytes)
        .map_err(|e| format!("failed to write {}: {e}", host_path.display()))?;
    speedwave_runtime::fs_perms::set_owner_only(&host_path)?;

    let container_path = format!("/workspace/{subdir}/{filename}");
    Ok(SavedPaste {
        container_path,
        host_path: host_path.to_string_lossy().to_string(),
        filename,
    })
}

fn resolve_project_dir(project: &str) -> Result<PathBuf, String> {
    let user_config = config::load_user_config().map_err(|e| format!("config load: {e}"))?;
    let entry = user_config
        .find_project(project)
        .ok_or_else(|| format!("project '{project}' not found"))?;
    let dir = PathBuf::from(&entry.dir);
    if !dir.is_dir() {
        return Err(format!(
            "project directory does not exist on host: {}",
            dir.display()
        ));
    }
    Ok(dir)
}

fn generate_filename(extension: &str) -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("paste-{ts}-{seq:04}.{extension}")
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "unwrap is fine in test assertions")]
mod tests {
    use super::*;

    #[test]
    fn extension_for_known_mimes() {
        assert_eq!(extension_for("image/png"), Some("png"));
        assert_eq!(extension_for("image/jpeg"), Some("jpg"));
        assert_eq!(extension_for("image/gif"), Some("gif"));
        assert_eq!(extension_for("image/webp"), Some("webp"));
    }

    #[test]
    fn extension_for_rejects_other_mimes() {
        assert_eq!(extension_for("application/pdf"), None);
        assert_eq!(extension_for("image/svg+xml"), None);
        assert_eq!(extension_for("text/plain"), None);
        assert_eq!(extension_for(""), None);
    }

    #[test]
    fn generated_filename_shape() {
        let name = generate_filename("png");
        assert!(name.starts_with("paste-"));
        assert!(name.ends_with(".png"));
        assert!(name.len() >= 27, "got: {name}");
    }

    #[test]
    fn generated_filenames_are_unique_within_a_millisecond() {
        let a = generate_filename("png");
        let b = generate_filename("png");
        assert_ne!(a, b);
    }

    #[test]
    fn save_to_dir_rejects_unknown_mime() {
        let tmp = tempfile::tempdir().unwrap();
        let err = save_to_dir(tmp.path(), "application/octet-stream", b"\0\0\0").unwrap_err();
        assert!(err.contains("unsupported media type"));
    }

    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    const JPEG_MAGIC: &[u8] = b"\xff\xd8\xff\xe0";
    const GIF89A: &[u8] = b"GIF89a";
    const WEBP: &[u8] = b"RIFF\x00\x00\x00\x00WEBP";

    #[test]
    fn save_blocking_writes_file_and_returns_container_path() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("my-project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let saved = save_blocking_at(&project_dir, "image/png", PNG_MAGIC).unwrap();
        assert!(saved.filename.starts_with("paste-"));
        assert!(saved.filename.ends_with(".png"));
        assert!(saved
            .container_path
            .starts_with(&format!("/workspace/{}/paste-", PASTES_SUBDIR.as_str())));
        assert!(Path::new(&saved.host_path).is_file());
        assert_eq!(std::fs::read(&saved.host_path).unwrap(), PNG_MAGIC);
    }

    #[test]
    fn save_blocking_creates_pastes_subdir_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("fresh-project");
        std::fs::create_dir_all(&project_dir).unwrap();
        assert!(!project_dir.join(PASTES_SUBDIR.as_str()).exists());

        save_blocking_at(&project_dir, "image/jpeg", JPEG_MAGIC).unwrap();

        assert!(project_dir.join(PASTES_SUBDIR.as_str()).is_dir());
    }

    #[test]
    fn validate_magic_accepts_all_supported_mimes() {
        assert!(validate_magic("image/png", PNG_MAGIC).is_ok());
        assert!(validate_magic("image/jpeg", JPEG_MAGIC).is_ok());
        assert!(validate_magic("image/gif", GIF89A).is_ok());
        assert!(validate_magic("image/webp", WEBP).is_ok());
    }

    #[test]
    fn validate_magic_rejects_mismatch() {
        // Declared PNG, actual JPEG bytes.
        let err = validate_magic("image/png", JPEG_MAGIC).unwrap_err();
        assert!(err.contains("do not match"));
    }

    #[test]
    fn validate_magic_rejects_truncated_webp() {
        // RIFF header without WEBP fourcc.
        assert!(validate_magic("image/webp", b"RIFF\x00\x00\x00\x00????").is_err());
        assert!(validate_magic("image/webp", b"RIFF").is_err());
    }

    #[test]
    fn save_blocking_rejects_oversize() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("p");
        std::fs::create_dir_all(&project_dir).unwrap();
        let mut huge = vec![0u8; MAX_PASTE_BYTES + 1];
        huge[..PNG_MAGIC.len()].copy_from_slice(PNG_MAGIC);
        let err = save_blocking_at(&project_dir, "image/png", &huge).unwrap_err();
        assert!(err.contains("too large"));
    }

    #[test]
    fn save_blocking_rejects_bytes_without_correct_magic() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("p");
        std::fs::create_dir_all(&project_dir).unwrap();
        let err = save_blocking_at(&project_dir, "image/png", b"not a png").unwrap_err();
        assert!(err.contains("do not match"));
    }
}

#[cfg(test)]
fn save_blocking_at(
    project_dir: &Path,
    media_type: &str,
    bytes: &[u8],
) -> Result<SavedPaste, String> {
    save_to_dir(project_dir, media_type, bytes)
}

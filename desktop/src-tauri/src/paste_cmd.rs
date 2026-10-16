//! Save a pasted image to `<project>/.speedwave/pastes/` so Claude reads
//! it by path (see ADR-065), and stream any other pasted or dropped file
//! into the same directory in bounded chunks (ADR-094).

use serde::Serialize;
use speedwave_runtime::config;
use speedwave_runtime::consts::DATA_DIR;
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request};

/// `<project>/<DATA_DIR>/pastes` — composed from SSOT so a rename of the
/// data-dir literal stays in sync without a separate alignment entry.
pub(crate) static PASTES_SUBDIR: LazyLock<String> = LazyLock::new(|| format!("{DATA_DIR}/pastes"));

/// Defence-in-depth host-side cap. Renderer enforces a stricter 3 MB cap post-resample
/// (`MAX_IMAGE_BYTES`); this catches a malicious renderer or future caller bypassing it.
const MAX_PASTE_BYTES: usize = 10 * 1024 * 1024;

const MAX_UPLOAD_CHUNK_BYTES: usize = 16 * 1024 * 1024;

const UPLOAD_ID_HEADER: &str = "x-upload-id";

const UPLOAD_PART_SUFFIX: &str = ".part";

const MAX_UPLOAD_STEM_CHARS: usize = 64;

const MAX_UPLOAD_EXTENSION_CHARS: usize = 16;

const FALLBACK_UPLOAD_STEM: &str = "file";

#[derive(Serialize, Debug)]
pub struct SavedPaste {
    /// `/workspace/...` — what the in-container claude sees.
    pub container_path: String,
    pub host_path: String,
    pub filename: String,
}

/// Handle of an upload opened by `begin_paste_upload`.
#[derive(Serialize, Debug)]
pub struct UploadTicket {
    /// Key for the `append`, `finish` and `abort` calls of this upload.
    pub upload_id: u64,
    /// Name the file has under the pastes directory once finished.
    pub filename: String,
}

struct OpenUpload {
    file: File,
    part_path: PathBuf,
    final_path: PathBuf,
    container_path: String,
    filename: String,
    declared_bytes: u64,
    written_bytes: u64,
}

static UPLOADS: LazyLock<Mutex<HashMap<u64, OpenUpload>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static NEXT_UPLOAD_ID: AtomicU64 = AtomicU64::new(1);

/// Breaks timestamp ties on multi-file drops.
static SEQ: AtomicU32 = AtomicU32::new(0);

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

/// Opens a chunked upload of a non-image file into the project's pastes directory.
#[tauri::command]
pub async fn begin_paste_upload(
    project: String,
    filename: String,
    size_bytes: u64,
) -> Result<UploadTicket, String> {
    tokio::task::spawn_blocking(move || {
        let project_dir = resolve_project_dir(&project)?;
        begin_upload_in_dir(&project_dir, &filename, size_bytes)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Appends one raw-body chunk, addressed by the `x-upload-id` header, to an open
/// upload and returns the bytes written so far.
#[tauri::command(async)]
pub fn append_paste_upload(request: Request<'_>) -> Result<u64, String> {
    let upload_id = upload_id_from_headers(request.headers())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("append_paste_upload expects a raw byte body".to_string());
    };
    append_chunk(upload_id, bytes)
}

/// Closes an open upload: checks that the declared size arrived, syncs the part
/// file and renames it into place.
#[tauri::command]
pub async fn finish_paste_upload(upload_id: u64) -> Result<SavedPaste, String> {
    tokio::task::spawn_blocking(move || finish_upload(upload_id))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Drops an open upload together with its part file; an unknown id is a no-op.
#[tauri::command]
pub async fn abort_paste_upload(upload_id: u64) -> Result<(), String> {
    tokio::task::spawn_blocking(move || abort_upload(upload_id))
        .await
        .map_err(|e| format!("join error: {e}"))
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

    let pastes_dir = ensure_pastes_dir(project_dir)?;
    let filename = generate_filename(extension);
    let host_path = pastes_dir.join(&filename);
    std::fs::write(&host_path, bytes)
        .map_err(|e| format!("failed to write {}: {e}", host_path.display()))?;
    speedwave_runtime::fs_perms::set_owner_only(&host_path)?;

    Ok(SavedPaste {
        container_path: container_path_for(&filename),
        host_path: host_path.to_string_lossy().to_string(),
        filename,
    })
}

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

fn begin_upload_in_dir(
    project_dir: &Path,
    original_name: &str,
    declared_bytes: u64,
) -> Result<UploadTicket, String> {
    let pastes_dir = ensure_pastes_dir(project_dir)?;
    let filename = generate_upload_filename(original_name);
    let final_path = pastes_dir.join(&filename);
    let part_path = pastes_dir.join(format!("{filename}{UPLOAD_PART_SUFFIX}"));
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(&part_path)
        .map_err(|e| format!("failed to create {}: {e}", part_path.display()))?;
    if let Err(e) = speedwave_runtime::fs_perms::set_owner_only(&part_path) {
        drop(file);
        remove_part_file(&part_path);
        return Err(e);
    }
    let upload_id = NEXT_UPLOAD_ID.fetch_add(1, Ordering::SeqCst);
    uploads().insert(
        upload_id,
        OpenUpload {
            file,
            part_path,
            final_path,
            container_path: container_path_for(&filename),
            filename: filename.clone(),
            declared_bytes,
            written_bytes: 0,
        },
    );
    Ok(UploadTicket {
        upload_id,
        filename,
    })
}

fn append_chunk(upload_id: u64, bytes: &[u8]) -> Result<u64, String> {
    if bytes.len() > MAX_UPLOAD_CHUNK_BYTES {
        return Err(format!(
            "upload chunk of {} bytes exceeds the {MAX_UPLOAD_CHUNK_BYTES} byte cap",
            bytes.len()
        ));
    }
    let mut open = uploads();
    let Some(upload) = open.get_mut(&upload_id) else {
        return Err(format!("unknown upload {upload_id}"));
    };
    let outcome = write_chunk(upload, bytes);
    if outcome.is_err() {
        if let Some(failed) = open.remove(&upload_id) {
            discard_upload(failed);
        }
    }
    outcome
}

fn write_chunk(upload: &mut OpenUpload, bytes: &[u8]) -> Result<u64, String> {
    let next = upload.written_bytes.saturating_add(bytes.len() as u64);
    if next > upload.declared_bytes {
        return Err(format!(
            "upload exceeds its declared size of {} bytes",
            upload.declared_bytes
        ));
    }
    upload
        .file
        .write_all(bytes)
        .map_err(|e| format!("failed to write {}: {e}", upload.part_path.display()))?;
    upload.written_bytes = next;
    Ok(next)
}

fn finish_upload(upload_id: u64) -> Result<SavedPaste, String> {
    let upload = uploads()
        .remove(&upload_id)
        .ok_or_else(|| format!("unknown upload {upload_id}"))?;
    if upload.written_bytes != upload.declared_bytes {
        let failed = format!(
            "upload received {} of {} declared bytes",
            upload.written_bytes, upload.declared_bytes
        );
        discard_upload(upload);
        return Err(failed);
    }
    if let Err(e) = upload.file.sync_all() {
        let failed = format!("failed to sync {}: {e}", upload.part_path.display());
        discard_upload(upload);
        return Err(failed);
    }
    let OpenUpload {
        file,
        part_path,
        final_path,
        container_path,
        filename,
        declared_bytes,
        ..
    } = upload;
    drop(file);
    if let Err(e) = std::fs::rename(&part_path, &final_path) {
        let failed = format!(
            "failed to rename {} to {}: {e}",
            part_path.display(),
            final_path.display()
        );
        remove_part_file(&part_path);
        return Err(failed);
    }
    log::info!(
        "finished pasted file upload of {declared_bytes} bytes into {}",
        final_path.display()
    );
    Ok(SavedPaste {
        container_path,
        host_path: final_path.to_string_lossy().to_string(),
        filename,
    })
}

fn abort_upload(upload_id: u64) {
    if let Some(upload) = uploads().remove(&upload_id) {
        discard_upload(upload);
    }
}

fn uploads() -> MutexGuard<'static, HashMap<u64, OpenUpload>> {
    UPLOADS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn discard_upload(upload: OpenUpload) {
    let OpenUpload {
        file, part_path, ..
    } = upload;
    drop(file);
    remove_part_file(&part_path);
}

fn remove_part_file(part_path: &Path) {
    match std::fs::remove_file(part_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("failed to remove {}: {e}", part_path.display()),
    }
}

fn upload_id_from_headers(headers: &HeaderMap) -> Result<u64, String> {
    let value = headers
        .get(UPLOAD_ID_HEADER)
        .ok_or_else(|| format!("missing {UPLOAD_ID_HEADER} header"))?;
    let text = value
        .to_str()
        .map_err(|e| format!("invalid {UPLOAD_ID_HEADER} header: {e}"))?;
    text.trim()
        .parse::<u64>()
        .map_err(|e| format!("invalid {UPLOAD_ID_HEADER} header '{text}': {e}"))
}

fn ensure_pastes_dir(project_dir: &Path) -> Result<PathBuf, String> {
    let pastes_dir = project_dir.join(PASTES_SUBDIR.as_str());
    std::fs::create_dir_all(&pastes_dir)
        .map_err(|e| format!("failed to create {}: {e}", pastes_dir.display()))?;
    Ok(pastes_dir)
}

fn container_path_for(filename: &str) -> String {
    format!("/workspace/{}/{filename}", PASTES_SUBDIR.as_str())
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
    format!("paste-{}-{:04}.{extension}", unix_millis(), next_seq())
}

fn generate_upload_filename(original_name: &str) -> String {
    let base = original_name.rsplit(['/', '\\']).next().unwrap_or_default();
    let (stem, extension) = match base.rsplit_once('.') {
        Some((stem, extension)) => match sanitize_extension(extension) {
            Some(extension) => (stem, Some(extension)),
            None => (base, None),
        },
        None => (base, None),
    };
    let stem = sanitize_stem(stem);
    let prefix = format!("paste-{}-{:04}-{stem}", unix_millis(), next_seq());
    match extension {
        Some(extension) => format!("{prefix}.{extension}"),
        None => prefix,
    }
}

fn sanitize_stem(stem: &str) -> String {
    let mut out = String::new();
    let mut kept = 0;
    let mut last_was_dash = false;
    for ch in stem.chars() {
        if kept >= MAX_UPLOAD_STEM_CHARS {
            break;
        }
        if ch.is_alphanumeric() || ch == '_' || ch == '.' {
            out.push(ch);
            last_was_dash = false;
            kept += 1;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
            kept += 1;
        }
    }
    let trimmed = out.trim_matches(['-', '.']);
    if trimmed.is_empty() {
        FALLBACK_UPLOAD_STEM.to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_extension(extension: &str) -> Option<String> {
    let extension: String = extension
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if extension.is_empty() || extension.len() > MAX_UPLOAD_EXTENSION_CHARS {
        None
    } else {
        Some(extension)
    }
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn next_seq() -> u32 {
    SEQ.fetch_add(1, Ordering::SeqCst)
}

#[cfg(test)]
fn save_blocking_at(
    project_dir: &Path,
    media_type: &str,
    bytes: &[u8],
) -> Result<SavedPaste, String> {
    save_to_dir(project_dir, media_type, bytes)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "unwrap is fine in test assertions")]
mod tests {
    use super::*;
    use tauri::http::HeaderValue;

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
        let err = validate_magic("image/png", JPEG_MAGIC).unwrap_err();
        assert!(err.contains("do not match"));
    }

    #[test]
    fn validate_magic_rejects_truncated_webp() {
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

    fn project_dir_in(tmp: &tempfile::TempDir) -> PathBuf {
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        project_dir
    }

    fn part_path_of(project_dir: &Path, ticket: &UploadTicket) -> PathBuf {
        project_dir
            .join(PASTES_SUBDIR.as_str())
            .join(format!("{}{UPLOAD_PART_SUFFIX}", ticket.filename))
    }

    #[test]
    fn begin_creates_an_owner_only_part_file_and_registers_the_upload() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);

        let ticket = begin_upload_in_dir(&project_dir, "report q3.xlsx", 5).unwrap();

        let part = part_path_of(&project_dir, &ticket);
        assert!(part.is_file(), "part file missing at {}", part.display());
        assert!(
            ticket.filename.ends_with("-report-q3.xlsx"),
            "{}",
            ticket.filename
        );
        assert!(!project_dir
            .join(PASTES_SUBDIR.as_str())
            .join(&ticket.filename)
            .exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&part).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
        }
        assert_eq!(append_chunk(ticket.upload_id, b"12345").unwrap(), 5);
        abort_upload(ticket.upload_id);
    }

    #[test]
    fn append_and_finish_write_the_declared_bytes_and_rename_into_place() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let payload = b"hello, chunked world";
        let ticket = begin_upload_in_dir(&project_dir, "notes.txt", payload.len() as u64).unwrap();

        assert_eq!(append_chunk(ticket.upload_id, &payload[..6]).unwrap(), 6);
        assert_eq!(
            append_chunk(ticket.upload_id, &payload[6..]).unwrap(),
            payload.len() as u64
        );
        let saved = finish_upload(ticket.upload_id).unwrap();

        assert_eq!(saved.filename, ticket.filename);
        assert_eq!(
            saved.container_path,
            format!("/workspace/{}/{}", PASTES_SUBDIR.as_str(), ticket.filename)
        );
        assert_eq!(std::fs::read(&saved.host_path).unwrap(), payload);
        assert!(!part_path_of(&project_dir, &ticket).exists());
        let err = finish_upload(ticket.upload_id).unwrap_err();
        assert!(err.contains("unknown upload"), "{err}");
    }

    #[test]
    fn a_zero_byte_upload_finishes_without_any_chunk() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let ticket = begin_upload_in_dir(&project_dir, "empty.log", 0).unwrap();

        let saved = finish_upload(ticket.upload_id).unwrap();

        assert_eq!(std::fs::metadata(&saved.host_path).unwrap().len(), 0);
        assert!(saved.filename.ends_with("-empty.log"));
    }

    #[test]
    fn finish_refuses_an_upload_short_of_its_declared_size_and_removes_the_part() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let ticket = begin_upload_in_dir(&project_dir, "short.bin", 10).unwrap();
        append_chunk(ticket.upload_id, b"1234").unwrap();

        let err = finish_upload(ticket.upload_id).unwrap_err();

        assert!(err.contains("4 of 10"), "{err}");
        assert!(!part_path_of(&project_dir, &ticket).exists());
        assert!(!project_dir
            .join(PASTES_SUBDIR.as_str())
            .join(&ticket.filename)
            .exists());
    }

    #[test]
    fn append_beyond_the_declared_size_fails_and_discards_the_upload() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let ticket = begin_upload_in_dir(&project_dir, "over.bin", 3).unwrap();

        let err = append_chunk(ticket.upload_id, b"1234").unwrap_err();

        assert!(err.contains("declared size of 3"), "{err}");
        assert!(!part_path_of(&project_dir, &ticket).exists());
        let again = append_chunk(ticket.upload_id, b"1").unwrap_err();
        assert!(again.contains("unknown upload"), "{again}");
    }

    #[test]
    fn append_rejects_a_chunk_over_the_per_request_cap_and_keeps_the_upload_open() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let declared = (MAX_UPLOAD_CHUNK_BYTES + 1) as u64;
        let ticket = begin_upload_in_dir(&project_dir, "big.bin", declared).unwrap();
        let huge = vec![0u8; MAX_UPLOAD_CHUNK_BYTES + 1];

        let err = append_chunk(ticket.upload_id, &huge).unwrap_err();

        assert!(err.contains("byte cap"), "{err}");
        assert!(part_path_of(&project_dir, &ticket).is_file());
        assert_eq!(append_chunk(ticket.upload_id, b"x").unwrap(), 1);
        abort_upload(ticket.upload_id);
    }

    #[test]
    fn append_and_finish_report_an_unknown_upload_and_abort_ignores_it() {
        let err = append_chunk(u64::MAX, b"x").unwrap_err();
        assert!(err.contains("unknown upload"), "{err}");
        let err = finish_upload(u64::MAX).unwrap_err();
        assert!(err.contains("unknown upload"), "{err}");
        abort_upload(u64::MAX);
    }

    #[test]
    fn abort_removes_the_part_file_and_forgets_the_upload() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let ticket = begin_upload_in_dir(&project_dir, "cancelled.zip", 8).unwrap();
        append_chunk(ticket.upload_id, b"1234").unwrap();

        abort_upload(ticket.upload_id);

        assert!(!part_path_of(&project_dir, &ticket).exists());
        let err = append_chunk(ticket.upload_id, b"5").unwrap_err();
        assert!(err.contains("unknown upload"), "{err}");
    }

    #[test]
    fn upload_ids_are_unique_across_begins() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let a = begin_upload_in_dir(&project_dir, "a.txt", 0).unwrap();
        let b = begin_upload_in_dir(&project_dir, "a.txt", 0).unwrap();

        assert_ne!(a.upload_id, b.upload_id);
        assert_ne!(a.filename, b.filename);
        abort_upload(a.upload_id);
        abort_upload(b.upload_id);
    }

    #[test]
    fn upload_filename_keeps_only_the_base_name_of_a_path() {
        let unix = generate_upload_filename("../../etc/passwd");
        assert!(unix.ends_with("-passwd"), "{unix}");
        assert!(!unix.contains("..") && !unix.contains('/'), "{unix}");
        let windows = generate_upload_filename("C:\\Users\\me\\report.docx");
        assert!(windows.ends_with("-report.docx"), "{windows}");
        assert!(!windows.contains('\\'), "{windows}");
    }

    #[test]
    fn upload_filename_replaces_punctuation_and_whitespace_and_collapses_runs() {
        let name = generate_upload_filename("my  report (final) v2!!.PDF");
        assert!(name.ends_with("-my-report-final-v2.pdf"), "{name}");
    }

    #[test]
    fn upload_filename_keeps_unicode_letters() {
        let name = generate_upload_filename("raport_końcowy.xlsx");
        assert!(name.ends_with("-raport_końcowy.xlsx"), "{name}");
    }

    #[test]
    fn upload_filename_truncates_a_long_stem_to_the_cap() {
        let name = generate_upload_filename(&format!("{}.txt", "a".repeat(200)));
        let stem = name.rsplit_once('.').unwrap().0.rsplit('-').next().unwrap();
        assert_eq!(stem.chars().count(), MAX_UPLOAD_STEM_CHARS);
        assert!(name.ends_with(".txt"), "{name}");
    }

    #[test]
    fn upload_filename_without_a_usable_extension_has_none() {
        let makefile = generate_upload_filename("Makefile");
        assert!(makefile.ends_with("-Makefile"), "{makefile}");
        let trailing_dot = generate_upload_filename("notes.");
        assert!(trailing_dot.ends_with("-notes"), "{trailing_dot}");
        let long = generate_upload_filename("weird.extension-that-is-way-too-long");
        assert!(
            long.ends_with("-weird.extension-that-is-way-too-long"),
            "{long}"
        );
    }

    #[test]
    fn upload_filename_falls_back_for_an_empty_or_dot_only_name() {
        let empty = generate_upload_filename("");
        assert!(empty.ends_with("-file"), "{empty}");
        let dots = generate_upload_filename("...");
        assert!(dots.ends_with("-file"), "{dots}");
        let dotfile = generate_upload_filename(".env");
        assert!(dotfile.ends_with("-file.env"), "{dotfile}");
    }

    #[test]
    fn upload_filename_starts_with_the_paste_prefix_and_a_sequence() {
        let name = generate_upload_filename("x.txt");
        assert!(name.starts_with("paste-"), "{name}");
        let seq = name.split('-').nth(2).unwrap();
        assert_eq!(seq.len(), 4, "{name}");
        assert!(seq.chars().all(|c| c.is_ascii_digit()), "{name}");
    }

    #[test]
    fn upload_id_header_is_parsed_and_validated() {
        let mut headers = HeaderMap::new();
        headers.insert(UPLOAD_ID_HEADER, HeaderValue::from_static(" 42 "));
        assert_eq!(upload_id_from_headers(&headers).unwrap(), 42);

        let err = upload_id_from_headers(&HeaderMap::new()).unwrap_err();
        assert!(err.contains("missing"), "{err}");

        let mut bad = HeaderMap::new();
        bad.insert(UPLOAD_ID_HEADER, HeaderValue::from_static("abc"));
        let err = upload_id_from_headers(&bad).unwrap_err();
        assert!(err.contains("invalid"), "{err}");
    }
}

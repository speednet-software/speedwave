use serde::Serialize;
use speedwave_runtime::config;
use speedwave_runtime::consts::DATA_DIR;
use speedwave_runtime::pastes::{open_pastes_dir, PASTES_DIR};
use speedwave_runtime::pinned_dir::PinnedDir;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request};

static PASTES_SUBDIR: LazyLock<String> = LazyLock::new(|| format!("{DATA_DIR}/{PASTES_DIR}"));

/// Defence-in-depth host-side cap. Renderer enforces a stricter 3 MB cap post-resample
/// (`MAX_IMAGE_BYTES`); this catches a malicious renderer or future caller bypassing it.
const MAX_PASTE_BYTES: usize = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];

const UPLOAD_ID_HEADER: &str = "x-upload-id";

const UPLOAD_PART_SUFFIX: &str = ".part";

const STALE_PART_AGE: Duration = Duration::from_secs(60 * 60);

const MAX_STAGED_PASTES: usize = 256;

const MAX_UPLOAD_STEM_CHARS: usize = 64;

const MAX_UPLOAD_EXTENSION_CHARS: usize = 16;

const FALLBACK_UPLOAD_STEM: &str = "file";

#[derive(Serialize, Debug)]
pub struct SavedPaste {
    pub paste_id: u64,
    /// `/workspace/...` — what the in-container claude sees.
    pub container_path: String,
    pub filename: String,
}

struct OpenUpload {
    project_dir: PathBuf,
    dir: PinnedDir,
    file: Option<File>,
    part_name: String,
    filename: String,
    declared_bytes: u64,
    written_bytes: u64,
}

struct StagedPaste {
    project_dir: PathBuf,
    filename: String,
}

static UPLOADS: LazyLock<Mutex<HashMap<u64, Arc<Mutex<OpenUpload>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static STAGED_PASTES: Mutex<BTreeMap<u64, StagedPaste>> = Mutex::new(BTreeMap::new());

static NEXT_PASTE_ID: AtomicU64 = AtomicU64::new(1);

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

#[tauri::command]
pub async fn begin_paste_upload(
    project: String,
    filename: String,
    size_bytes: u64,
) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        let project_dir = resolve_project_dir(&project)?;
        begin_upload_in_dir(&project_dir, &filename, size_bytes)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn append_paste_upload(request: Request<'_>) -> Result<(), String> {
    let upload_id = upload_id_from_headers(request.headers())?;
    let bytes = chunk_bytes(request.body())?;
    tokio::task::spawn_blocking(move || append_chunk(upload_id, &bytes))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn finish_paste_upload(upload_id: u64) -> Result<SavedPaste, String> {
    tokio::task::spawn_blocking(move || finish_upload(upload_id))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn discard_paste(paste_id: u64) -> Result<(), String> {
    tokio::task::spawn_blocking(move || discard(paste_id))
        .await
        .map_err(|e| format!("join error: {e}"))
}

fn save_blocking(project: &str, media_type: &str, bytes: &[u8]) -> Result<SavedPaste, String> {
    let project_dir = resolve_project_dir(project)?;
    let saved = save_to_dir(&project_dir, media_type, bytes)?;
    log::info!(
        "saved a pasted image of {} bytes for project {project} as {}",
        bytes.len(),
        saved.container_path
    );
    Ok(saved)
}

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

    let dir = open_pastes_dir(project_dir)?;
    let filename = generate_filename(extension);
    let mut file = dir.create_new_file(&filename)?;
    if let Err(e) = file.write_all(bytes) {
        drop(file);
        remove_logged(&dir, &filename);
        return Err(format!(
            "failed to write {}: {e}",
            dir.path().join(&filename).display()
        ));
    }
    let paste_id = next_paste_id();
    stage_paste(paste_id, project_dir, &filename);
    Ok(SavedPaste {
        paste_id,
        container_path: container_path_for(&filename),
        filename,
    })
}

fn extension_for(media_type: &str) -> Option<&'static str> {
    IMAGE_EXTENSIONS
        .iter()
        .find(|(known, _)| *known == media_type)
        .map(|(_, extension)| *extension)
}

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
) -> Result<u64, String> {
    let dir = open_pastes_dir(project_dir)?;
    sweep_stale_parts(&dir);
    let filename = generate_upload_filename(original_name);
    let part_name = format!("{filename}{UPLOAD_PART_SUFFIX}");
    let file = dir.create_new_file(&part_name)?;
    let upload_id = next_paste_id();
    log::info!(
        "began pasted file upload {upload_id} of {declared_bytes} bytes into {}",
        dir.path().join(&part_name).display()
    );
    let upload = OpenUpload {
        project_dir: project_dir.to_path_buf(),
        dir,
        file: Some(file),
        part_name,
        filename,
        declared_bytes,
        written_bytes: 0,
    };
    uploads().insert(upload_id, Arc::new(Mutex::new(upload)));
    Ok(upload_id)
}

fn sweep_stale_parts(dir: &PinnedDir) {
    let Ok(entries) = std::fs::read_dir(dir.path()) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(UPLOAD_PART_SUFFIX) {
            continue;
        }
        let stale = entry.metadata().is_ok_and(|metadata| {
            metadata.is_file()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|idle| idle >= STALE_PART_AGE)
        });
        if !stale {
            continue;
        }
        match dir.remove_file(name) {
            Ok(()) => log::info!(
                "removed the stale upload part {}",
                dir.path().join(name).display()
            ),
            Err(e) => log::warn!("{e}"),
        }
    }
}

fn append_chunk(upload_id: u64, bytes: &[u8]) -> Result<(), String> {
    let entry = open_upload(upload_id)?;
    let mut upload = lock(&entry);
    let written = write_chunk(&mut upload, bytes);
    if written.is_err() {
        uploads().remove(&upload_id);
        discard_upload(&mut upload);
    }
    written
}

fn open_upload(upload_id: u64) -> Result<Arc<Mutex<OpenUpload>>, String> {
    let entry = uploads().get(&upload_id).cloned();
    entry.ok_or_else(|| format!("unknown upload {upload_id}"))
}

fn write_chunk(upload: &mut OpenUpload, bytes: &[u8]) -> Result<(), String> {
    let next = upload.written_bytes.saturating_add(bytes.len() as u64);
    if next > upload.declared_bytes {
        return Err(format!(
            "upload exceeds its declared size of {} bytes",
            upload.declared_bytes
        ));
    }
    let Some(file) = upload.file.as_mut() else {
        return Err(format!("upload of {} is already closed", upload.filename));
    };
    file.write_all(bytes).map_err(|e| {
        format!(
            "failed to write {}: {e}",
            upload.dir.path().join(&upload.part_name).display()
        )
    })?;
    upload.written_bytes = next;
    Ok(())
}

fn finish_upload(upload_id: u64) -> Result<SavedPaste, String> {
    let entry = uploads()
        .remove(&upload_id)
        .ok_or_else(|| format!("unknown upload {upload_id}"))?;
    let mut upload = lock(&entry);
    if let Err(e) = commit_upload(&mut upload) {
        discard_upload(&mut upload);
        return Err(e);
    }
    log::info!(
        "finished pasted file upload {upload_id} of {} bytes into {}",
        upload.declared_bytes,
        upload.dir.path().join(&upload.filename).display()
    );
    stage_paste(upload_id, &upload.project_dir, &upload.filename);
    Ok(SavedPaste {
        paste_id: upload_id,
        container_path: container_path_for(&upload.filename),
        filename: upload.filename.clone(),
    })
}

fn commit_upload(upload: &mut OpenUpload) -> Result<(), String> {
    if upload.written_bytes != upload.declared_bytes {
        return Err(format!(
            "upload received {} of {} declared bytes",
            upload.written_bytes, upload.declared_bytes
        ));
    }
    let file = upload
        .file
        .take()
        .ok_or_else(|| format!("upload of {} is already closed", upload.filename))?;
    upload
        .dir
        .persist(file, &upload.part_name, &upload.filename)
}

fn discard(paste_id: u64) {
    let open = uploads().remove(&paste_id);
    if let Some(entry) = open {
        let mut upload = lock(&entry);
        discard_upload(&mut upload);
        log::info!("discarded pasted file upload {paste_id}");
        return;
    }
    let staged = staged_pastes().remove(&paste_id);
    let Some(staged) = staged else {
        return;
    };
    let removed =
        open_pastes_dir(&staged.project_dir).and_then(|dir| dir.remove_file(&staged.filename));
    match removed {
        Ok(()) => log::info!("discarded the unsent attachment {}", staged.filename),
        Err(e) => log::warn!(
            "failed to discard the unsent attachment {}: {e}",
            staged.filename
        ),
    }
}

fn discard_upload(upload: &mut OpenUpload) {
    drop(upload.file.take());
    remove_logged(&upload.dir, &upload.part_name);
}

fn remove_logged(dir: &PinnedDir, name: &str) {
    if let Err(e) = dir.remove_file(name) {
        log::warn!("{e}");
    }
}

fn stage_paste(paste_id: u64, project_dir: &Path, filename: &str) {
    let staged = StagedPaste {
        project_dir: project_dir.to_path_buf(),
        filename: filename.to_string(),
    };
    insert_bounded(&mut staged_pastes(), paste_id, staged);
}

fn insert_bounded(staged: &mut BTreeMap<u64, StagedPaste>, paste_id: u64, paste: StagedPaste) {
    staged.insert(paste_id, paste);
    while staged.len() > MAX_STAGED_PASTES {
        staged.pop_first();
    }
}

fn uploads() -> MutexGuard<'static, HashMap<u64, Arc<Mutex<OpenUpload>>>> {
    UPLOADS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn staged_pastes() -> MutexGuard<'static, BTreeMap<u64, StagedPaste>> {
    STAGED_PASTES.lock().unwrap_or_else(PoisonError::into_inner)
}

fn lock(upload: &Mutex<OpenUpload>) -> MutexGuard<'_, OpenUpload> {
    upload.lock().unwrap_or_else(PoisonError::into_inner)
}

fn chunk_bytes(body: &InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| value.as_u64().and_then(|byte| u8::try_from(byte).ok()))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| "append_paste_upload expects an array of bytes".to_string()),
        InvokeBody::Json(_) => Err("append_paste_upload expects a byte body".to_string()),
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

fn next_paste_id() -> u64 {
    NEXT_PASTE_ID.fetch_add(1, Ordering::SeqCst)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "unwrap is fine in test assertions")]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
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
    fn image_media_types_match_ts_mirror() {
        let ts = include_str!("../../src/src/app/models/chat.ts");
        let list = ts
            .split("export const IMAGE_MEDIA_TYPES = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .unwrap();
        let ts_types: BTreeSet<&str> = list
            .split(',')
            .map(|item| item.trim().trim_matches('\''))
            .filter(|item| !item.is_empty())
            .collect();
        let rust_types: BTreeSet<&str> = IMAGE_EXTENSIONS.iter().map(|(t, _)| *t).collect();
        assert_eq!(ts_types, rust_types);
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

    fn project_dir_in(tmp: &tempfile::TempDir) -> PathBuf {
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        project_dir
    }

    fn pastes_dir_of(project_dir: &Path) -> PathBuf {
        project_dir.join(DATA_DIR).join(PASTES_DIR)
    }

    fn host_path_of(project_dir: &Path, filename: &str) -> PathBuf {
        pastes_dir_of(project_dir).join(filename)
    }

    fn filename_of(upload_id: u64) -> String {
        let entry = open_upload(upload_id).unwrap();
        let upload = lock(&entry);
        upload.filename.clone()
    }

    fn part_path_of(project_dir: &Path, upload_id: u64) -> PathBuf {
        let entry = open_upload(upload_id).unwrap();
        let upload = lock(&entry);
        host_path_of(project_dir, &upload.part_name)
    }

    fn backdate(path: &Path, age: Duration) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn save_to_dir_writes_an_owner_only_image_and_returns_its_container_path() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);

        let saved = save_to_dir(&project_dir, "image/png", PNG_MAGIC).unwrap();

        assert!(saved.filename.starts_with("paste-"));
        assert!(saved.filename.ends_with(".png"));
        assert_eq!(
            saved.container_path,
            format!("/workspace/{}/{}", PASTES_SUBDIR.as_str(), saved.filename)
        );
        let host_path = host_path_of(&project_dir, &saved.filename);
        assert_eq!(std::fs::read(&host_path).unwrap(), PNG_MAGIC);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&host_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
        }
    }

    #[test]
    fn save_to_dir_creates_pastes_subdir_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        assert!(!pastes_dir_of(&project_dir).exists());

        save_to_dir(&project_dir, "image/jpeg", JPEG_MAGIC).unwrap();

        assert!(pastes_dir_of(&project_dir).is_dir());
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
    fn save_to_dir_rejects_oversize() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let mut huge = vec![0u8; MAX_PASTE_BYTES + 1];
        huge[..PNG_MAGIC.len()].copy_from_slice(PNG_MAGIC);
        let err = save_to_dir(&project_dir, "image/png", &huge).unwrap_err();
        assert!(err.contains("too large"));
    }

    #[test]
    fn save_to_dir_rejects_bytes_without_correct_magic() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let err = save_to_dir(&project_dir, "image/png", b"not a png").unwrap_err();
        assert!(err.contains("do not match"));
    }

    #[test]
    fn begin_creates_an_owner_only_part_file_and_registers_the_upload() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);

        let upload_id = begin_upload_in_dir(&project_dir, "report q3.xlsx", 5).unwrap();

        let part = part_path_of(&project_dir, upload_id);
        let filename = filename_of(upload_id);
        assert!(part.is_file(), "part file missing at {}", part.display());
        assert!(filename.ends_with("-report-q3.xlsx"), "{filename}");
        assert!(!host_path_of(&project_dir, &filename).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&part).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
        }
        append_chunk(upload_id, b"12345").unwrap();
        discard(upload_id);
    }

    #[test]
    fn append_and_finish_write_the_declared_bytes_and_rename_into_place() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let payload = b"hello, chunked world";
        let upload_id =
            begin_upload_in_dir(&project_dir, "notes.txt", payload.len() as u64).unwrap();
        let part = part_path_of(&project_dir, upload_id);

        append_chunk(upload_id, &payload[..6]).unwrap();
        append_chunk(upload_id, &payload[6..]).unwrap();
        let saved = finish_upload(upload_id).unwrap();

        assert_eq!(saved.paste_id, upload_id);
        assert!(saved.filename.ends_with("-notes.txt"), "{}", saved.filename);
        assert_eq!(
            saved.container_path,
            format!("/workspace/{}/{}", PASTES_SUBDIR.as_str(), saved.filename)
        );
        assert_eq!(
            std::fs::read(host_path_of(&project_dir, &saved.filename)).unwrap(),
            payload
        );
        assert!(!part.exists());
        let err = finish_upload(upload_id).unwrap_err();
        assert!(err.contains("unknown upload"), "{err}");
    }

    #[test]
    fn a_zero_byte_upload_finishes_without_any_chunk() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let upload_id = begin_upload_in_dir(&project_dir, "empty.log", 0).unwrap();

        let saved = finish_upload(upload_id).unwrap();

        let host_path = host_path_of(&project_dir, &saved.filename);
        assert_eq!(std::fs::metadata(host_path).unwrap().len(), 0);
        assert!(saved.filename.ends_with("-empty.log"));
    }

    #[test]
    fn finish_refuses_an_upload_short_of_its_declared_size_and_removes_the_part() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let upload_id = begin_upload_in_dir(&project_dir, "short.bin", 10).unwrap();
        append_chunk(upload_id, b"1234").unwrap();
        let part = part_path_of(&project_dir, upload_id);
        let filename = filename_of(upload_id);

        let err = finish_upload(upload_id).unwrap_err();

        assert!(err.contains("4 of 10"), "{err}");
        assert!(!part.exists());
        assert!(!host_path_of(&project_dir, &filename).exists());
    }

    #[test]
    fn finish_reports_a_failed_rename_and_removes_the_part() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let upload_id = begin_upload_in_dir(&project_dir, "blocked.bin", 2).unwrap();
        append_chunk(upload_id, b"ok").unwrap();
        let part = part_path_of(&project_dir, upload_id);
        let blocker = host_path_of(&project_dir, &filename_of(upload_id));
        std::fs::create_dir(&blocker).unwrap();
        std::fs::write(blocker.join("inside"), "x").unwrap();

        let err = finish_upload(upload_id).unwrap_err();

        assert!(err.contains("failed to rename"), "{err}");
        assert!(!part.exists());
        let again = finish_upload(upload_id).unwrap_err();
        assert!(again.contains("unknown upload"), "{again}");
    }

    #[test]
    fn append_beyond_the_declared_size_fails_and_discards_the_upload() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let upload_id = begin_upload_in_dir(&project_dir, "over.bin", 3).unwrap();
        let part = part_path_of(&project_dir, upload_id);

        let err = append_chunk(upload_id, b"1234").unwrap_err();

        assert!(err.contains("declared size of 3"), "{err}");
        assert!(!part.exists());
        let again = append_chunk(upload_id, b"1").unwrap_err();
        assert!(again.contains("unknown upload"), "{again}");
    }

    #[test]
    fn append_and_finish_report_an_unknown_upload_and_discard_ignores_it() {
        let err = append_chunk(u64::MAX, b"x").unwrap_err();
        assert!(err.contains("unknown upload"), "{err}");
        let err = finish_upload(u64::MAX).unwrap_err();
        assert!(err.contains("unknown upload"), "{err}");
        discard(u64::MAX);
    }

    #[test]
    fn discard_removes_an_open_upload_and_its_part_file() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let upload_id = begin_upload_in_dir(&project_dir, "cancelled.zip", 8).unwrap();
        append_chunk(upload_id, b"1234").unwrap();
        let part = part_path_of(&project_dir, upload_id);

        discard(upload_id);

        assert!(!part.exists());
        let err = append_chunk(upload_id, b"5").unwrap_err();
        assert!(err.contains("unknown upload"), "{err}");
    }

    #[test]
    fn discard_deletes_a_finished_upload_and_a_saved_image_once() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let upload_id = begin_upload_in_dir(&project_dir, "secret.env", 3).unwrap();
        append_chunk(upload_id, b"k=v").unwrap();
        let file = finish_upload(upload_id).unwrap();
        let image = save_to_dir(&project_dir, "image/png", PNG_MAGIC).unwrap();
        assert!(host_path_of(&project_dir, &file.filename).is_file());
        assert!(host_path_of(&project_dir, &image.filename).is_file());

        discard(file.paste_id);
        discard(image.paste_id);
        discard(file.paste_id);

        assert!(!host_path_of(&project_dir, &file.filename).exists());
        assert!(!host_path_of(&project_dir, &image.filename).exists());
    }

    #[test]
    fn the_oldest_staged_paste_drops_out_past_the_cap() {
        let mut staged = BTreeMap::new();
        let newest = MAX_STAGED_PASTES as u64 + 1;
        for paste_id in 1..=newest {
            let paste = StagedPaste {
                project_dir: PathBuf::from("project"),
                filename: format!("paste-{paste_id}"),
            };
            insert_bounded(&mut staged, paste_id, paste);
        }

        assert_eq!(staged.len(), MAX_STAGED_PASTES);
        assert!(!staged.contains_key(&1));
        assert!(staged.contains_key(&2));
        assert!(staged.contains_key(&newest));
    }

    #[test]
    fn upload_ids_are_unique_across_begins() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let a = begin_upload_in_dir(&project_dir, "a.txt", 0).unwrap();
        let b = begin_upload_in_dir(&project_dir, "a.txt", 0).unwrap();

        assert_ne!(a, b);
        assert_ne!(filename_of(a), filename_of(b));
        discard(a);
        discard(b);
    }

    #[test]
    fn begin_removes_a_stale_part_file_and_keeps_a_fresh_one() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let pastes = pastes_dir_of(&project_dir);
        std::fs::create_dir_all(&pastes).unwrap();
        let stale = pastes.join("paste-1-0001-old.bin.part");
        let fresh = pastes.join("paste-2-0002-new.bin.part");
        let finished = pastes.join("paste-3-0003-kept.bin");
        for path in [&stale, &fresh, &finished] {
            std::fs::write(path, "x").unwrap();
        }
        for path in [&stale, &finished] {
            backdate(path, STALE_PART_AGE + Duration::from_secs(60));
        }

        let upload_id = begin_upload_in_dir(&project_dir, "next.bin", 0).unwrap();

        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(finished.exists());
        discard(upload_id);
    }

    #[test]
    fn an_append_to_one_upload_does_not_wait_for_another_uploads_write() {
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = project_dir_in(&tmp);
        let busy = begin_upload_in_dir(&project_dir, "busy.bin", 1).unwrap();
        let free = begin_upload_in_dir(&project_dir, "free.bin", 1).unwrap();
        let busy_entry = open_upload(busy).unwrap();
        let held = lock(&busy_entry);
        let (done_tx, done_rx) = std::sync::mpsc::channel();

        let appender = std::thread::spawn(move || {
            let appended = append_chunk(free, b"x");
            let _ = done_tx.send(appended.is_ok());
        });
        let appended = done_rx.recv_timeout(Duration::from_secs(10));
        drop(held);
        appender.join().unwrap();

        assert_eq!(appended, Ok(true));
        discard(busy);
        discard(free);
    }

    #[cfg(unix)]
    #[test]
    fn nothing_is_written_through_a_symlinked_paste_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let project_dir = project_dir_in(&tmp);
        std::fs::create_dir_all(project_dir.join(DATA_DIR)).unwrap();
        std::os::unix::fs::symlink(&outside, pastes_dir_of(&project_dir)).unwrap();

        assert!(save_to_dir(&project_dir, "image/png", PNG_MAGIC).is_err());
        assert!(begin_upload_in_dir(&project_dir, "evil.plist", 1).is_err());

        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn chunk_bytes_accepts_a_raw_body_and_a_json_byte_array() {
        assert_eq!(
            chunk_bytes(&InvokeBody::Raw(vec![1, 2, 3])).unwrap(),
            vec![1, 2, 3]
        );
        assert_eq!(
            chunk_bytes(&InvokeBody::Json(serde_json::json!([0, 127, 255]))).unwrap(),
            vec![0, 127, 255]
        );
        assert!(chunk_bytes(&InvokeBody::Json(serde_json::json!([])))
            .unwrap()
            .is_empty());
        for bad in [
            serde_json::json!([256]),
            serde_json::json!([-1]),
            serde_json::json!([1.5]),
            serde_json::json!({"bytes": [1]}),
        ] {
            assert!(chunk_bytes(&InvokeBody::Json(bad)).is_err());
        }
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

    #[test]
    fn upload_id_header_matches_ts() {
        let ts = include_str!("../../src/src/app/services/file-attachment.service.ts");
        assert!(
            ts.contains(&format!("UPLOAD_ID_HEADER = '{UPLOAD_ID_HEADER}'")),
            "file-attachment.service.ts must send the header append_paste_upload reads"
        );
    }

    #[test]
    fn saved_paste_fields_match_ts_mirror() {
        let ts = include_str!("../../src/src/app/models/chat.ts");
        let body = ts
            .split("export interface SavedPaste {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .unwrap();
        let ts_fields: BTreeSet<&str> = body
            .lines()
            .filter_map(|line| line.trim().split(':').next())
            .map(|name| name.trim_end_matches('?'))
            .filter(|name| !name.is_empty())
            .collect();
        let saved = SavedPaste {
            paste_id: 1,
            container_path: "/workspace/x".to_string(),
            filename: "x".to_string(),
        };
        let json = serde_json::to_value(&saved).unwrap();
        let rust_fields: BTreeSet<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(ts_fields, rust_fields);
    }
}

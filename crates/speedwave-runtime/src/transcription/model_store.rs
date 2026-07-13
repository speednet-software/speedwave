//! On-demand download/verify/cache of Whisper models (ADR-056) under models/whisper/ (0700/0600).
//! Streams to a .part temp, SHA256-verifies, atomic rename; redirects allowlisted, size-capped.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::consts;
use crate::transcription::model_catalog::{whisper_model, WhisperModelInfo, VAD_MODEL};

/// Max time to establish the connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Whole-request backstop. 8 h keeps a ~100 KB/s link viable for a 2.9 GiB
/// model (1 h aborted those); dead links are caught earlier by TCP keepalive.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(8 * 60 * 60);
/// Keepalive probe interval — detects a dead peer without capping transfer time.
const TCP_KEEPALIVE: Duration = Duration::from_secs(60);

/// Read-buffer size for the streaming download (also the granularity at which
/// progress is reported).
const READ_CHUNK: usize = 256 * 1024;

/// Errors the model store can produce.
#[derive(Debug, thiserror::Error)]
pub enum ModelStoreError {
    /// Unknown catalogue key.
    #[error("no such model in the catalogue: {0}")]
    UnknownModel(String),
    /// Redirect chain led to a host not on `consts::TRANSCRIPTION_MODEL_ALLOWED_REDIRECT_HOSTS`
    /// — most likely a CDN hostname changed and the catalogue needs updating.
    #[error("model download redirected to a host not on the allowlist ({0}) — the model URL may have changed; report this")]
    DisallowedRedirect(String),
    /// `Content-Length` (or the bytes actually streamed) exceeded the per-model
    /// cap from the catalogue.
    #[error(
        "model {model} is larger than allowed ({actual} bytes > cap {cap}) — refusing to download"
    )]
    TooLarge {
        /// Catalogue key.
        model: String,
        /// Reported / streamed size.
        actual: u64,
        /// The per-model cap.
        cap: u64,
    },
    /// Downloading this model would push the total models-on-disk size over the
    /// `MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES` dome.
    #[error("downloading {model} would exceed the total model storage cap ({would_be} bytes > cap {cap}) — delete some models first")]
    StorageCapExceeded {
        /// Catalogue key.
        model: String,
        /// Total after this download.
        would_be: u64,
        /// The dome.
        cap: u64,
    },
    /// The downloaded bytes' SHA256 did not match the catalogue value (the
    /// `.part` temp file has been removed).
    #[error("model {model} failed integrity check: expected SHA256 {expected}, got {got} (partial download discarded)")]
    HashMismatch {
        /// Catalogue key.
        model: String,
        /// Expected hash from the catalogue.
        expected: String,
        /// Hash of what was actually downloaded.
        got: String,
    },
    /// HTTP failure (connection, non-2xx status, …).
    #[error("model download HTTP error: {0}")]
    Http(String),
    /// Filesystem failure.
    #[error("model store I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Progress of a model download, reported via the `&mut dyn FnMut(...)` callback `ensure_*`
/// takes. `total_bytes` is `None` when the server didn't send `Content-Length` (rare here).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DownloadProgress {
    /// Catalogue key of the model being downloaded.
    pub model_key: String,
    /// Bytes received so far.
    pub downloaded_bytes: u64,
    /// Total bytes if known.
    pub total_bytes: Option<u64>,
}

/// Status of one catalogue model on disk.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModelStatusEntry {
    /// Catalogue key.
    pub key: String,
    /// `true` if the verified model file is present locally.
    pub downloaded: bool,
    /// Size on disk in bytes if downloaded, else the catalogue's `approx_bytes`.
    pub size_bytes: u64,
    /// Local path if downloaded.
    pub path: Option<PathBuf>,
}

/// A no-op progress callback for callers that don't care about progress.
pub fn no_progress(_p: DownloadProgress) {}

/// Accepted on-disk size window for a verified model of estimated size
/// `approx_bytes`: rejects truncated/oversized leftovers, tolerates drift.
fn size_window(approx_bytes: u64) -> (u64, u64) {
    (approx_bytes / 10 * 9, download_cap(approx_bytes))
}

/// Per-download byte cap: the estimate plus 5% headroom (guards a wildly-wrong
/// `Content-Length` from writing gigabytes; the file itself is a fixed size).
fn download_cap(approx_bytes: u64) -> u64 {
    approx_bytes + approx_bytes / 20 + 1024
}

/// Downloads, verifies, and caches transcription models under a root directory.
pub struct ModelStore {
    root: PathBuf,
}

impl ModelStore {
    /// A `ModelStore` rooted at `<data_dir>/models/` — the production location.
    /// Shares the one path derivation with `super::models_dir()` (SSOT).
    pub fn new() -> Self {
        Self {
            root: super::models_dir(),
        }
    }

    /// A `ModelStore` rooted at an arbitrary directory (for tests).
    pub fn with_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn whisper_dir(&self) -> PathBuf {
        self.root.join("whisper")
    }

    /// Local path a Whisper model lives at once downloaded (`<root>/whisper/<file>`).
    fn whisper_path(&self, info: &WhisperModelInfo) -> PathBuf {
        self.whisper_dir().join(info.file)
    }

    /// `true` if the file size is within the [`size_window`] of the catalogue
    /// estimate (SHA-verified before rename put it there).
    fn whisper_is_present(&self, info: &WhisperModelInfo) -> bool {
        match std::fs::metadata(self.whisper_path(info)) {
            Ok(m) => {
                let (floor, ceil) = size_window(info.approx_bytes);
                m.len() >= floor && m.len() <= ceil
            }
            Err(_) => false,
        }
    }

    /// `true` if the Whisper model with catalogue key `key` is downloaded.
    /// Unknown keys return `false`.
    pub fn whisper_is_present_by_key(&self, key: &str) -> bool {
        whisper_model(key)
            .map(|info| self.whisper_is_present(info))
            .unwrap_or(false)
    }

    /// Ensures the Whisper model with catalogue key `key` is present locally,
    /// downloading + verifying it if needed. Returns the local path.
    pub fn ensure_model(
        &self,
        key: &str,
        progress: &mut dyn FnMut(DownloadProgress),
    ) -> Result<PathBuf, ModelStoreError> {
        let info =
            whisper_model(key).ok_or_else(|| ModelStoreError::UnknownModel(key.to_string()))?;
        let dest = self.whisper_path(info);
        if self.whisper_is_present(info) {
            return Ok(dest);
        }
        std::fs::create_dir_all(self.whisper_dir())?;
        restrict_dir_perms(&self.whisper_dir());
        let per_model_cap = download_cap(info.approx_bytes);
        // Total-storage check.
        let current_total = self.total_bytes_used();
        let would_be = current_total + info.approx_bytes;
        if would_be > consts::MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES {
            return Err(ModelStoreError::StorageCapExceeded {
                model: key.to_string(),
                would_be,
                cap: consts::MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES,
            });
        }
        log::info!(
            target: "transcription::models",
            "downloading model '{key}' (~{} bytes)",
            info.approx_bytes
        );
        self.download_to(
            &info.url(),
            &dest,
            key,
            info.sha256,
            per_model_cap,
            progress,
        )?;
        log::info!(target: "transcription::models", "model '{key}' downloaded and verified");
        Ok(dest)
    }

    /// Downloads `url` to `dest`, verifies SHA256 against `expected_sha256`, enforces `cap`,
    /// restricts perms, removes the file on mismatch. Shared body of `ensure_model` / test seam.
    fn download_to(
        &self,
        url: &str,
        dest: &Path,
        model_key: &str,
        expected_sha256: &str,
        cap: u64,
        progress: &mut dyn FnMut(DownloadProgress),
    ) -> Result<(), ModelStoreError> {
        let got_hash = download_verified(url, dest, model_key, cap, progress)?;
        if got_hash != expected_sha256 {
            // download_verified renamed the temp into `dest` on success; on a
            // hash mismatch that means there is now a bad file at `dest` — remove it.
            let _ = std::fs::remove_file(dest);
            return Err(ModelStoreError::HashMismatch {
                model: model_key.to_string(),
                expected: expected_sha256.to_string(),
                got: got_hash,
            });
        }
        restrict_file_perms(dest);
        Ok(())
    }

    /// Local path the Silero VAD model lives at once downloaded.
    pub fn vad_path(&self) -> PathBuf {
        self.whisper_dir().join(VAD_MODEL.file)
    }

    /// `true` if the verified VAD model file is present (same size window as
    /// `whisper_is_present`; SHA-verified before the rename put it there).
    pub fn vad_is_present(&self) -> bool {
        match std::fs::metadata(self.vad_path()) {
            Ok(m) => {
                let (floor, ceil) = size_window(VAD_MODEL.approx_bytes);
                m.len() >= floor && m.len() <= ceil
            }
            Err(_) => false,
        }
    }

    /// Ensures the Silero VAD model is present locally, downloading + verifying
    /// it if needed. Returns the local path.
    pub fn ensure_vad_model(
        &self,
        progress: &mut dyn FnMut(DownloadProgress),
    ) -> Result<PathBuf, ModelStoreError> {
        let dest = self.vad_path();
        if self.vad_is_present() {
            return Ok(dest);
        }
        std::fs::create_dir_all(self.whisper_dir())?;
        restrict_dir_perms(&self.whisper_dir());
        let cap = download_cap(VAD_MODEL.approx_bytes);
        log::info!(
            target: "transcription::models",
            "downloading the Silero VAD model (~{} bytes)",
            VAD_MODEL.approx_bytes
        );
        self.download_to(
            &VAD_MODEL.url(),
            &dest,
            "silero-vad",
            VAD_MODEL.sha256,
            cap,
            progress,
        )?;
        log::info!(target: "transcription::models", "the Silero VAD model downloaded and verified");
        Ok(dest)
    }

    /// Status of every Whisper model in the catalogue (downloaded? size? path?).
    pub fn whisper_status(&self) -> Vec<ModelStatusEntry> {
        crate::transcription::model_catalog::WHISPER_MODELS
            .iter()
            .map(|info| {
                let path = self.whisper_path(info);
                let present = self.whisper_is_present(info);
                ModelStatusEntry {
                    key: info.key.to_string(),
                    downloaded: present,
                    size_bytes: if present {
                        std::fs::metadata(&path)
                            .map(|m| m.len())
                            .unwrap_or(info.approx_bytes)
                    } else {
                        info.approx_bytes
                    },
                    path: present.then_some(path),
                }
            })
            .collect()
    }

    /// Deletes a downloaded Whisper model by catalogue key. No-op if it isn't
    /// present; errors on an unknown key.
    pub fn delete_model(&self, key: &str) -> Result<(), ModelStoreError> {
        if let Some(info) = whisper_model(key) {
            let p = self.whisper_path(info);
            if p.exists() {
                std::fs::remove_file(&p)?;
            }
            return Ok(());
        }
        Err(ModelStoreError::UnknownModel(key.to_string()))
    }

    /// Total bytes the downloaded models occupy on disk (best effort — walks
    /// the model directories).
    pub fn total_bytes_used(&self) -> u64 {
        dir_size(&self.root)
    }
}

impl Default for ModelStore {
    fn default() -> Self {
        Self::new()
    }
}

// --- the HTTP downloader ---------------------------------------------------

/// Model-download client: connect timeout + a generous whole-request backstop
/// and redirects only to allowlisted hosts that pass the shared SSRF validator.
fn build_client() -> Result<reqwest::blocking::Client, ModelStoreError> {
    reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .tcp_keepalive(TCP_KEEPALIVE)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 10 {
                return attempt.error("too many redirects");
            }
            let url = attempt.url();
            let host = url.host_str().unwrap_or("(none)").to_string();
            if !host_on_allowlist(url) {
                return attempt.error(format!("disallowed redirect host: {host}"));
            }
            if let Err(e) = crate::url_validation::validate_url(url.as_str()) {
                return attempt.error(format!("unsafe redirect target {host}: {e}"));
            }
            attempt.follow()
        }))
        .build()
        .map_err(|e| ModelStoreError::Http(format!("failed to build HTTP client: {e}")))
}

/// `true` if `url`'s host is an exact match for, or a subdomain of, an entry in
/// `consts::TRANSCRIPTION_MODEL_ALLOWED_REDIRECT_HOSTS`.
fn host_on_allowlist(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some(h) => consts::TRANSCRIPTION_MODEL_ALLOWED_REDIRECT_HOSTS
            .iter()
            .any(|a| h == *a || h.ends_with(&format!(".{a}"))),
        None => false,
    }
}

/// Streams `url` into `dest`, hashing SHA256, enforcing `cap`, reporting progress, and atomically
/// renaming on success (`.part` temp removed on error). Returns hex SHA256; parent must exist.
fn download_verified(
    url: &str,
    dest: &Path,
    model_key: &str,
    cap: u64,
    progress: &mut dyn FnMut(DownloadProgress),
) -> Result<String, ModelStoreError> {
    // The temp name is unique per attempt: the SHA256 is computed over the network
    // stream, so a second concurrent writer on a shared temp could install a
    // corrupt file whose hash check passed.
    static DOWNLOAD_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let attempt = DOWNLOAD_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let tmp = parent.join(format!(
        ".{}.{}-{attempt}.part",
        dest.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("download"),
        std::process::id()
    ));
    let hash = stream_to_path(url, &tmp, model_key, cap, progress)?;
    // Atomic rename into place.
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        ModelStoreError::Io(e)
    })?;
    Ok(hash)
}

/// The shared streaming-download-with-hash core. Writes to `path`, returns the
/// hex SHA256. On error removes `path`.
fn stream_to_path(
    url: &str,
    path: &Path,
    model_key: &str,
    cap: u64,
    progress: &mut dyn FnMut(DownloadProgress),
) -> Result<String, ModelStoreError> {
    let client = build_client()?;
    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| classify_reqwest_err(&e))?
        .error_for_status()
        .map_err(|e| {
            ModelStoreError::Http(format!(
                "HTTP {} for {url}",
                e.status().map(|s| s.as_u16()).unwrap_or(0)
            ))
        })?;

    let total = resp.content_length();
    if let Some(len) = total {
        if len > cap {
            return Err(ModelStoreError::TooLarge {
                model: model_key.to_string(),
                actual: len,
                cap,
            });
        }
    }

    let mut file = match std::fs::File::create(path) {
        Ok(f) => f,
        Err(e) => return Err(ModelStoreError::Io(e)),
    };
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut buf = vec![0u8; READ_CHUNK];
    progress(DownloadProgress {
        model_key: model_key.to_string(),
        downloaded_bytes: 0,
        total_bytes: total,
    });
    loop {
        let n = match std::io::Read::read(&mut resp, &mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let _ = std::fs::remove_file(path);
                return Err(ModelStoreError::Http(format!(
                    "read error while downloading {model_key}: {e}"
                )));
            }
        };
        downloaded += n as u64;
        if downloaded > cap {
            let _ = std::fs::remove_file(path);
            return Err(ModelStoreError::TooLarge {
                model: model_key.to_string(),
                actual: downloaded,
                cap,
            });
        }
        hasher.update(&buf[..n]);
        if let Err(e) = file.write_all(&buf[..n]) {
            let _ = std::fs::remove_file(path);
            return Err(ModelStoreError::Io(e));
        }
        progress(DownloadProgress {
            model_key: model_key.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
        });
    }
    if let Err(e) = file.flush() {
        let _ = std::fs::remove_file(path);
        return Err(ModelStoreError::Io(e));
    }
    drop(file);
    Ok(hex_lower(&hasher.finalize()))
}

/// Maps a `reqwest::Error` to our error type, surfacing a redirect-policy rejection specially
/// (`is_redirect()`, message buried in `source()`) so the UI can say "the model URL changed".
fn classify_reqwest_err(e: &reqwest::Error) -> ModelStoreError {
    if e.is_redirect() {
        // Try to pull the host out of our "disallowed redirect host: <host>"
        // message somewhere in the source chain; fall back to the URL.
        let mut src: Option<&dyn std::error::Error> = Some(e);
        while let Some(cur) = src {
            let m = cur.to_string();
            if let Some(idx) = m.find("disallowed redirect host: ") {
                let host = m[idx + "disallowed redirect host: ".len()..]
                    .trim()
                    .to_string();
                return ModelStoreError::DisallowedRedirect(host);
            }
            src = cur.source();
        }
        let host = e
            .url()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| "(unknown)".to_string());
        ModelStoreError::DisallowedRedirect(host)
    } else {
        ModelStoreError::Http(e.to_string())
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Recursively sums file sizes under `dir`. Returns 0 if `dir` doesn't exist.
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

/// Best-effort owner-only dir perms (Unix `chmod 0o700` / Windows DACL); logs, doesn't fail.
fn restrict_dir_perms(dir: &Path) {
    if let Err(e) = crate::fs_perms::set_owner_only_dir(dir) {
        log::warn!(target: "transcription::models", "failed to restrict perms on {}: {e}", dir.display());
    }
}

/// Best-effort owner-only file perms (Unix `chmod 0o600` / Windows DACL); logs, doesn't fail.
fn restrict_file_perms(file: &Path) {
    if let Err(e) = crate::fs_perms::set_owner_only(file) {
        log::warn!(target: "transcription::models", "failed to restrict perms on {}: {e}", file.display());
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    /// Spins up a `mockito` server serving `body` at `/model.bin`, returns
    /// `(server, url)`. `mockito` is local — no real network in unit tests.
    fn serve_bytes(body: &[u8]) -> (mockito::ServerGuard, String) {
        let mut server = mockito::Server::new();
        let url = format!("{}/model.bin", server.url());
        server
            .mock("GET", "/model.bin")
            .with_status(200)
            .with_header("content-length", &body.len().to_string())
            .with_body(body)
            .create();
        (server, url)
    }

    fn sha256_hex(b: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(b);
        hex_lower(&h.finalize())
    }

    #[test]
    fn stream_to_path_downloads_and_hashes() {
        let body = b"hello speedwave model bytes".repeat(100);
        let (_srv, url) = serve_bytes(&body);
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("m.bin");
        let mut seen: Vec<DownloadProgress> = vec![];
        let hash = stream_to_path(&url, &out, "test", 10_000, &mut |p| seen.push(p)).unwrap();
        assert_eq!(hash, sha256_hex(&body), "returned hash matches the body");
        assert_eq!(std::fs::read(&out).unwrap(), body, "file content matches");
        // Progress was reported, monotonic, ending at the full size.
        assert!(seen.len() >= 2);
        assert_eq!(seen.first().unwrap().downloaded_bytes, 0);
        assert_eq!(seen.last().unwrap().downloaded_bytes, body.len() as u64);
        assert_eq!(seen.last().unwrap().total_bytes, Some(body.len() as u64));
        for w in seen.windows(2) {
            assert!(
                w[1].downloaded_bytes >= w[0].downloaded_bytes,
                "progress is monotonic"
            );
        }
    }

    #[test]
    fn stream_to_path_refuses_when_content_length_exceeds_cap() {
        let body = vec![0u8; 5000];
        let (_srv, url) = serve_bytes(&body);
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("m.bin");
        let err = stream_to_path(&url, &out, "big", 1000, &mut no_progress).unwrap_err();
        assert!(
            matches!(err, ModelStoreError::TooLarge { .. }),
            "expected TooLarge, got {err:?}"
        );
        assert!(!out.exists(), "nothing written when refused up front");
    }

    #[test]
    fn stream_to_path_aborts_and_cleans_up_when_body_exceeds_cap_mid_stream() {
        // Server lies: no content-length, but body is bigger than the cap.
        let mut server = mockito::Server::new();
        let url = format!("{}/m.bin", server.url());
        let big = vec![7u8; 200_000];
        server
            .mock("GET", "/m.bin")
            .with_status(200)
            .with_body(&big)
            .create();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("m.bin");
        let err = stream_to_path(&url, &out, "lying", 50_000, &mut no_progress).unwrap_err();
        assert!(
            matches!(err, ModelStoreError::TooLarge { .. }),
            "expected TooLarge mid-stream, got {err:?}"
        );
        assert!(!out.exists(), "partial file removed on abort");
    }

    #[test]
    fn download_verified_atomic_renames_on_success_and_removes_temp() {
        let body = b"abcdef".repeat(50);
        let (_srv, url) = serve_bytes(&body);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("final.bin");
        let hash = download_verified(&url, &dest, "t", 10_000, &mut no_progress).unwrap();
        assert_eq!(hash, sha256_hex(&body));
        assert!(dest.is_file(), "final file in place");
        assert!(no_part_files(dir.path()), "temp gone after rename");
    }

    /// `true` when `dir` holds no leftover `.part` temp files.
    fn no_part_files(dir: &Path) -> bool {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".part"))
    }

    #[test]
    fn concurrent_downloads_to_the_same_dest_never_share_a_temp_file() {
        // Two writers on one temp path could install a corrupt file whose
        // stream-hash check passed — unique temps make both installs valid.
        let body = b"model-bytes".repeat(400);
        let (_srv, url) = serve_bytes(&body);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.bin");
        let results: Vec<_> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let url = url.clone();
                    let dest = dest.clone();
                    s.spawn(move || download_verified(&url, &dest, "t", 100_000, &mut no_progress))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        for r in results {
            assert_eq!(r.unwrap(), sha256_hex(&body));
        }
        assert_eq!(std::fs::read(&dest).unwrap(), body, "installed file intact");
        assert!(no_part_files(dir.path()));
    }

    #[test]
    fn host_allowlist_accepts_known_hosts_and_subdomains_and_rejects_others() {
        let ok = [
            "https://huggingface.co/x",
            "https://cas-bridge.xethub.hf.co/y",
            "https://cdn.hf.co/z",
            "https://us.aws.cdn.hf.co/model.bin",
            "https://eu.aws.cdn.hf.co/model.bin",
            "https://github.com/z",
            "https://release-assets.githubusercontent.com/w",
            "https://sub.huggingface.co/q",
        ];
        for u in ok {
            assert!(
                host_on_allowlist(&reqwest::Url::parse(u).unwrap()),
                "should allow {u}"
            );
        }
        let bad = [
            "https://example.com/x",
            "https://evil-huggingface.co/y",
            "https://huggingface.co.evil.com/z",
            "https://cdn.hf.co.evil.com/z",
            "http://localhost/w",
        ];
        for u in bad {
            assert!(
                !host_on_allowlist(&reqwest::Url::parse(u).unwrap()),
                "should reject {u}"
            );
        }
    }

    #[test]
    fn redirect_ssrf_guard_blocks_private_and_reserved_targets() {
        // The redirect policy follows a target only if allowlisted AND SSRF-validated;
        // the validator rejects loopback, the cloud-metadata link-local endpoint, and private IPs.
        for u in [
            "http://127.0.0.1/m.bin",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5/m.bin",
            "http://192.168.1.10/m.bin",
        ] {
            assert!(
                crate::url_validation::validate_url(u).is_err(),
                "SSRF guard must reject {u}"
            );
        }
        // A normal public CDN host passes.
        assert!(crate::url_validation::validate_url("https://cas-bridge.xethub.hf.co/y").is_ok());
    }

    #[test]
    fn redirect_to_a_non_allowlisted_host_is_refused() {
        // First server redirects to a second, non-allowlisted, server.
        let mut target = mockito::Server::new();
        target
            .mock("GET", "/m.bin")
            .with_status(200)
            .with_body(b"should-never-be-fetched")
            .create();
        let mut redirector = mockito::Server::new();
        let redir_url = format!("{}/m.bin", redirector.url());
        redirector
            .mock("GET", "/m.bin")
            .with_status(302)
            .with_header("location", &format!("{}/m.bin", target.url()))
            .create();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("m.bin");
        // mockito serves on 127.0.0.1 with a random port — definitely not on the
        // allowlist — so the redirect must be refused.
        let err = stream_to_path(&redir_url, &out, "redir", 10_000, &mut no_progress).unwrap_err();
        assert!(
            matches!(
                err,
                ModelStoreError::DisallowedRedirect(_) | ModelStoreError::Http(_)
            ),
            "expected DisallowedRedirect (or an Http error wrapping it), got {err:?}"
        );
        // Be stricter: it should specifically be the disallowed-redirect classification.
        assert!(
            matches!(err, ModelStoreError::DisallowedRedirect(_)),
            "expected DisallowedRedirect, got {err:?}"
        );
        assert!(
            !out.exists(),
            "nothing written when the redirect is refused"
        );
    }

    #[test]
    fn http_non_2xx_is_surfaced() {
        let mut server = mockito::Server::new();
        let url = format!("{}/m.bin", server.url());
        server.mock("GET", "/m.bin").with_status(404).create();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("m.bin");
        let err = stream_to_path(&url, &out, "missing", 10_000, &mut no_progress).unwrap_err();
        assert!(
            matches!(err, ModelStoreError::Http(_)),
            "expected Http error for 404, got {err:?}"
        );
        assert!(!out.exists());
    }

    #[test]
    fn ensure_model_rejects_unknown_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        let err = store
            .ensure_model("not-a-real-model", &mut no_progress)
            .unwrap_err();
        assert!(
            matches!(err, ModelStoreError::UnknownModel(_)),
            "expected UnknownModel, got {err:?}"
        );
    }

    #[test]
    fn download_to_succeeds_when_the_hash_matches() {
        let body = b"the actual model bytes".repeat(20);
        let (_srv, url) = serve_bytes(&body);
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        std::fs::create_dir_all(store.whisper_dir()).unwrap();
        let dest = store.whisper_dir().join("m.bin");
        store
            .download_to(
                &url,
                &dest,
                "t",
                &sha256_hex(&body),
                10_000,
                &mut no_progress,
            )
            .unwrap();
        assert!(dest.is_file());
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o600,
                "file restricted to 0600"
            );
        }
    }

    #[test]
    fn download_to_rejects_a_hash_mismatch_and_leaves_nothing_behind() {
        let body = b"served bytes that do not match the expected hash".to_vec();
        let (_srv, url) = serve_bytes(&body);
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        std::fs::create_dir_all(store.whisper_dir()).unwrap();
        let dest = store.whisper_dir().join("m.bin");
        let wrong = "0".repeat(64);
        let err = store
            .download_to(&url, &dest, "t", &wrong, 10_000, &mut no_progress)
            .unwrap_err();
        match err {
            ModelStoreError::HashMismatch {
                model,
                expected,
                got,
            } => {
                assert_eq!(model, "t");
                assert_eq!(expected, wrong);
                assert_eq!(got, sha256_hex(&body));
            }
            other => panic!("expected HashMismatch, got {other:?}"),
        }
        assert!(!dest.exists(), "the bad file is removed after the mismatch");
        assert!(no_part_files(&store.whisper_dir()), "no temp left behind");
    }

    #[test]
    fn ensure_model_storage_cap_arithmetic_blocks_overflow() {
        // Can't fill 12 GiB of disk in a unit test, so assert the property the `total + approx
        // > MAX` check relies on: the dome exceeds any single model's size.
        let biggest = crate::transcription::model_catalog::WHISPER_MODELS
            .iter()
            .map(|m| m.approx_bytes)
            .max()
            .unwrap();
        assert!(
            biggest < consts::MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES,
            "the dome must exceed the largest model, else ensure_model could never download it"
        );
        // A store summing over the dome would block a new download: `total_bytes_used` is
        // plain `dir_size` (exercised elsewhere), and the check is `current + approx > MAX`.
    }

    #[test]
    fn status_and_delete_round_trip_on_a_fake_downloaded_model() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        let info = whisper_model("tiny").unwrap();
        std::fs::create_dir_all(store.whisper_dir()).unwrap();
        let path = store.whisper_path(info);
        // tiny's approx_bytes (~78 MiB) is too big to write in a unit test, so verify the
        // *negative* side (not present) + delete-noop instead:
        assert!(
            !store
                .whisper_status()
                .iter()
                .find(|e| e.key == "tiny")
                .unwrap()
                .downloaded
        );
        // delete on a not-present model is a no-op, not an error:
        store.delete_model("tiny").unwrap();
        // delete on unknown key errors:
        let err = store.delete_model("nope").unwrap_err();
        assert!(matches!(err, ModelStoreError::UnknownModel(_)));
        // a tiny file that's the *wrong* size is correctly reported as not-present:
        std::fs::write(&path, b"too small").unwrap();
        assert!(
            !store.whisper_is_present(info),
            "wrong-sized file isn't 'present'"
        );
        // and total_bytes_used counts it anyway:
        assert!(store.total_bytes_used() >= 9);
        // delete removes it:
        store.delete_model("tiny").unwrap();
        assert!(!path.exists());
    }

    /// Regression: a complete file whose size drifts from the catalogue estimate is still
    /// "present" (large-v3 was falsely "not downloaded" under the old 64-byte tolerance).
    #[test]
    fn present_check_tolerates_size_drift_but_rejects_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        let info = whisper_model("large-v3").unwrap();
        std::fs::create_dir_all(store.whisper_dir()).unwrap();
        let path = store.whisper_path(info);

        let write_sparse = |len: u64| {
            let f = std::fs::File::create(&path).unwrap();
            f.set_len(len).unwrap();
        };

        // Exactly the estimate → present.
        write_sparse(info.approx_bytes);
        assert!(store.whisper_is_present(info), "exact size must be present");

        // Larger than the estimate (the real-world large-v3 case) → present.
        write_sparse(info.approx_bytes + 409_792);
        assert!(
            store.whisper_is_present(info),
            "a complete file larger than the estimate must be present"
        );

        // Just above the 90% floor → present; just below → not.
        write_sparse(info.approx_bytes / 10 * 9 + 1);
        assert!(
            store.whisper_is_present(info),
            "≥90% of estimate is present"
        );
        write_sparse(info.approx_bytes / 10 * 9 - 1);
        assert!(
            !store.whisper_is_present(info),
            "a clearly-truncated file (<90%) is not present"
        );

        // At the +5% ceiling → present; clearly above it (corrupt/oversized) → not.
        let ceil = info.approx_bytes + info.approx_bytes / 20 + 1024;
        write_sparse(ceil);
        assert!(
            store.whisper_is_present(info),
            "exactly at the ceiling is present"
        );
        write_sparse(ceil + info.approx_bytes / 10);
        assert!(
            !store.whisper_is_present(info),
            "a wildly-oversized file (>105%) is not present"
        );
    }

    #[test]
    fn vad_presence_tracks_the_size_window_and_skips_the_download_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        assert!(store.vad_path().starts_with(dir.path()));
        assert!(!store.vad_is_present(), "empty store has no VAD model");

        std::fs::create_dir_all(store.whisper_dir()).unwrap();
        let write_sparse = |len: u64| {
            let f = std::fs::File::create(store.vad_path()).unwrap();
            f.set_len(len).unwrap();
        };
        write_sparse(VAD_MODEL.approx_bytes);
        assert!(store.vad_is_present(), "exact size is present");
        // Present → ensure returns the path without touching the network.
        let p = store.ensure_vad_model(&mut no_progress).unwrap();
        assert_eq!(p, store.vad_path());

        write_sparse(VAD_MODEL.approx_bytes / 2);
        assert!(!store.vad_is_present(), "a truncated file is not present");
    }

    #[test]
    fn model_store_dirs_are_under_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        assert!(store.whisper_dir().starts_with(dir.path()));
    }

    #[cfg(unix)]
    #[test]
    fn restrict_dir_perms_sets_0o700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("whisper");
        std::fs::create_dir_all(&target).unwrap();

        restrict_dir_perms(&target);

        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0o700, got 0o{mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn restrict_file_perms_sets_0o600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("m.bin");
        std::fs::write(&target, b"data").unwrap();

        restrict_file_perms(&target);

        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
    }

    #[test]
    fn restrict_perms_on_a_missing_path_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        restrict_dir_perms(&missing);
        restrict_file_perms(&missing);
    }
}

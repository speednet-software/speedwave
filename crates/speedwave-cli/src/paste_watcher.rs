//! Host-side clipboard watcher for CLI paste (ADR-065).

use anyhow::{Context, Result};
use arboard::Clipboard;
use image::{ColorType, ImageEncoder};
use speedwave_runtime::consts::DATA_DIR;
use speedwave_runtime::fs_perms::set_owner_only;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const POLL_MS: u64 = 250;

/// `<project>/<DATA_DIR>/pastes/clip.png` — composed from SSOT.
pub fn clip_path(project_dir: &Path) -> PathBuf {
    project_dir.join(DATA_DIR).join("pastes").join("clip.png")
}

/// Owned watcher handle — drop or call `stop()` to terminate.
pub struct PasteWatcher {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl PasteWatcher {
    /// Spawns the watcher thread; returns immediately.
    pub fn spawn(project_dir: PathBuf) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let handle = thread::spawn(move || run_loop(&project_dir, &stop_clone));
        Self {
            stop,
            handle: Some(handle),
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for PasteWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_loop(project_dir: &Path, stop: &AtomicBool) {
    let target = clip_path(project_dir);
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("cannot create paste directory {}: {e}", parent.display());
            return;
        }
    }

    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("clipboard unavailable: {e} — CLI paste disabled");
            return;
        }
    };

    let mut last_hash: Option<u64> = None;
    while !stop.load(Ordering::Relaxed) {
        match clipboard.get_image() {
            Ok(img) => {
                let h = hash_image(&img);
                if Some(h) != last_hash {
                    if let Err(e) = write_png(&target, &img) {
                        log::warn!("failed to write {}: {e}", target.display());
                    } else {
                        log::debug!("wrote {} ({}x{})", target.display(), img.width, img.height);
                    }
                    last_hash = Some(h);
                }
            }
            Err(arboard::Error::ContentNotAvailable) => {
                // No image in clipboard — keep the last file (or absence) as is.
            }
            Err(e) => {
                log::trace!("failed to get clipboard image: {e}");
            }
        }
        thread::sleep(Duration::from_millis(POLL_MS));
    }
}

fn hash_image(img: &arboard::ImageData<'_>) -> u64 {
    let mut h = DefaultHasher::new();
    img.width.hash(&mut h);
    img.height.hash(&mut h);
    img.bytes.as_ref().hash(&mut h);
    h.finish()
}

fn write_png(target: &Path, img: &arboard::ImageData<'_>) -> Result<()> {
    let tmp = target.with_extension("png.tmp");
    {
        let file =
            std::fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let writer = std::io::BufWriter::new(file);
        let encoder = image::codecs::png::PngEncoder::new(writer);
        encoder
            .write_image(
                &img.bytes,
                img.width as u32,
                img.height as u32,
                ColorType::Rgba8.into(),
            )
            .context("png encode")?;
    }
    // Owner-only perm BEFORE rename so the final inode never appears world-readable.
    restrict_paste_perms(&tmp)?;
    std::fs::rename(&tmp, target).with_context(|| format!("rename → {}", target.display()))?;
    Ok(())
}

/// Unix: a chmod failure aborts the paste. Windows: DACL calls can transiently
/// fail under AV/EDR, so it degrades to warn-and-continue instead.
#[cfg(unix)]
fn restrict_paste_perms(tmp: &Path) -> Result<()> {
    set_owner_only(tmp)
        .map_err(|e| anyhow::anyhow!(e))
        .with_context(|| format!("owner-only perms {}", tmp.display()))
}

#[cfg(not(unix))]
fn restrict_paste_perms(tmp: &Path) -> Result<()> {
    if let Err(e) = set_owner_only(tmp) {
        log::warn!("owner-only perms failed for {}: {e}", tmp.display());
    }
    Ok(())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;

    #[test]
    fn clip_path_is_under_project_pastes_dir() {
        let p = clip_path(Path::new("/tmp/proj"));
        // Join-built on both sides — a formatted literal diverges on Windows separators.
        assert_eq!(
            p,
            Path::new("/tmp/proj")
                .join(DATA_DIR)
                .join("pastes")
                .join("clip.png")
        );
    }

    #[test]
    fn hash_differs_for_different_pixels() {
        let a = arboard::ImageData {
            width: 2,
            height: 2,
            bytes: vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].into(),
        };
        let b = arboard::ImageData {
            width: 2,
            height: 2,
            bytes: vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 99].into(),
        };
        assert_ne!(hash_image(&a), hash_image(&b));
    }

    #[test]
    fn hash_stable_for_same_image() {
        let a = arboard::ImageData {
            width: 1,
            height: 1,
            bytes: vec![255, 128, 64, 255].into(),
        };
        let h1 = hash_image(&a);
        let h2 = hash_image(&a);
        assert_eq!(h1, h2);
    }

    #[test]
    fn write_png_atomic_creates_file() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("clip.png");
        let img = arboard::ImageData {
            width: 2,
            height: 2,
            bytes: vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ]
            .into(),
        };
        write_png(&target, &img).unwrap();
        assert!(target.is_file());
        let bytes = std::fs::read(&target).unwrap();
        assert!(
            bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "not a PNG: {:?}",
            &bytes[..8]
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_png_creates_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("clip.png");
        let img = arboard::ImageData {
            width: 1,
            height: 1,
            bytes: vec![1, 2, 3, 4].into(),
        };
        write_png(&target, &img).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {:o}", mode);
    }

    #[cfg(unix)]
    #[test]
    fn restrict_paste_perms_fails_on_nonexistent_path_unix() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist.png.tmp");
        assert!(restrict_paste_perms(&missing).is_err());
    }

    #[cfg(not(unix))]
    #[test]
    fn restrict_paste_perms_degrades_to_ok_on_failure_non_unix() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist.png.tmp");
        assert!(
            restrict_paste_perms(&missing).is_ok(),
            "a DACL failure must warn-and-continue, not fail the paste"
        );
    }

    #[test]
    fn watcher_stops_cleanly() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = PasteWatcher::spawn(tmp.path().to_path_buf());
        thread::sleep(Duration::from_millis(50));
        w.stop();
    }
}

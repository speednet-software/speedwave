//! Host-side clipboard watcher for CLI paste (ADR-065).

use anyhow::{Context, Result};
use arboard::Clipboard;
use image::{ColorType, ImageEncoder};
use speedwave_runtime::consts::DATA_DIR;
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
            log::warn!("paste_watcher: cannot create {}: {e}", parent.display());
            return;
        }
    }

    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("paste_watcher: clipboard unavailable: {e} — CLI paste disabled");
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
                        log::warn!("paste_watcher: write {} failed: {e}", target.display());
                    } else {
                        log::debug!(
                            "paste_watcher: wrote {} ({}x{})",
                            target.display(),
                            img.width,
                            img.height
                        );
                    }
                    last_hash = Some(h);
                }
            }
            Err(arboard::Error::ContentNotAvailable) => {
                // No image in clipboard — keep the last file (or absence) as is.
            }
            Err(e) => {
                log::trace!("paste_watcher: get_image error: {e}");
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
    set_owner_only(&tmp)?;
    std::fs::rename(&tmp, target).with_context(|| format!("rename → {}", target.display()))?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod 600 {}", path.display()))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<()> {
    // Windows: NTFS ACLs handled by parent dir creation; no per-file chmod.
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn clip_path_is_under_project_pastes_dir() {
        let p = clip_path(Path::new("/tmp/proj"));
        assert_eq!(
            p,
            PathBuf::from(format!("/tmp/proj/{DATA_DIR}/pastes/clip.png"))
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

    #[test]
    fn watcher_stops_cleanly() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = PasteWatcher::spawn(tmp.path().to_path_buf());
        thread::sleep(Duration::from_millis(50));
        w.stop();
    }
}

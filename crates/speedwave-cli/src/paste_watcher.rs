//! Host-side clipboard watcher for CLI paste (ADR-065).

use anyhow::{Context, Result};
use arboard::Clipboard;
use image::{ColorType, ImageEncoder};
use speedwave_runtime::pastes::open_pastes_dir;
use speedwave_runtime::pinned_dir::PinnedDir;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const POLL_MS: u64 = 250;

const CLIP_FILE: &str = "clip.png";

const CLIP_TMP_FILE: &str = "clip.png.tmp";

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
    if let Err(e) = open_pastes_dir(project_dir) {
        log::warn!(
            "cannot open the paste directory of {}: {e}",
            project_dir.display()
        );
        return;
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
                    match write_clip(project_dir, &img) {
                        Ok(target) => {
                            log::debug!("wrote {} ({}x{})", target.display(), img.width, img.height)
                        }
                        Err(e) => log::warn!(
                            "failed to write the clipboard image of {}: {e:#}",
                            project_dir.display()
                        ),
                    }
                    last_hash = Some(h);
                }
            }
            Err(arboard::Error::ContentNotAvailable) => {}
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

fn write_clip(project_dir: &Path, img: &arboard::ImageData<'_>) -> Result<PathBuf> {
    let dir = open_pastes_dir(project_dir).map_err(anyhow::Error::msg)?;
    write_png(&dir, img)?;
    Ok(dir.path().join(CLIP_FILE))
}

fn write_png(dir: &PinnedDir, img: &arboard::ImageData<'_>) -> Result<()> {
    dir.remove_file(CLIP_TMP_FILE).map_err(anyhow::Error::msg)?;
    let file = dir
        .create_new_file(CLIP_TMP_FILE)
        .map_err(anyhow::Error::msg)?;
    let mut writer = BufWriter::new(file);
    image::codecs::png::PngEncoder::new(&mut writer)
        .write_image(
            &img.bytes,
            img.width as u32,
            img.height as u32,
            ColorType::Rgba8.into(),
        )
        .context("png encode")?;
    let file = writer
        .into_inner()
        .map_err(|e| anyhow::anyhow!("flush {CLIP_TMP_FILE}: {}", e.error()))?;
    dir.persist(file, CLIP_TMP_FILE, CLIP_FILE)
        .map_err(anyhow::Error::msg)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;
    use speedwave_runtime::consts::DATA_DIR;
    use speedwave_runtime::pastes::PASTES_DIR;

    fn red_pixels() -> arboard::ImageData<'static> {
        arboard::ImageData {
            width: 2,
            height: 2,
            bytes: vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ]
            .into(),
        }
    }

    fn pastes_dir_of(project_dir: &Path) -> PathBuf {
        project_dir.join(DATA_DIR).join(PASTES_DIR)
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
    fn write_clip_writes_a_png_into_the_project_paste_directory() {
        let tmp = tempfile::tempdir().unwrap();

        let target = write_clip(tmp.path(), &red_pixels()).unwrap();

        assert_eq!(target, pastes_dir_of(tmp.path()).join(CLIP_FILE));
        let bytes = std::fs::read(&target).unwrap();
        assert!(
            bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "not a PNG: {:?}",
            &bytes[..8]
        );
        assert!(!pastes_dir_of(tmp.path()).join(CLIP_TMP_FILE).exists());
    }

    #[test]
    fn write_clip_replaces_the_previous_clip_and_a_leftover_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let first = write_clip(tmp.path(), &red_pixels()).unwrap();
        std::fs::write(&first, "stale").unwrap();
        std::fs::write(pastes_dir_of(tmp.path()).join(CLIP_TMP_FILE), "leftover").unwrap();

        let second = write_clip(tmp.path(), &red_pixels()).unwrap();

        assert_eq!(first, second);
        assert!(std::fs::read(&second)
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(!pastes_dir_of(tmp.path()).join(CLIP_TMP_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_clip_creates_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();

        let target = write_clip(tmp.path(), &red_pixels()).unwrap();

        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {:o}", mode);
    }

    #[cfg(unix)]
    #[test]
    fn write_clip_never_writes_through_a_symlinked_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("victim.txt");
        std::fs::write(&victim, "untouched").unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(pastes_dir_of(&project)).unwrap();
        std::os::unix::fs::symlink(&victim, pastes_dir_of(&project).join(CLIP_TMP_FILE)).unwrap();

        write_clip(&project, &red_pixels()).unwrap();

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
    }

    #[cfg(unix)]
    #[test]
    fn write_clip_refuses_a_symlinked_paste_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(project.join(DATA_DIR)).unwrap();
        std::os::unix::fs::symlink(&outside, pastes_dir_of(&project)).unwrap();

        assert!(write_clip(&project, &red_pixels()).is_err());

        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn watcher_stops_cleanly() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = PasteWatcher::spawn(tmp.path().to_path_buf());
        thread::sleep(Duration::from_millis(50));
        w.stop();
    }
}

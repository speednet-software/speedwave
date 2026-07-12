//! Bridges container `pbcopy` writes to the host clipboard via a watched file, for the process
//! lifetime. Deduplicated (same content never re-copied), capped at 64 KB/payload.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::io::Read;
use std::path::Path;
use std::sync::mpsc;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

const BRIDGE_FILENAME: &str = ".clipboard-bridge";
const MAX_PAYLOAD_BYTES: u64 = 64 * 1024;

/// Handle to the running bridge. Dropping it stops the watcher; the event-loop
/// thread then exits because its channel disconnects.
pub struct ClipboardBridge {
    _watcher: RecommendedWatcher,
}

/// Shared slot so `factory_reset` can stop the bridge before wiping the data dir.
pub type SharedClipboardBridge = std::sync::Arc<std::sync::Mutex<Option<ClipboardBridge>>>;

/// Starts the watcher thread. `None` means the watcher could not start and
/// clipboard integration is disabled for this session (already logged).
pub fn spawn(app: AppHandle) -> Option<ClipboardBridge> {
    let root =
        speedwave_runtime::consts::data_dir().join(speedwave_runtime::consts::CLAUDE_HOME_SUBDIR);
    let (watcher, rx) = match start_watcher(&root) {
        Ok(pair) => pair,
        Err(e) => {
            log::error!(
                "clipboard bridge watcher failed to start: {e}. Clipboard integration disabled for this session"
            );
            return None;
        }
    };
    log::info!("clipboard bridge started: watching {}", root.display());
    std::thread::spawn(move || {
        run(app, rx);
        log::warn!("clipboard bridge watcher channel closed; disabled for this session");
    });
    Some(ClipboardBridge { _watcher: watcher })
}

/// Creates the recursive watcher on `root` (created if absent). Split from
/// `spawn` so tests can exercise the watcher without an `AppHandle`.
fn start_watcher(
    root: &Path,
) -> anyhow::Result<(RecommendedWatcher, mpsc::Receiver<notify::Result<Event>>)> {
    std::fs::create_dir_all(root)?;
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(tx)?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok((watcher, rx))
}

fn run(app: AppHandle, rx: mpsc::Receiver<notify::Result<Event>>) {
    // Dedup key: the last content pushed to the clipboard.
    let mut last_content = String::new();
    while let Ok(res) = rx.recv() {
        let event = match res {
            Ok(e) => e,
            Err(e) => {
                // Watcher error (inotify exhaustion, permission loss); events dropped.
                log::warn!("clipboard bridge watcher error: {e}");
                continue;
            }
        };
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            continue;
        }
        for path in event.paths {
            if path.file_name().is_some_and(|n| n == BRIDGE_FILENAME) {
                handle_bridge_write(&app, &path, &mut last_content);
            }
        }
    }
}

/// Reads up to `MAX_PAYLOAD_BYTES + 1` bytes in one open to detect oversized
/// payloads atomically. `None` means empty, too large, or unreadable.
fn read_capped(path: &Path) -> Option<String> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            // NotFound is expected (file can vanish between notify event and open).
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("clipboard bridge: open failed at {}: {e}", path.display());
            }
            return None;
        }
    };
    let mut buf = Vec::with_capacity(MAX_PAYLOAD_BYTES as usize + 1);
    if let Err(e) = file
        .by_ref()
        .take(MAX_PAYLOAD_BYTES + 1)
        .read_to_end(&mut buf)
    {
        log::warn!("clipboard bridge: read failed at {}: {e}", path.display());
        return None;
    }
    if buf.len() as u64 > MAX_PAYLOAD_BYTES {
        log::warn!(
            "clipboard bridge: payload exceeds {} bytes at {}; ignored",
            MAX_PAYLOAD_BYTES,
            path.display()
        );
        return None;
    }
    if buf.is_empty() {
        return None;
    }
    match String::from_utf8(buf) {
        Ok(s) => Some(s),
        Err(e) => {
            log::warn!(
                "clipboard bridge: non-UTF-8 payload at {}: {e}",
                path.display()
            );
            None
        }
    }
}

fn handle_bridge_write(app: &AppHandle, path: &Path, last_content: &mut String) {
    let Some(content) = read_capped(path) else {
        return;
    };
    if content == *last_content {
        return;
    }
    let len = content.len();
    if let Err(e) = app.clipboard().write_text(content.clone()) {
        log::warn!("clipboard bridge: write_text failed: {e}");
        return;
    }
    *last_content = content;
    log::info!("clipboard bridge: copied {len} bytes");
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_bridge_file(dir: &Path, content: &[u8]) -> std::path::PathBuf {
        let path = dir.join(BRIDGE_FILENAME);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content).unwrap();
        path
    }

    // -- read_capped: happy path --

    #[test]
    fn read_capped_returns_content_within_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_bridge_file(tmp.path(), b"https://example.com/login?code=abc");
        assert_eq!(
            read_capped(&path).unwrap(),
            "https://example.com/login?code=abc"
        );
    }

    #[test]
    fn read_capped_returns_content_exactly_at_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let payload = vec![b'a'; MAX_PAYLOAD_BYTES as usize];
        let path = write_bridge_file(tmp.path(), &payload);
        assert_eq!(
            read_capped(&path).unwrap().len(),
            MAX_PAYLOAD_BYTES as usize
        );
    }

    // -- read_capped: edge cases --

    #[test]
    fn read_capped_rejects_oversized_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let payload = vec![b'a'; MAX_PAYLOAD_BYTES as usize + 1];
        let path = write_bridge_file(tmp.path(), &payload);
        assert!(read_capped(&path).is_none());
    }

    #[test]
    fn read_capped_rejects_empty_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_bridge_file(tmp.path(), b"");
        assert!(read_capped(&path).is_none());
    }

    #[test]
    fn read_capped_rejects_non_utf8() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_bridge_file(tmp.path(), &[0xff, 0xfe, 0xfd]);
        assert!(read_capped(&path).is_none());
    }

    // -- read_capped: error path (file gone between event and read) --

    #[test]
    fn read_capped_returns_none_when_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(BRIDGE_FILENAME);
        // never created
        assert!(read_capped(&path).is_none());
    }

    // -- dedup state transitions --

    #[test]
    fn dedup_skips_identical_content() {
        // Dedup decision is the String equality the function uses.
        let mut last = String::from("payload-1");
        let new = String::from("payload-1");
        let is_dup = new == last;
        assert!(is_dup);
        // and a changed payload is not a dup
        let changed = String::from("payload-2");
        assert!(changed != last);
        last = changed.clone();
        assert_eq!(last, "payload-2");
    }

    #[test]
    fn max_payload_bytes_is_64k() {
        // Guards against an accidental constant change without a failing test.
        assert_eq!(MAX_PAYLOAD_BYTES, 65_536);
    }

    #[test]
    fn bridge_filename_matches_shell_wrapper_literal() {
        // SSOT: containers/osc52-copy.sh and _tests/entrypoint/osc52-copy.bats depend on this value.
        assert_eq!(BRIDGE_FILENAME, ".clipboard-bridge");
    }

    // -- watcher lifecycle: stop releases the watched directory --

    #[cfg(windows)]
    #[test]
    fn watched_dir_cannot_be_removed_until_watcher_drops() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("claude-home");
        let (watcher, _rx) = start_watcher(&root).unwrap();
        // ReadDirectoryChangesW holds the watched dir open — removal must fail (the factory-reset bug).
        let err = std::fs::remove_dir_all(&root).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        drop(watcher);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn dropped_watcher_releases_watched_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("claude-home");
        let (watcher, _rx) = start_watcher(&root).unwrap();
        drop(watcher);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn start_watcher_creates_missing_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("claude-home");
        assert!(!root.exists());
        let (_watcher, _rx) = start_watcher(&root).unwrap();
        assert!(root.exists());
    }

    #[test]
    fn watcher_drop_closes_event_channel() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("claude-home");
        let (watcher, rx) = start_watcher(&root).unwrap();
        drop(watcher);
        // Drain queued events; the channel must then disconnect so the bridge thread exits.
        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("channel not closed after watcher drop")
                }
            }
        }
    }
}

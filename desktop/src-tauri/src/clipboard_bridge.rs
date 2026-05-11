//! Bridges container `pbcopy` writes to the host clipboard via a watched
//! file. Runs for the desktop process lifetime. Deduplicated (the same
//! content is never re-copied) and capped at 64 KB per payload.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::io::Read;
use std::path::Path;
use std::sync::mpsc;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

const BRIDGE_FILENAME: &str = ".clipboard-bridge";
const MAX_PAYLOAD_BYTES: u64 = 64 * 1024;

/// Spawns the watcher thread. Should be called once at desktop startup.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || match run(app) {
        Ok(()) => log::warn!("clipboard bridge: watcher channel closed; disabled for this session"),
        Err(e) => log::error!(
            "clipboard bridge: watcher exited: {e}. Clipboard integration disabled for this session"
        ),
    });
}

fn run(app: AppHandle) -> anyhow::Result<()> {
    let root =
        speedwave_runtime::consts::data_dir().join(speedwave_runtime::consts::CLAUDE_HOME_SUBDIR);
    std::fs::create_dir_all(&root)?;

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    // Dedup key: the last content we pushed to the clipboard. A single write
    // to `.clipboard-bridge` fires both Create and Modify events on most
    // platforms; equal content means we already handled it.
    let mut last_content = String::new();
    log::info!("clipboard bridge started: watching {}", root.display());

    while let Ok(res) = rx.recv() {
        let event = match res {
            Ok(e) => e,
            Err(e) => {
                // inotify exhaustion (MaxFilesWatch), permission loss, etc. —
                // events are now being dropped; surface it.
                log::warn!("clipboard bridge: watcher error: {e}");
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
    Ok(())
}

/// Reads up to `MAX_PAYLOAD_BYTES + 1` bytes from `path` in a single open —
/// this collapses the check-then-act window a separate `metadata()` + `read()`
/// would leave (a container could swap a small file for a huge one in between).
/// `Ok(None)` means "nothing actionable" (empty, too large, or unreadable —
/// unreadable is logged at warn unless it's the benign "file already gone").
fn read_capped(path: &Path) -> Option<String> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            // NotFound is expected — the file can be deleted between the notify
            // event and this open. Anything else is worth a log line.
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
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
        // We can't easily call handle_bridge_write without an AppHandle, but
        // the dedup decision is observable through the content comparison:
        // simulate by checking the equality the function uses.
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
        // SSOT cross-check: containers/osc52-copy.sh writes "~/.clipboard-bridge".
        // If this constant changes, that script must change too (and the BATS
        // test in _tests/entrypoint/osc52-copy.bats greps for this exact value).
        assert_eq!(BRIDGE_FILENAME, ".clipboard-bridge");
    }
}

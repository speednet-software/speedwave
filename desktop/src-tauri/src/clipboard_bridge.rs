//! Bridges container `pbcopy` writes to the host clipboard via a watched
//! file. Runs for the desktop process lifetime. Throttled to 1 write/sec,
//! max 64 KB payload.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

const BRIDGE_FILENAME: &str = ".clipboard-bridge";
const MAX_PAYLOAD_BYTES: u64 = 64 * 1024;
const THROTTLE_MS: u128 = 1000;

/// Spawns the watcher thread. Should be called once at desktop startup.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = run(app) {
            log::warn!("clipboard bridge: watcher exited: {e}");
        }
    });
}

fn run(app: AppHandle) -> anyhow::Result<()> {
    let root = speedwave_runtime::consts::data_dir().join("claude-home");
    std::fs::create_dir_all(&root)?;

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let last_write_ms = Arc::new(AtomicI64::new(0));
    log::info!("clipboard bridge started: watching {}", root.display());

    while let Ok(res) = rx.recv() {
        let Ok(event) = res else { continue };
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            continue;
        }
        for path in event.paths {
            if path.file_name().is_some_and(|n| n == BRIDGE_FILENAME) {
                handle_bridge_write(&app, &path, &last_write_ms);
            }
        }
    }
    Ok(())
}

fn handle_bridge_write(app: &AppHandle, path: &PathBuf, last_write_ms: &AtomicI64) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // Atomic claim: only the thread that wins compare_exchange proceeds.
    // Closes a check-then-act race where two events fire within THROTTLE_MS.
    let prev = last_write_ms.load(Ordering::Acquire);
    if now_ms.saturating_sub(prev) < THROTTLE_MS as i64 {
        log::debug!("clipboard bridge: throttled");
        return;
    }
    if last_write_ms
        .compare_exchange(prev, now_ms, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    std::thread::sleep(std::time::Duration::from_millis(50));
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if metadata.len() > MAX_PAYLOAD_BYTES {
        log::warn!(
            "clipboard bridge: oversized payload {} bytes at {}",
            metadata.len(),
            path.display()
        );
        return;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("clipboard bridge: read failed: {e}");
            return;
        }
    };
    if let Err(e) = app.clipboard().write_text(content) {
        log::warn!("clipboard bridge: write_text failed: {e}");
        return;
    }
    log::info!("clipboard bridge: copied {} bytes", metadata.len());
}

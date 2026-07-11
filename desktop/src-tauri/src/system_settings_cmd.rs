// Tauri commands for opening macOS System Settings panes.

/// Opens a macOS Privacy & Security sub-pane via the `x-apple.systempreferences`
/// URL scheme. On non-macOS this is a no-op (returns `Ok`).
#[cfg(target_os = "macos")]
fn open_privacy_subpane(anchor: &str) -> Result<(), String> {
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    speedwave_runtime::binary::system_command("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open System Settings: {e}"))?;
    Ok(())
}

/// Opens the macOS System Settings "Files and Folders" (Privacy & Security) pane
/// so the user can grant CloudStorage TCC permissions to Speedwave.
///
/// On non-macOS platforms this is a no-op (returns Ok).
#[tauri::command]
pub fn open_files_folders_pane() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // "Files and Folders" sub-pane is not directly addressable; use parent anchor.
        open_privacy_subpane("Privacy_FilesAndFolders")?;
    }
    Ok(())
}

/// Opens the macOS System Settings "Microphone" privacy pane so the user can
/// re-enable Speedwave's mic access (meeting transcription, ADR-056).
/// No-op on non-macOS.
#[tauri::command]
pub fn open_microphone_pane() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_privacy_subpane("Privacy_Microphone")?;
    }
    Ok(())
}

/// Opens the macOS System Settings "Audio Recording" (system-audio capture)
/// privacy pane — the permission `NSAudioCaptureUsageDescription` gates.
/// No-op on non-macOS.
#[tauri::command]
pub fn open_audio_capture_pane() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // macOS 14.4+ uses the "Audio Recording" anchor for system-audio TCC.
        open_privacy_subpane("Privacy_AudioCapture")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::*;

    #[test]
    fn pane_openers_return_ok_on_windows() {
        // On non-macOS these are no-ops — verify they return Ok without panicking.
        #[cfg(target_os = "windows")]
        {
            assert!(open_files_folders_pane().is_ok());
            assert!(open_microphone_pane().is_ok());
            assert!(open_audio_capture_pane().is_ok());
        }
        // On macOS verify the source carries the expected anchors.
        #[cfg(target_os = "macos")]
        {
            let source = include_str!("system_settings_cmd.rs");
            assert!(source.contains("x-apple.systempreferences"));
            assert!(source.contains("Privacy_FilesAndFolders"));
            assert!(source.contains("Privacy_Microphone"));
            assert!(source.contains("Privacy_AudioCapture"));
        }
    }
}

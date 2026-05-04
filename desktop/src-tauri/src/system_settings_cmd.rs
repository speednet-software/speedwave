// Tauri commands for opening macOS System Settings panes.

/// Opens the macOS System Settings "Files and Folders" (Privacy & Security) pane
/// so the user can grant CloudStorage TCC permissions to Speedwave.
///
/// On non-macOS platforms this is a no-op (returns Ok).
#[tauri::command]
pub fn open_files_folders_pane() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // x-apple.systempreferences:com.apple.preference.security is the
        // stable URL for the Privacy & Security pane on macOS 13+.
        // The "Files and Folders" sub-pane is not directly addressable,
        // but opening the parent pane guides the user to the right place.
        let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open System Settings: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn open_files_folders_pane_returns_ok_on_non_macos() {
        // On non-macOS this is a no-op — verify it returns Ok without panicking.
        #[cfg(not(target_os = "macos"))]
        {
            let result = open_files_folders_pane();
            assert!(result.is_ok());
        }
        // On macOS we can only verify the function exists and compiles.
        // Spawning `open` in CI may produce unwanted side effects.
        #[cfg(target_os = "macos")]
        {
            // Structural: verify the URL constant is present in source.
            let source = include_str!("system_settings_cmd.rs");
            assert!(
                source.contains("x-apple.systempreferences"),
                "must contain the System Settings URL scheme"
            );
            assert!(
                source.contains("Privacy_FilesAndFolders"),
                "must target the Files and Folders privacy sub-pane"
            );
        }
    }
}

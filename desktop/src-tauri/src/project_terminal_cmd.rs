//! Tauri commands: open the host terminal running the Speedwave CLI for a project, or
//! copy that same command to the clipboard.

use crate::auth_commands::{
    build_project_cli_command_for_platform, ensure_cli_installed, resolve_project_dirs,
    CliInvocation,
};
use crate::oauth_login_cmd::open_terminal_with_command;
use crate::types::check_project;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Tauri command: opens the user's terminal running `speedwave --project <project>`.
#[tauri::command]
pub async fn open_project_terminal(project: String) -> Result<(), String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        log::info!("opening project terminal for project {project}");
        let cmd = resolve_run_command(&project)?;
        open_terminal_with_command(
            CliInvocation::Run,
            &project,
            speedwave_runtime::consts::data_dir(),
            &cmd,
        )
        .map_err(|e| {
            log::error!("failed to spawn project terminal: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tauri command: copies the command `open_project_terminal` runs to the host clipboard.
#[tauri::command]
pub async fn copy_project_terminal_command(
    app: tauri::AppHandle,
    project: String,
) -> Result<(), String> {
    check_project(&project)?;
    let cmd = tokio::task::spawn_blocking(move || {
        log::info!("copying project terminal command for project {project}");
        resolve_run_command(&project)
    })
    .await
    .map_err(|e| e.to_string())??;
    app.clipboard().write_text(cmd).map_err(|e| {
        log::error!("failed to write project terminal command to clipboard: {e}");
        e.to_string()
    })
}

fn resolve_run_command(project: &str) -> Result<String, String> {
    let (project_dir, home, data_dir, default_data_dir) = resolve_project_dirs(project)?;
    ensure_cli_installed()?;
    Ok(build_project_cli_command_for_platform(
        CliInvocation::Run,
        project,
        &project_dir,
        &home,
        &data_dir,
        default_data_dir.as_deref(),
        cfg!(target_os = "windows"),
    ))
}

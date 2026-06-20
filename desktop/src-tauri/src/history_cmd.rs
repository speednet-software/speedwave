//! Chat-history Tauri commands: read-only views of persisted conversations and CLAUDE.md.
//! Validates the project, then delegates to the `history` module.

use crate::history;
use crate::types::check_project;

#[tauri::command]
pub(crate) async fn list_conversations(
    project: String,
) -> Result<Vec<history::ConversationSummary>, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("list_conversations: project={project}");
        history::list_conversations(&project).map_err(|e| {
            log::error!("list_conversations: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_conversation(
    project: String,
    session_id: String,
) -> Result<history::ConversationTranscript, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("get_conversation: project={project}");
        history::get_conversation(&project, &session_id).map_err(|e| {
            log::error!("get_conversation: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn delete_conversation(project: String, session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("delete_conversation: project={project}");
        history::delete_conversation(&project, &session_id).map_err(|e| {
            log::error!("delete_conversation: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_project_memory(project: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("get_project_memory: project={project}");
        history::get_project_memory(&project).map_err(|e| {
            log::error!("get_project_memory: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

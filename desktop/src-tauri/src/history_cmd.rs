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
        log::info!("listing conversations for project={project}");
        let mut summaries = history::list_conversations(&project).map_err(|e| {
            log::error!("failed to list conversations for project={project}: {e}");
            e.to_string()
        })?;
        // Display-only copy: the on-disk sessions stay tokenized.
        let policy = crate::pii_display::load_display_policy(
            speedwave_runtime::consts::data_dir(),
            &project,
        );
        crate::pii_display::detokenize_summaries(&mut summaries, &policy);
        Ok(summaries)
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
        log::info!("getting conversation for project={project}");
        let mut transcript = history::get_conversation(&project, &session_id).map_err(|e| {
            log::error!("failed to get conversation for project={project}: {e}");
            e.to_string()
        })?;
        // Detokenize the returned copy only; the tokenized source file stays unchanged.
        let policy = crate::pii_display::load_display_policy(
            speedwave_runtime::consts::data_dir(),
            &project,
        );
        crate::pii_display::detokenize_transcript(&mut transcript, &policy);
        Ok(transcript)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn delete_conversation(project: String, session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("deleting conversation for project={project}");
        history::delete_conversation(&project, &session_id).map_err(|e| {
            log::error!("failed to delete conversation for project={project}: {e}");
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
        log::info!("getting project memory for project={project}");
        history::get_project_memory(&project).map_err(|e| {
            log::error!("failed to get project memory for project={project}: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

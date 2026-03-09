use crate::history;
use speedwave_runtime::{config, consts, runtime};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Events emitted to the Angular frontend via Tauri's event system.
/// The frontend listens for `"chat_stream"` events with this payload.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StreamChunk {
    pub chunk_type: String,
    pub content: String,
}

/// Parse a single line of Claude's stream-json output into an optional `StreamChunk`.
///
/// Returns `None` for empty lines, invalid JSON, or message types that should be
/// ignored (e.g. `assistant`, `system`, `user`).
pub fn parse_stream_line(line: &str) -> Option<StreamChunk> {
    if line.trim().is_empty() {
        return None;
    }

    let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
    let msg_type = parsed["type"].as_str().unwrap_or("");

    match msg_type {
        // Real-time token streaming (from --include-partial-messages)
        "stream_event" => {
            let event = &parsed["event"];
            let event_type = event["type"].as_str().unwrap_or("");

            match event_type {
                "content_block_delta" => {
                    let delta = &event["delta"];
                    let delta_type = delta["type"].as_str().unwrap_or("");
                    if delta_type == "text_delta" {
                        if let Some(text) = delta["text"].as_str() {
                            return Some(StreamChunk {
                                chunk_type: "text".to_string(),
                                content: text.to_string(),
                            });
                        }
                    }
                    None
                }
                "content_block_start" => {
                    let block = &event["content_block"];
                    let block_type = block["type"].as_str().unwrap_or("");
                    if block_type == "tool_use" {
                        if let Some(name) = block["name"].as_str() {
                            return Some(StreamChunk {
                                chunk_type: "tool_use".to_string(),
                                content: name.to_string(),
                            });
                        }
                    }
                    None
                }
                _ => None,
            }
        }

        // Complete assistant message — ignored since we stream via stream_event
        // and finalize on the "result" message.
        "assistant" => None,

        // Final result — conversation done
        "result" => {
            let is_error = parsed["is_error"].as_bool().unwrap_or(false);
            let result_text = parsed["result"].as_str().unwrap_or("").to_string();

            if is_error {
                Some(StreamChunk {
                    chunk_type: "error".to_string(),
                    content: result_text,
                })
            } else {
                Some(StreamChunk {
                    chunk_type: "result".to_string(),
                    content: result_text,
                })
            }
        }

        // system, user — ignore
        _ => None,
    }
}

/// Build the JSON value for a user message in Claude's stream-json input format.
pub fn build_user_message(message: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": message}]
        }
    })
}

/// Build the argument list for Claude Code's stream-json mode.
///
/// When `resume_session_id` is `Some`, adds `--resume <id>` to resume an
/// existing conversation.
pub fn build_claude_args(resume_session_id: Option<&str>, flags: &[&str]) -> Vec<String> {
    let mut args = vec![
        consts::CLAUDE_BINARY.to_string(),
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];

    if let Some(id) = resume_session_id {
        args.push("--resume".to_string());
        args.push(id.to_string());
    }

    for flag in flags {
        args.push(flag.to_string());
    }

    args
}

/// Build the container name for a project's Claude container.
pub fn claude_container_name(project: &str) -> String {
    format!("{}_{}_claude", consts::COMPOSE_PREFIX, project)
}

/// Manages a Claude Code subprocess running inside the container.
/// Claude is launched via `container_exec` from the ContainerRuntime trait,
/// which abstracts limactl/nerdctl/wsl.exe differences.
///
/// Stdout is parsed in a background thread that emits Tauri events directly.
pub struct ChatSession {
    child: Option<Child>,
    project_name: String,
}

impl ChatSession {
    pub fn new(project_name: &str) -> Self {
        Self {
            child: None,
            project_name: project_name.to_string(),
        }
    }

    /// Start Claude Code in stream-json mode inside the container.
    /// Spawns a background thread that reads stdout and emits `chat_stream`
    /// Tauri events for the Angular frontend.
    ///
    /// When `resume_session_id` is `Some`, resumes an existing conversation.
    pub fn start(
        &mut self,
        app_handle: AppHandle,
        resume_session_id: Option<&str>,
    ) -> anyhow::Result<()> {
        if let Some(id) = resume_session_id {
            history::validate_session_id(id)?;
        }

        let rt = runtime::detect_runtime();
        let user_config = config::load_user_config().unwrap_or_default();

        let project_dir = user_config
            .projects
            .iter()
            .find(|p| p.name == self.project_name)
            .map(|p| std::path::PathBuf::from(&p.dir))
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join("projects")
                    .join(&self.project_name)
            });

        let resolved =
            config::resolve_claude_config(&project_dir, &user_config, &self.project_name);

        let args = build_claude_args(resume_session_id, &resolved.flags);

        let container = claude_container_name(&self.project_name);
        let mut cmd = rt.container_exec_piped(
            &container,
            &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        )?;

        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture stdout from child process"))?;

        // Spawn stderr reader to log errors (avoids pipe buffer deadlock)
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => log::debug!("{l}"),
                        Err(_) => break,
                    }
                }
            });
        }

        // Background thread: parse Claude's stream-json and emit Tauri events
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };

                if let Some(chunk) = parse_stream_line(&line) {
                    let _ = app_handle.emit("chat_stream", chunk);
                }
            }
        });

        self.child = Some(child);
        Ok(())
    }

    /// Send a user message to Claude (write JSON to stdin).
    /// Uses the stream-json input format: `{"type":"user","message":{"role":"user","content":[...]}}`.
    ///
    /// Returns an error if the subprocess has exited (broken pipe).
    /// The caller should restart the session and retry.
    pub fn send_message(&mut self, message: &str) -> anyhow::Result<()> {
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;

        // Check if process is still alive
        if let Some(status) = child.try_wait()? {
            self.child = None;
            anyhow::bail!("session exited ({})", status);
        }

        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("stdin not available"))?;
        let input = build_user_message(message);
        writeln!(stdin, "{}", input)?;
        stdin.flush()?;
        Ok(())
    }

    /// Stop the Claude subprocess.
    pub fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(ref mut child) = self.child {
            child.kill().ok();
            child.wait().ok();
        }
        self.child = None;
        Ok(())
    }
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        self.stop().ok();
    }
}

/// Thread-safe wrapper for ChatSession, to be used from Tauri commands.
pub type SharedChatSession = Arc<Mutex<ChatSession>>;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // ── StreamChunk serialization ────────────────────────────────────

    #[test]
    fn stream_chunk_serializes_to_json_with_correct_fields() {
        let chunk = StreamChunk {
            chunk_type: "text".to_string(),
            content: "hello".to_string(),
        };
        let json = serde_json::to_value(&chunk).unwrap();
        assert_eq!(json["chunk_type"], "text");
        assert_eq!(json["content"], "hello");
    }

    #[test]
    fn stream_chunk_round_trips_through_json() {
        let original = StreamChunk {
            chunk_type: "text".to_string(),
            content: "hello".to_string(),
        };
        let serialized = serde_json::to_string(&original).unwrap();
        let deserialized: StreamChunk = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.chunk_type, "text");
        assert_eq!(deserialized.content, "hello");
    }

    // ── send_message JSON format ─────────────────────────────────────

    #[test]
    fn build_user_message_produces_correct_json_structure() {
        let msg = build_user_message("test msg");

        assert_eq!(msg["type"], "user");
        assert_eq!(msg["message"]["role"], "user");

        let content = &msg["message"]["content"];
        assert!(content.is_array());

        let items = content.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "text");
        assert_eq!(items[0]["text"], "test msg");
    }

    #[test]
    fn build_user_message_preserves_special_characters() {
        let msg = build_user_message("hello \"world\" \n\ttab");
        let text = msg["message"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "hello \"world\" \n\ttab");
    }

    // ── Stream-json parsing ──────────────────────────────────────────

    #[test]
    fn parse_text_delta_produces_text_chunk() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello world"}}}"#;
        let chunk = parse_stream_line(line).unwrap();
        assert_eq!(chunk.chunk_type, "text");
        assert_eq!(chunk.content, "Hello world");
    }

    #[test]
    fn parse_content_block_start_tool_use_produces_tool_use_chunk() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}}"#;
        let chunk = parse_stream_line(line).unwrap();
        assert_eq!(chunk.chunk_type, "tool_use");
        assert_eq!(chunk.content, "Read");
    }

    #[test]
    fn parse_result_success_produces_result_chunk() {
        let line = r#"{"type":"result","is_error":false,"result":"Done."}"#;
        let chunk = parse_stream_line(line).unwrap();
        assert_eq!(chunk.chunk_type, "result");
        assert_eq!(chunk.content, "Done.");
    }

    #[test]
    fn parse_result_error_produces_error_chunk() {
        let line = r#"{"type":"result","is_error":true,"result":"Something went wrong"}"#;
        let chunk = parse_stream_line(line).unwrap();
        assert_eq!(chunk.chunk_type, "error");
        assert_eq!(chunk.content, "Something went wrong");
    }

    #[test]
    fn parse_assistant_type_is_ignored() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[]}}"#;
        assert!(parse_stream_line(line).is_none());
    }

    #[test]
    fn parse_system_type_is_ignored() {
        let line = r#"{"type":"system","message":"hello"}"#;
        assert!(parse_stream_line(line).is_none());
    }

    #[test]
    fn parse_invalid_json_is_skipped() {
        assert!(parse_stream_line("not json at all").is_none());
    }

    #[test]
    fn parse_empty_line_is_skipped() {
        assert!(parse_stream_line("").is_none());
        assert!(parse_stream_line("   ").is_none());
        assert!(parse_stream_line("\t\n").is_none());
    }

    #[test]
    fn parse_result_without_is_error_defaults_to_result() {
        let line = r#"{"type":"result","result":"ok"}"#;
        let chunk = parse_stream_line(line).unwrap();
        assert_eq!(chunk.chunk_type, "result");
        assert_eq!(chunk.content, "ok");
    }

    #[test]
    fn parse_result_without_result_field_gives_empty_content() {
        let line = r#"{"type":"result","is_error":false}"#;
        let chunk = parse_stream_line(line).unwrap();
        assert_eq!(chunk.chunk_type, "result");
        assert_eq!(chunk.content, "");
    }

    // ── ChatSession::new() ───────────────────────────────────────────

    #[test]
    fn chat_session_new_stores_project_name() {
        let session = ChatSession::new("acme-corp");
        assert_eq!(session.project_name, "acme-corp");
    }

    #[test]
    fn chat_session_new_has_no_child() {
        let session = ChatSession::new("acme-corp");
        assert!(session.child.is_none());
    }

    // ── Container name construction ──────────────────────────────────

    #[test]
    fn claude_container_name_uses_compose_prefix() {
        let name = claude_container_name("myproject");
        assert_eq!(name, format!("{}_myproject_claude", consts::COMPOSE_PREFIX));
    }

    #[test]
    fn claude_container_name_format_is_prefix_project_claude() {
        let name = claude_container_name("acme-corp");
        assert_eq!(name, "speedwave_acme-corp_claude");
    }

    // ── build_claude_args ────────────────────────────────────────────

    #[test]
    fn build_claude_args_without_resume() {
        let args = build_claude_args(None, &[]);
        assert!(args.contains(&consts::CLAUDE_BINARY.to_string()));
        assert!(args.contains(&"-p".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_claude_args_with_resume() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let args = build_claude_args(Some(id), &[]);
        let resume_pos = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[resume_pos + 1], id);
    }

    #[test]
    fn build_claude_args_includes_flags() {
        let args = build_claude_args(None, &["--dangerously-skip-permissions"]);
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
    }
}

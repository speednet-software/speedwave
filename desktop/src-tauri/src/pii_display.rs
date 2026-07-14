//! Host-side PII detokenization at the Desktop presentation boundary (design ch.10):
//! chat_stream emission (`chat.rs::emit_sanitized_chunk`) and the history transcript
//! returned to the webview (`history_cmd.rs::get_conversation`). Angular never sees a
//! token — it renders whatever this module hands back. Best-effort DISPLAY only, unlike
//! the fail-closed tool-params path: this never writes a detokenized value back to disk,
//! the JSONL transcript, or anything the model could re-read.

use std::path::Path;

use speedwave_pii_engine::{detokenize_text, EngineKey};

use crate::history::{ConversationSummary, ConversationTranscript, MessageBlock};

/// Loads the active project's PII tokenization key once per session/command (never
/// per-chunk). `None` when the project has no key yet — no PII policy was ever enabled,
/// or the project predates the policy feature — callers treat that as a detok no-op.
pub(crate) fn load_display_key(data_dir: &Path, project: &str) -> Option<EngineKey> {
    speedwave_runtime::pii_key::read_project_key_in(data_dir, project)
        .ok()
        .map(EngineKey::from_bytes)
}

/// Detokenizes one string for display. `key: None` and an unresolvable token (wrong
/// project, corrupted span) both fall back to `text` unchanged — never panics or errors
/// the render. Never logs the key or the text.
pub(crate) fn detokenize_for_display(key: Option<&EngineKey>, text: &str) -> String {
    let Some(key) = key else {
        return text.to_string();
    };
    detokenize_text(key, text).unwrap_or_else(|_| text.to_string())
}

/// Detokenizes a `ConversationTranscript` IN PLACE for display. The caller already holds
/// this as an owned copy parsed from the on-disk JSONL — mutating it here never touches
/// the tokenized transcript file itself, which stays the model-readable source.
/// `ToolUse.input_json` is left untouched (tool call arguments, not display prose) —
/// only the same fields `sanitize_chunk`/`detokenize_chunk` treat as free text: text,
/// thinking, tool-result content, and error content.
pub(crate) fn detokenize_transcript(
    transcript: &mut ConversationTranscript,
    key: Option<&EngineKey>,
) {
    let Some(key) = key else {
        return;
    };
    for message in &mut transcript.messages {
        message.content = detokenize_for_display(Some(key), &message.content);
        let Some(blocks) = &mut message.blocks else {
            continue;
        };
        for block in blocks {
            match block {
                MessageBlock::Text { content } => {
                    *content = detokenize_for_display(Some(key), content)
                }
                MessageBlock::Thinking { content } => {
                    *content = detokenize_for_display(Some(key), content)
                }
                MessageBlock::ToolResult { content, .. } => {
                    *content = detokenize_for_display(Some(key), content)
                }
                MessageBlock::Error { content } => {
                    *content = detokenize_for_display(Some(key), content)
                }
                MessageBlock::ToolUse { .. } => {}
            }
        }
    }
}

/// Detokenizes each summary's `preview` (a truncated snippet of the first user
/// message shown in the sidebar) IN PLACE — the only display-facing text field
/// `list_conversations` returns.
pub(crate) fn detokenize_summaries(summaries: &mut [ConversationSummary], key: Option<&EngineKey>) {
    let Some(key) = key else {
        return;
    };
    for summary in summaries {
        summary.preview = detokenize_for_display(Some(key), &summary.preview);
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;
    use speedwave_pii_engine::{compile_policy_v2, default_policy_json, scan_text};

    fn full_policy() -> speedwave_pii_engine::CompiledPolicy {
        compile_policy_v2(&default_policy_json()).expect("default policy compiles")
    }

    #[test]
    fn roundtrips_a_real_token_back_to_its_original_value() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let key = load_display_key(tmp.path(), "proj").expect("key must load");

        let tokenized = scan_text(&full_policy(), &key, "contact me at jan@example.com please")
            .expect("scan succeeds")
            .text;
        assert!(
            tokenized.contains("TOKEN_"),
            "fixture must actually tokenize"
        );

        let displayed = detokenize_for_display(Some(&key), &tokenized);
        assert_eq!(displayed, "contact me at jan@example.com please");
    }

    #[test]
    fn missing_key_returns_text_unchanged() {
        let text = "[EMAIL:TOKEN_whatever] no key on disk";
        assert_eq!(detokenize_for_display(None, text), text);
    }

    #[test]
    fn load_display_key_is_none_when_project_has_no_key_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load_display_key(tmp.path(), "no-policy-proj").is_none());
    }

    #[test]
    fn plain_text_without_tokens_is_returned_unchanged_when_key_present() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let key = load_display_key(tmp.path(), "proj").expect("key must load");
        assert_eq!(
            detokenize_for_display(Some(&key), "just plain text"),
            "just plain text"
        );
    }

    #[test]
    fn unresolvable_token_falls_back_to_the_original_tokenized_text() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let key = load_display_key(tmp.path(), "proj").expect("key must load");
        // Well-formed span shape but bogus ciphertext — must not decode, and must not error.
        let text = "see [EMAIL:TOKEN_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA] there";
        assert_eq!(detokenize_for_display(Some(&key), text), text);
    }

    #[test]
    fn empty_text_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let key = load_display_key(tmp.path(), "proj").expect("key must load");
        assert_eq!(detokenize_for_display(Some(&key), ""), "");
    }

    #[test]
    fn a_wrong_project_key_cannot_decode_another_projects_token() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj-a").unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj-b").unwrap();
        let key_a = load_display_key(tmp.path(), "proj-a").expect("key must load");
        let key_b = load_display_key(tmp.path(), "proj-b").expect("key must load");

        let tokenized = scan_text(&full_policy(), &key_a, "secret@example.com")
            .expect("scan succeeds")
            .text;

        // Displaying under proj-b's key must not resolve proj-a's token.
        let displayed = detokenize_for_display(Some(&key_b), &tokenized);
        assert_eq!(displayed, tokenized);
    }

    // ── detokenize_transcript / detokenize_summaries ──

    fn setup_key(tmp: &std::path::Path, project: &str) -> EngineKey {
        speedwave_runtime::pii_key::ensure_project_key_in(tmp, project).unwrap();
        load_display_key(tmp, project).expect("key must load")
    }

    fn tokenize(key: &EngineKey, plain: &str) -> String {
        scan_text(&full_policy(), key, plain)
            .expect("scan succeeds")
            .text
    }

    #[test]
    fn detokenize_transcript_resolves_flat_content_and_blocks() {
        let tmp = tempfile::tempdir().unwrap();
        let key = setup_key(tmp.path(), "proj");
        let tokenized = tokenize(&key, "jan@example.com");

        let mut transcript = ConversationTranscript {
            session_id: "s1".to_string(),
            messages: vec![crate::history::ConversationMessage {
                role: "assistant".to_string(),
                content: tokenized.clone(),
                blocks: Some(vec![
                    MessageBlock::Text {
                        content: tokenized.clone(),
                    },
                    MessageBlock::Thinking {
                        content: tokenized.clone(),
                    },
                    MessageBlock::ToolResult {
                        content: tokenized.clone(),
                        is_error: false,
                    },
                    MessageBlock::Error {
                        content: tokenized.clone(),
                    },
                    MessageBlock::ToolUse {
                        tool_name: "Read".to_string(),
                        input_json: tokenized.clone(),
                    },
                ]),
                timestamp: None,
                uuid: None,
                model: None,
                usage: None,
            }],
        };

        detokenize_transcript(&mut transcript, Some(&key));

        let msg = &transcript.messages[0];
        assert_eq!(msg.content, "jan@example.com");
        let blocks = msg.blocks.as_ref().unwrap();
        for block in &blocks[..4] {
            let content = match block {
                MessageBlock::Text { content }
                | MessageBlock::Thinking { content }
                | MessageBlock::ToolResult { content, .. }
                | MessageBlock::Error { content } => content,
                MessageBlock::ToolUse { .. } => panic!("unexpected ToolUse in first 4"),
            };
            assert_eq!(content.as_str(), "jan@example.com");
        }
        match &blocks[4] {
            MessageBlock::ToolUse { input_json, .. } => {
                assert_eq!(
                    input_json, &tokenized,
                    "ToolUse.input_json must be left tokenized (not display prose)"
                );
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn detokenize_transcript_without_key_leaves_transcript_unchanged() {
        let tokenized = "[EMAIL:TOKEN_whatever]".to_string();
        let mut transcript = ConversationTranscript {
            session_id: "s1".to_string(),
            messages: vec![crate::history::ConversationMessage {
                role: "user".to_string(),
                content: tokenized.clone(),
                blocks: None,
                timestamp: None,
                uuid: None,
                model: None,
                usage: None,
            }],
        };
        detokenize_transcript(&mut transcript, None);
        assert_eq!(transcript.messages[0].content, tokenized);
    }

    #[test]
    fn detokenize_summaries_resolves_preview_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let key = setup_key(tmp.path(), "proj");
        let tokenized = tokenize(&key, "jan@example.com");

        let mut summaries = vec![ConversationSummary {
            session_id: "s1".to_string(),
            timestamp: None,
            preview: tokenized,
            message_count: 1,
        }];
        detokenize_summaries(&mut summaries, Some(&key));
        assert_eq!(summaries[0].preview, "jan@example.com");
    }
}

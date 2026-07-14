//! Host-side PII detokenization at the Desktop presentation boundary.
//! Chat emissions and history to webview are detokenized for display; the tokenized JSONL source and model-readable content stay on disk.

use std::path::Path;

use speedwave_pii_engine::{detokenize_text, EngineKey};

use crate::history::{ConversationSummary, ConversationTranscript, MessageBlock};

/// Loads the active project's PII tokenization key once per session. Returns `None` if the project has no key yet.
pub(crate) fn load_display_key(data_dir: &Path, project: &str) -> Option<EngineKey> {
    speedwave_runtime::pii_key::read_project_key_in(data_dir, project)
        .ok()
        .map(EngineKey::from_bytes)
}

/// Detokenizes one string for display. Unresolvable tokens and missing keys fall back to unchanged text.
pub(crate) fn detokenize_for_display(key: Option<&EngineKey>, text: &str) -> String {
    let Some(key) = key else {
        return text.to_string();
    };
    detokenize_text(key, text).unwrap_or_else(|_| text.to_string())
}

/// Detokenizes a `ConversationTranscript` in place for display, on a copy parsed from disk.
/// The tokenized source file stays unchanged; `ToolUse.input_json` remains tokenized (not display prose).
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

/// Detokenizes each summary's `preview` in place (the only display-facing text field returned by `list_conversations`).
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
        // Well-formed span shape but bogus ciphertext: must not decode, and must not error.
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

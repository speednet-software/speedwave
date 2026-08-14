//! Host-side PII detokenization at the Desktop presentation boundary.
//! Chat emissions and history to webview are detokenized for display; the tokenized JSONL source and model-readable content stay on disk.

use std::path::Path;

use speedwave_pii_engine::{
    compile_policy_v3, detokenize_text_lossy, unalias_text_preserving_tokens, CompiledKeyword,
    EngineKey,
};

use crate::history::{ConversationSummary, ConversationTranscript, MessageBlock};

/// Display-rewrite inputs: the project's tokenization key plus its resolved keyword aliases,
/// loaded once per display pass.
#[derive(Default)]
pub(crate) struct DisplayPolicy {
    key: Option<EngineKey>,
    keywords: Vec<CompiledKeyword>,
}

impl DisplayPolicy {
    /// Builds a policy from parts (loader, chat/history call sites, tests).
    pub(crate) fn new(key: Option<EngineKey>, keywords: Vec<CompiledKeyword>) -> Self {
        Self { key, keywords }
    }

    /// True when neither a key nor keywords are configured, so the display rewrite is a no-op.
    pub(crate) fn is_noop(&self) -> bool {
        self.key.is_none() && self.keywords.is_empty()
    }
}

/// Loads the active project's PII tokenization key once per session. Returns `None` if the project has no key yet.
pub(crate) fn load_display_key(data_dir: &Path, project: &str) -> Option<EngineKey> {
    speedwave_runtime::pii_key::read_project_key_in(data_dir, project)
        .ok()
        .map(EngineKey::from_bytes)
}

/// Loads the display policy: the project's key plus the rendered policy.json's keywords (the
/// same file hub/proxy run with). Missing or unparseable pieces degrade to a partial rewrite.
pub(crate) fn load_display_policy(data_dir: &Path, project: &str) -> DisplayPolicy {
    let keywords = std::fs::read_to_string(speedwave_runtime::pii_policy::policy_config_path_in(
        data_dir, project,
    ))
    .ok()
    .and_then(|json| compile_policy_v3(&json).ok())
    .map(|policy| policy.keywords().to_vec())
    .unwrap_or_default();
    DisplayPolicy::new(load_display_key(data_dir, project), keywords)
}

/// Rewrites one string for display: keyword aliases are unmasked first (token spans skipped),
/// then tokens are resolved per span — unresolvable spans stay verbatim (a model-garbled span
/// must not hide its valid neighbors).
pub(crate) fn detokenize_for_display(policy: &DisplayPolicy, text: &str) -> String {
    let mut result = text.to_string();
    for keyword in &policy.keywords {
        result = unalias_text_preserving_tokens(
            &result,
            &keyword.match_text,
            &keyword.alias,
            keyword.case_sensitive,
        );
    }
    match &policy.key {
        Some(key) => detokenize_text_lossy(key, &result),
        None => result,
    }
}

/// Rewrites a `ConversationTranscript` in place for display, on a copy parsed from disk.
/// The tokenized source file stays unchanged; `ToolUse.input_json` remains tokenized (not display prose).
pub(crate) fn detokenize_transcript(
    transcript: &mut ConversationTranscript,
    policy: &DisplayPolicy,
) {
    if policy.is_noop() {
        return;
    }
    for message in &mut transcript.messages {
        message.content = detokenize_for_display(policy, &message.content);
        let Some(blocks) = &mut message.blocks else {
            continue;
        };
        for block in blocks {
            match block {
                MessageBlock::Text { content } => {
                    *content = detokenize_for_display(policy, content)
                }
                MessageBlock::Thinking { content } => {
                    *content = detokenize_for_display(policy, content)
                }
                MessageBlock::ToolResult { content, .. } => {
                    *content = detokenize_for_display(policy, content)
                }
                MessageBlock::Error { content } => {
                    *content = detokenize_for_display(policy, content)
                }
                MessageBlock::ToolUse { .. } | MessageBlock::ControlChip { .. } => {}
            }
        }
    }
}

/// Rewrites each summary's `preview` in place (the only display-facing text field returned by `list_conversations`).
pub(crate) fn detokenize_summaries(summaries: &mut [ConversationSummary], policy: &DisplayPolicy) {
    if policy.is_noop() {
        return;
    }
    for summary in summaries {
        summary.preview = detokenize_for_display(policy, &summary.preview);
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
    use speedwave_pii_engine::{default_policy_json, scan_text};

    fn full_policy() -> speedwave_pii_engine::CompiledPolicy {
        compile_policy_v3(&default_policy_json()).expect("default policy compiles")
    }

    /// Key-only display policy (no keywords configured).
    fn key_policy(key: EngineKey) -> DisplayPolicy {
        DisplayPolicy::new(Some(key), Vec::new())
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

        let displayed = detokenize_for_display(&key_policy(key), &tokenized);
        assert_eq!(displayed, "contact me at jan@example.com please");
    }

    #[test]
    fn missing_key_returns_text_unchanged() {
        let text = "[EMAIL:TOKEN_whatever] no key on disk";
        assert_eq!(
            detokenize_for_display(&DisplayPolicy::default(), text),
            text
        );
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
            detokenize_for_display(&key_policy(key), "just plain text"),
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
        assert_eq!(detokenize_for_display(&key_policy(key), text), text);
    }

    #[test]
    fn one_garbled_span_does_not_hide_a_valid_neighbor_token() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let key = load_display_key(tmp.path(), "proj").expect("key must load");

        let tokenized = scan_text(
            &full_policy(),
            &key,
            "reach [EMAIL:TOKEN_thdCj2wWFBpZi2_8dGYJTD7URNshH26HUe_R39Sq4Q]",
        )
        .expect("scan succeeds")
        .text;
        // A model reply that garbles one span (e.g. a literal example token) alongside a real one.
        let mixed = format!("{tokenized} but not [EMAIL:TOKEN_XYZ]");

        let displayed = detokenize_for_display(&key_policy(key), &mixed);
        assert_eq!(
            displayed,
            "reach [EMAIL:TOKEN_thdCj2wWFBpZi2_8dGYJTD7URNshH26HUe_R39Sq4Q] but not [EMAIL:TOKEN_XYZ]"
        );
    }

    #[test]
    fn empty_text_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let key = load_display_key(tmp.path(), "proj").expect("key must load");
        assert_eq!(detokenize_for_display(&key_policy(key), ""), "");
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
        let displayed = detokenize_for_display(&key_policy(key_b), &tokenized);
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

        detokenize_transcript(&mut transcript, &key_policy(key));

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
                MessageBlock::ControlChip { .. } => panic!("unexpected ControlChip in first 4"),
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
        detokenize_transcript(&mut transcript, &DisplayPolicy::default());
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
        detokenize_summaries(&mut summaries, &key_policy(key));
        assert_eq!(summaries[0].preview, "jan@example.com");
    }

    // ── keyword unmasking at display ──

    fn keyword_policy(key: Option<EngineKey>) -> DisplayPolicy {
        DisplayPolicy::new(
            key,
            vec![speedwave_pii_engine::CompiledKeyword {
                match_text: "coca-cola".to_string(),
                alias: "Brandex".to_string(),
                case_sensitive: false,
            }],
        )
    }

    #[test]
    fn keyword_alias_is_unmasked_alongside_token_resolution() {
        let tmp = tempfile::tempdir().unwrap();
        let key = setup_key(tmp.path(), "proj");
        let plain = format!("contact {}", ["user", "example.com"].join("@"));
        let tokenized = tokenize(&key, &plain);
        let mixed = format!("brandex says {tokenized}");

        let displayed = detokenize_for_display(&keyword_policy(Some(key)), &mixed);
        assert_eq!(displayed, format!("coca-cola says {plain}"));
    }

    #[test]
    fn keyword_alias_is_unmasked_even_without_a_key() {
        let displayed = detokenize_for_display(
            &keyword_policy(None),
            "BRANDEX kept [EMAIL:TOKEN_abc] verbatim",
        );
        assert_eq!(displayed, "COCA-COLA kept [EMAIL:TOKEN_abc] verbatim");
    }

    #[test]
    fn tool_result_block_alias_is_unmasked_but_tool_use_input_stays() {
        let mut transcript = ConversationTranscript {
            session_id: "s1".to_string(),
            messages: vec![crate::history::ConversationMessage {
                role: "assistant".to_string(),
                content: "brandex".to_string(),
                blocks: Some(vec![
                    MessageBlock::ToolResult {
                        content: "brandex done".to_string(),
                        is_error: false,
                    },
                    MessageBlock::ToolUse {
                        tool_name: "Read".to_string(),
                        input_json: "{\"q\":\"brandex\"}".to_string(),
                    },
                ]),
                timestamp: None,
                uuid: None,
                model: None,
                usage: None,
            }],
        };

        detokenize_transcript(&mut transcript, &keyword_policy(None));

        let msg = &transcript.messages[0];
        assert_eq!(msg.content, "coca-cola");
        let blocks = msg.blocks.as_ref().unwrap();
        match &blocks[0] {
            MessageBlock::ToolResult { content, .. } => assert_eq!(content, "coca-cola done"),
            other => panic!("expected ToolResult, got {other:?}"),
        }
        match &blocks[1] {
            MessageBlock::ToolUse { input_json, .. } => {
                assert_eq!(input_json, "{\"q\":\"brandex\"}");
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn load_display_policy_reads_keywords_from_the_rendered_policy_json() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let policy_path = speedwave_runtime::pii_policy::policy_config_path_in(tmp.path(), "proj");
        std::fs::write(
            &policy_path,
            r#"{"version":3,"source":{"policies":[],"forced":[]},"rules":[],"keywords":[{"match":"coca-cola","alias":"Brandex","caseSensitive":false}]}"#,
        )
        .unwrap();

        let policy = load_display_policy(tmp.path(), "proj");
        assert!(!policy.is_noop());
        assert_eq!(
            detokenize_for_display(&policy, "brandex ok"),
            "coca-cola ok"
        );
    }

    #[test]
    fn load_display_policy_without_policy_json_has_no_keywords() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let policy = load_display_policy(tmp.path(), "proj");
        assert_eq!(
            detokenize_for_display(&policy, "brandex stays"),
            "brandex stays"
        );
    }
}

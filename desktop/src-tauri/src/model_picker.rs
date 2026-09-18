use crate::chat::SharedChatSession;
use crate::control_channel::{ModelRow, SessionInfo, SessionInfoState};
use crate::types::check_project;
use serde::Serialize;
use speedwave_runtime::config::{self, LlmProviderKind};
use speedwave_runtime::defaults::{
    anthropic_wire_model_id, canonical_anthropic_model_id, AnthropicPlan, OneMillionContext,
    ANTHROPIC_MODELS,
};
use std::path::Path;

const DEFAULT_ROW_VALUE: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PickerSource {
    ClaudeCode,
    Catalog,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct PickerRow {
    pub(crate) id: String,
    pub(crate) wire_id: String,
    pub(crate) is_default: bool,
    pub(crate) display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct ModelPicker {
    pub(crate) source: PickerSource,
    pub(crate) rows: Vec<PickerRow>,
}

pub(crate) fn plan_for(kind: LlmProviderKind, info: Option<&SessionInfo>) -> AnthropicPlan {
    if kind == LlmProviderKind::AnthropicApiKey {
        return AnthropicPlan::Api;
    }
    AnthropicPlan::from_claude_code(info.and_then(|i| i.account.subscription_type.as_deref()))
}

fn row_model(row: &ModelRow) -> &str {
    row.resolved_model.as_deref().unwrap_or(&row.value)
}

fn in_catalog(id: &str) -> bool {
    ANTHROPIC_MODELS.iter().any(|m| m.id == id)
}

fn strip_one_million_decoration(name: &str) -> String {
    let mut kept = String::with_capacity(name.len());
    let mut rest = name;
    while let Some(open) = rest.find('(') {
        let Some(len) = rest[open..].find(')') else {
            break;
        };
        let group = &rest[open..=open + len];
        kept.push_str(&rest[..open]);
        if !group.to_ascii_lowercase().contains("1m") {
            kept.push_str(group);
        }
        rest = &rest[open + len + 1..];
    }
    kept.push_str(rest);
    kept.replace("[1m]", "")
        .replace("[1M]", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn unlisted_in_catalog_row(id: &str, info: &SessionInfo, is_default: bool) -> PickerRow {
    let group: Vec<&ModelRow> = info
        .models
        .iter()
        .filter(|m| canonical_anthropic_model_id(row_model(m)) == id)
        .collect();
    let named: Vec<&ModelRow> = group
        .iter()
        .copied()
        .filter(|m| m.value != DEFAULT_ROW_VALUE)
        .collect();
    let candidates = if named.is_empty() { &group } else { &named };
    let chosen = candidates
        .iter()
        .copied()
        .find(|m| !row_model(m).ends_with("[1m]"))
        .or_else(|| candidates.first().copied());
    PickerRow {
        id: id.to_string(),
        wire_id: chosen.map_or_else(|| id.to_string(), |m| row_model(m).to_string()),
        is_default,
        display_name: chosen
            .map(|m| strip_one_million_decoration(&m.display_name))
            .filter(|name| !name.is_empty()),
    }
}

fn catalog_picker(plan: AnthropicPlan) -> ModelPicker {
    ModelPicker {
        source: PickerSource::Catalog,
        rows: ANTHROPIC_MODELS
            .iter()
            .map(|m| PickerRow {
                id: m.id.to_string(),
                wire_id: anthropic_wire_model_id(m.id, plan),
                is_default: false,
                display_name: None,
            })
            .collect(),
    }
}

pub(crate) fn build_picker(info: Option<&SessionInfo>, plan: AnthropicPlan) -> ModelPicker {
    let Some(info) = info.filter(|i| !i.models.is_empty()) else {
        return catalog_picker(plan);
    };
    let default_id = info
        .models
        .iter()
        .find(|m| m.value == DEFAULT_ROW_VALUE)
        .map(|m| canonical_anthropic_model_id(row_model(m)).to_string());

    let mut rows: Vec<PickerRow> = Vec::new();
    for listed in &info.models {
        let id = canonical_anthropic_model_id(row_model(listed));
        if id.is_empty() || rows.iter().any(|r| r.id == id) {
            continue;
        }
        let is_default = default_id.as_deref() == Some(id);
        rows.push(if in_catalog(id) {
            PickerRow {
                id: id.to_string(),
                wire_id: anthropic_wire_model_id(id, plan),
                is_default,
                display_name: None,
            }
        } else {
            unlisted_in_catalog_row(id, info, is_default)
        });
    }
    for legacy in ANTHROPIC_MODELS.iter().filter(|m| !m.latest) {
        if !rows.iter().any(|r| r.id == legacy.id) {
            rows.push(PickerRow {
                id: legacy.id.to_string(),
                wire_id: anthropic_wire_model_id(legacy.id, plan),
                is_default: false,
                display_name: None,
            });
        }
    }
    ModelPicker {
        source: PickerSource::ClaudeCode,
        rows,
    }
}

pub(crate) fn normalized_pin(pin: &str, plan: AnthropicPlan) -> Option<String> {
    let id = canonical_anthropic_model_id(pin);
    let model = ANTHROPIC_MODELS.iter().find(|m| m.id == id)?;
    let plan_dependent = matches!(
        model.one_million_context,
        OneMillionContext::PaidPlansAndApi | OneMillionContext::ApiOnly
    );
    if plan_dependent && plan == AnthropicPlan::Unknown {
        return None;
    }
    let wanted = anthropic_wire_model_id(id, plan);
    (wanted != pin).then_some(wanted)
}

pub(crate) fn normalize_pin_for_session(
    data_dir: &Path,
    project: &str,
    kind: LlmProviderKind,
    info: Option<&SessionInfo>,
) {
    let plan = plan_for(kind, info);
    match crate::claude_settings::normalize_model_pin(data_dir, project, |pin| {
        normalized_pin(pin, plan)
    }) {
        Ok(Some(next)) => log::info!("normalized the model pin of project {project} to {next}"),
        Ok(None) => {}
        Err(e) => log::warn!("could not normalize the model pin of project {project}: {e}"),
    }
}

pub(crate) fn session_info_for(
    session_arc: &SharedChatSession,
    project: &str,
) -> Option<SessionInfo> {
    match crate::chat_session_cmd::session_info_state_inner(session_arc, project) {
        SessionInfoState::Ready { info } => Some(info),
        SessionInfoState::Pending | SessionInfoState::Unavailable => None,
    }
}

pub(crate) fn picker_for(
    user_config: &config::SpeedwaveUserConfig,
    session_arc: &SharedChatSession,
    project: &str,
) -> Result<ModelPicker, String> {
    let summary = crate::containers_cmd::active_provider_summary_from(user_config, project)?;
    if !summary.kind.is_anthropic() {
        return Err("the model picker rows exist for Anthropic providers only".to_string());
    }
    let info = session_info_for(session_arc, project);
    Ok(build_picker(
        info.as_ref(),
        plan_for(summary.kind, info.as_ref()),
    ))
}

#[tauri::command]
pub(crate) fn list_model_picker(
    project: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<ModelPicker, String> {
    check_project(&project)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    picker_for(&user_config, state.inner(), &project)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;
    use crate::control_channel::{parse_session_info, AccountInfo, FIXTURE};

    fn fixture_info(run: &str) -> SessionInfo {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture");
        parse_session_info(&fixture[run]["initialize"]).expect("initialize parses")
    }

    fn listed(value: &str, resolved: Option<&str>, display_name: &str) -> ModelRow {
        ModelRow {
            value: value.to_string(),
            resolved_model: resolved.map(str::to_string),
            display_name: display_name.to_string(),
            description: String::new(),
            supports_effort: false,
            supported_effort_levels: Vec::new(),
        }
    }

    fn info_of(models: Vec<ModelRow>, plan: Option<&str>) -> SessionInfo {
        SessionInfo {
            models,
            account: AccountInfo {
                subscription_type: plan.map(str::to_string),
                api_provider: None,
            },
        }
    }

    fn labels(picker: &ModelPicker) -> Vec<&str> {
        picker
            .rows
            .iter()
            .map(|r| {
                ANTHROPIC_MODELS
                    .iter()
                    .find(|m| m.id == r.id)
                    .map_or("<unlisted>", |m| m.family)
            })
            .collect()
    }

    #[test]
    fn max_account_lists_every_model_once_with_default_on_opus_5() {
        for run in ["run_A", "run_B"] {
            let info = fixture_info(run);
            let plan = plan_for(LlmProviderKind::AnthropicOauth, Some(&info));
            assert_eq!(plan, AnthropicPlan::Max);
            let picker = build_picker(Some(&info), plan);
            assert_eq!(picker.source, PickerSource::ClaudeCode);
            assert_eq!(
                labels(&picker),
                vec![
                    "Opus 5",
                    "Fable 5.1",
                    "Sonnet 5",
                    "Haiku 4.5",
                    "Fable 5",
                    "Opus 4.8",
                    "Opus 4.7",
                    "Opus 4.6",
                    "Sonnet 4.6"
                ],
                "{run}"
            );
            let defaults: Vec<&str> = picker
                .rows
                .iter()
                .filter(|r| r.is_default)
                .map(|r| r.id.as_str())
                .collect();
            assert_eq!(defaults, vec!["claude-opus-5"], "{run}");
            assert!(picker.rows.iter().all(|r| r.display_name.is_none()));
        }
    }

    #[test]
    fn max_account_wire_ids_take_the_largest_included_window() {
        let info = fixture_info("run_A");
        let picker = build_picker(Some(&info), AnthropicPlan::Max);
        let wire: Vec<&str> = picker.rows.iter().map(|r| r.wire_id.as_str()).collect();
        assert_eq!(
            wire,
            vec![
                "claude-opus-5[1m]",
                "claude-fable-5-1[1m]",
                "claude-sonnet-5[1m]",
                "claude-haiku-4-5",
                "claude-fable-5[1m]",
                "claude-opus-4-8[1m]",
                "claude-opus-4-7[1m]",
                "claude-opus-4-6[1m]",
                "claude-sonnet-4-6"
            ]
        );
    }

    #[test]
    fn pro_account_keeps_opus_on_the_bare_id() {
        let mut info = fixture_info("run_A");
        info.account.subscription_type = Some("Claude Pro".to_string());
        let plan = plan_for(LlmProviderKind::AnthropicOauth, Some(&info));
        let picker = build_picker(Some(&info), plan);
        let wire_of = |id: &str| {
            picker
                .rows
                .iter()
                .find(|r| r.id == id)
                .map(|r| r.wire_id.clone())
                .unwrap()
        };
        assert_eq!(wire_of("claude-opus-5"), "claude-opus-5");
        assert_eq!(wire_of("claude-opus-4-8"), "claude-opus-4-8");
        assert_eq!(wire_of("claude-sonnet-5"), "claude-sonnet-5[1m]");
        assert_eq!(wire_of("claude-sonnet-4-6"), "claude-sonnet-4-6");
    }

    #[test]
    fn api_key_provider_is_the_api_plan_whatever_claude_code_reports() {
        let info = fixture_info("run_A");
        assert_eq!(
            plan_for(LlmProviderKind::AnthropicApiKey, Some(&info)),
            AnthropicPlan::Api
        );
        assert_eq!(
            plan_for(LlmProviderKind::AnthropicApiKey, None),
            AnthropicPlan::Api
        );
        let picker = build_picker(None, AnthropicPlan::Api);
        let sonnet_46 = picker
            .rows
            .iter()
            .find(|r| r.id == "claude-sonnet-4-6")
            .unwrap();
        assert_eq!(sonnet_46.wire_id, "claude-sonnet-4-6[1m]");
    }

    #[test]
    fn oauth_plan_is_unknown_without_session_info_or_a_known_label() {
        assert_eq!(
            plan_for(LlmProviderKind::AnthropicOauth, None),
            AnthropicPlan::Unknown
        );
        let odd = info_of(Vec::new(), Some("Claude Ultra"));
        assert_eq!(
            plan_for(LlmProviderKind::AnthropicOauth, Some(&odd)),
            AnthropicPlan::Unknown
        );
    }

    #[test]
    fn current_model_claude_code_does_not_list_is_not_offered() {
        let info = info_of(
            vec![
                listed(
                    "default",
                    Some("claude-sonnet-5[1m]"),
                    "Default (recommended)",
                ),
                listed("sonnet", Some("claude-sonnet-5[1m]"), "Sonnet"),
                listed("haiku", Some("claude-haiku-4-5"), "Haiku"),
            ],
            Some("Claude Pro"),
        );
        let picker = build_picker(Some(&info), AnthropicPlan::Pro);
        assert_eq!(
            labels(&picker),
            vec![
                "Sonnet 5",
                "Haiku 4.5",
                "Fable 5",
                "Opus 4.8",
                "Opus 4.7",
                "Opus 4.6",
                "Sonnet 4.6"
            ]
        );
        assert!(picker.rows[0].is_default);
    }

    #[test]
    fn legacy_model_claude_code_lists_keeps_claude_codes_position() {
        let info = info_of(
            vec![
                listed("claude-opus-4-8", Some("claude-opus-4-8"), "Opus 4.8"),
                listed("sonnet", Some("claude-sonnet-5"), "Sonnet"),
            ],
            Some("Claude Max"),
        );
        let picker = build_picker(Some(&info), AnthropicPlan::Max);
        assert_eq!(
            labels(&picker),
            vec![
                "Opus 4.8",
                "Sonnet 5",
                "Fable 5",
                "Opus 4.7",
                "Opus 4.6",
                "Sonnet 4.6"
            ]
        );
        assert!(picker.rows.iter().all(|r| !r.is_default));
    }

    #[test]
    fn dated_resolved_model_groups_with_its_undated_catalog_row() {
        let picker = build_picker(Some(&fixture_info("run_B")), AnthropicPlan::Max);
        let haiku: Vec<&PickerRow> = picker
            .rows
            .iter()
            .filter(|r| r.id.contains("haiku"))
            .collect();
        assert_eq!(haiku.len(), 1);
        assert_eq!(haiku[0].id, "claude-haiku-4-5");
        assert_eq!(haiku[0].wire_id, "claude-haiku-4-5");
    }

    #[test]
    fn model_unknown_to_the_catalog_shows_claude_codes_name_without_the_1m_decoration() {
        let info = info_of(
            vec![
                listed(
                    "default",
                    Some("claude-opus-9[1m]"),
                    "Default (recommended)",
                ),
                listed("opus[1m]", Some("claude-opus-9[1m]"), "Opus (1M context)"),
                listed("opus", Some("claude-opus-9"), "Opus"),
            ],
            Some("Claude Max"),
        );
        let picker = build_picker(Some(&info), AnthropicPlan::Max);
        let row = &picker.rows[0];
        assert_eq!(row.id, "claude-opus-9");
        assert_eq!(row.display_name.as_deref(), Some("Opus"));
        assert_eq!(row.wire_id, "claude-opus-9");
        assert!(row.is_default);
        assert_eq!(
            picker
                .rows
                .iter()
                .filter(|r| r.id == "claude-opus-9")
                .count(),
            1
        );
    }

    #[test]
    fn unknown_model_listed_only_with_1m_keeps_that_id_and_a_clean_name() {
        let info = info_of(
            vec![listed(
                "claude-nova-1[1m]",
                Some("claude-nova-1[1m]"),
                "Nova 1 (1M context)",
            )],
            Some("Claude Max"),
        );
        let row = &build_picker(Some(&info), AnthropicPlan::Max).rows[0];
        assert_eq!(row.id, "claude-nova-1");
        assert_eq!(row.wire_id, "claude-nova-1[1m]");
        assert_eq!(row.display_name.as_deref(), Some("Nova 1"));
    }

    #[test]
    fn row_without_a_resolved_model_falls_back_to_its_value() {
        let info = info_of(
            vec![listed("claude-sonnet-5[1m]", None, "Sonnet 5 (1M context)")],
            None,
        );
        let picker = build_picker(Some(&info), AnthropicPlan::Unknown);
        assert_eq!(picker.rows[0].id, "claude-sonnet-5");
        assert_eq!(picker.rows[0].wire_id, "claude-sonnet-5[1m]");
    }

    #[test]
    fn no_session_info_or_an_empty_list_falls_back_to_the_whole_catalog() {
        for picker in [
            build_picker(None, AnthropicPlan::Unknown),
            build_picker(Some(&info_of(Vec::new(), None)), AnthropicPlan::Unknown),
        ] {
            assert_eq!(picker.source, PickerSource::Catalog);
            let ids: Vec<&str> = picker.rows.iter().map(|r| r.id.as_str()).collect();
            let catalog: Vec<&str> = ANTHROPIC_MODELS.iter().map(|m| m.id).collect();
            assert_eq!(ids, catalog);
            assert!(picker.rows.iter().all(|r| !r.is_default));
            let opus = picker
                .rows
                .iter()
                .find(|r| r.id == "claude-opus-5")
                .unwrap();
            assert_eq!(opus.wire_id, "claude-opus-5");
        }
    }

    #[test]
    fn no_row_id_or_display_name_carries_a_1m_marker() {
        let info = fixture_info("run_A");
        for plan in [AnthropicPlan::Max, AnthropicPlan::Pro, AnthropicPlan::Api] {
            for row in build_picker(Some(&info), plan).rows {
                assert!(!row.id.contains("[1m]"), "{row:?}");
                let name = row.display_name.unwrap_or_default().to_ascii_lowercase();
                assert!(!name.contains("1m"), "{name}");
            }
        }
    }

    #[test]
    fn strip_one_million_decoration_covers_the_known_shapes() {
        for (raw, clean) in [
            ("Opus (1M context)", "Opus"),
            ("Sonnet 5 (1M context)", "Sonnet 5"),
            ("Sonnet 5 (1M)", "Sonnet 5"),
            ("Sonnet 5 [1m]", "Sonnet 5"),
            ("Default (recommended)", "Default (recommended)"),
            ("Fable", "Fable"),
            ("Opus (1M context) (beta)", "Opus (beta)"),
            ("Broken (1M", "Broken (1M"),
            ("", ""),
        ] {
            assert_eq!(strip_one_million_decoration(raw), clean, "{raw:?}");
        }
    }

    #[test]
    fn normalized_pin_moves_a_pin_to_the_id_the_policy_picks() {
        assert_eq!(
            normalized_pin("claude-sonnet-5", AnthropicPlan::Pro).as_deref(),
            Some("claude-sonnet-5[1m]")
        );
        assert_eq!(
            normalized_pin("claude-opus-5", AnthropicPlan::Max).as_deref(),
            Some("claude-opus-5[1m]")
        );
        assert_eq!(
            normalized_pin("claude-opus-5[1m]", AnthropicPlan::Pro).as_deref(),
            Some("claude-opus-5")
        );
        assert_eq!(
            normalized_pin("claude-haiku-4-5-20251001", AnthropicPlan::Max).as_deref(),
            Some("claude-haiku-4-5")
        );
    }

    #[test]
    fn normalized_pin_leaves_a_pin_that_already_matches_the_policy() {
        assert_eq!(
            normalized_pin("claude-fable-5-1[1m]", AnthropicPlan::Max),
            None
        );
        assert_eq!(normalized_pin("claude-opus-5", AnthropicPlan::Pro), None);
        assert_eq!(
            normalized_pin("claude-haiku-4-5", AnthropicPlan::Unknown),
            None
        );
    }

    #[test]
    fn normalized_pin_with_an_unknown_plan_touches_only_plan_independent_models() {
        assert_eq!(
            normalized_pin("claude-sonnet-5", AnthropicPlan::Unknown).as_deref(),
            Some("claude-sonnet-5[1m]")
        );
        assert_eq!(
            normalized_pin("claude-opus-5[1m]", AnthropicPlan::Unknown),
            None
        );
        assert_eq!(
            normalized_pin("claude-sonnet-4-6[1m]", AnthropicPlan::Unknown),
            None
        );
    }

    #[test]
    fn normalized_pin_leaves_aliases_and_foreign_ids_alone() {
        for pin in [
            "opus",
            "fable[1m]",
            "default",
            "claude-opus-9[1m]",
            "local/qwen3",
            "",
        ] {
            assert_eq!(normalized_pin(pin, AnthropicPlan::Max), None, "{pin:?}");
        }
    }

    #[test]
    fn normalize_pin_for_session_rewrites_the_settings_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir =
            speedwave_runtime::claude_home::claude_home_dir(tmp.path(), "proj").join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), r#"{"model":"claude-opus-5"}"#).unwrap();

        let info = fixture_info("run_A");
        normalize_pin_for_session(
            tmp.path(),
            "proj",
            LlmProviderKind::AnthropicOauth,
            Some(&info),
        );
        assert_eq!(
            crate::claude_settings::get_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-opus-5[1m]")
        );

        normalize_pin_for_session(tmp.path(), "proj", LlmProviderKind::AnthropicOauth, None);
        assert_eq!(
            crate::claude_settings::get_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-opus-5[1m]"),
            "an unknown plan must not downgrade a plan-dependent pin"
        );
    }

    #[test]
    fn canonical_model_id_matches_ts() {
        let spec = include_str!("../../src/src/app/models/model-picker.spec.ts");
        let start = spec
            .find("const CANONICAL_CASES")
            .expect("model-picker.spec.ts must keep the CANONICAL_CASES table");
        let table = &spec[start..];
        let table = &table[..table.find("\n];").expect("CANONICAL_CASES must close")];
        let mut cases = 0;
        for line in table.lines().filter(|l| l.trim_start().starts_with("['")) {
            let parts: Vec<&str> = line.split('\'').collect();
            assert_eq!(parts.len(), 5, "unparsable case line: {line}");
            assert_eq!(
                canonical_anthropic_model_id(parts[1]),
                parts[3],
                "Rust and TS disagree on {line}"
            );
            cases += 1;
        }
        assert!(cases >= 10, "parsed only {cases} shared cases");
    }

    #[test]
    fn model_picker_matches_ts_mirror() {
        let ts = include_str!("../../src/src/app/models/model-picker.ts");
        let picker = build_picker(Some(&fixture_info("run_A")), AnthropicPlan::Max);
        let fields = |value: serde_json::Value| {
            let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort_unstable();
            keys
        };
        let ts_fields = |name: &str| {
            let marker = format!("export interface {name} {{");
            let idx = ts
                .find(&marker)
                .unwrap_or_else(|| panic!("missing `{marker}`"));
            let body = ts[idx + marker.len()..].split("\n}").next().unwrap();
            let mut keys: Vec<&str> = body
                .lines()
                .filter_map(|l| l.split(':').next())
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.starts_with('/') && !s.starts_with('*'))
                .collect();
            keys.sort_unstable();
            keys
        };
        assert_eq!(
            fields(serde_json::to_value(&picker.rows[0]).unwrap()),
            ts_fields("ModelPickerRow")
        );
        assert_eq!(
            fields(serde_json::to_value(&picker).unwrap()),
            ts_fields("ModelPicker")
        );
        for source in [PickerSource::ClaudeCode, PickerSource::Catalog] {
            let tag = serde_json::to_value(source).unwrap();
            assert!(
                ts.contains(&format!("'{}'", tag.as_str().unwrap())),
                "ModelPickerSource must carry {tag}"
            );
        }
    }
}

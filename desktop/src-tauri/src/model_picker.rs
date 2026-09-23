use crate::chat::SharedChatSession;
use crate::control_channel::{ModelRow, SessionInfo, SessionInfoState};
use crate::types::check_project;
use serde::Serialize;
use speedwave_runtime::config::{self, LlmProviderKind};
use speedwave_runtime::defaults::{
    anthropic_wire_model_id, canonical_anthropic_model_id, AnthropicModelInfo, AnthropicPlan,
    OneMillionContext, ANTHROPIC_MODELS, EFFORT_LEVELS,
};
use std::path::Path;

const DEFAULT_ROW_VALUE: &str = "default";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct PickerRow {
    pub(crate) id: String,
    pub(crate) wire_id: String,
    pub(crate) is_default: bool,
    pub(crate) display_name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) requires_usage_credits: bool,
    pub(crate) effort_levels: Vec<String>,
    pub(crate) default_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct ModelPicker {
    pub(crate) rows: Vec<PickerRow>,
    pub(crate) effort_order: Vec<String>,
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

fn catalog_entry(id: &str) -> Option<&'static AnthropicModelInfo> {
    ANTHROPIC_MODELS.iter().find(|m| m.id == id)
}

fn effort_order() -> Vec<String> {
    EFFORT_LEVELS.iter().map(|l| (*l).to_string()).collect()
}

fn listed_effort_levels(listed: &ModelRow) -> Vec<String> {
    if !listed.supports_effort {
        return Vec::new();
    }
    EFFORT_LEVELS
        .iter()
        .filter(|level| listed.supported_effort_levels.iter().any(|l| l == *level))
        .map(|level| (*level).to_string())
        .collect()
}

fn catalog_default_effort(id: &str, levels: &[String]) -> Option<String> {
    catalog_entry(id)
        .and_then(|m| m.default_effort)
        .filter(|default| levels.iter().any(|l| l == default))
        .map(str::to_string)
}

fn group_of<'a>(id: &str, info: &'a SessionInfo) -> Vec<&'a ModelRow> {
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
    if named.is_empty() {
        group
    } else {
        named
    }
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

fn clean_description(row: &ModelRow) -> Option<String> {
    let description = row.description.trim();
    (!description.is_empty()).then(|| description.to_string())
}

fn requires_usage_credits(row: &ModelRow) -> bool {
    row.description
        .to_ascii_lowercase()
        .contains("requires usage credits")
}

fn listed_variant<'a>(
    id: &str,
    group: &'a [&'a ModelRow],
    plan: AnthropicPlan,
) -> Option<&'a ModelRow> {
    let desired = catalog_entry(id).map(|_| anthropic_wire_model_id(id, plan));
    if let Some(desired) = desired.as_deref() {
        if let Some(exact) = group.iter().copied().find(|row| row_model(row) == desired) {
            return Some(exact);
        }
        let wants_one_million = desired.ends_with("[1m]");
        if let Some(same_context) = group
            .iter()
            .copied()
            .find(|row| row_model(row).ends_with("[1m]") == wants_one_million)
        {
            return Some(same_context);
        }
    }
    group
        .iter()
        .copied()
        .find(|row| !row_model(row).ends_with("[1m]"))
        .or_else(|| group.first().copied())
}

fn listed_row(id: &str, info: &SessionInfo, plan: AnthropicPlan, is_default: bool) -> PickerRow {
    let group = group_of(id, info);
    let chosen = listed_variant(id, &group, plan);
    let effort_levels = chosen.map(listed_effort_levels).unwrap_or_default();
    let default_effort = catalog_default_effort(id, &effort_levels);
    let description = chosen.and_then(clean_description);
    let requires_usage_credits = chosen.is_some_and(requires_usage_credits);
    if catalog_entry(id).is_some() {
        return PickerRow {
            id: id.to_string(),
            wire_id: chosen.map_or_else(|| id.to_string(), |m| row_model(m).to_string()),
            is_default,
            display_name: None,
            description,
            requires_usage_credits,
            effort_levels,
            default_effort,
        };
    }
    PickerRow {
        id: id.to_string(),
        wire_id: chosen.map_or_else(|| id.to_string(), |m| row_model(m).to_string()),
        is_default,
        display_name: chosen
            .map(|m| strip_one_million_decoration(&m.display_name))
            .filter(|name| !name.is_empty()),
        description,
        requires_usage_credits,
        effort_levels,
        default_effort,
    }
}

pub(crate) fn build_picker(info: &SessionInfo, plan: AnthropicPlan) -> Option<ModelPicker> {
    if info.models.is_empty() {
        return None;
    }
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
        rows.push(listed_row(id, info, plan, is_default));
    }
    Some(ModelPicker {
        rows,
        effort_order: effort_order(),
    })
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
    let picker = info.and_then(|session| build_picker(session, plan));
    match crate::claude_settings::normalize_model_pin(data_dir, project, |pin| {
        if let Some(picker) = &picker {
            let id = canonical_anthropic_model_id(pin);
            picker
                .rows
                .iter()
                .find(|row| row.id == id)
                .filter(|row| row.wire_id != pin)
                .map(|row| row.wire_id.clone())
        } else {
            normalized_pin(pin, plan)
        }
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
) -> Result<Option<ModelPicker>, String> {
    let summary = crate::containers_cmd::active_provider_summary_from(user_config, project)?;
    if !summary.kind.is_anthropic() {
        return Err("the model picker rows exist for Anthropic providers only".to_string());
    }
    let info = session_info_for(session_arc, project);
    let plan = plan_for(summary.kind, info.as_ref());
    Ok(info.as_ref().and_then(|info| build_picker(info, plan)))
}

#[tauri::command]
pub(crate) fn list_model_picker(
    project: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<Option<ModelPicker>, String> {
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

    fn listed_with_effort(value: &str, resolved: &str, levels: &[&str]) -> ModelRow {
        ModelRow {
            supports_effort: true,
            supported_effort_levels: levels.iter().map(|l| (*l).to_string()).collect(),
            ..listed(value, Some(resolved), value)
        }
    }

    fn effort_of<'a>(picker: &'a ModelPicker, id: &str) -> (&'a [String], Option<&'a str>) {
        let row = picker
            .rows
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("no row for {id}"));
        (&row.effort_levels, row.default_effort.as_deref())
    }

    fn picker_of(info: &SessionInfo, plan: AnthropicPlan) -> ModelPicker {
        build_picker(info, plan).expect("Claude Code listed at least one model")
    }

    #[test]
    fn listed_model_takes_its_effort_stops_from_claude_code_not_the_catalog() {
        let info = info_of(
            vec![listed_with_effort(
                "sonnet",
                "claude-sonnet-5[1m]",
                &["low", "medium", "high"],
            )],
            Some("Claude Max"),
        );
        let picker = picker_of(&info, AnthropicPlan::Max);
        let (levels, default) = effort_of(&picker, "claude-sonnet-5");
        assert_eq!(levels, ["low", "medium", "high"]);
        assert_eq!(default, Some("high"));
    }

    #[test]
    fn listed_model_without_supports_effort_offers_no_stops() {
        let picker = picker_of(&fixture_info("run_A"), AnthropicPlan::Max);
        let (levels, default) = effort_of(&picker, "claude-haiku-4-5");
        assert!(levels.is_empty());
        assert_eq!(default, None);
    }

    #[test]
    fn listed_model_with_levels_but_no_supports_effort_flag_offers_no_stops() {
        let mut row = listed_with_effort("opus", "claude-opus-5", &["low", "high"]);
        row.supports_effort = false;
        let picker = picker_of(&info_of(vec![row], None), AnthropicPlan::Unknown);
        assert!(effort_of(&picker, "claude-opus-5").0.is_empty());
    }

    #[test]
    fn captured_max_account_reports_all_five_stops_for_every_listed_effort_model() {
        let picker = picker_of(&fixture_info("run_A"), AnthropicPlan::Max);
        for id in ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5"] {
            let (levels, default) = effort_of(&picker, id);
            assert_eq!(levels, EFFORT_LEVELS, "{id}");
            assert_eq!(default, Some("high"), "{id}");
        }
    }

    #[test]
    fn successful_initialize_does_not_restore_models_claude_code_omits() {
        let picker = picker_of(&fixture_info("run_A"), AnthropicPlan::Max);
        for id in [
            "claude-fable-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
        ] {
            assert!(!picker.rows.iter().any(|row| row.id == id), "{id}");
        }
    }

    #[test]
    fn effort_stops_follow_the_slider_order_and_drop_levels_speedwave_cannot_pin() {
        let info = info_of(
            vec![listed_with_effort(
                "opus",
                "claude-opus-5",
                &["max", "ultra", "low", "high"],
            )],
            None,
        );
        let picker = picker_of(&info, AnthropicPlan::Unknown);
        assert_eq!(
            effort_of(&picker, "claude-opus-5").0,
            ["low", "high", "max"]
        );
    }

    #[test]
    fn catalog_default_effort_outside_the_reported_stops_is_not_offered() {
        let info = info_of(
            vec![listed_with_effort(
                "claude-opus-4-7",
                "claude-opus-4-7",
                &["low", "medium"],
            )],
            None,
        );
        let picker = picker_of(&info, AnthropicPlan::Unknown);
        assert_eq!(effort_of(&picker, "claude-opus-4-7").1, None);
    }

    #[test]
    fn model_unknown_to_the_catalog_has_stops_but_no_default() {
        let info = info_of(
            vec![listed_with_effort(
                "claude-nova-1",
                "claude-nova-1",
                &["low", "high"],
            )],
            None,
        );
        let picker = picker_of(&info, AnthropicPlan::Unknown);
        let (levels, default) = effort_of(&picker, "claude-nova-1");
        assert_eq!(levels, ["low", "high"]);
        assert_eq!(default, None);
    }

    #[test]
    fn picker_carries_the_effort_order_from_the_ssot() {
        let picker = picker_of(&fixture_info("run_A"), AnthropicPlan::Max);
        assert_eq!(picker.effort_order, EFFORT_LEVELS);
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
    fn max_account_lists_every_reported_model_once_with_default_on_opus_5() {
        for run in ["run_A", "run_B"] {
            let info = fixture_info(run);
            let plan = plan_for(LlmProviderKind::AnthropicOauth, Some(&info));
            assert_eq!(plan, AnthropicPlan::Max);
            let picker = picker_of(&info, plan);
            assert_eq!(
                labels(&picker),
                vec!["Opus 5", "Fable 5.1", "Sonnet 5", "Haiku 4.5"],
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
    fn max_account_wire_ids_are_exactly_the_reported_variants() {
        let info = fixture_info("run_A");
        let picker = picker_of(&info, AnthropicPlan::Max);
        let wire: Vec<&str> = picker.rows.iter().map(|r| r.wire_id.as_str()).collect();
        assert_eq!(
            wire,
            vec![
                "claude-opus-5[1m]",
                "claude-fable-5-1[1m]",
                "claude-sonnet-5[1m]",
                "claude-haiku-4-5"
            ]
        );
    }

    #[test]
    fn plan_preference_selects_among_variants_claude_code_actually_reported() {
        let info = info_of(
            vec![
                listed("opus[1m]", Some("claude-opus-5[1m]"), "Opus (1M)"),
                listed("opus", Some("claude-opus-5"), "Opus"),
            ],
            Some("Claude Pro"),
        );
        let pro = picker_of(&info, AnthropicPlan::Pro);
        assert_eq!(pro.rows[0].wire_id, "claude-opus-5");

        let max = picker_of(&info, AnthropicPlan::Max);
        assert_eq!(max.rows[0].wire_id, "claude-opus-5[1m]");
    }

    #[test]
    fn plan_preference_never_synthesizes_an_unreported_variant() {
        let info = info_of(
            vec![listed(
                "opus[1m]",
                Some("claude-opus-5-20260901[1m]"),
                "Opus (1M)",
            )],
            Some("Claude Pro"),
        );
        let row = &picker_of(&info, AnthropicPlan::Pro).rows[0];
        assert_eq!(row.wire_id, "claude-opus-5-20260901[1m]");
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
        let info = info_of(
            vec![
                listed("claude-sonnet-4-6", Some("claude-sonnet-4-6"), "Sonnet 4.6"),
                listed(
                    "claude-sonnet-4-6[1m]",
                    Some("claude-sonnet-4-6[1m]"),
                    "Sonnet 4.6 (1M context)",
                ),
            ],
            None,
        );
        let picker = picker_of(&info, AnthropicPlan::Api);
        assert_eq!(picker.rows[0].wire_id, "claude-sonnet-4-6[1m]");
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
        let picker = picker_of(&info, AnthropicPlan::Pro);
        assert_eq!(labels(&picker), vec!["Sonnet 5", "Haiku 4.5"]);
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
        let picker = picker_of(&info, AnthropicPlan::Max);
        assert_eq!(labels(&picker), vec!["Opus 4.8", "Sonnet 5"]);
        assert!(picker.rows.iter().all(|r| !r.is_default));
    }

    #[test]
    fn dated_resolved_model_groups_with_its_catalog_row_and_keeps_the_snapshot() {
        let picker = picker_of(&fixture_info("run_B"), AnthropicPlan::Max);
        let haiku: Vec<&PickerRow> = picker
            .rows
            .iter()
            .filter(|r| r.id.contains("haiku"))
            .collect();
        assert_eq!(haiku.len(), 1);
        assert_eq!(haiku[0].id, "claude-haiku-4-5");
        assert_eq!(haiku[0].wire_id, "claude-haiku-4-5-20251001");
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
        let picker = picker_of(&info, AnthropicPlan::Max);
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
        let row = &picker_of(&info, AnthropicPlan::Max).rows[0];
        assert_eq!(row.id, "claude-nova-1");
        assert_eq!(row.wire_id, "claude-nova-1[1m]");
        assert_eq!(row.display_name.as_deref(), Some("Nova 1"));
    }

    #[test]
    fn picker_preserves_the_selected_rows_usage_credit_warning() {
        let mut paid = listed("claude-fable-5-1", Some("claude-fable-5-1"), "Fable");
        paid.description = "Fable 5.1 · Requires usage credits for this account".to_string();
        let row = &picker_of(&info_of(vec![paid], Some("Claude Pro")), AnthropicPlan::Pro).rows[0];
        assert_eq!(
            row.description.as_deref(),
            Some("Fable 5.1 · Requires usage credits for this account")
        );
        assert!(row.requires_usage_credits);
    }

    #[test]
    fn ordinary_descriptions_do_not_trigger_the_usage_credit_warning() {
        let mut included = listed("sonnet", Some("claude-sonnet-5"), "Sonnet");
        included.description = "Efficient for routine tasks".to_string();
        let row = &picker_of(
            &info_of(vec![included], Some("Claude Pro")),
            AnthropicPlan::Pro,
        )
        .rows[0];
        assert_eq!(
            row.description.as_deref(),
            Some("Efficient for routine tasks")
        );
        assert!(!row.requires_usage_credits);
    }

    #[test]
    fn row_without_a_resolved_model_falls_back_to_its_value() {
        let info = info_of(
            vec![listed("claude-sonnet-5[1m]", None, "Sonnet 5 (1M context)")],
            None,
        );
        let picker = picker_of(&info, AnthropicPlan::Unknown);
        assert_eq!(picker.rows[0].id, "claude-sonnet-5");
        assert_eq!(picker.rows[0].wire_id, "claude-sonnet-5[1m]");
    }

    #[test]
    fn an_empty_model_list_yields_no_picker() {
        for plan in [
            AnthropicPlan::Unknown,
            AnthropicPlan::Max,
            AnthropicPlan::Api,
        ] {
            assert_eq!(build_picker(&info_of(Vec::new(), None), plan), None);
        }
    }

    #[test]
    fn no_row_id_or_display_name_carries_a_1m_marker() {
        let info = fixture_info("run_A");
        for plan in [AnthropicPlan::Max, AnthropicPlan::Pro, AnthropicPlan::Api] {
            for row in picker_of(&info, plan).rows {
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
    fn normalize_pin_for_session_uses_the_reported_variant_not_a_synthetic_one() {
        let tmp = tempfile::tempdir().unwrap();
        let dir =
            speedwave_runtime::claude_home::claude_home_dir(tmp.path(), "proj").join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"claude-sonnet-5[1m]"}"#,
        )
        .unwrap();

        let info = info_of(
            vec![listed("sonnet", Some("claude-sonnet-5"), "Sonnet")],
            Some("Claude Max"),
        );
        normalize_pin_for_session(
            tmp.path(),
            "proj",
            LlmProviderKind::AnthropicOauth,
            Some(&info),
        );
        assert_eq!(
            crate::claude_settings::get_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-sonnet-5")
        );
    }

    #[test]
    fn model_selector_takes_the_slider_order_from_the_picker_not_from_a_level_count() {
        let ts = include_str!(
            "../../src/src/app/chat/composer/model-selector/model-selector.component.ts"
        );
        assert!(
            !ts.contains("length === 5"),
            "the slider order comes from EFFORT_LEVELS via the picker's effort_order"
        );
        assert!(ts.contains("effort_order"));
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
        let picker = picker_of(&fixture_info("run_A"), AnthropicPlan::Max);
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
    }

    fn anthropic_oauth_config(project: &str) -> config::SpeedwaveUserConfig {
        config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: project.to_string(),
                dir: "/tmp/proj".to_string(),
                claude: Some(config::ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(config::LlmConfig {
                        schema_version: Some(config::LLM_SCHEMA_VERSION),
                        providers: vec![config::LlmProviderEntry {
                            id: config::ANTHROPIC_PROVIDER_ID.to_string(),
                            kind: LlmProviderKind::AnthropicOauth,
                            base_url: None,
                            model: None,
                            has_api_key: false,
                            context_tokens: None,
                            has_custom_headers: false,
                        }],
                        active: Some(config::LlmActive {
                            provider_id: config::ANTHROPIC_PROVIDER_ID.to_string(),
                            model: None,
                        }),
                        ..Default::default()
                    }),
                }),
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            ..Default::default()
        }
    }

    fn idle_session(project: &str) -> SharedChatSession {
        std::sync::Arc::new(std::sync::Mutex::new(crate::chat::ChatSession::new(
            project,
            "550e8400-e29b-41d4-a716-446655440000",
            std::sync::Arc::new(std::sync::Mutex::new(None)),
        )))
    }

    #[test]
    fn picker_offers_no_rows_until_the_session_reports_its_models() {
        let cfg = anthropic_oauth_config("proj");
        let session = idle_session("proj");

        assert_eq!(picker_for(&cfg, &session, "proj").unwrap(), None);

        let held = session.lock().unwrap();
        let respawning = picker_for(&cfg, &session, "proj");
        drop(held);
        assert_eq!(respawning.unwrap(), None);
    }

    #[test]
    fn picker_rows_exist_for_anthropic_providers_only() {
        let mut cfg = anthropic_oauth_config("proj");
        let llm = cfg.projects[0]
            .claude
            .as_mut()
            .unwrap()
            .llm
            .as_mut()
            .unwrap();
        llm.providers[0].kind = LlmProviderKind::Local;
        llm.providers[0].base_url = Some("http://host.docker.internal:11434".to_string());

        let err = picker_for(&cfg, &idle_session("proj"), "proj").unwrap_err();
        assert!(err.contains("Anthropic providers only"), "{err}");
    }
}

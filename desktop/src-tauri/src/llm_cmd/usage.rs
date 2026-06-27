//! LLM usage/cost aggregation (ADR-073).
//!
//! Reads the proxy usage JSONL + host cost sidecar to surface the dashboard,
//! chat-footer, and session/conversation totals, enriching pending OpenRouter
//! `/generation` costs host-side.

use crate::http_util::read_body_limited;
use crate::llm_cmd::{build_llm_probe_client_with_auth, strip_bearer_prefix};

/// OpenRouter generation-cost endpoint — fixed host, never user input.
const OPENROUTER_GENERATION_URL: &str = "https://openrouter.ai/api/v1/generation";

/// Aggregated LLM usage for the project's dashboard. The single source is
/// the proxy callback JSONL (see `speedwave_runtime::usage`); chat-stream
/// session stats are deliberately NOT mixed in (double counting).
#[tauri::command]
pub async fn get_llm_usage(
    project: String,
) -> Result<speedwave_runtime::usage::UsageSummary, String> {
    let data_dir = speedwave_runtime::consts::data_dir();
    speedwave_runtime::usage::rotate_usage_if_large_in(data_dir.as_path(), &project);
    enrich_with_openrouter(data_dir.as_path(), &project).await;
    Ok(speedwave_runtime::usage::read_usage_summary_in(
        data_dir.as_path(),
        &project,
    ))
}

/// Final usage (tokens + cost) for one response id, for the chat-footer
/// reconcile. Bounded retry: the proxy append can lag Claude Code's `result`.
/// `None` on miss (the footer then keeps Claude Code's live values).
#[tauri::command]
pub async fn get_usage_for_response(
    project: String,
    response_id: String,
) -> Option<speedwave_runtime::usage::ResponseUsage> {
    let data_dir = speedwave_runtime::consts::data_dir();
    // Wait (cheap, no HTTP) for the proxy's async usage append. Backoff grows
    // 100→1600ms (~3.1s total) to tolerate slow I/O (Windows/WSL2); the proxy
    // write usually lands on the first attempt.
    let mut found = None;
    let mut delay = std::time::Duration::from_millis(100);
    for attempt in 0..6 {
        if attempt > 0 {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
        found = speedwave_runtime::usage::get_usage_for_response_in(
            data_dir.as_path(),
            &project,
            &response_id,
        );
        if found.is_some() {
            break;
        }
    }
    let u = found?;
    // Line is present; enrich cost once (HTTP + sidecar) only if not yet priced.
    if u.cost_usd.is_some() {
        return Some(u);
    }
    enrich_with_openrouter(data_dir.as_path(), &project).await;
    speedwave_runtime::usage::get_usage_for_response_in(data_dir.as_path(), &project, &response_id)
}

/// Summed session cost (USD) from the proxy cost sidecar — the single
/// aggregator (invariant 6). `None` when nothing priced, never 0.0. Enriches
/// pending OpenRouter `/generation` costs first so the total is current.
#[tauri::command]
pub async fn get_session_cost(project: String) -> Option<f64> {
    let data_dir = speedwave_runtime::consts::data_dir();
    let dir = data_dir.as_path();
    speedwave_runtime::usage::rotate_usage_if_large_in(dir, &project);
    // One scan yields both the enrich work-list and the window for the sum;
    // enrich only writes the sidecar, so the window stays valid afterward.
    let priced = speedwave_runtime::usage_cost::read_cost_cache_in(dir, &project);
    let window = speedwave_runtime::usage::scan_usage_window_in(dir, &project, &priced);
    enrich_openrouter_gen_ids(dir, &project, window.pending_gen_ids).await;
    speedwave_runtime::usage::session_cost_for_window_in(dir, &project, &window.ids)
}

/// Summed cost (USD) for the current conversation's `response_id`s — the chat
/// footer total. `None` when none are priced (subscription/unknown), never 0.0.
#[tauri::command]
pub async fn get_conversation_cost(project: String, response_ids: Vec<String>) -> Option<f64> {
    let data_dir = speedwave_runtime::consts::data_dir();
    enrich_with_openrouter(data_dir.as_path(), &project).await;
    speedwave_runtime::usage::conversation_cost_in(data_dir.as_path(), &project, &response_ids)
}

/// Fetches pending OpenRouter `/generation` costs and writes them into the cost
/// sidecar. No-op (no HTTP) when nothing is pending — the common case.
async fn enrich_with_openrouter(data_dir: &std::path::Path, project: &str) {
    let gen_ids = speedwave_runtime::usage_cost::pending_deferred_gen_ids(data_dir, project);
    enrich_openrouter_gen_ids(data_dir, project, gen_ids).await;
}

/// `enrich_with_openrouter` with a pre-scanned gen-id list, so callers that
/// already walked the usage JSONL avoid a second scan.
async fn enrich_openrouter_gen_ids(
    data_dir: &std::path::Path,
    project: &str,
    gen_ids: Vec<String>,
) {
    if gen_ids.is_empty() {
        return;
    }
    let gen_costs = openrouter_costs_for(data_dir, project, gen_ids).await;
    if let Err(e) =
        speedwave_runtime::usage_cost::enrich_cost_with_in(data_dir, project, &|gen_id| {
            gen_costs.get(gen_id).copied()
        })
    {
        log::warn!("cost sidecar write failed for project '{project}': {e}");
    }
}

/// Resolves real OpenRouter cost for the given `gen_id`s into a `gen_id` → USD
/// map (host-side `/generation`). Fetches run concurrently — the generations
/// are independent.
async fn openrouter_costs_for(
    data_dir: &std::path::Path,
    project: &str,
    gen_ids: Vec<String>,
) -> std::collections::HashMap<String, f64> {
    let fetches = gen_ids.into_iter().map(|gen| async move {
        fetch_openrouter_gen_cost(data_dir, project, &gen)
            .await
            .map(|cost| (gen, cost))
    });
    futures_util::future::join_all(fetches)
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// Real cost (`data.total_cost`, USD) for an OpenRouter generation id, fetched
/// host-side (ADR-041). `None` on a non-`gen-` id, missing key, or any error.
async fn fetch_openrouter_gen_cost(
    data_dir: &std::path::Path,
    project: &str,
    gen_id: &str,
) -> Option<f64> {
    if !gen_id.starts_with("gen-") {
        return None;
    }
    let key_path =
        speedwave_runtime::compose::llm_provider_key_path_in(data_dir, project, "openrouter")
            .ok()?;
    let key = strip_bearer_prefix(&std::fs::read_to_string(key_path).ok()?)?;
    let client = build_llm_probe_client_with_auth(Some(&key), None).ok()?;
    let resp = client
        .get(OPENROUTER_GENERATION_URL)
        .query(&[("id", gen_id)])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = read_body_limited(resp, "openrouter generation")
        .await
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&body).ok()?;
    v.get("data")?.get("total_cost")?.as_f64()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn gen_cost_rejects_non_gen_id_without_http() {
        let dir = tempfile::tempdir().unwrap();
        // A non-`gen-` id never touches the network or the key file.
        let c = fetch_openrouter_gen_cost(dir.path(), "proj", "msg_1").await;
        assert!(c.is_none());
    }

    #[tokio::test]
    async fn gen_cost_missing_key_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let c = fetch_openrouter_gen_cost(dir.path(), "proj", "gen-abc").await;
        assert!(c.is_none(), "no openrouter key on disk → None, not a panic");
    }

    #[tokio::test]
    async fn openrouter_costs_empty_when_no_openrouter_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = speedwave_runtime::usage::usage_file_in(dir.path(), "proj");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"local/qwen3","response_id":"m1","provider_kind":"local"}"#,
        )
        .unwrap();
        let gen_ids = speedwave_runtime::usage_cost::pending_deferred_gen_ids(dir.path(), "proj");
        let map = openrouter_costs_for(dir.path(), "proj", gen_ids).await;
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn enrich_empty_gen_ids_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        // Empty work-list → no HTTP, sidecar stays absent (read returns empty).
        enrich_openrouter_gen_ids(dir.path(), "proj", Vec::new()).await;
        let costs = speedwave_runtime::usage_cost::read_cost_cache_in(dir.path(), "proj");
        assert!(costs.is_empty());
    }
}

//! Host-side cost enrichment for the proxy usage JSONL (ADR-073).
//! The proxy writes token lines with `cost_usd: null`; cost is computed here,
//! per provider, into an append-only sidecar keyed by `response_id` — the usage
//! JSONL is never mutated (it races the proxy's append + rotation).

use crate::usage::UsageRecord;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// One sidecar line: the priced result for a single `response_id`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CostEntry {
    /// Joins back to the usage line.
    pub response_id: String,
    /// USD cost; `None` for subscription/unknown/error (never collapsed to 0.0).
    pub cost_usd: Option<f64>,
    /// Provenance: `catalog` | `subscription` | `free` | `actual` | `unknown` | `deferred`.
    pub cost_source: String,
}

/// Sidecar cost cache, alongside the proxy usage JSONL.
pub fn cost_cache_file_in(data_dir: &Path, project: &str) -> PathBuf {
    data_dir
        .join("usage")
        .join(project)
        .join("proxy")
        .join("cost-cache.jsonl")
}

/// Fetches OpenRouter's real cost for a generation id via `GET /generation`
/// (`data.total_cost`, USD). Injected host-side (Desktop) so the runtime keeps
/// no HTTP/SSRF surface; `None` on missing id, transport error, or absent field.
pub type GenCostFetcher<'a> = dyn Fn(&str) -> Option<f64> + 'a;

/// Computes the cost for one usage record by its `provider_kind`, with no
/// OpenRouter fetcher — the `openrouter` branch resolves to `unknown` (used by
/// non-HTTP callers and the catalog/local/oauth paths).
pub fn compute_cost(r: &UsageRecord) -> CostEntry {
    compute_cost_with(r, &|_| None)
}

/// Computes the cost for one usage record. `openrouter` calls `fetch_gen_cost`
/// with the line's `gen_id`: a `None` result with a gen_id is `deferred`
/// (retryable), a missing gen_id is `unknown` (terminal — no other source).
pub fn compute_cost_with(r: &UsageRecord, fetch_gen_cost: &GenCostFetcher) -> CostEntry {
    let id = r.response_id.clone().unwrap_or_default();
    let (cost_usd, cost_source) = match r.provider_kind.as_str() {
        "anthropic_apikey" => match anthropic_catalog_cost(r) {
            Some(c) => (Some(c), "catalog"),
            None => (None, "unknown"),
        },
        "anthropic_oauth" => (None, "subscription"),
        "local" | "openai_compat" => (Some(0.0), "free"),
        // With a gen_id the cost is still fetchable later → `deferred` (retryable);
        // without one no source exists → `unknown` (terminal).
        "openrouter" => match r.gen_id.as_deref().filter(|g| !g.is_empty()) {
            Some(gen) => match fetch_gen_cost(gen) {
                Some(c) => (Some(c), "actual"),
                None => (None, "deferred"),
            },
            None => (None, "unknown"),
        },
        _ => (None, "unknown"),
    };
    CostEntry {
        response_id: id,
        cost_usd,
        cost_source: cost_source.to_string(),
    }
}

/// Anthropic-API-key cost from the in-repo catalog (USD per 1M tokens). `None`
/// when the model id is absent from the catalog (caller maps to `unknown`).
fn anthropic_catalog_cost(r: &UsageRecord) -> Option<f64> {
    let model = r.model.as_deref()?;
    // `[1m]` suffix selects the 1M-context price variant when present.
    let is_1m = model.ends_with("[1m]");
    let base = model.trim_end_matches("[1m]");
    let info = crate::defaults::ANTHROPIC_MODELS
        .iter()
        .find(|m| m.id == base)?;
    let p = if is_1m {
        info.pricing_1m.as_ref().unwrap_or(&info.pricing)
    } else {
        &info.pricing
    };
    let cost = (r.prompt_tokens.unwrap_or(0) as f64 * p.input
        + r.completion_tokens.unwrap_or(0) as f64 * p.output
        + r.cache_read.unwrap_or(0) as f64 * p.cached_input
        + r.cache_write.unwrap_or(0) as f64 * p.cache_write)
        / 1_000_000.0;
    Some(cost)
}

/// A cost_source that won't change on re-enrichment. Only `deferred` (an
/// OpenRouter line whose `/generation` fetch has not yet succeeded) is
/// non-terminal and re-priced on a later pass; `unknown` is permanent.
pub fn is_terminal_cost(source: &str) -> bool {
    source != "deferred"
}

/// Appends a `CostEntry` per not-yet-priced `response_id`; idempotent, usage
/// JSONL read-only. No fetcher — `openrouter` → `unknown` (see [`enrich_cost_with_in`]).
pub fn enrich_cost_in(data_dir: &Path, project: &str) -> std::io::Result<()> {
    enrich_cost_with_in(data_dir, project, &|_| None)
}

/// Like [`enrich_cost_in`], but `openrouter` lines are priced via the injected
/// `fetch_gen_cost` (real `GET /generation`, host-side).
pub fn enrich_cost_with_in(
    data_dir: &Path,
    project: &str,
    fetch_gen_cost: &GenCostFetcher,
) -> std::io::Result<()> {
    if crate::validation::validate_project_name(project).is_err() {
        return Ok(());
    }
    let already = read_cost_cache_in(data_dir, project);
    let mut to_append: Vec<CostEntry> = Vec::new();
    let mut queued: std::collections::HashSet<String> = std::collections::HashSet::new();
    crate::usage::for_each_usage_record(data_dir, project, |record| {
        let Some(id) = record.response_id.clone().filter(|s| !s.is_empty()) else {
            return;
        };
        let prior = already.get(&id);
        // Skip ids already resolved to a terminal cost; re-price non-terminal
        // ones (`deferred`) so a lagging OpenRouter `/generation` can recover.
        if prior.is_some_and(|e| is_terminal_cost(&e.cost_source)) || !queued.insert(id) {
            return;
        }
        let entry = compute_cost_with(&record, fetch_gen_cost);
        // Append only when the re-priced result actually changes — a still-
        // `deferred` line must not grow the sidecar on every pass.
        if prior.is_some_and(|e| e.cost_source == entry.cost_source && e.cost_usd == entry.cost_usd)
        {
            return;
        }
        to_append.push(entry);
    });
    if to_append.is_empty() {
        return Ok(());
    }
    let cache = cost_cache_file_in(data_dir, project);
    if let Some(parent) = cache.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&cache)?;
    for entry in &to_append {
        let line = serde_json::to_string(entry).unwrap_or_default();
        writeln!(f, "{line}")?;
    }
    Ok(())
}

/// Reads the sidecar into a `response_id` → `CostEntry` map; last write wins.
pub fn read_cost_cache_in(data_dir: &Path, project: &str) -> HashMap<String, CostEntry> {
    let mut out = HashMap::new();
    if crate::validation::validate_project_name(project).is_err() {
        return out;
    }
    let Ok(content) = std::fs::read_to_string(cost_cache_file_in(data_dir, project)) else {
        return out;
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<CostEntry>(trimmed) {
            out.insert(entry.response_id.clone(), entry);
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::usage::usage_file_in;

    fn record(
        kind: &str,
        model: &str,
        prompt: u64,
        completion: u64,
        cr: u64,
        cw: u64,
    ) -> UsageRecord {
        record_with_id("msg_1", kind, model, prompt, completion, cr, cw)
    }

    fn record_with_id(
        id: &str,
        kind: &str,
        model: &str,
        prompt: u64,
        completion: u64,
        cr: u64,
        cw: u64,
    ) -> UsageRecord {
        serde_json::from_value(serde_json::json!({
            "ts": "2026-06-26T10:00:00+0200",
            "model": model,
            "response_id": id,
            "provider_kind": kind,
            "provider_id": kind,
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cache_read": cr,
            "cache_write": cw,
        }))
        .unwrap()
    }

    fn write_usage_line(dir: &Path, project: &str, id: &str, kind: &str, model: &str) {
        let path = usage_file_in(dir, project);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let line = serde_json::to_string(&serde_json::json!({
            "ts": "2026-06-26T10:00:00+0200",
            "status": "success",
            "model": model,
            "response_id": id,
            "provider_kind": kind,
            "provider_id": kind,
            "prompt_tokens": 100,
            "completion_tokens": 50,
        }))
        .unwrap();
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{line}").unwrap();
    }

    fn write_openrouter_line(dir: &Path, project: &str, id: &str, gen_id: &str) {
        let path = usage_file_in(dir, project);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let line = serde_json::to_string(&serde_json::json!({
            "ts": "2026-06-26T10:00:00+0200",
            "status": "success",
            "model": "anthropic/claude-3.5-haiku",
            "response_id": id,
            "provider_kind": "openrouter",
            "provider_id": "openrouter",
            "gen_id": gen_id,
            "prompt_tokens": 100,
            "completion_tokens": 50,
        }))
        .unwrap();
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{line}").unwrap();
    }

    #[test]
    fn anthropic_apikey_cost_from_catalog() {
        // 1M input tokens of opus (input 5.0/MTok) = $5.00 exactly.
        let e = compute_cost(&record(
            "anthropic_apikey",
            "claude-opus-4-8",
            1_000_000,
            0,
            0,
            0,
        ));
        assert!(
            (e.cost_usd.unwrap() - 5.0).abs() < 1e-9,
            "got {:?}",
            e.cost_usd
        );
        assert_eq!(e.cost_source, "catalog");
    }

    #[test]
    fn oauth_cost_is_null_subscription() {
        let e = compute_cost(&record(
            "anthropic_oauth",
            "claude-opus-4-8",
            100,
            100,
            0,
            0,
        ));
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, "subscription");
    }

    #[test]
    fn local_cost_is_zero_free() {
        let e = compute_cost(&record("local", "qwen3", 100, 100, 0, 0));
        assert_eq!(e.cost_usd, Some(0.0));
        assert_eq!(e.cost_source, "free");
    }

    #[test]
    fn openrouter_without_fetcher_is_unknown() {
        // No injected fetcher (default compute_cost) can't reach /generation.
        let e = compute_cost(&record(
            "openrouter",
            "anthropic/claude-3.5-haiku",
            100,
            50,
            0,
            0,
        ));
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, "unknown");
    }

    #[test]
    fn openrouter_with_gen_id_uses_real_cost() {
        let mut r = record("openrouter", "anthropic/claude-3.5-haiku", 100, 50, 0, 0);
        r.gen_id = Some("gen-abc".into());
        let e = compute_cost_with(&r, &|id| {
            assert_eq!(id, "gen-abc");
            Some(0.0123)
        });
        assert_eq!(e.cost_usd, Some(0.0123));
        assert_eq!(e.cost_source, "actual");
    }

    #[test]
    fn openrouter_without_gen_id_is_unknown_even_with_fetcher() {
        let r = record("openrouter", "anthropic/claude-3.5-haiku", 100, 50, 0, 0);
        assert!(r.gen_id.is_none());
        let e = compute_cost_with(&r, &|_| Some(9.9));
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, "unknown");
    }

    #[test]
    fn openrouter_fetcher_failure_with_gen_id_is_deferred() {
        // gen_id present but /generation not yet resolved → retryable `deferred`.
        let mut r = record("openrouter", "anthropic/claude-3.5-haiku", 100, 50, 0, 0);
        r.gen_id = Some("gen-abc".into());
        let e = compute_cost_with(&r, &|_| None);
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, "deferred");
    }

    #[test]
    fn is_terminal_cost_only_deferred_is_non_terminal() {
        assert!(!is_terminal_cost("deferred"));
        for s in ["catalog", "actual", "free", "subscription", "unknown", ""] {
            assert!(is_terminal_cost(s), "{s} should be terminal");
        }
    }

    #[test]
    fn catalog_miss_is_null_unknown() {
        let e = compute_cost(&record("anthropic_apikey", "made-up-model", 100, 0, 0, 0));
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, "unknown");
    }

    #[test]
    fn unknown_provider_kind_is_unknown() {
        let e = compute_cost(&record("", "whatever", 100, 0, 0, 0));
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, "unknown");
    }

    #[test]
    fn sidecar_never_touches_usage_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        write_usage_line(
            dir.path(),
            "proj",
            "msg_1",
            "anthropic_apikey",
            "claude-opus-4-8",
        );
        let usage = usage_file_in(dir.path(), "proj");
        let before = std::fs::read(&usage).unwrap();
        enrich_cost_in(dir.path(), "proj").unwrap();
        let after = std::fs::read(&usage).unwrap();
        assert_eq!(before, after, "usage JSONL must be byte-identical");
        let cache = read_cost_cache_in(dir.path(), "proj");
        assert_eq!(cache.len(), 1);
        assert!(cache.get("msg_1").unwrap().cost_usd.is_some());
    }

    #[test]
    fn enrich_is_idempotent_per_response_id() {
        let dir = tempfile::tempdir().unwrap();
        write_usage_line(dir.path(), "proj", "msg_1", "local", "qwen3");
        enrich_cost_in(dir.path(), "proj").unwrap();
        enrich_cost_in(dir.path(), "proj").unwrap();
        assert_eq!(read_cost_cache_in(dir.path(), "proj").len(), 1);
    }

    #[test]
    fn enrich_with_fetcher_prices_openrouter_real() {
        let dir = tempfile::tempdir().unwrap();
        write_openrouter_line(dir.path(), "proj", "msg_or", "gen-xyz");
        enrich_cost_with_in(dir.path(), "proj", &|id| {
            assert_eq!(id, "gen-xyz");
            Some(0.0042)
        })
        .unwrap();
        let cache = read_cost_cache_in(dir.path(), "proj");
        let e = cache.get("msg_or").unwrap();
        assert_eq!(e.cost_usd, Some(0.0042));
        assert_eq!(e.cost_source, "actual");
    }

    #[test]
    fn deferred_cost_is_repriced_on_later_pass() {
        let dir = tempfile::tempdir().unwrap();
        write_openrouter_line(dir.path(), "proj", "msg_or", "gen-xyz");
        // First pass: /generation lags → deferred (retryable).
        enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        assert_eq!(
            read_cost_cache_in(dir.path(), "proj")
                .get("msg_or")
                .unwrap()
                .cost_source,
            "deferred"
        );
        // Second pass: /generation now succeeds → re-priced to actual.
        enrich_cost_with_in(dir.path(), "proj", &|_| Some(0.0042)).unwrap();
        let e = read_cost_cache_in(dir.path(), "proj")
            .get("msg_or")
            .unwrap()
            .clone();
        assert_eq!(e.cost_usd, Some(0.0042));
        assert_eq!(e.cost_source, "actual");
    }

    #[test]
    fn terminal_unknown_is_idempotent_no_unbounded_append() {
        // openrouter line with NO gen_id → terminal `unknown`; repeated enrich
        // must not append a duplicate (the regression this fix restores).
        let dir = tempfile::tempdir().unwrap();
        write_openrouter_line(dir.path(), "proj", "msg_or", "");
        for _ in 0..3 {
            enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        }
        let cache = cost_cache_file_in(dir.path(), "proj");
        let lines = std::fs::read_to_string(&cache).unwrap();
        let count = lines.lines().filter(|l| !l.trim().is_empty()).count();
        assert_eq!(count, 1, "terminal unknown must be written exactly once");
        assert_eq!(
            read_cost_cache_in(dir.path(), "proj")
                .get("msg_or")
                .unwrap()
                .cost_source,
            "unknown"
        );
    }

    #[test]
    fn still_deferred_does_not_grow_sidecar() {
        // A line that stays deferred across passes (fetch keeps failing) must
        // not append an identical line each time — bounded sidecar.
        let dir = tempfile::tempdir().unwrap();
        write_openrouter_line(dir.path(), "proj", "msg_or", "gen-xyz");
        for _ in 0..3 {
            enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        }
        let cache = cost_cache_file_in(dir.path(), "proj");
        let lines = std::fs::read_to_string(&cache).unwrap();
        let count = lines.lines().filter(|l| !l.trim().is_empty()).count();
        assert_eq!(count, 1, "still-deferred must be written exactly once");
    }

    #[test]
    fn terminal_cost_is_not_repriced() {
        let dir = tempfile::tempdir().unwrap();
        write_usage_line(
            dir.path(),
            "proj",
            "msg_1",
            "anthropic_apikey",
            "claude-opus-4-8",
        );
        enrich_cost_in(dir.path(), "proj").unwrap();
        // A second pass with a fetcher must NOT add a duplicate for a terminal (catalog) id.
        enrich_cost_with_in(dir.path(), "proj", &|_| Some(99.0)).unwrap();
        // Exactly one cache line for msg_1 still resolves to the catalog cost.
        let cache = read_cost_cache_in(dir.path(), "proj");
        assert_eq!(cache.get("msg_1").unwrap().cost_source, "catalog");
    }

    #[test]
    fn read_cost_cache_last_write_wins() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cost_cache_file_in(dir.path(), "proj");
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        let l1 = serde_json::to_string(&CostEntry {
            response_id: "msg_1".into(),
            cost_usd: Some(1.0),
            cost_source: "catalog".into(),
        })
        .unwrap();
        let l2 = serde_json::to_string(&CostEntry {
            response_id: "msg_1".into(),
            cost_usd: Some(2.0),
            cost_source: "actual".into(),
        })
        .unwrap();
        std::fs::write(&cache, format!("{l1}\n{l2}\n")).unwrap();
        let map = read_cost_cache_in(dir.path(), "proj");
        assert_eq!(map.get("msg_1").unwrap().cost_usd, Some(2.0));
        assert_eq!(map.get("msg_1").unwrap().cost_source, "actual");
    }

    #[test]
    fn enrich_missing_usage_file_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        enrich_cost_in(dir.path(), "proj").unwrap();
        assert!(read_cost_cache_in(dir.path(), "proj").is_empty());
    }

    #[test]
    fn cache_1m_variant_uses_1m_pricing() {
        // sonnet 1M output (22.5/MTok) differs from base (15.0/MTok).
        let e = compute_cost(&record(
            "anthropic_apikey",
            "claude-sonnet-4-6[1m]",
            0,
            1_000_000,
            0,
            0,
        ));
        assert!(
            (e.cost_usd.unwrap() - 22.5).abs() < 1e-9,
            "got {:?}",
            e.cost_usd
        );
    }
}

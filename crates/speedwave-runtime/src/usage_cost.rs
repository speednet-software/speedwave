//! Host-side cost enrichment for the proxy usage JSONL (ADR-073): per-provider
//! cost into an append-only `response_id` sidecar; the usage JSONL is never mutated.

use crate::usage::UsageRecord;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Cost provenance for one priced `response_id`. Wire/disk format is the
/// snake_case string (statusline + front-end read it); never reorder/rename.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CostSource {
    /// Priced from the in-repo Anthropic catalog (API key).
    Catalog,
    /// Anthropic OAuth — billed on the subscription, no per-call USD.
    Subscription,
    /// Local custom-URL server — no charge; cost is `null` (shown as `—`, not $0.00).
    Free,
    /// Real cost fetched from OpenRouter `/generation`.
    Actual,
    /// No cost source (unrecognized provider or OpenRouter line with no gen_id);
    /// terminal, never re-priced. Both sub-cases share this until one needs splitting.
    Unknown,
    /// OpenRouter `/generation` not yet resolved; retryable.
    Deferred,
    /// Request failed (upstream ≥400 / aborted) — not billed; terminal.
    Failed,
}

impl CostSource {
    /// A source that won't change on re-enrichment. Only `Deferred` (OpenRouter
    /// `/generation` not yet fetched) is non-terminal and re-priced later.
    pub fn is_terminal(&self) -> bool {
        !matches!(self, CostSource::Deferred)
    }
}

/// Snake_case wire string matching the serde `rename_all` repr — pinned by the
/// `cost_source_wire_format_is_snake_case` test.
impl std::fmt::Display for CostSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CostSource::Catalog => "catalog",
            CostSource::Subscription => "subscription",
            CostSource::Free => "free",
            CostSource::Actual => "actual",
            CostSource::Unknown => "unknown",
            CostSource::Deferred => "deferred",
            CostSource::Failed => "failed",
        })
    }
}

/// One sidecar line: the priced result for a single `response_id`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CostEntry {
    /// Joins back to the usage line.
    pub response_id: String,
    /// USD cost; `None` for subscription/unknown/error (never collapsed to 0.0).
    pub cost_usd: Option<f64>,
    /// Provenance of `cost_usd`.
    pub cost_source: CostSource,
}

impl CostEntry {
    /// Builds an entry, enforcing the source↔cost invariant: debug builds
    /// assert (documents intent), release builds clamp via [`normalize_cost`].
    pub(crate) fn new(response_id: String, cost_usd: Option<f64>, cost_source: CostSource) -> Self {
        debug_assert!(
            match cost_source {
                CostSource::Catalog | CostSource::Actual => cost_usd.is_some(),
                CostSource::Subscription
                | CostSource::Free
                | CostSource::Unknown
                | CostSource::Deferred
                | CostSource::Failed => cost_usd.is_none(),
            },
            "CostEntry invariant: {cost_source:?} with cost {cost_usd:?}"
        );
        CostEntry {
            response_id,
            cost_usd: normalize_cost(cost_usd, cost_source),
            cost_source,
        }
    }
}

/// Release-path clamp for the source↔cost invariant (invariant 6): an unpriced
/// source never carries a cost — `null`, never collapsed to `0.0`.
fn normalize_cost(cost_usd: Option<f64>, cost_source: CostSource) -> Option<f64> {
    match cost_source {
        CostSource::Catalog | CostSource::Actual => cost_usd,
        CostSource::Subscription
        | CostSource::Free
        | CostSource::Unknown
        | CostSource::Deferred
        | CostSource::Failed => None,
    }
}

/// Sidecar cost cache, alongside the proxy usage JSONL.
pub(crate) fn cost_cache_file_in(data_dir: &Path, project: &str) -> PathBuf {
    data_dir
        .join("usage")
        .join(project)
        .join("proxy")
        .join("cost-cache.jsonl")
}

/// Fetches OpenRouter's real cost (`GET /generation` `data.total_cost`, USD).
/// Injected host-side so the runtime keeps no HTTP/SSRF surface; `None` on miss.
pub type GenCostFetcher<'a> = dyn Fn(&str) -> Option<f64> + 'a;

/// The id a usage record is keyed by: its `response_id`, or the OpenRouter
/// `gen_id` when the backend sent no `message.id`. None when neither is present.
pub fn effective_response_id(r: &UsageRecord) -> Option<String> {
    r.response_id
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| r.gen_id.clone().filter(|s| !s.is_empty()))
}

/// Computes the cost for one usage record. For `openrouter`: a gen_id with a
/// `None` fetch is `deferred` (retryable), a missing gen_id is terminal `unknown`.
pub(crate) fn compute_cost_with(r: &UsageRecord, fetch_gen_cost: &GenCostFetcher) -> CostEntry {
    let id = effective_response_id(r).unwrap_or_default();
    // A failed request is never billed, regardless of provider.
    if r.status == "failure" {
        return CostEntry::new(id, None, CostSource::Failed);
    }
    let (cost_usd, cost_source) = match r.provider_kind.as_str() {
        "anthropic_apikey" => match anthropic_catalog_cost(r) {
            Some(c) => (Some(c), CostSource::Catalog),
            None => (None, CostSource::Unknown),
        },
        "anthropic_oauth" => (None, CostSource::Subscription),
        "local" => (None, CostSource::Free),
        // With a gen_id the cost is still fetchable later → `deferred` (retryable);
        // without one no source exists → `unknown` (terminal).
        "openrouter" => match r.gen_id.as_deref().filter(|g| !g.is_empty()) {
            Some(gen) => match fetch_gen_cost(gen) {
                Some(c) => (Some(c), CostSource::Actual),
                None => (None, CostSource::Deferred),
            },
            None => (None, CostSource::Unknown),
        },
        _ => (None, CostSource::Unknown),
    };
    CostEntry::new(id, cost_usd, cost_source)
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
        info.pricing_1m.as_ref().unwrap_or_else(|| {
            // A [1m] pin on a model without 1M pricing would silently mis-charge.
            log::warn!("model {base}[1m] has no 1M pricing; using base rate");
            &info.pricing
        })
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

/// Appends a `CostEntry` per not-yet-priced `response_id`; idempotent, usage
/// JSONL read-only. `openrouter` priced via the injected `fetch_gen_cost`.
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
        // Key off response_id, or gen_id when message.id was absent (B6).
        let Some(id) = effective_response_id(&record) else {
            return;
        };
        let prior = already.get(&id);
        // Skip ids already resolved to a terminal cost; re-price non-terminal
        // ones (`deferred`) so a lagging OpenRouter `/generation` can recover.
        if prior.is_some_and(|e| e.cost_source.is_terminal()) || !queued.insert(id) {
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
        let line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
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
        match serde_json::from_str::<CostEntry>(trimmed) {
            Ok(entry) => {
                out.insert(entry.response_id.clone(), entry);
            }
            Err(e) => log::warn!("skipping malformed cost-cache line: {e}"),
        }
    }
    out
}

/// Deduped `gen_id`s of OpenRouter lines still needing a `/generation` fetch
/// (uncached or `deferred`); keyed by `effective_response_id` (incl. gen-id-only).
pub fn pending_deferred_gen_ids(data_dir: &Path, project: &str) -> Vec<String> {
    let priced = read_cost_cache_in(data_dir, project);
    let mut seen = std::collections::HashSet::new();
    let mut gen_ids: Vec<String> = Vec::new();
    crate::usage::for_each_usage_record(data_dir, project, |rec| {
        if rec.provider_kind != "openrouter" {
            return;
        }
        let Some(gen) = rec.gen_id.as_deref().filter(|g| !g.is_empty()) else {
            return;
        };
        // Cache is keyed by effective_response_id (gen_id when message.id absent).
        let key = effective_response_id(&rec).unwrap_or_else(|| gen.to_string());
        let priced_terminal = priced
            .get(&key)
            .is_some_and(|e| e.cost_source.is_terminal());
        if priced_terminal || !seen.insert(gen.to_string()) {
            return;
        }
        gen_ids.push(gen.to_string());
    });
    gen_ids
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: unwrap/expect on fixtures is the sanctioned boundary"
)]
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
        let e = compute_cost_with(
            &record("anthropic_apikey", "claude-opus-4-8", 1_000_000, 0, 0, 0),
            &|_| None,
        );
        assert!(
            (e.cost_usd.unwrap() - 5.0).abs() < 1e-9,
            "got {:?}",
            e.cost_usd
        );
        assert_eq!(e.cost_source, CostSource::Catalog);
    }

    #[test]
    fn oauth_cost_is_null_subscription() {
        let e = compute_cost_with(
            &record("anthropic_oauth", "claude-opus-4-8", 100, 100, 0, 0),
            &|_| None,
        );
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Subscription);
    }

    #[test]
    fn local_cost_is_null_free() {
        // Local is no-charge: cost is null (rendered `—`), never $0.00 (invariant 6).
        let e = compute_cost_with(&record("local", "qwen3", 100, 100, 0, 0), &|_| None);
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Free);
    }

    #[test]
    fn openrouter_without_fetcher_is_unknown() {
        // A fetcher that resolves nothing can't reach /generation.
        let e = compute_cost_with(
            &record("openrouter", "anthropic/claude-3.5-haiku", 100, 50, 0, 0),
            &|_| None,
        );
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Unknown);
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
        assert_eq!(e.cost_source, CostSource::Actual);
    }

    #[test]
    fn openrouter_without_gen_id_is_unknown_even_with_fetcher() {
        let r = record("openrouter", "anthropic/claude-3.5-haiku", 100, 50, 0, 0);
        assert!(r.gen_id.is_none());
        let e = compute_cost_with(&r, &|_| Some(9.9));
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Unknown);
    }

    #[test]
    fn openrouter_fetcher_failure_with_gen_id_is_deferred() {
        // gen_id present but /generation not yet resolved → retryable `deferred`.
        let mut r = record("openrouter", "anthropic/claude-3.5-haiku", 100, 50, 0, 0);
        r.gen_id = Some("gen-abc".into());
        let e = compute_cost_with(&r, &|_| None);
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Deferred);
    }

    #[test]
    fn is_terminal_cost_only_deferred_is_non_terminal() {
        assert!(!CostSource::Deferred.is_terminal());
        for s in [
            CostSource::Catalog,
            CostSource::Actual,
            CostSource::Free,
            CostSource::Subscription,
            CostSource::Unknown,
            CostSource::Failed,
        ] {
            assert!(s.is_terminal(), "{s:?} should be terminal");
        }
    }

    #[test]
    fn cost_source_ts_union_matches_rust() {
        // The TS CostSourceKind union must list exactly the Rust serde strings
        // (cf. llm_provider_kind_matches_ts_union).
        let all = [
            CostSource::Catalog,
            CostSource::Subscription,
            CostSource::Free,
            CostSource::Actual,
            CostSource::Unknown,
            CostSource::Deferred,
            CostSource::Failed,
        ];
        // Exhaustiveness gate: a new variant fails to compile until added above.
        for s in all {
            match s {
                CostSource::Catalog
                | CostSource::Subscription
                | CostSource::Free
                | CostSource::Actual
                | CostSource::Unknown
                | CostSource::Deferred
                | CostSource::Failed => {}
            }
        }
        let mut rust: Vec<String> = all.iter().map(|s| s.to_string()).collect();
        rust.sort();
        let src = include_str!("../../../desktop/src/src/app/models/llm.ts");
        let re = regex::Regex::new(r"export\s+type\s+CostSourceKind\s*=\s*([^;]+);").unwrap();
        let cap = re
            .captures(src)
            .expect("llm.ts must declare `export type CostSourceKind`");
        let mut ts: Vec<String> = cap[1]
            .split('|')
            .map(|s| s.trim().trim_matches(['\'', '"']).to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts.sort();
        assert_eq!(
            rust, ts,
            "CostSourceKind (TS) must mirror CostSource (Rust)"
        );
    }

    #[test]
    fn cost_source_wire_format_is_snake_case() {
        // The sidecar/statusline/front-end contract: snake_case strings.
        let cases = [
            (CostSource::Catalog, "\"catalog\""),
            (CostSource::Subscription, "\"subscription\""),
            (CostSource::Free, "\"free\""),
            (CostSource::Actual, "\"actual\""),
            (CostSource::Unknown, "\"unknown\""),
            (CostSource::Deferred, "\"deferred\""),
            (CostSource::Failed, "\"failed\""),
        ];
        for (src, wire) in cases {
            assert_eq!(serde_json::to_string(&src).unwrap(), wire);
            assert_eq!(
                serde_json::from_str::<CostSource>(wire).unwrap(),
                src,
                "round-trip {wire}"
            );
            // `Display` must equal the serde string sans the JSON quotes.
            assert_eq!(format!("\"{src}\""), wire);
        }
    }

    #[test]
    fn catalog_miss_is_null_unknown() {
        let e = compute_cost_with(
            &record("anthropic_apikey", "made-up-model", 100, 0, 0, 0),
            &|_| None,
        );
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Unknown);
    }

    #[test]
    fn unknown_provider_kind_is_unknown() {
        let e = compute_cost_with(&record("", "whatever", 100, 0, 0, 0), &|_| None);
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Unknown);
    }

    #[test]
    fn failed_request_is_not_billed_even_for_apikey() {
        // status=failure short-circuits before the provider match → Failed, no cost.
        let mut r = record("anthropic_apikey", "claude-opus-4-8", 1_000_000, 0, 0, 0);
        r.status = "failure".to_string();
        let e = compute_cost_with(&r, &|_| None);
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Failed);
    }

    #[test]
    fn failed_openrouter_is_failed_not_deferred() {
        // A failed OpenRouter line must not become a retryable `deferred`.
        let mut r = record("openrouter", "anthropic/claude-3.5-haiku", 100, 50, 0, 0);
        r.gen_id = Some("gen-abc".into());
        r.status = "failure".to_string();
        let e = compute_cost_with(&r, &|_| Some(9.9));
        assert!(e.cost_usd.is_none());
        assert_eq!(e.cost_source, CostSource::Failed);
    }

    #[test]
    fn failed_cost_source_is_terminal() {
        assert!(CostSource::Failed.is_terminal());
        assert_eq!(CostSource::Failed.to_string(), "failed");
    }

    #[test]
    fn effective_response_id_falls_back_to_gen_id() {
        let mut r = record("openrouter", "x", 1, 1, 0, 0);
        r.response_id = None;
        r.gen_id = Some("gen-xyz".into());
        assert_eq!(effective_response_id(&r).as_deref(), Some("gen-xyz"));
        // response_id wins when both present.
        r.response_id = Some("msg_1".into());
        assert_eq!(effective_response_id(&r).as_deref(), Some("msg_1"));
        // Neither present → None.
        r.response_id = None;
        r.gen_id = None;
        assert!(effective_response_id(&r).is_none());
    }

    #[test]
    fn openrouter_no_message_id_keyed_by_gen_id() {
        // A line with no response_id but a gen_id is priced and keyed by gen_id.
        let mut r = record("openrouter", "anthropic/claude-3.5-haiku", 100, 50, 0, 0);
        r.response_id = None;
        r.gen_id = Some("gen-xyz".into());
        let e = compute_cost_with(&r, &|id| {
            assert_eq!(id, "gen-xyz");
            Some(0.01)
        });
        assert_eq!(e.response_id, "gen-xyz");
        assert_eq!(e.cost_usd, Some(0.01));
        assert_eq!(e.cost_source, CostSource::Actual);
    }

    #[test]
    fn one_m_suffix_without_pricing_1m_falls_back_to_base() {
        // haiku has no pricing_1m; a [1m] pin must fall back to the base rate.
        let e = compute_cost_with(
            &record(
                "anthropic_apikey",
                "claude-haiku-4-5[1m]",
                1_000_000,
                0,
                0,
                0,
            ),
            &|_| None,
        );
        // haiku base input = 1.0/MTok → $1.00 for 1M input.
        assert!(
            (e.cost_usd.unwrap() - 1.0).abs() < 1e-9,
            "got {:?}",
            e.cost_usd
        );
        assert_eq!(e.cost_source, CostSource::Catalog);
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
        enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
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
        enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
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
        assert_eq!(e.cost_source, CostSource::Actual);
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
            CostSource::Deferred
        );
        // Second pass: /generation now succeeds → re-priced to actual.
        enrich_cost_with_in(dir.path(), "proj", &|_| Some(0.0042)).unwrap();
        let e = read_cost_cache_in(dir.path(), "proj")
            .get("msg_or")
            .unwrap()
            .clone();
        assert_eq!(e.cost_usd, Some(0.0042));
        assert_eq!(e.cost_source, CostSource::Actual);
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
            CostSource::Unknown
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
        enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        // A second pass with a fetcher must NOT add a duplicate for a terminal (catalog) id.
        enrich_cost_with_in(dir.path(), "proj", &|_| Some(99.0)).unwrap();
        // Exactly one cache line for msg_1 still resolves to the catalog cost.
        let cache = read_cost_cache_in(dir.path(), "proj");
        assert_eq!(cache.get("msg_1").unwrap().cost_source, CostSource::Catalog);
    }

    #[test]
    fn read_cost_cache_last_write_wins() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cost_cache_file_in(dir.path(), "proj");
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        let l1 = serde_json::to_string(&CostEntry {
            response_id: "msg_1".into(),
            cost_usd: Some(1.0),
            cost_source: CostSource::Catalog,
        })
        .unwrap();
        let l2 = serde_json::to_string(&CostEntry {
            response_id: "msg_1".into(),
            cost_usd: Some(2.0),
            cost_source: CostSource::Actual,
        })
        .unwrap();
        std::fs::write(&cache, format!("{l1}\n{l2}\n")).unwrap();
        let map = read_cost_cache_in(dir.path(), "proj");
        assert_eq!(map.get("msg_1").unwrap().cost_usd, Some(2.0));
        assert_eq!(map.get("msg_1").unwrap().cost_source, CostSource::Actual);
    }

    #[test]
    fn enrich_missing_usage_file_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        assert!(read_cost_cache_in(dir.path(), "proj").is_empty());
    }

    #[test]
    fn cost_entry_new_accepts_valid_pairings() {
        // Each source paired with its legal cost; the debug_assert must not fire.
        CostEntry::new("a".into(), Some(1.0), CostSource::Catalog);
        CostEntry::new("b".into(), Some(0.5), CostSource::Actual);
        CostEntry::new("c".into(), None, CostSource::Free);
        CostEntry::new("d".into(), None, CostSource::Subscription);
        CostEntry::new("e".into(), None, CostSource::Unknown);
        CostEntry::new("f".into(), None, CostSource::Deferred);
        CostEntry::new("g".into(), None, CostSource::Failed);
    }

    #[test]
    #[should_panic(expected = "CostEntry invariant")]
    fn cost_entry_new_rejects_catalog_without_cost() {
        CostEntry::new("x".into(), None, CostSource::Catalog);
    }

    #[test]
    #[should_panic(expected = "CostEntry invariant")]
    fn cost_entry_new_rejects_subscription_with_cost() {
        CostEntry::new("x".into(), Some(1.0), CostSource::Subscription);
    }

    #[test]
    fn normalize_cost_clamps_unpriced_sources_to_none() {
        // Release-path clamp: `new` runs this after the debug_assert, so a
        // release build can never emit Free/0.0 (invariant 6).
        for src in [
            CostSource::Subscription,
            CostSource::Free,
            CostSource::Unknown,
            CostSource::Deferred,
            CostSource::Failed,
        ] {
            assert_eq!(normalize_cost(Some(0.0), src), None, "{src:?}");
            assert_eq!(normalize_cost(Some(1.5), src), None, "{src:?}");
            assert_eq!(normalize_cost(None, src), None, "{src:?}");
        }
    }

    #[test]
    fn normalize_cost_keeps_priced_sources_intact() {
        assert_eq!(normalize_cost(Some(1.5), CostSource::Catalog), Some(1.5));
        assert_eq!(
            normalize_cost(Some(0.0042), CostSource::Actual),
            Some(0.0042)
        );
        // A priced source with no cost stays None (fail-safe: never fabricate).
        assert_eq!(normalize_cost(None, CostSource::Catalog), None);
        assert_eq!(normalize_cost(None, CostSource::Actual), None);
    }

    #[test]
    fn pending_gen_ids_includes_gen_id_only_line() {
        // Regression: a line with response_id=null but gen_id set is keyed by
        // gen_id in the sidecar; it must still be returned for a /generation fetch.
        let dir = tempfile::tempdir().unwrap();
        let path = usage_file_in(dir.path(), "proj");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let line = serde_json::to_string(&serde_json::json!({
            "ts": "2026-06-26T10:00:00+0200",
            "status": "success",
            "model": "anthropic/claude-3.5-haiku",
            "response_id": serde_json::Value::Null,
            "provider_kind": "openrouter",
            "provider_id": "openrouter",
            "gen_id": "gen-only",
            "prompt_tokens": 100,
            "completion_tokens": 50,
        }))
        .unwrap();
        std::fs::write(&path, format!("{line}\n")).unwrap();
        assert_eq!(
            pending_deferred_gen_ids(dir.path(), "proj"),
            vec!["gen-only".to_string()]
        );
    }

    #[test]
    fn pending_gen_ids_skips_terminal_and_dedups() {
        let dir = tempfile::tempdir().unwrap();
        // Two lines: one will resolve to terminal (actual), one stays deferred.
        write_openrouter_line(dir.path(), "proj", "msg_a", "gen-a");
        write_openrouter_line(dir.path(), "proj", "msg_b", "gen-b");
        // Price gen-a terminally; leave gen-b deferred.
        enrich_cost_with_in(dir.path(), "proj", &|id| (id == "gen-a").then_some(0.01)).unwrap();
        let pending = pending_deferred_gen_ids(dir.path(), "proj");
        assert!(!pending.contains(&"gen-a".to_string()), "terminal skipped");
        assert!(
            pending.contains(&"gen-b".to_string()),
            "deferred re-included"
        );
    }

    #[test]
    fn pending_gen_ids_ignores_non_openrouter() {
        let dir = tempfile::tempdir().unwrap();
        write_usage_line(dir.path(), "proj", "msg_1", "local", "qwen3");
        assert!(pending_deferred_gen_ids(dir.path(), "proj").is_empty());
    }

    #[test]
    fn cache_1m_variant_uses_1m_pricing() {
        // The [1m] id must resolve to the catalog's pricing_1m — billed at the
        // standard rate on Claude 4.6+ (sonnet-4-6 output 15.0/MTok), never None.
        let e = compute_cost_with(
            &record(
                "anthropic_apikey",
                "claude-sonnet-4-6[1m]",
                0,
                1_000_000,
                0,
                0,
            ),
            &|_| None,
        );
        assert!(
            (e.cost_usd.unwrap() - 15.0).abs() < 1e-9,
            "got {:?}",
            e.cost_usd
        );
    }
}

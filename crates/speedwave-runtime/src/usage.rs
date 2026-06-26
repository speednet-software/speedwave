//! LLM usage aggregation (ADR-073): reads the proxy usage JSONL
//! (`<data_dir>/usage/<project>/proxy/usage.jsonl`) for the Desktop
//! dashboard. Records are deduplicated by `response_id`, first-seen wins.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One line of the callback JSONL. Unknown fields are ignored so the
/// container image and the host can evolve independently.
#[derive(Deserialize, Debug, Clone)]
pub struct UsageRecord {
    /// RFC3339-ish local timestamp written by the callback.
    #[serde(default)]
    pub ts: String,
    /// Capture path: `success_event` | `stream_iterator`.
    #[serde(default)]
    pub capture: String,
    /// `success` | `failure`.
    #[serde(default)]
    pub status: String,
    /// Model string as requested (`local/qwen3`, `claude-haiku-4-5`, …).
    #[serde(default)]
    pub model: Option<String>,
    /// Provider response id (dedup key when present).
    #[serde(default)]
    pub response_id: Option<String>,
    /// Active route kind (`anthropic_apikey`/`anthropic_oauth`/`openrouter`/`local`).
    #[serde(default)]
    pub provider_kind: String,
    /// Active provider id (route prefix); empty on pre-enrichment lines.
    #[serde(default)]
    pub provider_id: String,
    /// OpenRouter generation id (`gen-…`), used to fetch real cost.
    #[serde(default)]
    pub gen_id: Option<String>,
    /// Cost in USD when the call could be priced (None — omitted in the MVP forwarder).
    #[serde(default)]
    pub cost_usd: Option<f64>,
    /// Wall-clock latency of the request, milliseconds.
    #[serde(default)]
    pub latency_ms: Option<u64>,
    /// Input tokens.
    #[serde(default)]
    pub prompt_tokens: Option<u64>,
    /// Output tokens.
    #[serde(default)]
    pub completion_tokens: Option<u64>,
    /// Prompt-cache read tokens (Anthropic).
    #[serde(default)]
    pub cache_read: Option<u64>,
    /// Prompt-cache write tokens (Anthropic).
    #[serde(default)]
    pub cache_write: Option<u64>,
}

/// Aggregate for one (day, model) bucket. No `PartialEq`: the float
/// `cost_usd` makes `==` an exact-float trap; tests compare fields.
#[derive(Serialize, Debug, Clone, Default)]
pub struct UsageBucket {
    /// Total requests in the bucket.
    pub requests: u64,
    /// Requests whose callback line carried `status=failure`.
    pub failures: u64,
    /// Summed input tokens.
    pub prompt_tokens: u64,
    /// Summed output tokens.
    pub completion_tokens: u64,
    /// Summed prompt-cache read tokens.
    pub cache_read: u64,
    /// Summed prompt-cache write tokens.
    pub cache_write: u64,
    /// Summed cost over priced requests; `None` when none priced (never 0.0).
    pub cost_usd: Option<f64>,
    /// Requests with a known cost (catalog/actual/free).
    pub priced_requests: u64,
    /// Requests with no known cost (subscription/unknown).
    pub unpriced_requests: u64,
    /// Throughput numerator: completion tokens from success records that also
    /// carried a latency. Paired with `throughput_latency_ms_sum`.
    pub throughput_completion_tokens: u64,
    /// Throughput denominator: wall-clock latency over the same success+latency
    /// records that feed `throughput_completion_tokens`.
    pub throughput_latency_ms_sum: u64,
}

/// Dashboard payload: day → model → bucket, plus grand totals.
#[derive(Serialize, Debug, Clone, Default)]
pub struct UsageSummary {
    /// `YYYY-MM-DD` → model → bucket. BTreeMap keeps days/models ordered.
    pub days: BTreeMap<String, BTreeMap<String, UsageBucket>>,
    /// `YYYY-MM-DD` → requests per local hour (index 0–23) — the callback
    /// timestamps carry the container's TZ, which mirrors the host's.
    pub hours: BTreeMap<String, [u64; 24]>,
    /// Grand totals across all days and models.
    pub totals: UsageBucket,
    /// Lines that failed to parse (truncated tail after a crash is normal —
    /// surfaced so the UI can show "n records skipped" instead of lying).
    pub skipped_lines: u64,
}

/// Usage file as written by the container callback.
pub fn usage_file_in(data_dir: &Path, project: &str) -> PathBuf {
    data_dir
        .join("usage")
        .join(project)
        .join("proxy")
        .join("usage.jsonl")
}

/// Final usage for one response (`response_id`), for the chat-footer reconcile.
#[derive(Serialize, Debug, Clone, Default)]
pub struct ResponseUsage {
    /// Input tokens.
    pub prompt_tokens: u64,
    /// Output tokens.
    pub completion_tokens: u64,
    /// Prompt-cache read tokens.
    pub cache_read: u64,
    /// Prompt-cache write tokens.
    pub cache_write: u64,
    /// `None` when unpriced (subscription/unknown) — never collapsed to 0.0.
    pub cost_usd: Option<f64>,
    /// Provenance from the sidecar; empty when no sidecar entry.
    pub cost_source: String,
}

/// Joins the last usage line for `response_id` to its sidecar cost. `None` when
/// the id is absent (the footer then keeps Claude Code's live values).
pub fn get_usage_for_response_in(
    data_dir: &Path,
    project: &str,
    response_id: &str,
) -> Option<ResponseUsage> {
    crate::validation::validate_project_name(project).ok()?;
    if response_id.is_empty() {
        return None;
    }
    let mut found: Option<UsageRecord> = None;
    for_each_usage_record(data_dir, project, |rec| {
        if rec.response_id.as_deref() == Some(response_id) {
            found = Some(rec);
        }
    });
    let rec = found?;
    let costs = crate::usage_cost::read_cost_cache_in(data_dir, project);
    let entry = costs.get(response_id);
    Some(ResponseUsage {
        prompt_tokens: rec.prompt_tokens.unwrap_or(0),
        completion_tokens: rec.completion_tokens.unwrap_or(0),
        cache_read: rec.cache_read.unwrap_or(0),
        cache_write: rec.cache_write.unwrap_or(0),
        cost_usd: joined_cost(&rec, &costs),
        cost_source: entry
            .map(|e| e.cost_source.as_wire_str().to_string())
            .unwrap_or_default(),
    })
}

/// `effective_response_id`s present in the current usage window (live + `.1`).
fn response_ids_in_window(data_dir: &Path, project: &str) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    for_each_usage_record(data_dir, project, |rec| {
        if let Some(id) = crate::usage_cost::effective_response_id(&rec) {
            ids.insert(id);
        }
    });
    ids
}

/// Summed cost (USD) over the given conversation `response_id`s — the chat
/// footer total. `None` when none are priced (never 0.0).
pub fn conversation_cost_in(
    data_dir: &Path,
    project: &str,
    response_ids: &[String],
) -> Option<f64> {
    if response_ids.is_empty() {
        return None;
    }
    let costs = crate::usage_cost::read_cost_cache_in(data_dir, project);
    let mut total: Option<f64> = None;
    for id in response_ids {
        if let Some(c) = costs.get(id).and_then(|e| e.cost_usd) {
            total = Some(total.unwrap_or(0.0) + c);
        }
    }
    total
}

/// Summed project cost (USD), restricted to the current usage window so it
/// equals the dashboard total. `None` when nothing in-window is priced.
pub fn session_cost_in(data_dir: &Path, project: &str) -> Option<f64> {
    let costs = crate::usage_cost::read_cost_cache_in(data_dir, project);
    let in_window = response_ids_in_window(data_dir, project);
    let mut total: Option<f64> = None;
    for (id, entry) in &costs {
        if !in_window.contains(id) {
            continue;
        }
        if let Some(c) = entry.cost_usd {
            total = Some(total.unwrap_or(0.0) + c);
        }
    }
    total
}

/// Rotation threshold: past this size the live file is renamed to `.1`
/// (replacing any previous `.1`). The callback's per-write `open(append)`
/// picks up the fresh file on its next request.
pub const USAGE_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

/// Rotates `usage.jsonl` → `usage.jsonl.1` when it exceeds the threshold.
/// Call before reading; failures are non-fatal (rotation retries next time).
pub fn rotate_usage_if_large_in(data_dir: &Path, project: &str) {
    let live = usage_file_in(data_dir, project);
    let Ok(meta) = std::fs::metadata(&live) else {
        return;
    };
    if meta.len() <= USAGE_ROTATE_BYTES {
        return;
    }
    let rotated = live.with_extension("jsonl.1");
    if let Err(e) = std::fs::rename(&live, &rotated) {
        log::warn!("usage rotation failed for {}: {e}", live.display());
        return;
    }
    // Rotation shrank the window — drop now-orphaned sidecar entries.
    prune_cost_cache_in(data_dir, project);
}

/// Rewrites the sidecar to one line per `response_id` (last-write-wins),
/// keeping only ids still in the usage window. Bounds growth; non-fatal on IO.
pub fn prune_cost_cache_in(data_dir: &Path, project: &str) {
    if crate::validation::validate_project_name(project).is_err() {
        return;
    }
    let path = crate::usage_cost::cost_cache_file_in(data_dir, project);
    if !path.exists() {
        return;
    }
    let in_window = response_ids_in_window(data_dir, project);
    let costs = crate::usage_cost::read_cost_cache_in(data_dir, project);
    let mut kept: Vec<&crate::usage_cost::CostEntry> = costs
        .values()
        .filter(|e| in_window.contains(&e.response_id))
        .collect();
    kept.sort_by(|a, b| a.response_id.cmp(&b.response_id));
    let body: String = kept
        .iter()
        .filter_map(|e| serde_json::to_string(e).ok())
        .map(|l| format!("{l}\n"))
        .collect();
    if let Err(e) = crate::fs_perms::write_restricted_file_atomic(&path, &body) {
        // Orphans survive until the next successful prune; readers stay window-correct.
        log::warn!("cost-cache prune failed for {}: {e}", path.display());
    }
}

/// Walks the project's usage JSONL (rotated file first, then live), parsing
/// each line and invoking `f` per record. Returns the count of unparseable
/// lines. Single owner of the rotated/live file layout — all readers use it.
pub fn for_each_usage_record(
    data_dir: &Path,
    project: &str,
    mut f: impl FnMut(UsageRecord),
) -> u64 {
    let live = usage_file_in(data_dir, project);
    let rotated = live.with_extension("jsonl.1");
    let mut skipped = 0;
    for path in [rotated, live] {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<UsageRecord>(trimmed) {
                Ok(record) => f(record),
                Err(_) => skipped += 1,
            }
        }
    }
    skipped
}

/// Sidecar cost for a record, joined by `effective_response_id` (gen_id when
/// message.id is absent), else the record's inline cost (never lost).
fn joined_cost(
    record: &UsageRecord,
    costs: &std::collections::HashMap<String, crate::usage_cost::CostEntry>,
) -> Option<f64> {
    let sidecar = crate::usage_cost::effective_response_id(record)
        .and_then(|id| costs.get(&id))
        .and_then(|e| e.cost_usd);
    sidecar.or(record.cost_usd)
}

/// Reads and aggregates the project's usage (rotated file first, then the
/// live one). Missing files yield an empty summary — never an error.
pub fn read_usage_summary_in(data_dir: &Path, project: &str) -> UsageSummary {
    if crate::validation::validate_project_name(project).is_err() {
        return UsageSummary::default();
    }
    let costs = crate::usage_cost::read_cost_cache_in(data_dir, project);
    let mut summary = UsageSummary::default();
    let mut seen_ids = std::collections::HashSet::new();
    summary.skipped_lines = for_each_usage_record(data_dir, project, |record| {
        // Dedup by effective_response_id (gen_id fallback); first-seen wins.
        if let Some(id) = crate::usage_cost::effective_response_id(&record) {
            if !seen_ids.insert(id) {
                return;
            }
        }
        let day = record.ts.get(0..10).unwrap_or("unknown").to_string();
        let model = record
            .model
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        if let Some(hour) = record
            .ts
            .get(11..13)
            .and_then(|h| h.parse::<usize>().ok())
            .filter(|h| *h < 24)
        {
            summary.hours.entry(day.clone()).or_insert([0; 24])[hour] += 1;
        }
        let cost = joined_cost(&record, &costs);
        let bucket = summary
            .days
            .entry(day)
            .or_default()
            .entry(model)
            .or_default();
        apply_record(bucket, &record, cost);
        apply_record(&mut summary.totals, &record, cost);
    });
    summary
}

/// Aggregates one record; `cost` is the sidecar-joined cost (`None` = unpriced).
fn apply_record(bucket: &mut UsageBucket, r: &UsageRecord, cost: Option<f64>) {
    bucket.requests += 1;
    let is_failure = r.status == "failure";
    if is_failure {
        bucket.failures += 1;
    }
    let completion = r.completion_tokens.unwrap_or(0);
    bucket.prompt_tokens += r.prompt_tokens.unwrap_or(0);
    bucket.completion_tokens += completion;
    bucket.cache_read += r.cache_read.unwrap_or(0);
    bucket.cache_write += r.cache_write.unwrap_or(0);
    match cost {
        Some(c) => {
            bucket.priced_requests += 1;
            bucket.cost_usd = Some(bucket.cost_usd.unwrap_or(0.0) + c);
        }
        None => bucket.unpriced_requests += 1,
    }
    // Throughput counts only successful records with output and latency.
    if let Some(latency) = r.latency_ms {
        if !is_failure && completion > 0 && latency > 0 {
            bucket.throughput_completion_tokens += completion;
            bucket.throughput_latency_ms_sum += latency;
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn write_usage(dir: &Path, project: &str, lines: &[&str]) {
        let path = usage_file_in(dir, project);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, lines.join("\n")).unwrap();
    }

    #[test]
    fn aggregates_per_day_and_model() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-12T10:00:00+0200","capture":"success_event","status":"success","model":"claude-haiku-4-5","cost_usd":0.005,"prompt_tokens":50000,"completion_tokens":10,"latency_ms":900}"#,
                r#"{"ts":"2026-06-12T11:00:00+0200","capture":"stream_iterator","status":"success","model":"local/qwen3","prompt_tokens":14,"completion_tokens":2,"latency_ms":300}"#,
                // Failure with latency but no output — must NOT feed throughput.
                r#"{"ts":"2026-06-13T09:00:00+0200","capture":"stream_iterator","status":"failure","model":"local/qwen3","prompt_tokens":5,"completion_tokens":0,"latency_ms":60000}"#,
            ],
        );
        let s = read_usage_summary_in(dir.path(), "proj");
        assert_eq!(s.totals.requests, 3);
        assert_eq!(s.totals.failures, 1);
        assert_eq!(s.totals.prompt_tokens, 50019);
        assert!((s.totals.cost_usd.unwrap() - 0.005).abs() < 1e-9);
        assert_eq!(s.days.len(), 2);
        let day1 = &s.days["2026-06-12"];
        assert_eq!(day1["claude-haiku-4-5"].requests, 1);
        assert_eq!(day1["local/qwen3"].completion_tokens, 2);
        assert_eq!(s.skipped_lines, 0);
        // Failure with 0 output excluded from throughput numerator and denominator.
        assert_eq!(s.totals.throughput_completion_tokens, 12);
        assert_eq!(s.totals.throughput_latency_ms_sum, 1200);
        assert_eq!(day1["claude-haiku-4-5"].throughput_latency_ms_sum, 900);
        assert_eq!(
            s.days["2026-06-13"]["local/qwen3"].throughput_latency_ms_sum,
            0
        );
        // Hourly histogram: local hours 10 and 11 on day one, 9 on day two.
        assert_eq!(s.hours["2026-06-12"][10], 1);
        assert_eq!(s.hours["2026-06-12"][11], 1);
        assert_eq!(s.hours["2026-06-12"][9], 0);
        assert_eq!(s.hours["2026-06-13"][9], 1);
    }

    #[test]
    fn malformed_timestamps_skip_the_hour_histogram_only() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                // Record aggregates; only hour histogram skipped for malformed timestamps.
                r#"{"ts":"2026-06-12Txx:00:00+0200","status":"success","model":"m","prompt_tokens":1}"#,
                r#"{"ts":"2026-06-12T99:00:00+0200","status":"success","model":"m","prompt_tokens":2}"#,
                r#"{"ts":"short","status":"success","model":"m","prompt_tokens":4}"#,
            ],
        );
        let s = read_usage_summary_in(dir.path(), "proj");
        assert_eq!(s.totals.requests, 3);
        assert_eq!(s.totals.prompt_tokens, 7);
        assert!(s
            .hours
            .get("2026-06-12")
            .is_none_or(|h| h.iter().all(|c| *c == 0)));
    }

    #[test]
    fn multibyte_timestamp_does_not_panic_on_byte_slicing() {
        // Byte-slicing `ts` is safe with multibyte chars; str::get returns None (no panic).
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                // 'éé' crosses byte 10 → day becomes 'unknown'.
                r#"{"ts":"2026-06éé2T10:00:00+0200","status":"success","model":"m","prompt_tokens":1}"#,
                // Emoji at byte 11 → histogram entry skipped.
                r#"{"ts":"2026-06-12T😀0:00:00+0200","status":"success","model":"m","prompt_tokens":2}"#,
            ],
        );
        let s = read_usage_summary_in(dir.path(), "proj");
        // Both records aggregate (no panic, nothing skipped as unparsable).
        assert_eq!(s.totals.requests, 2);
        assert_eq!(s.totals.prompt_tokens, 3);
        assert_eq!(
            s.skipped_lines, 0,
            "valid JSON — only ts derivation degrades"
        );
        // Non-boundary day slice → "unknown"; the emoji record keeps its day.
        assert!(
            s.days.contains_key("unknown"),
            "non-boundary day → 'unknown'"
        );
        assert!(
            s.days.contains_key("2026-06-12"),
            "emoji record keeps its day"
        );
        // The emoji record's hour slice returned None, so no histogram entry.
        assert!(
            s.hours
                .get("2026-06-12")
                .is_none_or(|h| h.iter().all(|c| *c == 0)),
            "non-boundary hour slice must skip the histogram"
        );
    }

    #[test]
    fn tolerates_broken_and_truncated_lines() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-12T10:00:00+0200","status":"success","model":"m","prompt_tokens":1}"#,
                r#"{"ts":"2026-06-12T10:01:00+0200","status":"succ"#, // crash-truncated
                "not json at all",
                "",
            ],
        );
        let s = read_usage_summary_in(dir.path(), "proj");
        assert_eq!(s.totals.requests, 1);
        assert_eq!(s.skipped_lines, 2, "truncated + garbage lines counted");
    }

    #[test]
    fn dedups_by_response_id_across_captures() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-12T10:00:00+0200","capture":"stream_iterator","status":"success","model":"m","response_id":"msg_1","prompt_tokens":10,"completion_tokens":5}"#,
                r#"{"ts":"2026-06-12T10:00:01+0200","capture":"success_event","status":"success","model":"m","response_id":"msg_1","cost_usd":0.01,"prompt_tokens":10,"completion_tokens":5}"#,
                r#"{"ts":"2026-06-12T10:02:00+0200","capture":"success_event","status":"success","model":"m","response_id":"msg_2","prompt_tokens":3}"#,
            ],
        );
        let s = read_usage_summary_in(dir.path(), "proj");
        assert_eq!(s.totals.requests, 2, "msg_1 counted once");
        assert_eq!(s.totals.prompt_tokens, 13);
        // First-seen (costless stream_iterator) wins; both kept records unpriced.
        assert!(
            s.totals.cost_usd.is_none(),
            "no priced request → None, not 0.0"
        );
        assert_eq!(s.totals.unpriced_requests, 2);
    }

    #[test]
    fn aggregation_keeps_unknown_vs_zero() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-12T10:00:00+0200","status":"success","model":"local/qwen3","response_id":"msg_local","provider_kind":"local"}"#,
                r#"{"ts":"2026-06-12T10:01:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_oauth","provider_kind":"anthropic_oauth"}"#,
            ],
        );
        // Sidecar: local priced 0.0 (free), oauth unpriced (subscription).
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        let s = read_usage_summary_in(dir.path(), "proj");
        assert_eq!(
            s.totals.cost_usd,
            Some(0.0),
            "free 0.0 must not vanish into None"
        );
        assert_eq!(s.totals.priced_requests, 1);
        assert_eq!(
            s.totals.unpriced_requests, 1,
            "subscription is unpriced, not $0"
        );
    }

    #[test]
    fn missing_file_and_bad_project_yield_empty() {
        let dir = tempfile::tempdir().unwrap();
        let s = read_usage_summary_in(dir.path(), "proj");
        assert_eq!(s.totals.requests, 0);
        let s = read_usage_summary_in(dir.path(), "../escape");
        assert_eq!(s.totals.requests, 0);
    }

    #[test]
    fn reads_rotated_file_before_live() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-12T10:00:00+0200","status":"success","model":"m","prompt_tokens":1}"#,
            ],
        );
        let live = usage_file_in(dir.path(), "proj");
        let rotated = live.with_extension("jsonl.1");
        std::fs::write(
            &rotated,
            r#"{"ts":"2026-06-11T10:00:00+0200","status":"success","model":"m","prompt_tokens":2}"#,
        )
        .unwrap();
        let s = read_usage_summary_in(dir.path(), "proj");
        assert_eq!(s.totals.requests, 2);
        assert_eq!(s.totals.prompt_tokens, 3);
        assert!(s.days.contains_key("2026-06-11") && s.days.contains_key("2026-06-12"));
    }

    #[test]
    fn rotation_renames_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let live = usage_file_in(dir.path(), "proj");
        std::fs::create_dir_all(live.parent().unwrap()).unwrap();
        std::fs::write(&live, vec![b'x'; (USAGE_ROTATE_BYTES + 1) as usize]).unwrap();
        rotate_usage_if_large_in(dir.path(), "proj");
        assert!(!live.exists(), "live file rotated away");
        assert!(live.with_extension("jsonl.1").exists());

        // Under the threshold: untouched.
        std::fs::write(&live, b"small").unwrap();
        rotate_usage_if_large_in(dir.path(), "proj");
        assert!(live.exists());
    }

    #[test]
    fn get_usage_for_response_joins_line_and_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_1","provider_kind":"anthropic_apikey","prompt_tokens":1000000,"completion_tokens":0}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        let u = get_usage_for_response_in(dir.path(), "proj", "msg_1").unwrap();
        assert_eq!(u.prompt_tokens, 1_000_000);
        assert!(u.cost_usd.unwrap() > 0.0);
        assert_eq!(u.cost_source, "catalog");
    }

    #[test]
    fn get_usage_for_response_missing_id_is_none() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[r#"{"ts":"2026-06-26T10:00:00+0200","response_id":"msg_1","prompt_tokens":1}"#],
        );
        assert!(get_usage_for_response_in(dir.path(), "proj", "nope").is_none());
        assert!(get_usage_for_response_in(dir.path(), "proj", "").is_none());
    }

    #[test]
    fn session_cost_sums_priced_sidecar_entries() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_1","provider_kind":"anthropic_apikey","prompt_tokens":1000000,"completion_tokens":0}"#,
                r#"{"ts":"2026-06-26T10:01:00+0200","status":"success","model":"local/qwen3","response_id":"msg_2","provider_kind":"local"}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        // opus 1M input = $5.00 + local free $0.00 = $5.00.
        let total = session_cost_in(dir.path(), "proj").unwrap();
        assert!((total - 5.0).abs() < 1e-9, "got {total}");
    }

    #[test]
    fn session_cost_free_zero_does_not_vanish() {
        // A purely-free session is priced 0.0, not unpriced None.
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"local/qwen3","response_id":"msg_1","provider_kind":"local"}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        assert_eq!(session_cost_in(dir.path(), "proj"), Some(0.0));
    }

    #[test]
    fn session_cost_all_unpriced_is_none() {
        // Subscription/unknown only → None (never collapsed to 0.0).
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_1","provider_kind":"anthropic_oauth"}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        assert!(session_cost_in(dir.path(), "proj").is_none());
    }

    #[test]
    fn session_cost_missing_sidecar_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(session_cost_in(dir.path(), "proj").is_none());
        assert!(session_cost_in(dir.path(), "../escape").is_none());
    }

    #[test]
    fn conversation_cost_sums_only_listed_response_ids() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_a","provider_kind":"anthropic_apikey","prompt_tokens":1000000,"completion_tokens":0}"#,
                r#"{"ts":"2026-06-26T10:01:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_b","provider_kind":"anthropic_apikey","prompt_tokens":1000000,"completion_tokens":0}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        // Only msg_a is in this conversation → $5.00, not the project's $10.00.
        let only_a = conversation_cost_in(dir.path(), "proj", &["msg_a".to_string()]).unwrap();
        assert!((only_a - 5.0).abs() < 1e-9, "got {only_a}");
        // Both turns → $10.00 (matches a two-turn conversation).
        let both =
            conversation_cost_in(dir.path(), "proj", &["msg_a".into(), "msg_b".into()]).unwrap();
        assert!((both - 10.0).abs() < 1e-9, "got {both}");
    }

    #[test]
    fn conversation_cost_empty_list_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(conversation_cost_in(dir.path(), "proj", &[]).is_none());
    }

    #[test]
    fn conversation_cost_unpriced_turns_are_none() {
        // A subscription-only conversation is unpriced → None (not 0.0).
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_sub","provider_kind":"anthropic_oauth"}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        assert!(conversation_cost_in(dir.path(), "proj", &["msg_sub".to_string()]).is_none());
    }

    #[test]
    fn conversation_cost_free_zero_does_not_vanish() {
        // A free/local conversation is priced 0.0, not unpriced None.
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"local/q","response_id":"msg_local","provider_kind":"local"}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        assert_eq!(
            conversation_cost_in(dir.path(), "proj", &["msg_local".to_string()]),
            Some(0.0)
        );
    }

    #[test]
    fn get_usage_for_response_without_sidecar_uses_inline_cost() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","response_id":"msg_1","cost_usd":0.02,"prompt_tokens":5}"#,
            ],
        );
        let u = get_usage_for_response_in(dir.path(), "proj", "msg_1").unwrap();
        assert_eq!(u.cost_usd, Some(0.02));
        assert_eq!(u.cost_source, "");
    }

    #[test]
    fn session_cost_excludes_failed_requests() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_ok","provider_kind":"anthropic_apikey","prompt_tokens":1000000,"completion_tokens":0}"#,
                r#"{"ts":"2026-06-26T10:01:00+0200","status":"failure","model":"claude-opus-4-8","response_id":"msg_fail","provider_kind":"anthropic_apikey","prompt_tokens":1000000,"completion_tokens":0}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        // Only the successful $5.00 counts; the failed line is not billed.
        let total = session_cost_in(dir.path(), "proj").unwrap();
        assert!((total - 5.0).abs() < 1e-9, "got {total}");
    }

    #[test]
    fn failed_request_counts_as_failure_not_priced() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"failure","model":"claude-opus-4-8","response_id":"msg_fail","provider_kind":"anthropic_apikey","prompt_tokens":100,"completion_tokens":0}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        let s = read_usage_summary_in(dir.path(), "proj");
        assert_eq!(s.totals.failures, 1);
        assert_eq!(s.totals.priced_requests, 0);
        assert_eq!(s.totals.unpriced_requests, 1);
        assert!(s.totals.cost_usd.is_none(), "failed must not be priced");
    }

    #[test]
    fn session_cost_only_counts_window_after_rotation() {
        // An old priced line rotated entirely out of the window must not be
        // summed by the footer; footer total then equals the dashboard total.
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_live","provider_kind":"anthropic_apikey","prompt_tokens":1000000,"completion_tokens":0}"#,
            ],
        );
        // Price the live line.
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        // Inject an orphan sidecar entry whose usage line is NOT in the window.
        let cache = crate::usage_cost::cost_cache_file_in(dir.path(), "proj");
        let orphan = serde_json::to_string(&crate::usage_cost::CostEntry {
            response_id: "msg_orphan".into(),
            cost_usd: Some(99.0),
            cost_source: crate::usage_cost::CostSource::Catalog,
        })
        .unwrap();
        let mut existing = std::fs::read_to_string(&cache).unwrap();
        existing.push_str(&orphan);
        existing.push('\n');
        std::fs::write(&cache, existing).unwrap();
        // Footer ignores the orphan; equals dashboard ($5.00 from the live line).
        let footer = session_cost_in(dir.path(), "proj").unwrap();
        let dashboard = read_usage_summary_in(dir.path(), "proj")
            .totals
            .cost_usd
            .unwrap();
        assert!((footer - 5.0).abs() < 1e-9, "footer {footer}");
        assert!(
            (footer - dashboard).abs() < 1e-9,
            "footer must equal dashboard"
        );
    }

    #[test]
    fn prune_drops_orphans_and_compacts_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"local/q","response_id":"msg_keep","provider_kind":"local"}"#,
            ],
        );
        let cache = crate::usage_cost::cost_cache_file_in(dir.path(), "proj");
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        // Two duplicate lines for the kept id + one orphan not in the window.
        std::fs::write(
            &cache,
            concat!(
                r#"{"response_id":"msg_keep","cost_usd":0.0,"cost_source":"free"}"#,
                "\n",
                r#"{"response_id":"msg_keep","cost_usd":0.0,"cost_source":"free"}"#,
                "\n",
                r#"{"response_id":"msg_orphan","cost_usd":1.0,"cost_source":"catalog"}"#,
                "\n",
            ),
        )
        .unwrap();
        prune_cost_cache_in(dir.path(), "proj");
        let lines: Vec<String> = std::fs::read_to_string(&cache)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect();
        assert_eq!(lines.len(), 1, "duplicates collapsed + orphan dropped");
        assert!(lines[0].contains("msg_keep"));
    }

    #[test]
    fn rotation_prunes_orphaned_sidecar_entries() {
        let dir = tempfile::tempdir().unwrap();
        let live = usage_file_in(dir.path(), "proj");
        std::fs::create_dir_all(live.parent().unwrap()).unwrap();
        // Oversized live file with one record → triggers rotation.
        let mut content =
            r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","response_id":"msg_in","provider_kind":"local","model":"local/q"}"#.to_string();
        content.push('\n');
        content.push_str(&"x".repeat((USAGE_ROTATE_BYTES + 1) as usize));
        std::fs::write(&live, content).unwrap();
        // Sidecar carries an orphan whose usage line never existed.
        let cache = crate::usage_cost::cost_cache_file_in(dir.path(), "proj");
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        std::fs::write(
            &cache,
            "{\"response_id\":\"msg_orphan\",\"cost_usd\":1.0,\"cost_source\":\"catalog\"}\n",
        )
        .unwrap();
        rotate_usage_if_large_in(dir.path(), "proj");
        // The orphan is gone after rotation pruned the sidecar.
        let map = crate::usage_cost::read_cost_cache_in(dir.path(), "proj");
        assert!(map.get("msg_orphan").is_none(), "orphan pruned on rotation");
    }

    #[test]
    fn footer_and_dashboard_cost_agree_across_provider_mix() {
        // Invariant 6: footer total == dashboard total over a mixed session.
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_api","provider_kind":"anthropic_apikey","prompt_tokens":1000000,"completion_tokens":0}"#,
                r#"{"ts":"2026-06-26T10:01:00+0200","status":"success","model":"local/q","response_id":"msg_local","provider_kind":"local"}"#,
                r#"{"ts":"2026-06-26T10:02:00+0200","status":"success","model":"or/x","response_id":"msg_or","provider_kind":"openrouter","gen_id":"gen-1"}"#,
                r#"{"ts":"2026-06-26T10:03:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_sub","provider_kind":"anthropic_oauth"}"#,
                r#"{"ts":"2026-06-26T10:04:00+0200","status":"failure","model":"claude-opus-4-8","response_id":"msg_fail","provider_kind":"anthropic_apikey","prompt_tokens":500,"completion_tokens":0}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|gen| {
            (gen == "gen-1").then_some(0.0046)
        })
        .unwrap();
        // apikey 5.00 + local 0.00 + openrouter 0.0046 = 5.0046; sub/fail unpriced.
        let footer = session_cost_in(dir.path(), "proj").unwrap();
        let dashboard = read_usage_summary_in(dir.path(), "proj")
            .totals
            .cost_usd
            .unwrap();
        assert!((footer - 5.0046).abs() < 1e-9, "footer {footer}");
        assert!(
            (footer - dashboard).abs() < 1e-9,
            "footer {footer} must equal dashboard {dashboard}"
        );
    }

    #[test]
    fn gen_id_only_line_is_priced_on_dashboard_and_footer() {
        // An OpenRouter line with no message.id (response_id=null) but a gen_id
        // must be priced (keyed by gen_id) on BOTH dashboard and footer — not $0.
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"or/x","provider_kind":"openrouter","gen_id":"gen-1","prompt_tokens":10,"completion_tokens":5}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|gen| {
            (gen == "gen-1").then_some(0.02)
        })
        .unwrap();
        let dashboard = read_usage_summary_in(dir.path(), "proj")
            .totals
            .cost_usd
            .unwrap();
        let footer = session_cost_in(dir.path(), "proj").unwrap();
        assert!((dashboard - 0.02).abs() < 1e-9, "dashboard {dashboard}");
        assert!(
            (footer - dashboard).abs() < 1e-9,
            "footer must equal dashboard"
        );
        // The conversation footer keyed by gen_id also resolves it.
        let convo = conversation_cost_in(dir.path(), "proj", &["gen-1".to_string()]).unwrap();
        assert!((convo - 0.02).abs() < 1e-9, "convo {convo}");
    }

    #[test]
    fn orphan_sidecar_entry_excluded_even_if_prune_did_not_run() {
        // If prune fails (or hasn't run), an orphan whose usage line is gone must
        // still be excluded from session_cost_in — the window filter is the guard,
        // not the prune. This keeps footer == dashboard regardless of prune state.
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"local/q","response_id":"msg_live","provider_kind":"local"}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        // Manually inject a numeric-cost orphan not present in the usage window.
        let cache = crate::usage_cost::cost_cache_file_in(dir.path(), "proj");
        let orphan = serde_json::to_string(&crate::usage_cost::CostEntry {
            response_id: "msg_orphan".into(),
            cost_usd: Some(42.0),
            cost_source: crate::usage_cost::CostSource::Catalog,
        })
        .unwrap();
        let mut body = std::fs::read_to_string(&cache).unwrap();
        body.push_str(&orphan);
        body.push('\n');
        std::fs::write(&cache, body).unwrap();
        // session_cost_in excludes the orphan (window filter), equals dashboard.
        let footer = session_cost_in(dir.path(), "proj").unwrap();
        let dashboard = read_usage_summary_in(dir.path(), "proj")
            .totals
            .cost_usd
            .unwrap();
        assert_eq!(footer, 0.0, "only the in-window free line counts");
        assert!(
            (footer - dashboard).abs() < 1e-9,
            "footer must equal dashboard"
        );
        // The orphan is still physically in the file (prune didn't remove it).
        assert!(std::fs::read_to_string(&cache)
            .unwrap()
            .contains("msg_orphan"));
    }

    #[test]
    fn unpriced_only_session_is_none_on_both_surfaces() {
        // Subscription + failed only → both surfaces None, not 0.
        let dir = tempfile::tempdir().unwrap();
        write_usage(
            dir.path(),
            "proj",
            &[
                r#"{"ts":"2026-06-26T10:00:00+0200","status":"success","model":"claude-opus-4-8","response_id":"msg_sub","provider_kind":"anthropic_oauth"}"#,
                r#"{"ts":"2026-06-26T10:01:00+0200","status":"failure","model":"claude-opus-4-8","response_id":"msg_fail","provider_kind":"anthropic_apikey","prompt_tokens":5}"#,
            ],
        );
        crate::usage_cost::enrich_cost_with_in(dir.path(), "proj", &|_| None).unwrap();
        assert!(session_cost_in(dir.path(), "proj").is_none());
        assert!(read_usage_summary_in(dir.path(), "proj")
            .totals
            .cost_usd
            .is_none());
    }
}

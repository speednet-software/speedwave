//! LLM usage aggregation (ADR-073): reads the litellm callback JSONL
//! (`<data_dir>/usage/<project>/litellm/usage.jsonl`) for the Desktop
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
    /// Cost in USD when litellm could price the call (None for local).
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

/// Aggregate for one (day, model) bucket. No `PartialEq` derive: the
/// `cost_usd` f64 makes `==` an exact-float trap; tests compare fields.
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
    /// Summed cost in USD (0.0 where litellm had no pricing — local models).
    pub cost_usd: f64,
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
        .join("litellm")
        .join("usage.jsonl")
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
    }
}

/// Reads and aggregates the project's usage (rotated file first, then the
/// live one). Missing files yield an empty summary — never an error.
pub fn read_usage_summary_in(data_dir: &Path, project: &str) -> UsageSummary {
    crate::validation::validate_project_name(project)
        .map(|()| {
            let live = usage_file_in(data_dir, project);
            let rotated = live.with_extension("jsonl.1");
            let mut summary = UsageSummary::default();
            let mut seen_ids = std::collections::HashSet::new();
            for path in [rotated, live] {
                aggregate_file(&path, &mut summary, &mut seen_ids);
            }
            summary
        })
        .unwrap_or_default()
}

fn aggregate_file(
    path: &Path,
    summary: &mut UsageSummary,
    seen_ids: &mut std::collections::HashSet<String>,
) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<UsageRecord>(trimmed) else {
            summary.skipped_lines += 1;
            continue;
        };
        // Dedup by response_id; first-seen wins.
        if let Some(id) = record.response_id.as_deref() {
            if !id.is_empty() && !seen_ids.insert(id.to_string()) {
                continue;
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
        let bucket = summary
            .days
            .entry(day)
            .or_default()
            .entry(model)
            .or_default();
        apply_record(bucket, &record);
        apply_record(&mut summary.totals, &record);
    }
}

fn apply_record(bucket: &mut UsageBucket, r: &UsageRecord) {
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
    bucket.cost_usd += r.cost_usd.unwrap_or(0.0);
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
        assert!((s.totals.cost_usd - 0.005).abs() < 1e-9);
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
        // First-seen wins: the stream_iterator record (no cost) arrives before
        // the success_event (cost=0.01) and is the one kept, so cost stays 0.
        assert!(
            s.totals.cost_usd < 1e-9,
            "first-seen (costless stream_iterator) wins the dedup"
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
}

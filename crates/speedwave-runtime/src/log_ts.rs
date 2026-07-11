//! Single timestamp format for all Speedwave logs (RFC 3339, millis, offset).
//! Rust SSOT; the TS counterpart is `@speedwave/mcp-shared`'s `ts()`.

use chrono::{DateTime, Local, SecondsFormat, TimeZone};

/// Current local time as an RFC 3339 string with millisecond precision and a
/// colon-separated UTC offset, e.g. `2026-05-12T14:34:02.814+02:00`.
pub fn log_timestamp() -> String {
    format_log_timestamp(&Local::now())
}

/// Render `dt` in the canonical Speedwave log timestamp format — RFC 3339, millisecond precision,
/// colon-separated offset (UTC renders as `+00:00`, not `Z`); testable core of [`log_timestamp`].
pub fn format_log_timestamp<Tz: TimeZone>(dt: &DateTime<Tz>) -> String
where
    Tz::Offset: core::fmt::Display,
{
    dt.to_rfc3339_opts(SecondsFormat::Millis, false)
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Timelike};

    #[test]
    fn fixed_offset_renders_colon_form_with_millis() {
        let dt = FixedOffset::east_opt(2 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 5, 12, 14, 34, 2)
            .unwrap()
            .with_nanosecond(814_000_000)
            .unwrap();
        assert_eq!(format_log_timestamp(&dt), "2026-05-12T14:34:02.814+02:00");
    }

    #[test]
    fn utc_renders_plus_zero_not_z() {
        let dt = FixedOffset::east_opt(0)
            .unwrap()
            .with_ymd_and_hms(2026, 5, 12, 12, 34, 2)
            .unwrap()
            .with_nanosecond(814_000_000)
            .unwrap();
        // `to_rfc3339_opts(.., false)` uses `+00:00`, never `Z`.
        assert_eq!(format_log_timestamp(&dt), "2026-05-12T12:34:02.814+00:00");
    }

    #[test]
    fn midnight_zero_millis_edge() {
        let dt = FixedOffset::east_opt(-5 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 1, 1, 0, 0, 0)
            .unwrap();
        assert_eq!(format_log_timestamp(&dt), "2026-01-01T00:00:00.000-05:00");
    }

    #[test]
    fn log_timestamp_round_trips_via_rfc3339_parser() {
        let s = log_timestamp();
        let parsed = DateTime::parse_from_rfc3339(&s);
        assert!(
            parsed.is_ok(),
            "log_timestamp must be RFC-3339 parseable: {s}"
        );
        // millisecond fractional-seconds slot is present
        assert!(s.contains('.'), "must carry millis: {s}");
    }
}

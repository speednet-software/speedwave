//! Time window of the diagnostics export.

use std::borrow::Cow;
use std::str::FromStr;

use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeDelta, Utc};

/// How far back the export reaches.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExportWindow {
    /// Two hours.
    Hours2,
    /// Twenty-four hours.
    Hours24,
    /// Seven days.
    Days7,
    /// Thirty days.
    Days30,
}

/// A window value outside the four accepted ones.
#[derive(Debug, thiserror::Error)]
#[error("unknown export window '{0}', expected one of 2h, 24h, 7d, 30d")]
pub struct UnknownExportWindow(String);

impl ExportWindow {
    /// The value the UI sends.
    pub fn as_str(self) -> &'static str {
        match self {
            ExportWindow::Hours2 => "2h",
            ExportWindow::Hours24 => "24h",
            ExportWindow::Days7 => "7d",
            ExportWindow::Days30 => "30d",
        }
    }

    /// The oldest instant the window keeps.
    pub fn since(self, now: DateTime<Utc>) -> DateTime<Utc> {
        let span = match self {
            ExportWindow::Hours2 => TimeDelta::hours(2),
            ExportWindow::Hours24 => TimeDelta::hours(24),
            ExportWindow::Days7 => TimeDelta::days(7),
            ExportWindow::Days30 => TimeDelta::days(30),
        };
        now - span
    }
}

impl FromStr for ExportWindow {
    type Err = UnknownExportWindow;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "2h" => Ok(ExportWindow::Hours2),
            "24h" => Ok(ExportWindow::Hours24),
            "7d" => Ok(ExportWindow::Days7),
            "30d" => Ok(ExportWindow::Days30),
            other => Err(UnknownExportWindow(other.to_string())),
        }
    }
}

/// Where a line carries its timestamp.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TimestampShape {
    /// RFC 3339 prefix with any offset.
    Rfc3339Prefix,
    /// `<container> | <RFC 3339 UTC>` prefix.
    ContainerPrefix,
    /// JSON object with an RFC 3339 `ts` field.
    JsonlTs,
}

/// What the export keeps of a source.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Retention {
    /// Lines at or after the window start.
    Windowed(TimestampShape),
    /// The last N bytes.
    LastBytes(usize),
    /// The whole text.
    Whole,
}

/// Applies `retention` to `text` for a window starting at `since`.
pub fn apply(text: &str, retention: Retention, since: DateTime<Utc>) -> Cow<'_, str> {
    match retention {
        Retention::Windowed(shape) => Cow::Owned(filter_lines(text, shape, since)),
        Retention::LastBytes(max) => Cow::Borrowed(last_bytes(text, max)),
        Retention::Whole => Cow::Borrowed(text),
    }
}

/// Keeps stamped lines at or after `since`, and unstamped lines that follow a kept line.
pub fn filter_lines(text: &str, shape: TimestampShape, since: DateTime<Utc>) -> String {
    let mut out = String::new();
    let mut keeping = false;
    for line in text.split_inclusive('\n') {
        if let Some(ts) = line_timestamp(line, shape) {
            keeping = ts >= since;
        }
        if keeping {
            out.push_str(line);
        }
    }
    out
}

/// The last `max` bytes of `text`, cut at a line start.
pub fn last_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    if text.as_bytes()[start - 1] == b'\n' {
        return &text[start..];
    }
    match text[start..].find('\n') {
        Some(pos) if start + pos + 1 < text.len() => &text[start + pos + 1..],
        _ => &text[start..],
    }
}

/// True when the rotation date in the file name is before `since`.
pub fn rotated_file_ends_before(file_name: &str, since: DateTime<Utc>) -> bool {
    const STAMP_LEN: usize = "2026-11-13_10-00-00".len();
    let Some(stem) = file_name.strip_suffix(".log") else {
        return false;
    };
    let Some(stamp) = stem
        .len()
        .checked_sub(STAMP_LEN)
        .and_then(|i| stem.get(i..))
    else {
        return false;
    };
    NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d_%H-%M-%S")
        .map(|rotated| rotated.and_utc() < since)
        .unwrap_or(false)
}

fn line_timestamp(line: &str, shape: TimestampShape) -> Option<DateTime<FixedOffset>> {
    match shape {
        TimestampShape::Rfc3339Prefix => leading_rfc3339(line),
        TimestampShape::ContainerPrefix => {
            let (name, rest) = line.split_once('|')?;
            let name = name.trim_end();
            let is_name = !name.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
            if is_name {
                leading_rfc3339(rest.trim_start())
            } else {
                None
            }
        }
        TimestampShape::JsonlTs => {
            #[derive(serde::Deserialize)]
            struct Row {
                ts: String,
            }
            let row: Row = serde_json::from_str(line).ok()?;
            DateTime::parse_from_rfc3339(&row.ts).ok()
        }
    }
}

fn leading_rfc3339(text: &str) -> Option<DateTime<FixedOffset>> {
    let token = text.split_whitespace().next()?;
    DateTime::parse_from_rfc3339(token).ok()
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn parses_the_four_values_and_rejects_the_rest() {
        for (raw, window) in [
            ("2h", ExportWindow::Hours2),
            ("24h", ExportWindow::Hours24),
            ("7d", ExportWindow::Days7),
            ("30d", ExportWindow::Days30),
        ] {
            assert_eq!(raw.parse::<ExportWindow>().unwrap(), window);
            assert_eq!(window.as_str(), raw);
        }
        for bad in ["", "1h", "7D", " 7d", "7d ", "all", "30"] {
            let err = bad.parse::<ExportWindow>().unwrap_err();
            assert!(err.to_string().contains(bad), "{err}");
        }
    }

    #[test]
    fn since_counts_back_from_now_in_utc() {
        let now = at("2026-11-13T12:00:00Z");
        assert_eq!(ExportWindow::Hours2.since(now), at("2026-11-13T10:00:00Z"));
        assert_eq!(ExportWindow::Hours24.since(now), at("2026-11-12T12:00:00Z"));
        assert_eq!(ExportWindow::Days7.since(now), at("2026-11-06T12:00:00Z"));
        assert_eq!(ExportWindow::Days30.since(now), at("2026-10-14T12:00:00Z"));
    }

    #[test]
    fn rfc3339_prefix_compares_instants_across_offsets() {
        let since = at("2026-11-13T10:00:00Z");
        let text = "\
2026-11-13T11:59:59.999+02:00 old, 09:59:59Z
2026-11-13T12:00:00.000+02:00 boundary, 10:00:00Z
2026-11-13T09:00:01.000-02:00 new, 11:00:01Z
2026-11-13T10:00:00.000Z utc boundary
";
        let kept = filter_lines(text, TimestampShape::Rfc3339Prefix, since);
        assert_eq!(
            kept,
            "\
2026-11-13T12:00:00.000+02:00 boundary, 10:00:00Z
2026-11-13T09:00:01.000-02:00 new, 11:00:01Z
2026-11-13T10:00:00.000Z utc boundary
"
        );
    }

    #[test]
    fn continuation_lines_follow_the_line_before_them() {
        let since = at("2026-11-13T10:00:00Z");
        let text = "\
2026-11-13T08:00:00.000+00:00 old
  at old.stack
2026-11-13T11:00:00.000+00:00 new
  at new.stack
  at new.stack.2
";
        let kept = filter_lines(text, TimestampShape::Rfc3339Prefix, since);
        assert_eq!(
            kept,
            "2026-11-13T11:00:00.000+00:00 new\n  at new.stack\n  at new.stack.2\n"
        );
    }

    #[test]
    fn lines_before_the_first_stamp_are_dropped() {
        let since = at("2026-11-13T10:00:00Z");
        let kept = filter_lines(
            "=== header ===\n2026-11-13T11:00:00+00:00 x\n",
            TimestampShape::Rfc3339Prefix,
            since,
        );
        assert_eq!(kept, "2026-11-13T11:00:00+00:00 x\n");
    }

    #[test]
    fn a_stamp_inside_the_message_is_not_a_line_stamp() {
        let since = at("2026-11-13T10:00:00Z");
        let text = "2026-11-01T00:00:00+00:00 saw 2026-11-13T11:00:00+00:00 in input\n";
        assert_eq!(filter_lines(text, TimestampShape::Rfc3339Prefix, since), "");
    }

    #[test]
    fn container_prefix_reads_the_utc_stamp_after_the_pipe() {
        let since = at("2026-11-13T10:00:00Z");
        let text = "\
mcp-hub-1      | 2026-11-13T09:59:59.999999999Z old
mcp-hub-1      | 2026-11-13T10:00:00.000000000Z boundary
mcp-hub-1      |   indented continuation
proxy_1 | 2026-11-13T09:00:00.000000000Z older | with a pipe
proxy_1 | 2026-11-13T12:00:00.000000000Z new | with a pipe
";
        let kept = filter_lines(text, TimestampShape::ContainerPrefix, since);
        assert_eq!(
            kept,
            "\
mcp-hub-1      | 2026-11-13T10:00:00.000000000Z boundary
mcp-hub-1      |   indented continuation
proxy_1 | 2026-11-13T12:00:00.000000000Z new | with a pipe
"
        );
    }

    #[test]
    fn container_prefix_ignores_a_pipe_in_a_non_container_line() {
        let since = at("2026-11-13T10:00:00Z");
        let text = "a b | 2026-11-13T12:00:00Z not a container prefix\n";
        assert_eq!(
            filter_lines(text, TimestampShape::ContainerPrefix, since),
            ""
        );
    }

    #[test]
    fn jsonl_ts_field_decides_and_unparsable_lines_follow() {
        let since = at("2026-11-13T10:00:00Z");
        let text = "\
{\"ts\":\"2026-11-13T11:59:59.000+02:00\",\"n\":1}
{\"ts\":\"2026-11-13T12:00:00.000+02:00\",\"n\":2}
not json
{\"n\":3}
{\"ts\":\"2026-11-13T09:00:00.000+00:00\",\"n\":4}
{\"ts\":\"2026-11-13T10:00:01.000+00:00\",\"n\":5}
";
        let kept = filter_lines(text, TimestampShape::JsonlTs, since);
        assert_eq!(
            kept,
            "\
{\"ts\":\"2026-11-13T12:00:00.000+02:00\",\"n\":2}
not json
{\"n\":3}
{\"ts\":\"2026-11-13T10:00:01.000+00:00\",\"n\":5}
"
        );
    }

    #[test]
    fn crlf_and_a_missing_final_newline_are_preserved() {
        let since = at("2026-11-13T10:00:00Z");
        let text = "2026-11-13T11:00:00+00:00 a\r\n  b\r\n2026-11-13T12:00:00+00:00 c";
        assert_eq!(
            filter_lines(text, TimestampShape::Rfc3339Prefix, since),
            text
        );
    }

    #[test]
    fn last_bytes_cuts_at_a_line_start() {
        assert_eq!(last_bytes("abc\ndef\nghi\n", 100), "abc\ndef\nghi\n");
        assert_eq!(last_bytes("abc\ndef\nghi\n", 8), "def\nghi\n");
        assert_eq!(last_bytes("abc\ndef\nghi\n", 7), "ghi\n");
        assert_eq!(last_bytes("abc\ndef\nghi\n", 9), "def\nghi\n");
    }

    #[test]
    fn last_bytes_keeps_a_single_long_line_whole_to_the_limit() {
        assert_eq!(last_bytes("abcdefghij", 4), "ghij");
    }

    #[test]
    fn last_bytes_never_splits_a_character() {
        let text = "zażółć gęślą jaźń";
        let tail = last_bytes(text, 6);
        assert!(tail.len() <= 6);
        assert!(text.ends_with(tail));
    }

    #[test]
    fn apply_dispatches_on_retention() {
        let since = at("2026-11-13T10:00:00Z");
        let text = "2026-11-13T09:00:00+00:00 old\n2026-11-13T11:00:00+00:00 new\n";
        assert_eq!(apply(text, Retention::Whole, since), text);
        assert_eq!(
            apply(
                text,
                Retention::Windowed(TimestampShape::Rfc3339Prefix),
                since
            ),
            "2026-11-13T11:00:00+00:00 new\n"
        );
        assert!(apply(text, Retention::LastBytes(5), since).len() <= 5);
    }

    #[test]
    fn rotated_file_before_the_window_is_skipped() {
        let since = at("2026-11-13T10:00:00Z");
        assert!(rotated_file_ends_before(
            "speedwave-desktop_2026-11-13_09-59-59.log",
            since
        ));
        assert!(!rotated_file_ends_before(
            "speedwave-desktop_2026-11-13_10-00-00.log",
            since
        ));
        assert!(!rotated_file_ends_before(
            "speedwave-desktop_2026-11-14_00-00-00.log",
            since
        ));
    }

    #[test]
    fn a_name_without_a_rotation_date_is_never_skipped() {
        let since = at("2026-11-13T10:00:00Z");
        for name in [
            "speedwave-desktop.log",
            "x.log",
            "",
            "speedwave-desktop_2026-13-45_99-99-99.log",
            "speedwave-desktop_2020-01-01_00-00-00.txt",
            "żółć.log",
        ] {
            assert!(!rotated_file_ends_before(name, since), "{name}");
        }
    }
}

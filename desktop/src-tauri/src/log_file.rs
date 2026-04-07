//! Shared log-file utilities used by mcp-os and Claude session logging.

use std::path::Path;

/// Open a log file for appending with chmod 600 on Unix.
pub fn open_log_file(path: &Path) -> Option<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path).ok()
}

/// Format a DateTime as DD-MM-YYYY HH:MM:SS for log lines.
/// Format must match Angular date pipe in system-health.component.ts template.
fn format_timestamp<Tz: chrono::TimeZone>(dt: &chrono::DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    dt.format("%d-%m-%Y %H:%M:%S").to_string()
}

/// Write a timestamped line to the log file. Errors are silently ignored.
/// When `prefix` is empty, writes `[ts] line`; otherwise `[ts] prefix: line`.
pub fn write_log_line(file: &mut Option<std::fs::File>, prefix: &str, line: &str) {
    use std::io::Write;
    if let Some(ref mut f) = file {
        let ts = format_timestamp(&chrono::Local::now());
        if prefix.is_empty() {
            let _ = writeln!(f, "[{ts}] {line}");
        } else {
            let _ = writeln!(f, "[{ts}] {prefix}: {line}");
        }
    }
}

/// Rotate a log file if it exceeds `max_bytes` by keeping the last half.
/// This preserves the most recent entries which are most useful for debugging.
pub fn truncate_if_oversized(path: &Path, max_bytes: u64) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) if c.len() as u64 > max_bytes => c,
        _ => return,
    };
    // Keep the last half, aligned to a line boundary
    let keep_from = content.len() / 2;
    let tail = match content[keep_from..].find('\n') {
        Some(pos) => &content[keep_from + pos + 1..],
        None => &content[keep_from..],
    };
    let _ = std::fs::write(path, tail);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn open_log_file_creates_new_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.log");
        let file = open_log_file(&path);
        assert!(file.is_some(), "should open/create log file");
        assert!(path.exists(), "log file should exist on disk");
    }

    #[test]
    fn open_log_file_returns_none_for_invalid_path() {
        let path = std::path::Path::new("/nonexistent/dir/impossible.log");
        let file = open_log_file(path);
        assert!(file.is_none(), "should return None for invalid path");
    }

    #[test]
    fn format_timestamp_day_greater_than_12() {
        use chrono::TimeZone;
        let dt = chrono::FixedOffset::east_opt(3600)
            .unwrap()
            .with_ymd_and_hms(2026, 12, 25, 9, 5, 3)
            .unwrap();
        assert_eq!(format_timestamp(&dt), "25-12-2026 09:05:03");
    }

    #[test]
    fn format_timestamp_day_less_than_12() {
        use chrono::TimeZone;
        let dt = chrono::FixedOffset::east_opt(0)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 7, 0, 0, 0)
            .unwrap();
        assert_eq!(format_timestamp(&dt), "07-03-2026 00:00:00");
    }

    #[test]
    fn write_log_line_with_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("prefixed.log");
        let mut file = open_log_file(&path);
        write_log_line(&mut file, "STDERR", "something went wrong");
        drop(file);

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.contains("STDERR: something went wrong"),
            "content: {content}"
        );
        assert!(
            content.starts_with('['),
            "should start with bracket: {content}"
        );
        let close = content.find(']').expect("should have closing bracket");
        let ts_inner = &content[1..close];
        assert_eq!(
            ts_inner.len(),
            19,
            "timestamp should be 19 chars (DD-MM-YYYY HH:MM:SS): {content}"
        );
        let year: u32 = ts_inner[6..10].parse().expect("year should be numeric");
        assert!(year >= 2025, "year should be plausible: {year}");
    }

    #[test]
    fn write_log_line_without_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("no-prefix.log");
        let mut file = open_log_file(&path);
        write_log_line(&mut file, "", "bare line");
        drop(file);

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("] bare line"), "content: {content}");
        assert!(
            !content.contains(": bare line"),
            "no colon separator when prefix is empty: {content}"
        );
        assert!(
            content.starts_with('['),
            "should start with bracket: {content}"
        );
        let close = content.find(']').expect("should have closing bracket");
        let ts_inner = &content[1..close];
        assert_eq!(
            ts_inner.len(),
            19,
            "timestamp should be 19 chars (DD-MM-YYYY HH:MM:SS): {content}"
        );
        let year: u32 = ts_inner[6..10].parse().expect("year should be numeric");
        assert!(year >= 2025, "year should be plausible: {year}");
    }

    #[test]
    fn write_log_line_noop_on_none() {
        let mut file: Option<std::fs::File> = None;
        write_log_line(&mut file, "TEST", "should not panic");
        // No panic = success
    }

    #[test]
    fn truncate_if_oversized_keeps_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("big.log");
        // Write lines totaling >2000 bytes
        let mut content = String::new();
        for i in 0..100 {
            content.push_str(&format!("[{i}] line number {i} with some padding text\n"));
        }
        assert!(content.len() > 2000);
        std::fs::write(&path, &content).unwrap();

        truncate_if_oversized(&path, 2000);

        let result = std::fs::read_to_string(&path).unwrap();
        assert!(
            result.len() < content.len(),
            "file should be smaller after rotation"
        );
        assert!(
            result.contains("[99]"),
            "should keep the most recent entries: {result}"
        );
        assert!(
            !result.contains("[0] "),
            "should have dropped the oldest entries"
        );
    }

    #[test]
    fn truncate_if_oversized_leaves_small_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("small.log");
        std::fs::write(&path, "x".repeat(100)).unwrap();

        truncate_if_oversized(&path, 2000);

        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            100,
            "should be unchanged"
        );
    }

    #[test]
    fn truncate_if_oversized_noop_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("missing.log");
        // Should not panic
        truncate_if_oversized(&path, 2000);
    }
}

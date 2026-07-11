//! Shared log-file utilities — chmod-600 append handles, timestamped lines,
//! size-bounded rotation. Used by Desktop's claude-session log and the mcp-os drain.

use std::path::Path;

/// Open a log file for appending with chmod 600 on Unix. `None` on error
/// (logged via the `log` facade).
pub fn open_log_file(path: &Path) -> Option<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(path) {
        Ok(f) => Some(f),
        Err(e) => {
            log::warn!("cannot open log file {}: {e}", path.display());
            None
        }
    }
}

/// Write `<ISO> [prefix: ]line` to the log (errors silently ignored); unbracketed ISO so
/// `/logs`'s `ISO_TIME_RE` matches. `line` passes through `log_sanitizer::sanitize` first.
pub fn write_log_line(file: &mut Option<std::fs::File>, prefix: &str, line: &str) {
    use std::io::Write;
    if let Some(ref mut f) = file {
        let ts = crate::log_ts::log_timestamp();
        let sanitized = crate::log_sanitizer::sanitize(line);
        if prefix.is_empty() {
            let _ = writeln!(f, "{ts} {sanitized}");
        } else {
            let _ = writeln!(f, "{ts} {prefix}: {sanitized}");
        }
    }
}

/// Rotate a log file if it exceeds `max_bytes` by keeping the last half (line-aligned).
/// Best-effort; stat-only when under threshold, full read only if truncation is needed.
pub fn truncate_if_oversized(path: &Path, max_bytes: u64) {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > max_bytes => {}
        _ => return,
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let keep_from = content.len() / 2;
    let tail = match content[keep_from..].find('\n') {
        Some(pos) => &content[keep_from + pos + 1..],
        None => &content[keep_from..],
    };
    let _ = std::fs::write(path, tail);
}

// ── Tests ───────────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    /// Split a written log line into `(timestamp, rest)` at the first space.
    fn split_line(content: &str) -> (&str, &str) {
        let first = content.lines().next().expect("at least one line");
        let space = first
            .find(' ')
            .expect("line has a space after the timestamp");
        (&first[..space], &first[space + 1..])
    }

    #[test]
    fn open_log_file_creates_new_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.log");
        let file = open_log_file(&path);
        assert!(file.is_some(), "should open/create log file");
        assert!(path.exists(), "log file should exist on disk");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600,
                "log file must be chmod 600"
            );
        }
    }

    #[test]
    fn open_log_file_returns_none_for_invalid_path() {
        // Exercises the error arm: returns None.
        let path = std::path::Path::new("/nonexistent/dir/impossible.log");
        let file = open_log_file(path);
        assert!(file.is_none(), "should return None for invalid path");
    }

    #[test]
    fn write_log_line_with_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("prefixed.log");
        let mut file = open_log_file(&path);
        write_log_line(&mut file, "STDERR", "something went wrong");
        drop(file);

        let content = std::fs::read_to_string(&path).unwrap();
        let (ts, rest) = split_line(&content);
        assert!(
            chrono::DateTime::parse_from_rfc3339(ts).is_ok(),
            "line must start with an RFC-3339 timestamp: {content}"
        );
        assert_eq!(rest, "STDERR: something went wrong");
    }

    #[test]
    fn write_log_line_without_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("no-prefix.log");
        let mut file = open_log_file(&path);
        write_log_line(&mut file, "", "bare line");
        drop(file);

        let content = std::fs::read_to_string(&path).unwrap();
        let (ts, rest) = split_line(&content);
        assert!(
            chrono::DateTime::parse_from_rfc3339(ts).is_ok(),
            "line must start with an RFC-3339 timestamp: {content}"
        );
        assert_eq!(rest, "bare line");
        assert!(
            !content.contains(": bare line"),
            "no colon separator when prefix is empty: {content}"
        );
    }

    #[test]
    fn write_log_line_unicode_message() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("unicode.log");
        let mut file = open_log_file(&path);
        write_log_line(&mut file, "STDOUT", "🚀 héllo — café");
        drop(file);

        let content = std::fs::read_to_string(&path).unwrap();
        let (_ts, rest) = split_line(&content);
        assert_eq!(rest, "STDOUT: 🚀 héllo — café");
    }

    #[test]
    fn write_log_line_sanitizes_secret() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret.log");
        let mut file = open_log_file(&path);
        write_log_line(
            &mut file,
            "STDOUT",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc",
        );
        drop(file);

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            !content.contains("eyJhbGciOiJIUzI1NiJ9.abc"),
            "token must not reach disk: {content}"
        );
        assert!(
            content.contains("***REDACTED***"),
            "sanitizer marker expected: {content}"
        );
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

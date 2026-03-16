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

/// Write a timestamped line to the log file. Errors are silently ignored.
/// When `prefix` is empty, writes `[ts] line`; otherwise `[ts] prefix: line`.
pub fn write_log_line(file: &mut Option<std::fs::File>, prefix: &str, line: &str) {
    use std::io::Write;
    if let Some(ref mut f) = file {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if prefix.is_empty() {
            let _ = writeln!(f, "[{secs}] {line}");
        } else {
            let _ = writeln!(f, "[{secs}] {prefix}: {line}");
        }
    }
}

/// Truncate a log file to empty if it exceeds `max_bytes`.
pub fn truncate_if_oversized(path: &Path, max_bytes: u64) {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > max_bytes {
            let _ = std::fs::write(path, "");
        }
    }
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
            "should start with timestamp bracket"
        );
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
    }

    #[test]
    fn write_log_line_noop_on_none() {
        let mut file: Option<std::fs::File> = None;
        write_log_line(&mut file, "TEST", "should not panic");
        // No panic = success
    }

    #[test]
    fn truncate_if_oversized_truncates_large_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("big.log");
        // Write 3000 bytes
        std::fs::write(&path, "x".repeat(3000)).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 3000);

        truncate_if_oversized(&path, 2000);

        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            0,
            "should be truncated to empty"
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

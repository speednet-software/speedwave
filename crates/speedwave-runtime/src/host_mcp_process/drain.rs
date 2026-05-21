//! Stdout/stderr drain shared by every host MCP worker manager.
//!
//! After spawning the Node child, the manager must:
//! 1. Read the first stdout line as `{"port": N}` to learn the OS-assigned port.
//! 2. Keep draining stdout/stderr for the rest of the child's lifetime — if
//!    either pipe blocks or closes, Node dies (SIGPIPE / write block).
//!
//! Both pipes are appended to a per-worker audit log. The drain handles
//! returned by `drain_and_read_port` must be joined by the caller in
//! `stop()` so the log-file handles are released before the file is
//! truncated or rotated.

use std::io::BufRead;
use std::path::Path;
use std::process::Child;
use std::sync::mpsc;
use std::thread::JoinHandle;

use crate::log_file::{open_log_file, write_log_line};

use super::PORT_READ_TIMEOUT;

/// Parse a `{"port": N}` JSON line into a valid `u16`. Rejects `0`
/// (invalid bind target) and values above `u16::MAX` so a malformed
/// worker can't trick the manager into recording garbage.
pub fn parse_port_line(line: &str) -> Option<u16> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let port = v.get("port")?.as_u64()?;
    if port == 0 || port > u16::MAX as u64 {
        return None;
    }
    u16::try_from(port).ok()
}

/// Spawn background threads to drain both stdout and stderr of the
/// child, then wait for the `{"port": N}` JSON line on stdout.
/// Returns the port and the join handles for both drain threads so the
/// caller can join them on stop.
///
/// `service_tag` is included in `log::debug`/`log::warn` output and in
/// the log-file row prefix so multi-worker logs are diagnosable.
pub fn drain_and_read_port(
    child: &mut Child,
    log_path: &Path,
    service_tag: &'static str,
) -> anyhow::Result<(u16, Vec<JoinHandle<()>>)> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("{service_tag} stdout not captured"))?;

    let mut handles = Vec::new();

    if let Some(stderr) = child.stderr.take() {
        let log_path_stderr = log_path.to_path_buf();
        let tag = service_tag;
        let h = std::thread::spawn(move || {
            let mut log_file = open_log_file(&log_path_stderr);
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        log::warn!("{tag} stderr: {line}");
                        write_log_line(&mut log_file, "STDERR", &line);
                    }
                    Err(_) => break,
                }
            }
        });
        handles.push(h);
    }

    let (tx, rx) = mpsc::channel();
    let log_path_stdout = log_path.to_path_buf();
    let tag = service_tag;
    let h = std::thread::spawn(move || {
        let mut log_file = open_log_file(&log_path_stdout);
        let reader = std::io::BufReader::new(stdout);
        let mut port_sent = false;
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if !port_sent {
                        if let Some(port) = parse_port_line(&line) {
                            let _ = tx.send(Ok(port));
                            port_sent = true;
                            write_log_line(&mut log_file, "STDOUT", &line);
                            continue;
                        }
                    }
                    log::debug!("{tag}: {line}");
                    write_log_line(&mut log_file, "STDOUT", &line);
                }
                Err(_) => break,
            }
        }
        if !port_sent {
            let _ = tx.send(Err(anyhow::anyhow!(
                "{tag} exited without announcing a port"
            )));
        }
    });
    handles.push(h);

    match rx.recv_timeout(PORT_READ_TIMEOUT) {
        Ok(result) => result.map(|port| (port, handles)),
        Err(_) => anyhow::bail!("timed out waiting for {service_tag} port announcement"),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod test_support {
    use std::process::{Child, Stdio};

    /// Spawn a `bash -c` child whose stdout emits the given lines (one
    /// per `printf '%s\n'`). Test-only fixture shared by every worker's
    /// drain tests; lets them exercise `drain_and_read_port` without
    /// pulling Node into the test binary.
    pub fn spawn_stdout_lines(lines: &[&str]) -> Child {
        let mut script = String::new();
        for line in lines {
            // The newline must survive shell quoting — `printf '%s\n' "..."`.
            let escaped = line.replace('\'', "'\\''");
            script.push_str(&format!("printf '%s\\n' '{escaped}';"));
        }
        std::process::Command::new("bash")
            .arg("-c")
            .arg(&script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::test_support::spawn_stdout_lines;
    use super::*;

    fn temp_log() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn parse_port_line_accepts_valid_port() {
        assert_eq!(parse_port_line(r#"{"port":12345}"#), Some(12345));
        assert_eq!(parse_port_line(r#"  {"port":1}  "#), Some(1));
        assert_eq!(parse_port_line(r#"{"port":65535}"#), Some(65535));
    }

    #[test]
    fn parse_port_line_rejects_zero_and_overflow() {
        assert_eq!(parse_port_line(r#"{"port":0}"#), None);
        assert_eq!(parse_port_line(r#"{"port":65536}"#), None);
        assert_eq!(parse_port_line(r#"{"port":4294967295}"#), None);
    }

    #[test]
    fn parse_port_line_rejects_non_json() {
        assert_eq!(parse_port_line("not json"), None);
        assert_eq!(parse_port_line(""), None);
        assert_eq!(parse_port_line("{}"), None);
        assert_eq!(parse_port_line(r#"{"other":1}"#), None);
    }

    #[test]
    fn drain_reads_port_from_first_json_line() {
        let dir = temp_log();
        let log = dir.path().join("audit.log");
        let mut child = spawn_stdout_lines(&[r#"{"port":54321}"#, "another line", "third line"]);
        let (port, handles) = drain_and_read_port(&mut child, &log, "test-worker").unwrap();
        assert_eq!(port, 54321);
        let _ = child.wait();
        for h in handles {
            h.join().ok();
        }
        let body = std::fs::read_to_string(&log).unwrap();
        assert!(body.contains("STDOUT"));
        assert!(body.contains(r#"{"port":54321}"#));
    }

    #[test]
    fn drain_skips_lines_until_port_announcement() {
        let dir = temp_log();
        let log = dir.path().join("audit.log");
        let mut child =
            spawn_stdout_lines(&["noisy startup message", "another one", r#"{"port":40400}"#]);
        let (port, handles) = drain_and_read_port(&mut child, &log, "test-worker").unwrap();
        assert_eq!(port, 40400);
        let _ = child.wait();
        for h in handles {
            h.join().ok();
        }
    }

    #[test]
    fn drain_rejects_port_over_u16_via_parse_port_line() {
        let dir = temp_log();
        let log = dir.path().join("audit.log");
        let mut child = spawn_stdout_lines(&[r#"{"port":999999}"#]);
        let result = drain_and_read_port(&mut child, &log, "test-worker");
        let _ = child.wait();
        assert!(result.is_err(), "out-of-range port must error out");
    }

    #[test]
    fn drain_errors_when_child_exits_without_port() {
        let dir = temp_log();
        let log = dir.path().join("audit.log");
        let mut child = spawn_stdout_lines(&["one", "two", "three"]);
        let result = drain_and_read_port(&mut child, &log, "test-worker");
        let _ = child.wait();
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap()
            .to_string()
            .contains("exited without announcing a port"));
    }
}

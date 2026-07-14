//! PII detection audit writer: appends JSONL rows to `$AUDIT_DIR/audit-proxy.jsonl` (mirrors
//! `consts::AUDIT_PROXY_FILE` / `audit-pii.ts`): one line per (category, action), never a data value.

use serde::Serialize;
use speedwave_pii_engine::{Detection, DetectionAction};
use std::io::Write;
use std::path::Path;

const AUDIT_FILE_NAME: &str = "audit-proxy.jsonl";

/// Proxy scans the whole request body as one boundary (A-in): it does not distinguish the
/// fresh prompt from replayed history (C), so every line carries the same fixed layer tag.
const LAYER: &str = "A-in";

#[derive(Serialize)]
struct PiiAuditLine {
    ts: String,
    layer: &'static str,
    category: String,
    action: &'static str,
    count: u32,
    session: Option<String>,
    tool: Option<String>,
}

/// Appends one JSONL line per detection to `<audit_dir>/audit-proxy.jsonl`; no-op when `None`.
/// A write failure warns and is swallowed; timestamp is local `chrono`, not the `ts()` SSOT.
pub fn write_pii_audit(audit_dir: Option<&Path>, detections: &[Detection]) {
    if detections.is_empty() {
        return;
    }
    let Some(dir) = audit_dir else {
        return;
    };
    if let Err(e) = write_pii_audit_to(dir, detections) {
        log::warn!("PII audit append failed ({}): {e}", dir.display());
    }
}

fn write_pii_audit_to(dir: &Path, detections: &[Detection]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let ts = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false);

    let mut buf = Vec::new();
    for d in detections {
        let line = PiiAuditLine {
            ts: ts.clone(),
            layer: LAYER,
            category: d.category.clone(),
            action: match d.action {
                DetectionAction::Tokenized => "tokenized",
                DetectionAction::Passed => "passed",
            },
            count: d.count,
            session: None,
            tool: None,
        };
        serde_json::to_writer(&mut buf, &line).map_err(std::io::Error::other)?;
        buf.push(b'\n');
    }

    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(dir.join(AUDIT_FILE_NAME))?;
    file.write_all(&buf)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixture setup, failure aborts the test"
)]
mod tests {
    use super::*;

    fn detection(category: &str, action: DetectionAction, count: u32) -> Detection {
        Detection {
            category: category.to_string(),
            action,
            count,
        }
    }

    #[test]
    fn no_op_when_audit_dir_is_none() {
        // Must not panic and must not create anything. Nothing to check, just no crash.
        write_pii_audit(None, &[detection("EMAIL", DetectionAction::Tokenized, 1)]);
    }

    #[test]
    fn no_op_when_detections_are_empty() {
        let dir = tempfile::tempdir().unwrap();
        write_pii_audit(Some(dir.path()), &[]);
        assert!(!dir.path().join(AUDIT_FILE_NAME).exists());
    }

    #[test]
    fn writes_one_json_line_per_detection_with_expected_schema() {
        let dir = tempfile::tempdir().unwrap();
        write_pii_audit(
            Some(dir.path()),
            &[
                detection("EMAIL", DetectionAction::Tokenized, 3),
                detection("PESEL", DetectionAction::Passed, 1),
            ],
        );
        let contents = std::fs::read_to_string(dir.path().join(AUDIT_FILE_NAME)).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);

        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["layer"], "A-in");
        assert_eq!(first["category"], "EMAIL");
        assert_eq!(first["action"], "tokenized");
        assert_eq!(first["count"], 3);
        assert_eq!(first["session"], serde_json::Value::Null);
        assert_eq!(first["tool"], serde_json::Value::Null);
        assert!(
            first["ts"].as_str().unwrap().contains('T'),
            "ts must be RFC3339"
        );

        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["category"], "PESEL");
        assert_eq!(second["action"], "passed");
    }

    #[test]
    fn appends_across_multiple_calls_instead_of_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        write_pii_audit(
            Some(dir.path()),
            &[detection("EMAIL", DetectionAction::Tokenized, 1)],
        );
        write_pii_audit(
            Some(dir.path()),
            &[detection("CARD", DetectionAction::Tokenized, 1)],
        );
        let contents = std::fs::read_to_string(dir.path().join(AUDIT_FILE_NAME)).unwrap();
        assert_eq!(contents.lines().count(), 2);
    }

    #[test]
    fn write_failure_is_swallowed_not_panicking() {
        // A path that cannot be created (parent is a file, not a dir).
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("not-a-dir");
        std::fs::write(&blocked, b"x").unwrap();
        write_pii_audit(
            Some(&blocked.join("audit")),
            &[detection("EMAIL", DetectionAction::Tokenized, 1)],
        );
    }
}

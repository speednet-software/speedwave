use std::io::Write;
use std::path::Path;

use chrono::{SecondsFormat, Utc};

use super::provider::ErrorCode;
use crate::consts;

pub(super) fn record(path: &Path, project: &str, service: &str, result: Result<(), ErrorCode>) {
    let outcome = match result {
        Ok(()) => "ok".to_string(),
        Err(code) => format!("error:{}", code.slug()),
    };
    let line = format!(
        "{} project={project} service={service} action=refresh outcome={outcome}\n",
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    );
    rotate_if_needed(path);
    if append(path, &line).is_err() {
        log::warn!("failed to append to the oauth audit log");
    }
}

fn rotate_if_needed(path: &Path) {
    let oversized = std::fs::metadata(path).is_ok_and(|m| m.len() > consts::OAUTH_AUDIT_MAX_BYTES);
    if oversized {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        if std::fs::rename(path, rotated).is_err() {
            log::warn!("failed to rotate the oauth audit log");
        }
    }
}

fn append(path: &Path, line: &str) -> std::io::Result<()> {
    let existed = path.exists();
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(line.as_bytes())?;
    if !existed {
        crate::fs_perms::set_owner_only(path).map_err(std::io::Error::other)?;
    }
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    #[test]
    fn appends_one_line_per_event_in_the_established_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.log");
        record(&path, "proj", "slack", Ok(()));
        record(&path, "proj", "slack", Err(ErrorCode::InvalidGrant));
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(" project=proj service=slack action=refresh outcome=ok"));
        assert!(lines[1]
            .ends_with(" project=proj service=slack action=refresh outcome=error:invalid_grant"));
        let stamp = lines[0].split(' ').next().unwrap();
        assert!(
            chrono::DateTime::parse_from_rfc3339(stamp).is_ok(),
            "{stamp}"
        );
    }

    #[test]
    fn rotates_past_the_size_limit_keeping_one_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.log");
        let filler = vec![b'x'; consts::OAUTH_AUDIT_MAX_BYTES as usize + 1];
        std::fs::write(&path, &filler).unwrap();
        record(&path, "proj", "slack", Ok(()));
        let rotated = dir.path().join("audit.log.1");
        assert_eq!(
            std::fs::metadata(&rotated).unwrap().len(),
            filler.len() as u64
        );
        let fresh = std::fs::read_to_string(&path).unwrap();
        assert_eq!(fresh.lines().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_new_log_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.log");
        record(&path, "proj", "slack", Ok(()));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

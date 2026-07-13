//! Per-spawn instance marker for reaping a leaked in-container `claude`
//! process (`nerdctl exec` drops SIGKILL): tag each spawn, kill by `/proc`.

/// Env var carrying the per-spawn instance id into the container process.
/// Lands in `/proc/<pid>/environ`, matched by [`kill_by_instance_command`].
pub const SESSION_INSTANCE_ENV: &str = "SPW_SESSION_INSTANCE_ID";

/// argv prefix that stamps `claude` with `id` via `env VAR=id`. Prepend to the
/// claude argv so the marker is inherited into the process environment.
pub fn instance_env_argv(id: &str) -> Vec<String> {
    vec!["env".to_string(), format!("{SESSION_INSTANCE_ENV}={id}")]
}

/// Fresh per-spawn instance id for [`SESSION_INSTANCE_ENV`].
pub fn new_instance_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Busybox-safe `sh -c` body killing only process(es) whose environ carries
/// `SPW_SESSION_INSTANCE_ID=<id>`; no procps, other sessions untouched.
pub fn kill_by_instance_command(id: &str) -> Vec<String> {
    let marker = format!("{SESSION_INSTANCE_ENV}={id}");
    let script = format!(
        "for d in /proc/[0-9]*; do \
grep -qa '{marker}' \"$d/environ\" 2>/dev/null && kill \"${{d#/proc/}}\" 2>/dev/null; \
done; true"
    );
    vec!["sh".to_string(), "-c".to_string(), script]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_instance_ids_are_unique_and_nonempty() {
        let a = new_instance_id();
        let b = new_instance_id();
        assert!(!a.is_empty());
        assert_ne!(a, b);
    }

    #[test]
    fn instance_env_argv_prefixes_env_assignment() {
        let argv = instance_env_argv("abc-123");
        assert_eq!(argv, vec!["env", "SPW_SESSION_INSTANCE_ID=abc-123"]);
    }

    #[test]
    fn kill_command_matches_the_given_instance() {
        let cmd = kill_by_instance_command("abc-123");
        assert_eq!(cmd[0], "sh");
        assert_eq!(cmd[1], "-c");
        assert!(cmd[2].contains("SPW_SESSION_INSTANCE_ID=abc-123"));
        assert!(cmd[2].contains("/proc/[0-9]*"));
        assert!(cmd[2].contains("kill"));
    }

    #[test]
    fn kill_command_does_not_match_a_different_instance() {
        // The script greps for the exact id; a different id is not a substring.
        let cmd = kill_by_instance_command("aaaa");
        assert!(!cmd[2].contains("SPW_SESSION_INSTANCE_ID=bbbb"));
    }

    #[test]
    fn env_name_is_the_documented_constant() {
        assert_eq!(SESSION_INSTANCE_ENV, "SPW_SESSION_INSTANCE_ID");
    }
}

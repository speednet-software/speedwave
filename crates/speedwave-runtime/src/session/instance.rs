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

const REAP_EXIT_WAIT_TENTHS: u32 = 30;

/// Busybox-safe `sh -c` body stopping only process(es) whose environ carries
/// `SPW_SESSION_INSTANCE_ID=<id>`: TERM, a bounded wait for their exit, then KILL.
pub fn kill_by_instance_command(id: &str) -> Vec<String> {
    let marker = format!("{SESSION_INSTANCE_ENV}={id}");
    let script = format!(
        "m='{marker}'; \
signal() {{ for d in /proc/[0-9]*; do \
grep -qa \"$m\" \"$d/environ\" 2>/dev/null && kill \"$1\" \"${{d#/proc/}}\" 2>/dev/null; \
done; }}; \
alive() {{ for d in /proc/[0-9]*; do \
grep -qa \"$m\" \"$d/environ\" 2>/dev/null && return 0; \
done; return 1; }}; \
signal -TERM; i=0; \
while [ \"$i\" -lt {REAP_EXIT_WAIT_TENTHS} ] && alive; do sleep 0.1; i=$((i + 1)); done; \
signal -KILL; true"
    );
    vec!["sh".to_string(), "-c".to_string(), script]
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "test assertions may expect freely")]
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
    fn kill_command_waits_for_the_instance_to_exit_before_it_kills_what_is_left() {
        let script = &kill_by_instance_command("abc-123")[2];
        let term = script.find("signal -TERM").expect("a TERM first");
        let wait = script.find("while").expect("a wait for the exit");
        let kill = script.find("signal -KILL").expect("a KILL for survivors");

        assert!(term < wait && wait < kill, "{script}");
        assert!(script.contains("&& alive; do sleep 0.1;"));
        assert!(script.contains(&format!("-lt {REAP_EXIT_WAIT_TENTHS} ]")));
        assert!(script.ends_with("true"));
    }

    #[test]
    fn kill_command_waits_at_most_three_seconds() {
        assert_eq!(REAP_EXIT_WAIT_TENTHS, 30);
    }

    #[test]
    fn kill_command_is_valid_posix_shell() {
        let script = &kill_by_instance_command("abc-123")[2];
        let words = shlex::split(script).expect("the script tokenizes as shell words");
        assert!(words
            .iter()
            .any(|w| w == "m=SPW_SESSION_INSTANCE_ID=abc-123;"));
    }

    #[test]
    fn kill_command_does_not_match_a_different_instance() {
        let cmd = kill_by_instance_command("aaaa");
        assert!(!cmd[2].contains("SPW_SESSION_INSTANCE_ID=bbbb"));
    }

    #[test]
    fn env_name_is_the_documented_constant() {
        assert_eq!(SESSION_INSTANCE_ENV, "SPW_SESSION_INSTANCE_ID");
    }
}

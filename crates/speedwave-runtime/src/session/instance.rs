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
fn reap_script(id: &str) -> String {
    let marker = format!("{SESSION_INSTANCE_ENV}={id}");
    format!(
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
    )
}

/// `sh -c <payload>` reaping the instance `id`, base64-wrapped
/// ([`crate::runtime::wrap_base64_sh`]) so the script survives the
/// `wsl.exe -d <distro> -- ...` interop boundary, which re-parses the argv
/// through the distro's default shell and would otherwise expand every `$`
/// in [`reap_script`] against an unrelated environment.
pub fn kill_by_instance_command(id: &str) -> Vec<String> {
    let script = reap_script(id);
    vec![
        "sh".to_string(),
        "-c".to_string(),
        crate::runtime::wrap_base64_sh(&script),
    ]
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
        let script = crate::runtime::decode_payload(&cmd[2]);
        assert!(script.contains("SPW_SESSION_INSTANCE_ID=abc-123"));
        assert!(script.contains("/proc/[0-9]*"));
        assert!(script.contains("kill"));
    }

    #[test]
    fn kill_command_waits_for_the_instance_to_exit_before_it_kills_what_is_left() {
        let cmd = kill_by_instance_command("abc-123");
        let script = crate::runtime::decode_payload(&cmd[2]);
        let term = script.find("signal -TERM").expect("a TERM first");
        let wait = script.find("while").expect("a wait for the exit");
        let kill = script.find("signal -KILL").expect("a KILL for survivors");

        assert!(term < wait && wait < kill, "{script}");
        assert!(script.contains("&& alive; do sleep 0.1;"));
        assert!(script.contains(&format!("-lt {REAP_EXIT_WAIT_TENTHS} ]")));
        assert!(script.ends_with("true"));
    }

    #[test]
    fn kill_command_waits_thirty_polls_of_a_tenth_of_a_second() {
        assert_eq!(REAP_EXIT_WAIT_TENTHS, 30);
    }

    #[test]
    fn reap_script_tokenizes_as_shell_words() {
        let script = reap_script("abc-123");
        let words = shlex::split(&script).expect("the script tokenizes as shell words");
        assert!(words
            .iter()
            .any(|w| w == "m=SPW_SESSION_INSTANCE_ID=abc-123;"));
    }

    #[cfg(unix)]
    #[test]
    fn reap_script_passes_a_real_shell_syntax_check() {
        let script = reap_script("abc-123");
        let status = std::process::Command::new("sh")
            .args(["-n", "-c", &script])
            .status()
            .expect("sh must be available to syntax-check the script");
        assert!(status.success(), "sh -n rejected the reap script: {script}");
    }

    #[test]
    fn kill_command_does_not_match_a_different_instance() {
        let cmd = kill_by_instance_command("aaaa");
        let script = crate::runtime::decode_payload(&cmd[2]);
        assert!(!script.contains("SPW_SESSION_INSTANCE_ID=bbbb"));
    }

    #[test]
    fn env_name_is_the_documented_constant() {
        assert_eq!(SESSION_INSTANCE_ENV, "SPW_SESSION_INSTANCE_ID");
    }

    #[test]
    fn kill_command_argv_survives_the_wsl_interop_reparse() {
        let cmd = kill_by_instance_command("abc-123");
        assert_eq!(cmd[0], "sh");
        assert_eq!(cmd[1], "-c");
        let payload = &cmd[2];
        assert!(
            !payload.contains('$') && !payload.contains('`') && !payload.contains('\\'),
            "the wrapped payload must carry no shell-expansion characters: {payload}"
        );
        let decoded = crate::runtime::decode_payload(payload);
        assert_eq!(decoded, reap_script("abc-123"));
    }
}

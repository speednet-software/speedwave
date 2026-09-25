//! Per-spawn instance marker for reaping a leaked in-container `claude`
//! process (`nerdctl exec` drops SIGKILL): tag each spawn, kill by `/proc`.

use std::time::Duration;

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

/// How long [`reap_instance`] lets one reap exec run: the script's exit wait plus 5 s.
pub const REAP_DEADLINE: Duration =
    Duration::from_millis(REAP_EXIT_WAIT_TENTHS as u64 * 100 + 5_000);

fn reap_script(id: &str) -> String {
    let marker = format!("{SESSION_INSTANCE_ENV}={id}");
    format!(
        "m='{marker}'; \
marked() {{ for d in /proc/[0-9]*; do \
grep -qa \"$m\" \"$d/environ\" 2>/dev/null && echo \"${{d#/proc/}}\"; \
done; }}; \
alive() {{ for p in $1; do \
grep -qa \"$m\" \"/proc/$p/environ\" 2>/dev/null && return 0; \
done; return 1; }}; \
pids=$(marked); [ -n \"$pids\" ] || exit 0; \
kill -TERM $pids 2>/dev/null; i=0; \
while [ \"$i\" -lt {REAP_EXIT_WAIT_TENTHS} ] && alive \"$pids\"; do sleep 0.1; i=$((i + 1)); done; \
left=$(marked); [ -z \"$left\" ] || kill -KILL $left 2>/dev/null; true"
    )
}

/// `sh -c <payload>` reaping the instance `id`; the payload is base64-wrapped
/// ([`crate::runtime::wrap_base64_sh`]) so the `wsl.exe` interop re-parse expands nothing.
pub fn kill_by_instance_command(id: &str) -> Vec<String> {
    let script = reap_script(id);
    vec![
        "sh".to_string(),
        "-c".to_string(),
        crate::runtime::wrap_base64_sh(&script),
    ]
}

static UNCONFIRMED: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// Runs [`kill_by_instance_command`] for `id` in `container` within [`REAP_DEADLINE`]; an
/// instance it cannot confirm gone is kept for [`reap_unconfirmed`].
pub fn reap_instance(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
    id: &str,
) -> anyhow::Result<()> {
    reap_instance_recorded(runtime, container, id, REAP_DEADLINE)
}

/// Reaps again each instance of `container` an earlier [`reap_instance`] could not confirm
/// gone, and fails while one survives, so no new session starts beside a leaked process.
pub fn reap_unconfirmed(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
) -> anyhow::Result<()> {
    reap_unconfirmed_within(runtime, container, REAP_DEADLINE)
}

fn reap_instance_recorded(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
    id: &str,
    deadline: Duration,
) -> anyhow::Result<()> {
    let reaped = reap_instance_within(runtime, container, id, deadline);
    if reaped.is_err() {
        unconfirmed().push((container.to_string(), id.to_string()));
    }
    reaped
}

fn reap_unconfirmed_within(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
    deadline: Duration,
) -> anyhow::Result<()> {
    let pending: Vec<String> = unconfirmed()
        .iter()
        .filter(|(c, _)| c == container)
        .map(|(_, id)| id.clone())
        .collect();
    for id in pending {
        reap_instance_within(runtime, container, &id, deadline).map_err(|e| {
            anyhow::anyhow!(
                "an earlier Claude Code process in '{container}' could not be stopped: {e}"
            )
        })?;
        unconfirmed().retain(|(c, i)| !(c == container && *i == id));
    }
    Ok(())
}

fn unconfirmed() -> std::sync::MutexGuard<'static, Vec<(String, String)>> {
    UNCONFIRMED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn reap_instance_within(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
    id: &str,
    deadline: Duration,
) -> anyhow::Result<()> {
    let argv = kill_by_instance_command(id);
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    let mut cmd = runtime.container_exec_piped(container, &argv)?;
    cmd.stdin(std::process::Stdio::null());
    let output = crate::binary::run_with_timeout_capture(&mut cmd, deadline)?;
    anyhow::ensure!(
        output.status.success(),
        "reap exec in '{container}' exited with {}",
        output.status
    );
    Ok(())
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
        let term = script.find("kill -TERM $pids").expect("a TERM first");
        let wait = script.find("while").expect("a wait for the exit");
        let kill = script
            .find("kill -KILL $left")
            .expect("a KILL for survivors");

        assert!(term < wait && wait < kill, "{script}");
        assert!(script.contains("&& alive \"$pids\"; do sleep 0.1;"));
        assert!(script.contains(&format!("-lt {REAP_EXIT_WAIT_TENTHS} ]")));
        assert!(script.ends_with("true"));
    }

    #[test]
    fn the_wait_polls_only_the_processes_the_term_went_to() {
        let script = reap_script("abc-123");
        let alive = script.find("alive() {").expect("an alive check");
        let body = &script[alive..script[alive..].find("}; ").expect("its end") + alive];

        assert!(body.contains("for p in $1;"), "{body}");
        assert!(body.contains("\"/proc/$p/environ\""), "{body}");
        assert!(!body.contains("/proc/[0-9]*"), "{body}");
    }

    #[test]
    fn the_kill_scans_again_for_processes_started_during_the_wait() {
        let script = reap_script("abc-123");
        let wait = script.find("while").expect("a wait for the exit");
        let rescan = script.find("left=$(marked)").expect("a second scan");

        assert!(wait < rescan, "{script}");
    }

    #[test]
    fn a_reap_with_nothing_to_stop_ends_before_the_wait() {
        let script = reap_script("abc-123");
        let empty = script
            .find("[ -n \"$pids\" ] || exit 0")
            .expect("an early exit");

        assert!(
            empty < script.find("kill -TERM").expect("a TERM"),
            "{script}"
        );
    }

    #[test]
    fn kill_command_waits_thirty_polls_of_a_tenth_of_a_second() {
        assert_eq!(REAP_EXIT_WAIT_TENTHS, 30);
    }

    #[test]
    fn the_reap_deadline_outlasts_the_scripts_own_wait() {
        let wait = Duration::from_millis(u64::from(REAP_EXIT_WAIT_TENTHS) * 100);

        assert_eq!(REAP_DEADLINE, wait + Duration::from_secs(5));
    }

    #[test]
    fn reap_instance_runs_the_reap_in_the_given_container() {
        let (runtime, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();

        reap_instance(&runtime, "proj_claude", "abc-123").expect("the reap exec succeeds");

        let calls = handles.exec_calls.lock().expect("exec calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].container, "proj_claude");
        assert_eq!(calls[0].argv, kill_by_instance_command("abc-123"));
    }

    #[test]
    fn reap_instance_stops_waiting_for_an_exec_at_its_deadline() {
        let (runtime, _handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_exec_piped_hang(30)
            .build();
        let start = std::time::Instant::now();

        let err = reap_instance_within(
            &runtime,
            "proj_claude",
            "abc-123",
            Duration::from_millis(200),
        )
        .expect_err("a stalled exec must not block the caller");

        assert!(err.to_string().contains("timed out"), "{err}");
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn reap_instance_reports_an_exec_that_fails() {
        let (runtime, _handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .push_exec_piped_failure("container is not running")
            .build();

        let err = reap_instance(&runtime, "proj_claude", "abc-123")
            .expect_err("a failed exec is reported");

        assert!(err.to_string().contains("proj_claude"), "{err}");
    }

    #[test]
    fn reap_instance_reports_an_exec_it_cannot_start() {
        let (runtime, _handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_exec_piped_error("no runtime")
            .build();

        let err = reap_instance(&runtime, "proj_claude", "abc-123")
            .expect_err("an exec that cannot be built is reported");

        assert!(err.to_string().contains("no runtime"), "{err}");
    }

    #[test]
    fn an_instance_whose_reap_timed_out_is_reaped_again_before_the_next_start() {
        let container = "unconfirmed-timeout_claude";
        let (runtime, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .with_exec_piped_hang(30)
            .build();
        reap_instance_recorded(&runtime, container, "leaked", Duration::from_millis(200))
            .expect_err("the stalled reap times out");

        reap_unconfirmed_within(&runtime, container, Duration::from_millis(200))
            .expect("the second reap confirms the instance gone");
        reap_unconfirmed_within(&runtime, container, Duration::from_millis(200))
            .expect("nothing is left to reap");

        let calls = handles.exec_calls.lock().expect("exec calls");
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert_eq!(calls[1].argv, kill_by_instance_command("leaked"));
    }

    #[test]
    fn a_start_is_refused_while_an_earlier_instance_survives_its_reap() {
        let container = "unconfirmed-survivor_claude";
        let (runtime, _handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .push_exec_piped_failure("container is not responding")
            .push_exec_piped_failure("container is not responding")
            .build();
        reap_instance_recorded(&runtime, container, "leaked", Duration::from_secs(5))
            .expect_err("the first reap fails");

        let err = reap_unconfirmed_within(&runtime, container, Duration::from_secs(5))
            .expect_err("the instance is still not confirmed gone");

        assert!(err.to_string().contains("could not be stopped"), "{err}");
        reap_unconfirmed_within(&runtime, container, Duration::from_secs(5))
            .expect("a later reap that succeeds lets the start through");
    }

    #[test]
    fn an_unconfirmed_instance_blocks_only_its_own_container() {
        let (failing, _) = crate::runtime::mock_runtime::MockRuntimeBuilder::new()
            .push_exec_piped_failure("container is not responding")
            .build();
        reap_instance_recorded(
            &failing,
            "unconfirmed-one_claude",
            "leaked",
            Duration::from_secs(5),
        )
        .expect_err("the reap fails");
        let (runtime, handles) = crate::runtime::mock_runtime::MockRuntimeBuilder::new().build();

        reap_unconfirmed_within(&runtime, "unconfirmed-other_claude", Duration::from_secs(5))
            .expect("another container has nothing to reap");

        assert!(handles.exec_calls.lock().expect("exec calls").is_empty());
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

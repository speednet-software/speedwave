//! Guest-side relay for WSL2 mirrored networking: a host bridge binds loopback and a
//! `socat` unit forwards its `mirror_relay_port` to it. No-op off Windows/mirrored. ADR-079.

/// Ensures a guest-side relay for a host listener bound on `bind_port`, asynchronously
/// (fire-and-forget thread — safe from the UI thread). Best-effort: failures are logged.
pub fn ensure_relay_for_port(bind_port: u16) {
    #[cfg(all(target_os = "windows", not(test)))]
    {
        // Coalesce to one in-flight ensure per port: watchdogs re-tick every ~30 s and a
        // wedged wsl.exe must not stack unbounded threads behind the ops lock.
        if !ensure_inflight().insert(bind_port) {
            return;
        }
        // Clears the in-flight mark on every exit path, including a panic.
        struct Clear(u16);
        impl Drop for Clear {
            fn drop(&mut self) {
                ensure_inflight().remove(&self.0);
            }
        }
        let spawned = std::thread::Builder::new()
            .name(format!("mirror-relay-ensure-{bind_port}"))
            .spawn(move || {
                let _clear = Clear(bind_port);
                ensure_relay_blocking(bind_port);
            });
        if let Err(e) = spawned {
            ensure_inflight().remove(&bind_port);
            log::warn!("spawning relay ensure thread for bind {bind_port} failed: {e}");
        }
    }
    #[cfg(any(not(target_os = "windows"), test))]
    let _ = bind_port;
}

/// Tears down the relay for a listener bound on `bind_port` (bounded, synchronous).
/// Runs on Windows regardless of the detected addressing mode (a mode flip or detection
/// failure must never orphan a unit) — but skips when the distro is not running, since
/// transient units die with it and probing must not boot a stopped distro.
pub fn remove_relay_for_port(bind_port: u16) {
    #[cfg(all(target_os = "windows", not(test)))]
    {
        if !distro_is_running() {
            return;
        }
        let _ops = relay_ops_lock();
        if let Err(e) = run_in_distro_root(&relay_teardown_script(bind_port)) {
            log::warn!("relay teardown for bind {bind_port} failed: {e}");
        }
    }
    #[cfg(any(not(target_os = "windows"), test))]
    let _ = bind_port;
}

/// Async [`remove_relay_for_port`] for watchdog/respawn paths — teardown can block for
/// tens of seconds and must not stall ticks or held locks. Exit paths stay synchronous.
pub fn remove_relay_for_port_async(bind_port: u16) {
    #[cfg(all(target_os = "windows", not(test)))]
    {
        if let Err(e) = std::thread::Builder::new()
            .name(format!("mirror-relay-remove-{bind_port}"))
            .spawn(move || remove_relay_for_port(bind_port))
        {
            log::warn!("spawning relay remove thread for bind {bind_port} failed: {e}");
        }
    }
    #[cfg(any(not(target_os = "windows"), test))]
    let _ = bind_port;
}

/// Ports with an in-flight ensure (see `ensure_relay_for_port` coalescing).
#[cfg(all(target_os = "windows", not(test)))]
fn ensure_inflight() -> std::sync::MutexGuard<'static, std::collections::BTreeSet<u16>> {
    static ENSURE_INFLIGHT: std::sync::Mutex<std::collections::BTreeSet<u16>> =
        std::sync::Mutex::new(std::collections::BTreeSet::new());
    ENSURE_INFLIGHT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Serializes all relay unit operations (sweep/create/teardown race otherwise).
#[cfg(all(target_os = "windows", not(test)))]
fn relay_ops_lock() -> std::sync::MutexGuard<'static, ()> {
    static RELAY_OPS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    RELAY_OPS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Ports whose last ensure failed — so a crash-looping `socat` warns once per streak
/// (poll loops log on state change only), not every 30 s watchdog tick.
#[cfg(all(target_os = "windows", not(test)))]
static FAILED_RELAY_PORTS: std::sync::Mutex<std::collections::BTreeSet<u16>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

#[cfg(all(target_os = "windows", not(test)))]
fn ensure_relay_blocking(bind_port: u16) {
    let Some(relay_port) = speedwave_runtime::compose::mirror_relay_port(bind_port) else {
        return;
    };
    sweep_orphan_relay_units_once();
    // socat upstream = the bridge's bind address (127.0.0.1 under mirrored), from the
    // addressing SSOT rather than hardcoded, so the two can never diverge (ADR-079).
    let upstream = match speedwave_runtime::compose::host_bind_address() {
        Ok(addr) => addr,
        Err(e) => {
            // mirror_relay_port just resolved, so this is a poison/race edge — surface it.
            log::warn!("relay ensure for bind {bind_port}: host_bind_address unavailable ({e}); assuming 127.0.0.1");
            "127.0.0.1".to_string()
        }
    };
    let gateway = speedwave_runtime::consts::MIRROR_RELAY_GATEWAY_IP;
    let script = relay_setup_script(
        RelayRoute {
            relay_port,
            bind_port,
        },
        gateway,
        &upstream,
    );
    let _ops = relay_ops_lock();
    let outcome = run_in_distro_root(&script);
    let mut failed = FAILED_RELAY_PORTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match outcome.map(|out| classify_relay_output(&out)) {
        Ok(RelayOutcome::Created) => {
            failed.remove(&bind_port);
            log::info!("relay up: {gateway}:{relay_port} -> {upstream}:{bind_port}");
        }
        Ok(RelayOutcome::Failed) => {
            if failed.insert(bind_port) {
                log::warn!(
                    "relay unit started but socat is not active for \
                     {gateway}:{relay_port} -> {upstream}:{bind_port} (port collision?)"
                );
            }
        }
        Ok(RelayOutcome::AlreadyActive) => {
            failed.remove(&bind_port);
            log::debug!("relay for bind {bind_port} already active");
        }
        Err(e) => {
            if failed.insert(bind_port) {
                log::warn!("relay ensure for bind {bind_port} failed: {e}");
            }
        }
    }
}

/// One-time stop of every `spw-mirror-relay-*` unit before the first create: a Desktop
/// crash leaves `Restart=on-failure` units forwarding to freed loopback ports (ADR-079).
#[cfg(all(target_os = "windows", not(test)))]
fn sweep_orphan_relay_units_once() {
    static SWEEP: std::sync::Once = std::sync::Once::new();
    SWEEP.call_once(|| {
        let _ops = relay_ops_lock();
        match run_in_distro_root(&relay_sweep_script()) {
            Ok(_) => log::info!("swept orphaned relay units"),
            Err(e) => log::warn!("orphan relay-unit sweep failed: {e}"),
        }
    });
}

/// True when the Speedwave distro is currently running. `--list --running` reports
/// without booting anything (a `-d <distro>` exec would start a stopped distro).
/// Negative results are cached briefly: exit paths tear down one relay per port, and a
/// wedged/stopped WSL must cost one probe stall, not one per port.
#[cfg(all(target_os = "windows", not(test)))]
fn distro_is_running() -> bool {
    const NEGATIVE_TTL: std::time::Duration = std::time::Duration::from_secs(10);
    static NEGATIVE_UNTIL: std::sync::Mutex<Option<std::time::Instant>> =
        std::sync::Mutex::new(None);
    let mut negative_until = NEGATIVE_UNTIL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(until) = *negative_until {
        if std::time::Instant::now() < until {
            return false;
        }
    }
    let running = match speedwave_runtime::binary::run_wsl_bounded(
        &["--list", "--running", "--quiet"],
        None,
        std::time::Duration::from_secs(15),
    ) {
        Ok(out) if out.status.success() => running_list_names_distro(
            &speedwave_runtime::runtime::decode_wsl_output(&out.stdout),
            speedwave_runtime::consts::wsl_distro_name(),
        ),
        Ok(_) => false,
        Err(e) => {
            log::warn!("wsl.exe --list --running failed: {e}");
            false
        }
    };
    *negative_until = (!running).then(|| std::time::Instant::now() + NEGATIVE_TTL);
    running
}

/// True when a decoded `wsl --list --running --quiet` output names `distro`.
#[cfg(any(all(target_os = "windows", not(test)), test))]
fn running_list_names_distro(decoded: &str, distro: &str) -> bool {
    decoded
        .lines()
        .any(|l| l.trim().trim_matches('\0') == distro)
}

/// Runs `script` as root in the distro via stdin `bash -s` — bare `bash -lc <script>`
/// splicing breaks on wsl.exe's default-shell reparse of the post-`--` line (ADR-079).
#[cfg(all(target_os = "windows", not(test)))]
fn run_in_distro_root(script: &str) -> anyhow::Result<String> {
    let out = speedwave_runtime::binary::run_wsl_bounded(
        &[
            "-d",
            speedwave_runtime::consts::wsl_distro_name(),
            "-u",
            "root",
            "--",
            "bash",
            "-s",
        ],
        Some(script),
        std::time::Duration::from_secs(30),
    )?;
    if !out.status.success() {
        anyhow::bail!(
            "wsl.exe relay command exited with {}: {}",
            out.status,
            speedwave_runtime::runtime::decode_wsl_output(&out.stderr).trim()
        );
    }
    Ok(speedwave_runtime::runtime::decode_wsl_output(&out.stdout))
}

/// The one place the relay unit-name scheme is encoded — `relay_unit_name` and the
/// sweep glob both derive from it, so setup/teardown/sweep can never diverge.
#[cfg(any(all(target_os = "windows", not(test)), test))]
const RELAY_UNIT_PREFIX: &str = "spw-mirror-relay-";

/// Printed by the setup script only when it started the unit AND saw socat active.
#[cfg(any(all(target_os = "windows", not(test)), test))]
const RELAY_CREATED_MARKER: &str = "SPW_RELAY_CREATED";

/// Printed by the setup script when the unit started but socat never went active.
#[cfg(any(all(target_os = "windows", not(test)), test))]
const RELAY_FAILED_MARKER: &str = "SPW_RELAY_FAILED";

/// What one setup-script run reported (see the marker consts).
#[cfg(any(all(target_os = "windows", not(test)), test))]
#[derive(Debug, PartialEq, Eq)]
enum RelayOutcome {
    Created,
    Failed,
    AlreadyActive,
}

/// Maps setup-script stdout to its outcome; no marker means the early
/// `is-active && exit 0` path fired (relay already up).
#[cfg(any(all(target_os = "windows", not(test)), test))]
fn classify_relay_output(stdout: &str) -> RelayOutcome {
    if stdout.contains(RELAY_CREATED_MARKER) {
        RelayOutcome::Created
    } else if stdout.contains(RELAY_FAILED_MARKER) {
        RelayOutcome::Failed
    } else {
        RelayOutcome::AlreadyActive
    }
}

/// Transient systemd unit name for a relay serving `bind_port`.
#[cfg(any(all(target_os = "windows", not(test)), test))]
fn relay_unit_name(bind_port: u16) -> String {
    format!("{RELAY_UNIT_PREFIX}{bind_port}")
}

/// Stops every relay unit (orphan sweep); `--all` also catches `failed` crash-looped
/// units so their `Restart=on-failure` cycle ends.
#[cfg(any(all(target_os = "windows", not(test)), test))]
fn relay_sweep_script() -> String {
    format!(
        "systemctl list-units --plain --no-legend --all \
         '{RELAY_UNIT_PREFIX}*' | awk '{{print $1}}' | while IFS= read -r u; do \
         systemctl stop \"$u\" 2>/dev/null; systemctl reset-failed \"$u\" 2>/dev/null; done; true"
    )
}

/// Bind→relay port pair for one relay; named fields prevent transposing the two
/// same-typed ports (a swap would forward the wrong direction and still type-check).
#[cfg(any(all(target_os = "windows", not(test)), test))]
struct RelayRoute {
    /// Guest-side port socat listens on (`mirror_relay_port(bind_port)`).
    relay_port: u16,
    /// Host-side port the bridge bound; socat's forward target.
    bind_port: u16,
}

/// Adds the relay address to `lo` and starts `socat` as a transient systemd unit; prints
/// [`RELAY_CREATED_MARKER`] once verified active, [`RELAY_FAILED_MARKER`] when socat
/// cannot hold the port.
#[cfg(any(all(target_os = "windows", not(test)), test))]
fn relay_setup_script(route: RelayRoute, gateway_ip: &str, upstream: &str) -> String {
    let unit = relay_unit_name(route.bind_port);
    format!(
        "ip addr add {gw}/32 dev lo 2>/dev/null; \
         systemctl reset-failed '{unit}' 2>/dev/null; \
         systemctl is-active --quiet '{unit}' && exit 0; \
         systemd-run --quiet --unit='{unit}' \
         --property=Restart=on-failure --property=RestartSec=1 \
         socat TCP-LISTEN:{relay},bind={gw},fork,reuseaddr TCP:{upstream}:{bind} \
         || {{ echo {failed}; exit 0; }}; \
         for i in 1 2 3 4 5; do \
         systemctl is-active --quiet '{unit}' && {{ echo {created}; exit 0; }}; \
         sleep 0.2; done; \
         echo {failed}",
        gw = gateway_ip,
        relay = route.relay_port,
        bind = route.bind_port,
        created = RELAY_CREATED_MARKER,
        failed = RELAY_FAILED_MARKER
    )
}

#[cfg(any(all(target_os = "windows", not(test)), test))]
fn relay_teardown_script(bind_port: u16) -> String {
    let unit = relay_unit_name(bind_port);
    format!(
        "systemctl stop '{unit}' 2>/dev/null; systemctl reset-failed '{unit}' 2>/dev/null; true"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        classify_relay_output, relay_setup_script, relay_sweep_script, relay_teardown_script,
        running_list_names_distro, RelayOutcome, RelayRoute, RELAY_CREATED_MARKER,
        RELAY_FAILED_MARKER, RELAY_UNIT_PREFIX,
    };

    fn sample_route() -> RelayRoute {
        // 60123 ^ 0x4000 = 43739 (the deterministic relay port).
        RelayRoute {
            relay_port: 43739,
            bind_port: 60123,
        }
    }

    #[test]
    fn setup_script_listens_on_relay_port_forwards_to_bind_port() {
        let s = relay_setup_script(sample_route(), "10.200.0.1", "127.0.0.1");
        assert!(s.contains("ip addr add 10.200.0.1/32 dev lo"));
        assert!(
            s.contains("socat TCP-LISTEN:43739,bind=10.200.0.1,fork,reuseaddr TCP:127.0.0.1:60123")
        );
        assert!(s.contains("systemd-run"));
        // Unit keyed by the stable bind port; idempotent + self-healing.
        assert!(s.contains("--unit='spw-mirror-relay-60123'"));
        assert!(s.contains("is-active --quiet 'spw-mirror-relay-60123'"));
        assert!(s.contains("Restart=on-failure"));
    }

    #[test]
    fn setup_script_verifies_socat_active_before_claiming_success() {
        // systemd-run returns 0 at unit START; a socat that cannot bind (port collision)
        // crash-loops — success must be claimed only after an is-active poll.
        let s = relay_setup_script(sample_route(), "10.200.0.1", "127.0.0.1");
        let created = s
            .find(RELAY_CREATED_MARKER)
            .expect("CREATED marker present");
        let poll = s
            .find("for i in 1 2 3 4 5")
            .expect("is-active poll present");
        assert!(
            poll < created,
            "CREATED must be printed inside the poll, after systemd-run"
        );
        assert!(s.contains(RELAY_FAILED_MARKER), "failure marker present");
        assert!(
            s.ends_with(&format!("echo {RELAY_FAILED_MARKER}")),
            "poll exhaustion must report failure"
        );
    }

    #[test]
    fn classify_relay_output_maps_markers_to_outcomes() {
        assert_eq!(
            classify_relay_output("noise\nSPW_RELAY_CREATED\n"),
            RelayOutcome::Created
        );
        assert_eq!(
            classify_relay_output("SPW_RELAY_FAILED\n"),
            RelayOutcome::Failed
        );
        assert_eq!(classify_relay_output(""), RelayOutcome::AlreadyActive);
        assert_eq!(
            classify_relay_output("unit already up, no marker"),
            RelayOutcome::AlreadyActive
        );
    }

    #[test]
    fn classify_relay_output_markers_match_setup_script() {
        // The classifier and the script share the marker consts; this pins that the
        // script actually emits them (a one-sided edit cannot silently misclassify).
        let s = relay_setup_script(sample_route(), "10.200.0.1", "127.0.0.1");
        assert!(s.contains(RELAY_CREATED_MARKER));
        assert!(s.contains(RELAY_FAILED_MARKER));
    }

    #[test]
    fn teardown_script_targets_unit_by_bind_port() {
        let s = relay_teardown_script(60123);
        assert!(s.contains("systemctl stop 'spw-mirror-relay-60123'"));
        assert!(!s.contains("socat"));
    }

    #[test]
    fn sweep_script_stops_all_relay_units_and_only_relay_units() {
        let s = relay_sweep_script();
        // The glob derives from RELAY_UNIT_PREFIX — same namespace the setup script
        // creates units in, so a prefix rename can never strand the sweep.
        assert!(s.contains(&format!("'{RELAY_UNIT_PREFIX}*'")));
        assert!(s.contains("--all"), "must catch failed units");
        assert!(s.contains("systemctl stop"));
        assert!(s.contains("reset-failed"));
        assert!(
            !s.contains("systemctl stop socat"),
            "must never stop units outside the spw-mirror-relay-* namespace"
        );
    }

    #[test]
    fn running_list_matcher_handles_trim_and_nul_padding() {
        assert!(running_list_names_distro("Speedwave\n", "Speedwave"));
        assert!(running_list_names_distro(
            "Ubuntu\n  Speedwave\u{0}\u{0}\n",
            "Speedwave"
        ));
        assert!(!running_list_names_distro("Ubuntu\n", "Speedwave"));
        assert!(!running_list_names_distro("", "Speedwave"));
        assert!(!running_list_names_distro("Speedwave-old\n", "Speedwave"));
    }
}

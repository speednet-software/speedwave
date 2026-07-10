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
/// Unconditional on Windows: a mode flip or detection failure must never orphan a unit.
pub fn remove_relay_for_port(bind_port: u16) {
    #[cfg(all(target_os = "windows", not(test)))]
    {
        // Transient systemd units die with the distro — nothing to tear down, and the
        // probe (`--list --running`) never boots a stopped distro on app exit.
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
    let upstream =
        speedwave_runtime::compose::host_bind_address().unwrap_or_else(|_| "127.0.0.1".to_string());
    let gateway = speedwave_runtime::consts::MIRROR_RELAY_GATEWAY_IP;
    let script = relay_setup_script(relay_port, bind_port, gateway, &upstream);
    let _ops = relay_ops_lock();
    let outcome = run_in_distro_root(&script);
    let mut failed = FAILED_RELAY_PORTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match outcome {
        // The script prints CREATED only when it actually started the unit AND saw it
        // active — an already-up relay polled every 30 s stays quiet.
        Ok(out) if out.contains("SPW_RELAY_CREATED") => {
            failed.remove(&bind_port);
            log::info!("relay up: {gateway}:{relay_port} -> {upstream}:{bind_port}");
        }
        Ok(out) if out.contains("SPW_RELAY_FAILED") => {
            if failed.insert(bind_port) {
                log::warn!(
                    "relay unit started but socat is not active for \
                     {gateway}:{relay_port} -> {upstream}:{bind_port} (port collision?)"
                );
            }
        }
        Ok(_) => {
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
        match run_in_distro_root(RELAY_SWEEP_SCRIPT) {
            Ok(_) => log::info!("swept orphaned relay units"),
            Err(e) => log::warn!("orphan relay-unit sweep failed: {e}"),
        }
    });
}

/// True when the Speedwave distro is currently running. `--list --running` reports
/// without booting anything (a `-d <distro>` exec would start a stopped distro).
#[cfg(all(target_os = "windows", not(test)))]
fn distro_is_running() -> bool {
    let child = speedwave_runtime::binary::system_command("wsl.exe")
        .args(["--list", "--running", "--quiet"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let child = match child {
        Ok(c) => c,
        Err(e) => {
            log::warn!("wsl.exe --list --running spawn failed: {e}");
            return false;
        }
    };
    match speedwave_runtime::binary::wait_with_output_timeout(
        child,
        std::time::Duration::from_secs(15),
    ) {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .any(|l| l.trim().trim_matches('\0') == speedwave_runtime::consts::wsl_distro_name()),
        Ok(_) => false,
        Err(e) => {
            log::warn!("wsl.exe --list --running failed: {e}");
            false
        }
    }
}

#[cfg(all(target_os = "windows", not(test)))]
fn run_in_distro_root(script: &str) -> anyhow::Result<String> {
    let child = speedwave_runtime::binary::system_command("wsl.exe")
        .args([
            "-d",
            speedwave_runtime::consts::wsl_distro_name(),
            "-u",
            "root",
            "--",
            "bash",
            "-lc",
            script,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    // Bounded — a wedged wsl.exe must not pin a thread forever (ADR-079).
    let out = speedwave_runtime::binary::wait_with_output_timeout(
        child,
        std::time::Duration::from_secs(30),
    )?;
    if !out.status.success() {
        anyhow::bail!(
            "wsl.exe relay command exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Transient systemd unit name for a relay serving `bind_port` — the one place the
/// scheme is encoded, so setup and teardown can never target divergent names.
#[cfg(any(all(target_os = "windows", not(test)), test))]
fn relay_unit_name(bind_port: u16) -> String {
    format!("spw-mirror-relay-{bind_port}")
}

/// Stops every `spw-mirror-relay-*` unit (orphan sweep); `--all` also catches `failed`
/// crash-looped units so their `Restart=on-failure` cycle ends.
#[cfg(any(all(target_os = "windows", not(test)), test))]
const RELAY_SWEEP_SCRIPT: &str = "systemctl list-units --plain --no-legend --all \
     'spw-mirror-relay-*' | awk '{print $1}' | while IFS= read -r u; do \
     systemctl stop \"$u\" 2>/dev/null; systemctl reset-failed \"$u\" 2>/dev/null; done; true";

/// Adds the relay address to `lo` and starts `socat` as a transient systemd unit; prints
/// `SPW_RELAY_CREATED` once verified active, `SPW_RELAY_FAILED` when socat cannot hold the port.
#[cfg(any(all(target_os = "windows", not(test)), test))]
fn relay_setup_script(relay_port: u16, bind_port: u16, gateway_ip: &str, upstream: &str) -> String {
    let unit = relay_unit_name(bind_port);
    format!(
        "ip addr add {gw}/32 dev lo 2>/dev/null; \
         systemctl reset-failed '{unit}' 2>/dev/null; \
         systemctl is-active --quiet '{unit}' && exit 0; \
         systemd-run --quiet --unit='{unit}' \
         --property=Restart=on-failure --property=RestartSec=1 \
         socat TCP-LISTEN:{relay_port},bind={gw},fork,reuseaddr TCP:{upstream}:{bind_port} \
         || {{ echo SPW_RELAY_FAILED; exit 0; }}; \
         for i in 1 2 3 4 5; do \
         systemctl is-active --quiet '{unit}' && {{ echo SPW_RELAY_CREATED; exit 0; }}; \
         sleep 0.2; done; \
         echo SPW_RELAY_FAILED",
        gw = gateway_ip
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
    use super::{relay_setup_script, relay_teardown_script, RELAY_SWEEP_SCRIPT};

    #[test]
    fn setup_script_listens_on_relay_port_forwards_to_bind_port() {
        // 60123 ^ 0x4000 = 43739 (the deterministic relay port).
        let s = relay_setup_script(43739, 60123, "10.200.0.1", "127.0.0.1");
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
        let s = relay_setup_script(43739, 60123, "10.200.0.1", "127.0.0.1");
        let created = s.find("SPW_RELAY_CREATED").expect("CREATED marker present");
        let poll = s
            .find("for i in 1 2 3 4 5")
            .expect("is-active poll present");
        assert!(
            poll < created,
            "CREATED must be printed inside the poll, after systemd-run"
        );
        assert!(s.contains("SPW_RELAY_FAILED"), "failure marker present");
        assert!(
            s.ends_with("echo SPW_RELAY_FAILED"),
            "poll exhaustion must report failure"
        );
    }

    #[test]
    fn teardown_script_targets_unit_by_bind_port() {
        let s = relay_teardown_script(60123);
        assert!(s.contains("systemctl stop 'spw-mirror-relay-60123'"));
        assert!(!s.contains("socat"));
    }

    #[test]
    fn sweep_script_stops_all_relay_units_and_only_relay_units() {
        assert!(RELAY_SWEEP_SCRIPT.contains("'spw-mirror-relay-*'"));
        assert!(
            RELAY_SWEEP_SCRIPT.contains("--all"),
            "must catch failed units"
        );
        assert!(RELAY_SWEEP_SCRIPT.contains("systemctl stop"));
        assert!(RELAY_SWEEP_SCRIPT.contains("reset-failed"));
        assert!(
            !RELAY_SWEEP_SCRIPT.contains("systemctl stop socat"),
            "must never stop units outside the spw-mirror-relay-* namespace"
        );
    }
}

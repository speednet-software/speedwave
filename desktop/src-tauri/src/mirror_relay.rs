//! Guest-side relay for WSL2 mirrored networking: a host bridge binds loopback and a
//! `socat` unit forwards its `mirror_relay_port` to it. No-op off Windows/mirrored. ADR-079.

/// Ensures a guest-side relay for a host bridge bound on `bind_port`. No-op unless the
/// active host addressing is WSL2 mirrored mode. Best-effort: failures are logged.
pub fn ensure_relay_for_port(bind_port: u16) {
    #[cfg(target_os = "windows")]
    {
        let Some(relay_port) = speedwave_runtime::compose::mirror_relay_port(bind_port) else {
            return;
        };
        // socat upstream = the bridge's bind address (127.0.0.1 under mirrored), from the
        // addressing SSOT rather than hardcoded, so the two can never diverge (ADR-079).
        let upstream = speedwave_runtime::compose::host_bind_address()
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        let script = relay_setup_script(
            relay_port,
            bind_port,
            speedwave_runtime::consts::MIRROR_RELAY_GATEWAY_IP,
            &upstream,
        );
        match run_in_distro_root(&script) {
            // Log only when the unit was actually (re)started — the script prints the
            // marker only on that path — so a 30s poll of an already-up relay stays quiet.
            Ok(out) if out.contains("SPW_RELAY_CREATED") => log::info!(
                "mirror relay: {}:{relay_port} -> 127.0.0.1:{bind_port}",
                speedwave_runtime::consts::MIRROR_RELAY_GATEWAY_IP
            ),
            Ok(_) => log::debug!("mirror relay: bind {bind_port} already active"),
            Err(e) => log::warn!("mirror relay: ensure for bind {bind_port} failed: {e}"),
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = bind_port;
}

/// Tears down the relay for a bridge bound on `bind_port`. No-op off Windows/mirrored.
pub fn remove_relay_for_port(bind_port: u16) {
    #[cfg(target_os = "windows")]
    {
        if speedwave_runtime::compose::mirror_relay_port(bind_port).is_none() {
            return;
        }
        if let Err(e) = run_in_distro_root(&relay_teardown_script(bind_port)) {
            log::warn!("mirror relay: teardown for bind {bind_port} failed: {e}");
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = bind_port;
}

#[cfg(target_os = "windows")]
fn run_in_distro_root(script: &str) -> anyhow::Result<String> {
    use std::io::Read;
    let mut child = speedwave_runtime::binary::system_command("wsl.exe")
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
    // Bounded (drain pipes on threads, kill on expiry): a wedged wsl.exe must not pin a
    // watchdog / spawn_blocking thread forever — unlike a plain `.output()` (ADR-079).
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = pipe {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(30);
    let status = loop {
        match child.try_wait()? {
            Some(s) => break s,
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!(
                    "wsl.exe relay command timed out after {}s",
                    timeout.as_secs()
                );
            }
            None => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    };
    let out = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned();
    if !status.success() {
        anyhow::bail!(
            "wsl.exe relay command exited with {}: {}",
            status,
            String::from_utf8_lossy(&stderr.join().unwrap_or_default()).trim()
        );
    }
    Ok(out)
}

/// Transient systemd unit name for a relay serving `bind_port` — the one place the
/// scheme is encoded, so setup and teardown can never target divergent names.
#[cfg(any(target_os = "windows", test))]
fn relay_unit_name(bind_port: u16) -> String {
    format!("spw-mirror-relay-{bind_port}")
}

/// Adds the relay address to `lo` and starts `socat` as a transient systemd unit; prints
/// `SPW_RELAY_CREATED` only when it starts one (not on the already-active short-circuit).
#[cfg(any(target_os = "windows", test))]
fn relay_setup_script(relay_port: u16, bind_port: u16, gateway_ip: &str, upstream: &str) -> String {
    let unit = relay_unit_name(bind_port);
    format!(
        "ip addr add {gw}/32 dev lo 2>/dev/null; \
         systemctl reset-failed '{unit}' 2>/dev/null; \
         systemctl is-active --quiet '{unit}' && exit 0; \
         systemd-run --quiet --unit='{unit}' \
         --property=Restart=on-failure --property=RestartSec=1 \
         socat TCP-LISTEN:{relay_port},bind={gw},fork,reuseaddr TCP:{upstream}:{bind_port} \
         && echo SPW_RELAY_CREATED",
        gw = gateway_ip
    )
}

#[cfg(any(target_os = "windows", test))]
fn relay_teardown_script(bind_port: u16) -> String {
    let unit = relay_unit_name(bind_port);
    format!(
        "systemctl stop '{unit}' 2>/dev/null; systemctl reset-failed '{unit}' 2>/dev/null; true"
    )
}

#[cfg(test)]
mod tests {
    use super::{relay_setup_script, relay_teardown_script};

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
        // State-change marker: printed only on the actually-created path.
        assert!(s.contains("&& echo SPW_RELAY_CREATED"));
    }

    #[test]
    fn teardown_script_targets_unit_by_bind_port() {
        let s = relay_teardown_script(60123);
        assert!(s.contains("systemctl stop 'spw-mirror-relay-60123'"));
        assert!(!s.contains("socat"));
    }
}

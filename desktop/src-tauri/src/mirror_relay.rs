//! Guest-side relay for WSL2 mirrored networking: a host bridge binds loopback and a
//! `socat` unit forwards its `mirror_relay_port` to it. No-op off Windows/mirrored. ADR-080.

use speedwave_runtime::host_mcp_process::{HostMcpProcess, WorkerSpec};

// ── Public relay operations (thin wrappers; the runtime lives in `imp`) ─────

/// Ensures a guest-side relay for a host listener bound on `bind_port`, asynchronously
/// (fire-and-forget thread — safe from the UI thread). Best-effort: failures are logged.
pub fn ensure_relay_for_port(bind_port: u16) {
    #[cfg(all(target_os = "windows", not(test)))]
    imp::ensure_relay_for_port(bind_port);
    #[cfg(test)]
    recorder::record(recorder::RelayOp::Ensure, bind_port);
    #[cfg(all(not(target_os = "windows"), not(test)))]
    let _ = bind_port;
}

/// Tears down the relay for `bind_port` (bounded, sync) regardless of detected mode (a
/// flip must never orphan a unit), skipping a stopped distro — transient units died with it.
pub fn remove_relay_for_port(bind_port: u16) {
    #[cfg(all(target_os = "windows", not(test)))]
    imp::remove_relay_for_port(bind_port);
    #[cfg(test)]
    recorder::record(recorder::RelayOp::Remove, bind_port);
    #[cfg(all(not(target_os = "windows"), not(test)))]
    let _ = bind_port;
}

/// Async [`remove_relay_for_port`] for watchdog/respawn paths — teardown can block for
/// tens of seconds and must not stall ticks or held locks. Exit paths stay synchronous.
pub fn remove_relay_for_port_async(bind_port: u16) {
    #[cfg(all(target_os = "windows", not(test)))]
    imp::remove_relay_for_port_async(bind_port);
    #[cfg(test)]
    recorder::record(recorder::RelayOp::RemoveAsync, bind_port);
    #[cfg(all(not(target_os = "windows"), not(test)))]
    let _ = bind_port;
}

// ── RelayedWorker: the relay lifecycle rides the worker lifecycle ────────────

/// Inner-worker surface the relay lifecycle rides on; `HostMcpProcess<S>` in
/// production, a fake in tests.
pub(crate) trait RelayWorkerInner {
    fn port(&self) -> u16;
    fn is_alive(&self) -> bool;
    fn stop(&mut self) -> anyhow::Result<()>;
    fn cleanup_files(&self);
    fn respawn(&mut self) -> anyhow::Result<u16>;
}

impl<S: WorkerSpec + Clone> RelayWorkerInner for HostMcpProcess<S> {
    fn port(&self) -> u16 {
        HostMcpProcess::port(self)
    }
    fn is_alive(&self) -> bool {
        HostMcpProcess::is_alive(self)
    }
    fn stop(&mut self) -> anyhow::Result<()> {
        HostMcpProcess::stop(self)
    }
    fn cleanup_files(&self) {
        HostMcpProcess::cleanup_files(self)
    }
    fn respawn(&mut self) -> anyhow::Result<u16> {
        HostMcpProcess::respawn(self)
    }
}

/// Host worker whose ADR-080 relay lifecycle rides its own lifecycle: ensure on spawn,
/// re-ensure on live probes, swap on respawn, teardown on stop (the HostBridge model).
pub(crate) struct RelayedWorker<I: RelayWorkerInner> {
    inner: I,
}

impl<I: RelayWorkerInner> RelayedWorker<I> {
    /// Wraps a freshly spawned worker, ensuring its guest relay.
    pub(crate) fn new(inner: I) -> Self {
        ensure_relay_for_port(inner.port());
        Self { inner }
    }

    /// Port the worker is listening on.
    pub(crate) fn port(&self) -> u16 {
        self.inner.port()
    }

    /// The wrapped worker (spec access etc.).
    pub(crate) fn inner(&self) -> &I {
        &self.inner
    }

    /// Re-ensures this worker's guest relay (idempotent, fire-and-forget).
    pub(crate) fn ensure_relay(&self) {
        ensure_relay_for_port(self.inner.port());
    }

    /// Liveness probe; a live worker also re-ensures its relay — a WSL distro
    /// restart wipes it while the host process survives (ADR-080).
    pub(crate) fn is_alive(&self) -> bool {
        let alive = self.inner.is_alive();
        if alive {
            self.ensure_relay();
        }
        alive
    }

    /// Stops the worker and tears its relay down synchronously — exit/teardown
    /// paths, where a fire-and-forget thread would not outlive the process.
    pub(crate) fn stop(&mut self) -> anyhow::Result<()> {
        let result = self.inner.stop();
        remove_relay_for_port(self.inner.port());
        result
    }

    /// Removes `lock.json` + spec extras (delegates to the wrapped worker).
    pub(crate) fn cleanup_files(&self) {
        self.inner.cleanup_files();
    }

    /// Stop + cleanup, deferring the relay decision to the returned guard — a
    /// replacement reusing the port adopts the relay instead of racing it.
    pub(crate) fn stop_for_replacement(mut self, label: &str) -> RetiredRelay {
        let port = self.inner.port();
        if let Err(e) = self.inner.stop() {
            log::warn!("{label} stop error: {e}");
        }
        self.inner.cleanup_files();
        RetiredRelay { port: Some(port) }
    }

    /// Respawns the worker, swapping the relay: the old one is dropped only when the
    /// port changed (an ephemeral-port reuse keeps it), the new one is always ensured.
    pub(crate) fn respawn(&mut self) -> anyhow::Result<u16> {
        let old_port = self.inner.port();
        let new_port = self.inner.respawn()?;
        if old_port != new_port {
            remove_relay_for_port_async(old_port);
        }
        ensure_relay_for_port(new_port);
        Ok(new_port)
    }
}

/// Relay of a worker stopped for replacement: dropping it tears the relay down (async)
/// unless the replacement adopted the same port via [`RetiredRelay::adopt_port`].
pub(crate) struct RetiredRelay {
    port: Option<u16>,
}

impl RetiredRelay {
    /// Keeps the relay when the replacement reuses the retired worker's port —
    /// tearing it down then would race the fresh ensure (ADR-080).
    pub(crate) fn adopt_port(&mut self, new_port: u16) {
        if self.port == Some(new_port) {
            self.port = None;
        }
    }
}

impl Drop for RetiredRelay {
    fn drop(&mut self) {
        if let Some(port) = self.port.take() {
            remove_relay_for_port_async(port);
        }
    }
}

// ── Test-only relay-op recorder ──────────────────────────────────────────────

/// Records every relay op under `cfg(test)` so lifecycle tests (wrapper, HostBridge)
/// can assert the exact ensure/remove sequence; keyed by port to stay parallel-safe.
#[cfg(test)]
pub(crate) mod recorder {
    use std::sync::Mutex;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum RelayOp {
        Ensure,
        Remove,
        RemoveAsync,
    }

    static CALLS: Mutex<Vec<(RelayOp, u16)>> = Mutex::new(Vec::new());

    pub(super) fn record(op: RelayOp, port: u16) {
        CALLS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((op, port));
    }

    /// Ops recorded for `port`, in call order.
    pub(crate) fn calls_for_port(port: u16) -> Vec<RelayOp> {
        CALLS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(_, p)| *p == port)
            .map(|(op, _)| *op)
            .collect()
    }
}

// ── Windows-only runtime ─────────────────────────────────────────────────────

/// Thread orchestration + `wsl.exe` execution. Everything decision-shaped lives
/// in [`logic`] so tests cover it on every platform.
#[cfg(all(target_os = "windows", not(test)))]
mod imp {
    use super::logic;
    use std::time::Duration;

    static ENSURE_INFLIGHT: logic::InflightSet = logic::InflightSet::new();
    static FAILED_RELAY_PORTS: logic::FailureStreaks = logic::FailureStreaks::new();
    static PORT_GENERATIONS: logic::PortGenerations = logic::PortGenerations::new();
    /// Negatives cached ~10 s so a stopped/wedged WSL costs one probe, not one per port.
    static DISTRO_NEGATIVE_CACHE: logic::NegativeCache =
        logic::NegativeCache::new(Duration::from_secs(10));

    /// Serializes all relay unit operations (sweep/create/teardown race otherwise).
    fn relay_ops_lock() -> std::sync::MutexGuard<'static, ()> {
        static RELAY_OPS: std::sync::Mutex<()> = std::sync::Mutex::new(());
        RELAY_OPS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn ensure_relay_for_port(bind_port: u16) {
        // Coalesce to one in-flight ensure per port: watchdogs re-tick every ~30 s and a
        // wedged wsl.exe must not stack unbounded threads behind the ops lock.
        let Some(inflight) = ENSURE_INFLIGHT.begin(bind_port) else {
            return;
        };
        let queued_generation = PORT_GENERATIONS.snapshot(bind_port);
        // The guard clears the in-flight mark on every exit path: a failed spawn drops
        // the un-run closure (and the captured guard), a panic unwinds through it.
        if let Err(e) = std::thread::Builder::new()
            .name(format!("mirror-relay-ensure-{bind_port}"))
            .spawn(move || {
                let _inflight = inflight;
                ensure_relay_blocking(bind_port, queued_generation);
            })
        {
            log::warn!("spawning relay ensure thread for bind {bind_port} failed: {e}");
        }
    }

    fn ensure_relay_blocking(bind_port: u16, queued_generation: u64) {
        let Some(relay_port) = speedwave_runtime::compose::mirror_relay_port(bind_port) else {
            return;
        };
        sweep_orphan_relay_units_once();
        // socat upstream = the bridge's bind address (127.0.0.1 under mirrored), from the
        // addressing SSOT rather than hardcoded, so the two can never diverge (ADR-080).
        let upstream = match speedwave_runtime::compose::host_bind_address() {
            Ok(addr) => addr,
            Err(e) => {
                // mirror_relay_port just resolved, so this is a poison/race edge — surface it.
                log::warn!("host_bind_address unavailable while ensuring relay for bind {bind_port} ({e}); assuming 127.0.0.1");
                "127.0.0.1".to_string()
            }
        };
        let gateway = speedwave_runtime::consts::MIRROR_RELAY_GATEWAY_IP;
        let script = logic::relay_setup_script(
            logic::RelayRoute {
                relay_port,
                bind_port,
            },
            gateway,
            &upstream,
        );
        let _ops = relay_ops_lock();
        // A remove may have retired this port while this ensure was queued — creating
        // the unit now would orphan a relay to a freed port (checked under the ops lock).
        let current_generation = PORT_GENERATIONS.snapshot(bind_port);
        if !logic::ensure_should_proceed(queued_generation, current_generation) {
            log::debug!("skipping relay ensure for retired bind {bind_port}");
            return;
        }
        match run_in_distro_root(&script).map(|out| logic::classify_relay_output(&out)) {
            Ok(logic::RelayOutcome::Created) => {
                FAILED_RELAY_PORTS.record_success(bind_port);
                log::info!("relay up: {gateway}:{relay_port} -> {upstream}:{bind_port}");
            }
            Ok(logic::RelayOutcome::Failed) => {
                if FAILED_RELAY_PORTS.record_failure(bind_port) {
                    log::warn!(
                        "relay unit started but socat is not active for \
                         {gateway}:{relay_port} -> {upstream}:{bind_port} (port collision?)"
                    );
                }
            }
            Ok(logic::RelayOutcome::AlreadyActive) => {
                FAILED_RELAY_PORTS.record_success(bind_port);
                log::debug!("relay for bind {bind_port} already active");
            }
            Err(e) => {
                if FAILED_RELAY_PORTS.record_failure(bind_port) {
                    log::warn!("relay ensure for bind {bind_port} failed: {e}");
                }
            }
        }
    }

    pub(super) fn remove_relay_for_port(bind_port: u16) {
        // Retire before anything else: a parked ensure must not resurrect this port
        // even when the distro is stopped (the queued thread survives the early return).
        PORT_GENERATIONS.retire(bind_port);
        if !distro_is_running() {
            return;
        }
        let _ops = relay_ops_lock();
        if let Err(e) = run_in_distro_root(&logic::relay_teardown_script(bind_port)) {
            log::warn!("relay teardown for bind {bind_port} failed: {e}");
        }
    }

    pub(super) fn remove_relay_for_port_async(bind_port: u16) {
        if let Err(e) = std::thread::Builder::new()
            .name(format!("mirror-relay-remove-{bind_port}"))
            .spawn(move || remove_relay_for_port(bind_port))
        {
            log::warn!("spawning relay remove thread for bind {bind_port} failed: {e}");
        }
    }

    /// One-time stop of every `spw-mirror-relay-*` unit before the first create: a Desktop
    /// crash leaves `Restart=on-failure` units forwarding to freed loopback ports (ADR-080).
    fn sweep_orphan_relay_units_once() {
        static SWEEP: std::sync::Once = std::sync::Once::new();
        SWEEP.call_once(|| {
            let _ops = relay_ops_lock();
            match run_in_distro_root(&logic::relay_sweep_script()) {
                Ok(_) => log::info!("swept orphaned relay units"),
                Err(e) => log::warn!("orphan relay-unit sweep failed: {e}"),
            }
        });
    }

    /// True when the Speedwave distro runs; `--list --running` reports without booting one.
    fn distro_is_running() -> bool {
        if DISTRO_NEGATIVE_CACHE.is_negative(std::time::Instant::now()) {
            return false;
        }
        let running = match speedwave_runtime::binary::run_wsl_bounded(
            &["--list", "--running", "--quiet"],
            None,
            Duration::from_secs(15),
        ) {
            Ok(out) if out.status.success() => logic::running_list_names_distro(
                &speedwave_runtime::runtime::decode_wsl_output(&out.stdout),
                speedwave_runtime::consts::wsl_distro_name(),
            ),
            Ok(_) => false,
            Err(e) => {
                log::warn!("wsl.exe --list --running failed: {e}");
                false
            }
        };
        DISTRO_NEGATIVE_CACHE.record(running, std::time::Instant::now());
        running
    }

    /// Runs `script` as root in the distro via stdin `bash -s` — bare `bash -lc <script>`
    /// splicing breaks on wsl.exe's default-shell reparse of the post-`--` line (ADR-080).
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
            Duration::from_secs(30),
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
}

// ── Pure decisions + scripts (cross-platform under test) ─────────────────────

/// Decision state and script/classifier helpers shared by the Windows runtime
/// (`imp`) and the cross-platform test suite.
#[cfg(any(all(target_os = "windows", not(test)), test))]
mod logic {
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::{Mutex, MutexGuard, PoisonError};
    use std::time::{Duration, Instant};

    /// Ports with an in-flight ensure: watchdogs re-tick every ~30 s and a wedged
    /// wsl.exe must not stack unbounded threads behind the ops lock.
    pub(super) struct InflightSet(Mutex<BTreeSet<u16>>);

    impl InflightSet {
        pub(super) const fn new() -> Self {
            Self(Mutex::new(BTreeSet::new()))
        }

        fn lock(&self) -> MutexGuard<'_, BTreeSet<u16>> {
            self.0.lock().unwrap_or_else(PoisonError::into_inner)
        }

        /// Marks `port` in-flight, or `None` when an ensure is already running for it.
        /// The guard clears the mark on every exit path, including a panic.
        pub(super) fn begin(&'static self, port: u16) -> Option<InflightGuard> {
            self.lock()
                .insert(port)
                .then(|| InflightGuard { set: self, port })
        }
    }

    /// Live in-flight mark for one port (see [`InflightSet::begin`]).
    pub(super) struct InflightGuard {
        set: &'static InflightSet,
        port: u16,
    }

    impl Drop for InflightGuard {
        fn drop(&mut self) {
            self.set.lock().remove(&self.port);
        }
    }

    /// Ports whose last ensure failed — a crash-looping `socat` warns once per streak
    /// (poll loops log on state change only), not every 30 s watchdog tick.
    pub(super) struct FailureStreaks(Mutex<BTreeSet<u16>>);

    impl FailureStreaks {
        pub(super) const fn new() -> Self {
            Self(Mutex::new(BTreeSet::new()))
        }

        fn lock(&self) -> MutexGuard<'_, BTreeSet<u16>> {
            self.0.lock().unwrap_or_else(PoisonError::into_inner)
        }

        /// Records a failure; true only for the first failure of a streak (warn now).
        pub(super) fn record_failure(&self, port: u16) -> bool {
            self.lock().insert(port)
        }

        /// Records a success, ending the port's failure streak.
        pub(super) fn record_success(&self, port: u16) {
            self.lock().remove(&port);
        }
    }

    /// Negative-probe cache: a negative outcome is trusted for `ttl`, any positive
    /// outcome clears it immediately.
    pub(super) struct NegativeCache {
        until: Mutex<Option<Instant>>,
        ttl: Duration,
    }

    impl NegativeCache {
        pub(super) const fn new(ttl: Duration) -> Self {
            Self {
                until: Mutex::new(None),
                ttl,
            }
        }

        fn lock(&self) -> MutexGuard<'_, Option<Instant>> {
            self.until.lock().unwrap_or_else(PoisonError::into_inner)
        }

        /// True while a cached negative probe is still fresh at `now` (skip the probe).
        pub(super) fn is_negative(&self, now: Instant) -> bool {
            self.lock().is_some_and(|until| now < until)
        }

        /// Records a probe outcome at `now`: negative arms the TTL, positive clears it.
        pub(super) fn record(&self, positive: bool, now: Instant) {
            *self.lock() = (!positive).then(|| now + self.ttl);
        }
    }

    /// Per-port retirement generations: a remove bumps the port's generation so a
    /// queued ensure can detect it raced a teardown and skip re-creating the unit.
    pub(super) struct PortGenerations(Mutex<BTreeMap<u16, u64>>);

    impl PortGenerations {
        pub(super) const fn new() -> Self {
            Self(Mutex::new(BTreeMap::new()))
        }

        fn lock(&self) -> MutexGuard<'_, BTreeMap<u16, u64>> {
            self.0.lock().unwrap_or_else(PoisonError::into_inner)
        }

        /// Generation for `port` (0 = never retired).
        pub(super) fn snapshot(&self, port: u16) -> u64 {
            self.lock().get(&port).copied().unwrap_or(0)
        }

        /// Retires `port` (bumps its generation); called by every remove.
        pub(super) fn retire(&self, port: u16) {
            *self.lock().entry(port).or_insert(0) += 1;
        }
    }

    /// True when a queued ensure may still create the relay: no remove retired the
    /// port between queueing (`queued_generation`) and execution (`current_generation`).
    pub(super) fn ensure_should_proceed(queued_generation: u64, current_generation: u64) -> bool {
        queued_generation == current_generation
    }

    /// The one place the relay unit-name scheme is encoded — `relay_unit_name` and the
    /// sweep glob both derive from it, so setup/teardown/sweep can never diverge.
    pub(super) const RELAY_UNIT_PREFIX: &str = "spw-mirror-relay-";

    /// Printed by the setup script only when it started the unit AND saw socat active.
    pub(super) const RELAY_CREATED_MARKER: &str = "SPW_RELAY_CREATED";

    /// Printed by the setup script when the unit started but socat never went active.
    pub(super) const RELAY_FAILED_MARKER: &str = "SPW_RELAY_FAILED";

    /// What one setup-script run reported (see the marker consts).
    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum RelayOutcome {
        Created,
        Failed,
        AlreadyActive,
    }

    /// Maps setup-script stdout to its outcome; no marker means the early
    /// `is-active && exit 0` path fired (relay already up).
    pub(super) fn classify_relay_output(stdout: &str) -> RelayOutcome {
        if stdout.contains(RELAY_CREATED_MARKER) {
            RelayOutcome::Created
        } else if stdout.contains(RELAY_FAILED_MARKER) {
            RelayOutcome::Failed
        } else {
            RelayOutcome::AlreadyActive
        }
    }

    /// Transient systemd unit name for a relay serving `bind_port`.
    fn relay_unit_name(bind_port: u16) -> String {
        format!("{RELAY_UNIT_PREFIX}{bind_port}")
    }

    /// Stops every relay unit (orphan sweep); `--all` also catches `failed` crash-looped
    /// units so their `Restart=on-failure` cycle ends.
    pub(super) fn relay_sweep_script() -> String {
        format!(
            "systemctl list-units --plain --no-legend --all \
             '{RELAY_UNIT_PREFIX}*' | awk '{{print $1}}' | while IFS= read -r u; do \
             systemctl stop \"$u\" 2>/dev/null; systemctl reset-failed \"$u\" 2>/dev/null; done; true"
        )
    }

    /// Bind→relay port pair for one relay; named fields prevent transposing the two
    /// same-typed ports (a swap would forward the wrong direction and still type-check).
    pub(super) struct RelayRoute {
        /// Guest-side port socat listens on (`mirror_relay_port(bind_port)`).
        pub(super) relay_port: u16,
        /// Host-side port the bridge bound; socat's forward target.
        pub(super) bind_port: u16,
    }

    /// Adds the relay address to `lo` and starts `socat` as a transient systemd unit; prints
    /// [`RELAY_CREATED_MARKER`] once verified active, [`RELAY_FAILED_MARKER`] otherwise.
    pub(super) fn relay_setup_script(
        route: RelayRoute,
        gateway_ip: &str,
        upstream: &str,
    ) -> String {
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

    pub(super) fn relay_teardown_script(bind_port: u16) -> String {
        let unit = relay_unit_name(bind_port);
        format!(
            "systemctl stop '{unit}' 2>/dev/null; systemctl reset-failed '{unit}' 2>/dev/null; true"
        )
    }

    /// True when a decoded `wsl --list --running --quiet` output names `distro`.
    pub(super) fn running_list_names_distro(decoded: &str, distro: &str) -> bool {
        decoded
            .lines()
            .any(|l| l.trim().trim_matches('\0') == distro)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::logic::{
        classify_relay_output, ensure_should_proceed, relay_setup_script, relay_sweep_script,
        relay_teardown_script, running_list_names_distro, FailureStreaks, InflightSet,
        NegativeCache, PortGenerations, RelayOutcome, RelayRoute, RELAY_CREATED_MARKER,
        RELAY_FAILED_MARKER, RELAY_UNIT_PREFIX,
    };
    use super::recorder::{calls_for_port, RelayOp};
    use super::{RelayWorkerInner, RelayedWorker};
    use std::cell::Cell;
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    // ── RelayedWorker lifecycle (the collapsed wiring guard) ────────────────

    struct FakeInner {
        port: u16,
        alive: bool,
        next_respawn: Result<u16, &'static str>,
        stopped: Rc<Cell<bool>>,
        cleaned: Rc<Cell<bool>>,
    }

    impl FakeInner {
        fn new(port: u16) -> Self {
            Self {
                port,
                alive: true,
                next_respawn: Err("no respawn scripted"),
                stopped: Rc::new(Cell::new(false)),
                cleaned: Rc::new(Cell::new(false)),
            }
        }
    }

    impl RelayWorkerInner for FakeInner {
        fn port(&self) -> u16 {
            self.port
        }
        fn is_alive(&self) -> bool {
            self.alive
        }
        fn stop(&mut self) -> anyhow::Result<()> {
            self.stopped.set(true);
            Ok(())
        }
        fn cleanup_files(&self) {
            self.cleaned.set(true);
        }
        fn respawn(&mut self) -> anyhow::Result<u16> {
            match self.next_respawn {
                Ok(p) => {
                    self.port = p;
                    self.alive = true;
                    Ok(p)
                }
                Err(e) => Err(anyhow::anyhow!(e)),
            }
        }
    }

    /// The one relay-lifecycle guard (replaces the four per-call-site wiring tests):
    /// ensure on spawn, re-ensure on live probe, swap on respawn, remove on stop.
    #[test]
    fn relayed_worker_drives_the_full_relay_lifecycle() {
        // Ports unique to this test — the recorder is global and tests run in parallel.
        let mut inner = FakeInner::new(1001);
        inner.next_respawn = Ok(1002);
        let stopped = inner.stopped.clone();
        let mut worker = RelayedWorker::new(inner);
        assert_eq!(
            calls_for_port(1001),
            vec![RelayOp::Ensure],
            "spawn must ensure the relay"
        );

        assert!(worker.is_alive());
        assert_eq!(
            calls_for_port(1001),
            vec![RelayOp::Ensure, RelayOp::Ensure],
            "a live probe must re-ensure the relay (watchdog self-heal)"
        );

        worker.inner.alive = false;
        assert!(!worker.is_alive());
        assert_eq!(
            calls_for_port(1001).len(),
            2,
            "a dead probe must not re-ensure"
        );

        // Respawn to a NEW port: the old relay is dropped (async), the new one ensured.
        assert_eq!(worker.respawn().unwrap(), 1002);
        assert_eq!(
            calls_for_port(1001),
            vec![RelayOp::Ensure, RelayOp::Ensure, RelayOp::RemoveAsync]
        );
        assert_eq!(calls_for_port(1002), vec![RelayOp::Ensure]);

        // Respawn reusing the SAME port: no teardown (it would race the live relay).
        worker.inner.next_respawn = Ok(1002);
        worker.respawn().unwrap();
        assert_eq!(
            calls_for_port(1002),
            vec![RelayOp::Ensure, RelayOp::Ensure],
            "a port-reusing respawn must only re-ensure"
        );

        // Failed respawn: no relay ops at all.
        worker.inner.next_respawn = Err("spawn failed");
        assert!(worker.respawn().is_err());
        assert_eq!(calls_for_port(1002).len(), 2);

        // Stop: synchronous removal (an exit-path thread would not outlive the process).
        worker.stop().unwrap();
        assert!(stopped.get(), "stop must stop the inner worker");
        assert_eq!(
            calls_for_port(1002),
            vec![RelayOp::Ensure, RelayOp::Ensure, RelayOp::Remove]
        );
    }

    #[test]
    fn stop_for_replacement_defers_relay_teardown_to_guard_drop() {
        let inner = FakeInner::new(1101);
        let stopped = inner.stopped.clone();
        let cleaned = inner.cleaned.clone();
        let worker = RelayedWorker::new(inner);
        let retired = worker.stop_for_replacement("test[worker]");
        assert!(stopped.get(), "stop_for_replacement must stop the worker");
        assert!(
            cleaned.get(),
            "stop_for_replacement must clean lock/token files"
        );
        assert_eq!(
            calls_for_port(1101),
            vec![RelayOp::Ensure],
            "teardown must be deferred until the guard drops"
        );
        drop(retired);
        assert_eq!(
            calls_for_port(1101),
            vec![RelayOp::Ensure, RelayOp::RemoveAsync],
            "an unadopted retired relay is torn down on drop"
        );
    }

    #[test]
    fn retired_relay_adopted_by_port_reuse_is_kept() {
        let worker = RelayedWorker::new(FakeInner::new(1111));
        let mut retired = worker.stop_for_replacement("test[worker]");
        retired.adopt_port(1111);
        drop(retired);
        assert_eq!(
            calls_for_port(1111),
            vec![RelayOp::Ensure],
            "a port-reusing replacement adopts the relay — no teardown"
        );
    }

    #[test]
    fn retired_relay_with_different_replacement_port_is_torn_down() {
        let worker = RelayedWorker::new(FakeInner::new(1121));
        let mut retired = worker.stop_for_replacement("test[worker]");
        retired.adopt_port(1122);
        drop(retired);
        assert_eq!(
            calls_for_port(1121),
            vec![RelayOp::Ensure, RelayOp::RemoveAsync],
            "a port-changing replacement must not adopt the old relay"
        );
    }

    // ── Coalescing, warn-once, negative cache, retire tombstone ─────────────

    #[test]
    fn inflight_set_coalesces_and_guard_clears_on_panic() {
        static SET: InflightSet = InflightSet::new();
        let guard = SET.begin(7001).expect("first begin must mark in-flight");
        assert!(SET.begin(7001).is_none(), "second begin must coalesce");
        assert!(SET.begin(7002).is_some(), "other ports are independent");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _guard = guard;
            panic!("simulated ensure panic");
        }));
        assert!(result.is_err());
        assert!(
            SET.begin(7001).is_some(),
            "a panicked ensure must clear its in-flight mark"
        );
    }

    #[test]
    fn inflight_guard_clears_on_normal_drop() {
        static SET: InflightSet = InflightSet::new();
        drop(SET.begin(7011).expect("first begin"));
        assert!(
            SET.begin(7011).is_some(),
            "a completed ensure must clear its in-flight mark"
        );
    }

    #[test]
    fn failure_streaks_warn_once_until_reset_by_success() {
        let streaks = FailureStreaks::new();
        assert!(
            streaks.record_failure(7101),
            "first failure of a streak warns"
        );
        assert!(
            !streaks.record_failure(7101),
            "repeat failures stay silent (poll loops log on state change only)"
        );
        streaks.record_success(7101);
        assert!(
            streaks.record_failure(7101),
            "a success resets the streak — the next failure warns again"
        );
        assert!(streaks.record_failure(7102), "ports latch independently");
    }

    #[test]
    fn negative_cache_expires_after_ttl_and_resets_on_success() {
        let cache = NegativeCache::new(Duration::from_secs(10));
        let t0 = Instant::now();
        assert!(!cache.is_negative(t0), "fresh cache holds no negative");
        cache.record(false, t0);
        assert!(
            cache.is_negative(t0 + Duration::from_secs(9)),
            "negative is cached inside the TTL"
        );
        assert!(
            !cache.is_negative(t0 + Duration::from_secs(10)),
            "the TTL boundary expires the negative"
        );
        cache.record(false, t0);
        cache.record(true, t0 + Duration::from_secs(1));
        assert!(
            !cache.is_negative(t0 + Duration::from_secs(2)),
            "a positive probe must clear the cached negative immediately"
        );
    }

    #[test]
    fn port_generations_gate_queued_ensures_after_remove() {
        let generations = PortGenerations::new();
        let queued = generations.snapshot(7201);
        assert!(
            ensure_should_proceed(queued, generations.snapshot(7201)),
            "no remove in between — the ensure proceeds"
        );
        generations.retire(7201);
        assert!(
            !ensure_should_proceed(queued, generations.snapshot(7201)),
            "a remove retired the port — the parked ensure must skip creation"
        );
        assert!(
            ensure_should_proceed(generations.snapshot(7201), generations.snapshot(7201)),
            "a NEW ensure queued after the remove proceeds"
        );
        assert!(
            ensure_should_proceed(queued, generations.snapshot(7202)),
            "ports are retired independently"
        );
        generations.retire(7201);
        assert_eq!(
            generations.snapshot(7201),
            2,
            "every remove bumps the generation"
        );
    }

    // ── Scripts + classifier ────────────────────────────────────────────────

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

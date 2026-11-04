//! Keeps the computer out of idle sleep while a recording, an offline pass or a chat turn runs
//! (SPEED-917, ADR-107).

use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use speedwave_runtime::config;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as platform;

const ASSERTION_NAME: &str = "Speedwave is recording, transcribing or running a chat";

const RELEASE_GRACE: Duration = Duration::from_secs(30);

type OsAssertion = Box<dyn Send>;

type Acquire = Box<dyn Fn() -> Result<OsAssertion, String> + Send + Sync>;

static KEEPER: LazyLock<Keeper> =
    LazyLock::new(|| Keeper::new(RELEASE_GRACE, Box::new(acquire_os), setting_from_config));

/// Keeps the computer awake until dropped; the OS assertion outlives the last hold by
/// [`RELEASE_GRACE`].
#[must_use = "the computer may sleep once the hold is dropped"]
pub(crate) struct Hold(&'static Keeper);

impl Drop for Hold {
    fn drop(&mut self) {
        self.0.release();
    }
}

struct Keeper {
    state: Mutex<State>,
    grace: Duration,
    acquire: Acquire,
    setting: fn() -> bool,
}

#[derive(Default)]
struct State {
    holders: usize,
    generation: u64,
    enabled: Option<bool>,
    assertion: Option<OsAssertion>,
}

/// Holds the computer awake; `reason` is logged only when this hold takes the assertion.
pub(crate) fn hold(reason: &'static str) -> Hold {
    KEEPER.hold(reason)
}

/// Releases the assertion at once and takes no new one: it lives in a static no exit drops.
pub(crate) fn release_on_exit() {
    KEEPER.set_enabled(false);
}

/// Renews the assertion whenever the display comes back on: Windows can clear it in battery standby.
pub(crate) fn install() {
    #[cfg(windows)]
    if let Err(e) = platform::watch_display() {
        log::warn!(
            "could not watch the display, so a wake will not renew the idle-sleep assertion: {e}"
        );
    }
}

/// Reads the Settings switch; unset means on.
#[tauri::command]
pub async fn get_keep_awake() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        config::load_user_config()
            .map(|cfg| cfg.keep_awake_enabled())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stores the Settings switch and applies it to the work running now.
#[tauri::command]
pub async fn set_keep_awake(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        config::with_config_lock(|| {
            let mut cfg = config::load_user_config()?;
            cfg.set_keep_awake(enabled);
            config::save_user_config(&cfg)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    KEEPER.set_enabled(enabled);
    Ok(())
}

impl Keeper {
    fn new(grace: Duration, acquire: Acquire, setting: fn() -> bool) -> Self {
        Self {
            state: Mutex::new(State::default()),
            grace,
            acquire,
            setting,
        }
    }

    fn hold(&'static self, reason: &'static str) -> Hold {
        let mut state = self.lock();
        state.holders += 1;
        state.generation += 1;
        self.ensure_assertion(&mut state, reason);
        Hold(self)
    }

    fn set_enabled(&self, enabled: bool) {
        let mut state = self.lock();
        state.enabled = Some(enabled);
        if !enabled {
            Self::drop_assertion(&mut state);
        } else if state.holders > 0 {
            self.ensure_assertion(&mut state, "the work already running");
        }
    }

    fn release(&'static self) {
        let mut state = self.lock();
        state.holders = state.holders.saturating_sub(1);
        if state.holders > 0 || state.assertion.is_none() {
            return;
        }
        let generation = state.generation;
        drop(state);
        let spawned = std::thread::Builder::new()
            .name("keep-awake-release".to_string())
            .spawn(move || {
                std::thread::sleep(self.grace);
                self.release_if_idle(generation);
            });
        if let Err(e) = spawned {
            log::warn!("could not delay the idle-sleep release, releasing now: {e}");
            self.release_if_idle(generation);
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn ensure_assertion(&self, state: &mut State, reason: &str) {
        let enabled = *state.enabled.get_or_insert_with(self.setting);
        if state.assertion.is_some() || !enabled {
            return;
        }
        match (self.acquire)() {
            Ok(assertion) => {
                log::info!("keeping the computer out of idle sleep for {reason}");
                state.assertion = Some(assertion);
            }
            Err(e) => log::warn!("could not keep the computer out of idle sleep for {reason}: {e}"),
        }
    }

    #[cfg(any(windows, test))]
    fn renew(&self) {
        let mut state = self.lock();
        if state.holders == 0 || state.enabled != Some(true) {
            return;
        }
        match (self.acquire)() {
            Ok(fresh) => {
                state.assertion = Some(fresh);
                log::info!("renewed the idle-sleep assertion after the display came back on");
            }
            Err(e) => log::warn!(
                "could not renew the idle-sleep assertion after the display came back on: {e}"
            ),
        }
    }

    fn release_if_idle(&self, generation: u64) {
        let mut state = self.lock();
        if state.holders == 0 && state.generation == generation {
            Self::drop_assertion(&mut state);
        }
    }

    fn drop_assertion(state: &mut State) {
        if state.assertion.take().is_some() {
            log::info!("the computer may idle-sleep again");
        }
    }
}

#[cfg(windows)]
fn renew_after_wake() {
    KEEPER.renew();
}

fn acquire_os() -> Result<OsAssertion, String> {
    platform::Assertion::acquire().map(|a| Box::new(a) as OsAssertion)
}

#[cfg(not(test))]
fn setting_from_config() -> bool {
    setting_from(config::load_user_config())
}

fn setting_from(loaded: anyhow::Result<config::SpeedwaveUserConfig>) -> bool {
    loaded
        .map(|cfg| cfg.keep_awake_enabled())
        .unwrap_or_else(|e| {
            log::warn!("the keep-awake setting is unreadable, keeping the computer awake: {e}");
            true
        })
}

#[cfg(test)]
fn setting_from_config() -> bool {
    false
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    use super::*;

    #[derive(Default)]
    struct Calls {
        acquired: AtomicUsize,
        released: AtomicUsize,
        refuse: AtomicBool,
    }

    struct FakeAssertion(Arc<Calls>);

    impl Drop for FakeAssertion {
        fn drop(&mut self) {
            self.0.released.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn keeper(grace: Duration, setting: fn() -> bool) -> (&'static Keeper, Arc<Calls>) {
        let calls = Arc::new(Calls::default());
        let for_acquire = calls.clone();
        let acquire: Acquire = Box::new(move || {
            if for_acquire.refuse.load(Ordering::SeqCst) {
                return Err("refused".to_string());
            }
            for_acquire.acquired.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeAssertion(for_acquire.clone())) as OsAssertion)
        });
        let keeper: &'static Keeper = Box::leak(Box::new(Keeper::new(grace, acquire, setting)));
        (keeper, calls)
    }

    fn on() -> bool {
        true
    }

    fn off() -> bool {
        false
    }

    const NEVER: Duration = Duration::from_secs(3600);

    fn counts(calls: &Calls) -> (usize, usize) {
        (
            calls.acquired.load(Ordering::SeqCst),
            calls.released.load(Ordering::SeqCst),
        )
    }

    #[test]
    fn holders_share_one_assertion_taken_by_the_first() {
        let (keeper, calls) = keeper(NEVER, on);
        let recording = keeper.hold("a recording");
        let turn = keeper.hold("a chat turn");
        assert_eq!(counts(&calls), (1, 0));
        drop(recording);
        assert_eq!(counts(&calls), (1, 0), "one holder is still working");
        drop(turn);
        assert_eq!(counts(&calls), (1, 0), "the release waits out the grace");
    }

    #[test]
    fn the_last_release_lets_the_computer_sleep_once_the_grace_runs_out() {
        let (keeper, calls) = keeper(Duration::from_millis(20), on);
        drop(keeper.hold("a recording"));
        let deadline = Instant::now() + Duration::from_secs(5);
        while counts(&calls).1 == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(counts(&calls), (1, 1));
        assert_eq!(keeper.lock().holders, 0);
    }

    #[test]
    fn work_that_starts_within_the_grace_keeps_the_assertion_it_finds() {
        let (keeper, calls) = keeper(NEVER, on);
        drop(keeper.hold("a recording"));
        let stopped_at = keeper.lock().generation;
        let pass = keeper.hold("an offline transcription pass");
        keeper.release_if_idle(stopped_at);
        assert_eq!(
            counts(&calls),
            (1, 0),
            "the offline pass took over the hold"
        );
        drop(pass);
        keeper.release_if_idle(stopped_at);
        assert_eq!(
            counts(&calls),
            (1, 0),
            "the recording's timer must not cut the offline pass's grace short"
        );
        let generation = keeper.lock().generation;
        keeper.release_if_idle(generation);
        assert_eq!(counts(&calls), (1, 1));
    }

    #[test]
    fn a_stale_timer_never_releases_while_someone_holds() {
        let (keeper, calls) = keeper(NEVER, on);
        let turn = keeper.hold("a chat turn");
        let generation = keeper.lock().generation;
        keeper.release_if_idle(generation);
        assert_eq!(counts(&calls), (1, 0));
        drop(turn);
    }

    #[test]
    fn the_switch_turned_off_in_settings_takes_no_assertion() {
        let (keeper, calls) = keeper(NEVER, off);
        let recording = keeper.hold("a recording");
        assert_eq!(counts(&calls), (0, 0));
        drop(recording);
        assert_eq!(keeper.lock().holders, 0);
    }

    #[test]
    fn turning_the_switch_off_releases_at_once_and_on_again_takes_it_back() {
        let (keeper, calls) = keeper(NEVER, on);
        let recording = keeper.hold("a recording");
        keeper.set_enabled(false);
        assert_eq!(counts(&calls), (1, 1));
        let turn = keeper.hold("a chat turn");
        assert_eq!(counts(&calls), (1, 1), "the switch stays off for new work");
        keeper.set_enabled(true);
        assert_eq!(counts(&calls), (2, 1));
        drop(recording);
        drop(turn);
    }

    #[test]
    fn turning_the_switch_on_with_nothing_running_takes_nothing() {
        let (keeper, calls) = keeper(NEVER, off);
        keeper.set_enabled(true);
        assert_eq!(counts(&calls), (0, 0));
        drop(keeper.hold("a chat turn"));
        assert_eq!(counts(&calls), (1, 0));
    }

    #[test]
    fn exit_releases_during_the_grace_and_refuses_later_work() {
        let (keeper, calls) = keeper(NEVER, on);
        drop(keeper.hold("a chat turn"));
        keeper.set_enabled(false);
        assert_eq!(counts(&calls), (1, 1));
        let late = keeper.hold("a recording");
        assert_eq!(counts(&calls), (1, 1));
        drop(late);
    }

    #[test]
    fn a_refused_assertion_is_tried_again_by_the_next_holder() {
        let (keeper, calls) = keeper(NEVER, on);
        calls.refuse.store(true, Ordering::SeqCst);
        let recording = keeper.hold("a recording");
        assert_eq!(counts(&calls), (0, 0));
        assert!(keeper.lock().assertion.is_none());
        calls.refuse.store(false, Ordering::SeqCst);
        let turn = keeper.hold("a chat turn");
        assert_eq!(counts(&calls), (1, 0));
        drop(recording);
        drop(turn);
    }

    #[test]
    fn a_wake_replaces_the_assertion_of_running_work() {
        let (keeper, calls) = keeper(NEVER, on);
        let pass = keeper.hold("an offline transcription pass");
        keeper.renew();
        assert_eq!(counts(&calls), (2, 1));
        assert!(keeper.lock().assertion.is_some());
        drop(pass);
    }

    #[test]
    fn a_wake_takes_the_assertion_a_refused_hold_never_got() {
        let (keeper, calls) = keeper(NEVER, on);
        calls.refuse.store(true, Ordering::SeqCst);
        let recording = keeper.hold("a recording");
        calls.refuse.store(false, Ordering::SeqCst);
        keeper.renew();
        assert_eq!(counts(&calls), (1, 0));
        drop(recording);
    }

    #[test]
    fn a_refused_renewal_keeps_the_assertion_it_had() {
        let (keeper, calls) = keeper(NEVER, on);
        let turn = keeper.hold("a chat turn");
        calls.refuse.store(true, Ordering::SeqCst);
        keeper.renew();
        assert_eq!(counts(&calls), (1, 0));
        assert!(keeper.lock().assertion.is_some());
        drop(turn);
    }

    #[test]
    fn a_wake_with_no_work_running_takes_nothing() {
        let (keeper, calls) = keeper(NEVER, on);
        keeper.renew();
        assert_eq!(counts(&calls), (0, 0));
        drop(keeper.hold("a chat turn"));
        keeper.renew();
        assert_eq!(
            counts(&calls),
            (1, 0),
            "an assertion left only for the grace is released by its timer, not renewed"
        );
    }

    #[test]
    fn a_wake_after_the_switch_was_turned_off_or_the_app_exits_takes_nothing() {
        let (keeper, calls) = keeper(NEVER, on);
        let recording = keeper.hold("a recording");
        keeper.set_enabled(false);
        keeper.renew();
        assert_eq!(counts(&calls), (1, 1));
        drop(recording);
    }

    #[test]
    fn a_wake_with_the_switch_stored_off_takes_nothing() {
        let (keeper, calls) = keeper(NEVER, off);
        let turn = keeper.hold("a chat turn");
        keeper.renew();
        assert_eq!(counts(&calls), (0, 0));
        drop(turn);
    }

    #[test]
    fn an_unset_switch_or_an_unreadable_config_keeps_the_computer_awake() {
        assert!(setting_from(Ok(config::SpeedwaveUserConfig::default())));
        let mut off = config::SpeedwaveUserConfig::default();
        off.set_keep_awake(false);
        assert!(!setting_from(Ok(off)));
        assert!(setting_from(Err(anyhow::anyhow!(
            "config.json is not valid JSON"
        ))));
    }

    #[test]
    fn the_assertion_name_fits_both_operating_systems() {
        assert!(ASSERTION_NAME.starts_with("Speedwave"));
        assert!(
            ASSERTION_NAME.chars().count() <= 128,
            "IOKit caps the name at 128"
        );
        assert!(ASSERTION_NAME.is_ascii());
    }

    #[test]
    fn the_operating_system_grants_and_takes_back_the_assertion() {
        let assertion = platform::Assertion::acquire().unwrap();
        drop(assertion);
    }
}

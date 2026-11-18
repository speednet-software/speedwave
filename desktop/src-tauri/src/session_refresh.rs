//! Keeps the OAuth tokens of every project with running containers fresh (SPEED-1002, ADR-060).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use speedwave_runtime::oauth_refresh::{self, RefreshOutcome, SessionRefresher};
use speedwave_runtime::runtime::LockedRuntime;

use crate::notifications;

const SYNC_INTERVAL: Duration = Duration::from_secs(30);
const START_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

static STOP: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Containers {
    Running,
    Stopped,
    Unknown,
}

#[derive(Default)]
struct ReconnectNotices(HashSet<(String, String)>);

impl ReconnectNotices {
    fn first_report(&mut self, project: &str, service: &str) -> bool {
        self.0.insert((project.to_string(), service.to_string()))
    }

    fn clear(&mut self, project: &str, service: &str) {
        self.0.remove(&(project.to_string(), service.to_string()));
    }
}

/// Starts the background sync: every project with running containers gets a session refresher
/// from the moment its containers run until they stop. Call once, after setup.
pub(crate) fn start_sync(app: tauri::AppHandle) {
    STOP.store(false, Ordering::Relaxed);
    std::thread::spawn(move || {
        let mut held: HashMap<String, SessionRefresher> = HashMap::new();
        while !STOP.load(Ordering::Relaxed) {
            if let Some(observed) = observe_projects() {
                reconcile(&mut held, &observed, |project| {
                    start_refresher(&app, project)
                });
            }
            std::thread::sleep(SYNC_INTERVAL);
        }
        log::info!("token refresh sync stopped");
    });
}

/// Stops the sync and drops its refreshers; for exit and factory reset.
pub(crate) fn stop_sync() {
    STOP.store(true, Ordering::Relaxed);
}

/// Refreshes the due tokens of `project` before a chat session starts; a network failure never
/// blocks the start. Blocking, run from `spawn_blocking`.
pub(crate) fn refresh_before_session(app: &tauri::AppHandle, project: &str) {
    for refreshed in oauth_refresh::refresh_now_with_timeout(project, START_REFRESH_TIMEOUT) {
        let service = refreshed.service.as_str();
        match refreshed.outcome {
            RefreshOutcome::ReconnectRequired => {
                if first_report(project, service) {
                    notifications::notify_reconnect_required(app, project, service);
                }
            }
            RefreshOutcome::NotDue | RefreshOutcome::Refreshed => clear_report(project, service),
            RefreshOutcome::NetworkError => {}
        }
    }
}

fn start_refresher(app: &tauri::AppHandle, project: &str) -> SessionRefresher {
    let app = app.clone();
    let owner = project.to_string();
    oauth_refresh::spawn_session_refresher(project, move |service| {
        first_report(&owner, service);
        notifications::notify_reconnect_required(&app, &owner, service);
    })
}

fn first_report(project: &str, service: &str) -> bool {
    notices()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .first_report(project, service)
}

fn clear_report(project: &str, service: &str) {
    notices()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear(project, service);
}

fn reconcile<H>(
    held: &mut HashMap<String, H>,
    observed: &[(String, Containers)],
    start: impl Fn(&str) -> H,
) {
    held.retain(|project, _| {
        observed
            .iter()
            .any(|(name, state)| name == project && *state != Containers::Stopped)
    });
    for (project, state) in observed {
        if *state == Containers::Running && !held.contains_key(project) {
            held.insert(project.clone(), start(project));
        }
    }
}

fn observe_projects() -> Option<Vec<(String, Containers)>> {
    let cfg = match speedwave_runtime::config::load_user_config() {
        Ok(cfg) => cfg,
        Err(e) => {
            log::warn!("token refresh sync skipped: user config unreadable: {e:#}");
            return None;
        }
    };
    let rt = speedwave_runtime::runtime::detect_runtime();
    let available = rt.is_available();
    Some(
        cfg.projects
            .iter()
            .map(|p| (p.name.clone(), containers_of(&rt, available, &p.name)))
            .collect(),
    )
}

fn containers_of(rt: &LockedRuntime, available: bool, project: &str) -> Containers {
    if !available || !speedwave_runtime::runtime::project_has_compose_file(project) {
        return Containers::Stopped;
    }
    match rt.compose_ps(project) {
        Ok(running) if !running.is_empty() => Containers::Running,
        Ok(_) => Containers::Stopped,
        Err(e) => {
            log::debug!("compose_ps failed for '{project}' during the token refresh sync: {e}");
            Containers::Unknown
        }
    }
}

fn notices() -> &'static Mutex<ReconnectNotices> {
    static NOTICES: OnceLock<Mutex<ReconnectNotices>> = OnceLock::new();
    NOTICES.get_or_init(|| Mutex::new(ReconnectNotices::default()))
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    fn observed(items: &[(&str, Containers)]) -> Vec<(String, Containers)> {
        items.iter().map(|(n, c)| (n.to_string(), *c)).collect()
    }

    #[test]
    fn every_running_project_gets_one_handle_and_keeps_it() {
        let started = Cell::new(0);
        let mut held: HashMap<String, u32> = HashMap::new();
        let seen = observed(&[("a", Containers::Running), ("b", Containers::Running)]);

        reconcile(&mut held, &seen, |_| {
            started.set(started.get() + 1);
            started.get()
        });
        reconcile(&mut held, &seen, |_| {
            started.set(started.get() + 1);
            started.get()
        });

        assert_eq!(started.get(), 2);
        assert_eq!(held.len(), 2);
    }

    #[test]
    fn a_stopped_or_removed_project_loses_its_handle() {
        let mut held: HashMap<String, u32> = HashMap::new();
        held.insert("stopped".to_string(), 1);
        held.insert("removed".to_string(), 2);
        held.insert("running".to_string(), 3);

        reconcile(
            &mut held,
            &observed(&[
                ("stopped", Containers::Stopped),
                ("running", Containers::Running),
            ]),
            |_| 9,
        );

        assert_eq!(held.keys().collect::<Vec<_>>(), vec!["running"]);
    }

    #[test]
    fn an_unknown_state_neither_starts_nor_drops_a_handle() {
        let mut held: HashMap<String, u32> = HashMap::new();
        held.insert("kept".to_string(), 1);

        reconcile(
            &mut held,
            &observed(&[("kept", Containers::Unknown), ("new", Containers::Unknown)]),
            |_| 9,
        );

        assert_eq!(held.get("kept"), Some(&1));
        assert!(!held.contains_key("new"));
    }

    #[test]
    fn a_reconnect_notice_is_first_per_project_and_service_until_cleared() {
        let mut notices = ReconnectNotices::default();
        assert!(notices.first_report("a", "slack"));
        assert!(!notices.first_report("a", "slack"));
        assert!(notices.first_report("b", "slack"));
        assert!(notices.first_report("a", "sharepoint"));

        notices.clear("a", "slack");

        assert!(notices.first_report("a", "slack"));
    }
}

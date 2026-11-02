use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::control_channel::{self, ControlError, PendingControl, GENERATE_TITLE_TIMEOUT};

const TITLE_CHANGED_EVENT: &str = "chat_title_changed";
const DESCRIPTION_MAX_CHARS: usize = 1000;
const PERSIST_POLLS: usize = 20;
const PERSIST_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct TitleChangedEvent {
    project: String,
    tab_id: String,
    session_id: String,
    title: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct KnownTitle {
    session_id: Option<String>,
    title: Option<String>,
    generated: bool,
}

pub(crate) struct TitleState {
    project: String,
    tab_id: String,
    transcript: Arc<Mutex<Option<String>>>,
    known: Mutex<KnownTitle>,
    request_in_flight: AtomicBool,
    app: Mutex<Option<AppHandle>>,
}

impl TitleState {
    pub(crate) fn new(
        project: &str,
        tab_id: &str,
        transcript: Arc<Mutex<Option<String>>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            project: project.to_string(),
            tab_id: tab_id.to_string(),
            transcript,
            known: Mutex::new(KnownTitle::default()),
            request_in_flight: AtomicBool::new(false),
            app: Mutex::new(None),
        })
    }

    pub(crate) fn restart(&self, app: AppHandle) {
        self.reset();
        *self.app.lock().unwrap_or_else(PoisonError::into_inner) = Some(app);
    }

    pub(crate) fn refresh(&self, session_id: &str) -> bool {
        self.refresh_with(session_id, |id| {
            crate::history::read_session_title(&self.project, id)
        })
    }

    pub(crate) fn maybe_request(
        self: &Arc<Self>,
        text: &str,
        request: impl FnOnce(&str) -> Result<PendingControl, ControlError>,
    ) -> bool {
        let Some(description) = description_for(text) else {
            return false;
        };
        if self.has_title() || !self.begin_request() {
            return false;
        }
        let pending = match request(&description) {
            Ok(pending) => pending,
            Err(e) => {
                log::warn!("could not ask Claude Code for a session title: {e}");
                self.end_request();
                return false;
            }
        };
        let state = Arc::clone(self);
        std::thread::spawn(move || {
            match pending
                .wait(GENERATE_TITLE_TIMEOUT)
                .map(|answer| control_channel::generated_title(&answer))
            {
                Ok(Some(title)) => {
                    state.mark_generated();
                    log::info!(
                        "Claude Code generated a session title of {} characters",
                        title.chars().count()
                    );
                    state.announce_once_persisted();
                }
                Ok(None) => log::info!("Claude Code generated no session title"),
                Err(ControlError::SessionEnded) => {
                    log::debug!("the session ended before Claude Code answered the title request");
                }
                Err(e) => log::warn!("the session title request failed: {e}"),
            }
            state.end_request();
        });
        true
    }

    fn reset(&self) {
        *self.lock() = KnownTitle::default();
        self.request_in_flight.store(false, Ordering::SeqCst);
    }

    fn has_title(&self) -> bool {
        let known = self.lock();
        known.title.is_some() || known.generated
    }

    fn begin_request(&self) -> bool {
        self.request_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn end_request(&self) {
        self.request_in_flight.store(false, Ordering::SeqCst);
    }

    fn mark_generated(&self) {
        self.lock().generated = true;
    }

    fn announce_once_persisted(&self) {
        poll_persisted_title(
            |session_id| {
                crate::history::read_session_title(&self.project, session_id)
                    .ok()
                    .flatten()
            },
            &self.transcript,
            || std::thread::sleep(PERSIST_POLL_INTERVAL),
            |session_id, title| self.announce(session_id, Some(title)),
        );
    }

    fn refresh_with(
        &self,
        session_id: &str,
        read: impl FnOnce(&str) -> std::io::Result<Option<String>>,
    ) -> bool {
        match read(session_id) {
            Ok(title) => self.announce(session_id, title),
            Err(_) => false,
        }
    }

    fn announce(&self, session_id: &str, title: Option<String>) -> bool {
        let app = self
            .app
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        self.announce_with(session_id, title, |event| match &app {
            Some(app) => app.emit(TITLE_CHANGED_EVENT, event),
            None => Ok(()),
        })
    }

    fn announce_with<E: std::fmt::Display>(
        &self,
        session_id: &str,
        title: Option<String>,
        emit: impl FnOnce(TitleChangedEvent) -> Result<(), E>,
    ) -> bool {
        let Some(title) = self.record(session_id, title) else {
            return false;
        };
        let event = TitleChangedEvent {
            project: self.project.clone(),
            tab_id: self.tab_id.clone(),
            session_id: session_id.to_string(),
            title,
        };
        if let Err(e) = emit(event) {
            log::warn!("failed to emit {TITLE_CHANGED_EVENT}: {e}");
        }
        true
    }

    fn record(&self, session_id: &str, title: Option<String>) -> Option<Option<String>> {
        let mut known = self.lock();
        let same_session = known.session_id.as_deref() == Some(session_id);
        if same_session && known.title == title {
            return None;
        }
        if !same_session {
            known.generated = false;
        }
        known.session_id = Some(session_id.to_string());
        known.title.clone_from(&title);
        Some(title)
    }

    fn lock(&self) -> MutexGuard<'_, KnownTitle> {
        self.known.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn description_for(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.starts_with('/') {
        return None;
    }
    Some(text.chars().take(DESCRIPTION_MAX_CHARS).collect())
}

fn poll_persisted_title(
    mut read: impl FnMut(&str) -> Option<String>,
    transcript: &Mutex<Option<String>>,
    mut sleep: impl FnMut(),
    announce: impl FnOnce(&str, String) -> bool,
) -> bool {
    for attempt in 0..PERSIST_POLLS {
        let session_id = transcript
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(session_id) = session_id else {
            return false;
        };
        if let Some(title) = read(&session_id) {
            return announce(&session_id, title);
        }
        if attempt + 1 < PERSIST_POLLS {
            sleep();
        }
    }
    false
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;

    const SESSION: &str = "95c7b744-b1e4-40d0-a855-fb3b29a81631";
    const OTHER_SESSION: &str = "5b8f78ad-eaff-467c-9cd6-10445433e476";

    fn state() -> Arc<TitleState> {
        TitleState::new(
            "proj",
            "tab",
            Arc::new(Mutex::new(Some(SESSION.to_string()))),
        )
    }

    fn collect(
        events: &mut Vec<TitleChangedEvent>,
    ) -> impl FnOnce(TitleChangedEvent) -> Result<(), String> + '_ {
        |event| {
            events.push(event);
            Ok(())
        }
    }

    fn ok(_: TitleChangedEvent) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn a_description_is_the_trimmed_message_text() {
        assert_eq!(
            description_for("  napraw logowanie w auth.rs  "),
            Some("napraw logowanie w auth.rs".to_string())
        );
    }

    #[test]
    fn an_empty_message_or_a_slash_command_gets_no_description() {
        assert_eq!(description_for(""), None);
        assert_eq!(description_for("   \n"), None);
        assert_eq!(description_for("/model claude-sonnet-5"), None);
        assert_eq!(description_for("/rename Auth fix"), None);
        assert_eq!(description_for("  /clear"), None);
    }

    #[test]
    fn a_description_is_cut_at_the_character_limit_not_at_a_byte() {
        let long = "ż".repeat(DESCRIPTION_MAX_CHARS + 200);
        let description = description_for(&long).unwrap();
        assert_eq!(description.chars().count(), DESCRIPTION_MAX_CHARS);
        assert!(description.chars().all(|c| c == 'ż'));
        let exact = "a".repeat(DESCRIPTION_MAX_CHARS);
        assert_eq!(
            description_for(&exact).unwrap().len(),
            DESCRIPTION_MAX_CHARS
        );
    }

    #[test]
    fn the_first_read_of_a_session_is_announced_even_without_a_title() {
        let state = state();
        let mut events = Vec::new();
        assert!(state.announce_with(SESSION, None, collect(&mut events)));
        assert_eq!(
            events,
            vec![TitleChangedEvent {
                project: "proj".into(),
                tab_id: "tab".into(),
                session_id: SESSION.into(),
                title: None,
            }]
        );
        assert!(!state.has_title());
    }

    #[test]
    fn an_unchanged_title_is_announced_once() {
        let state = state();
        let mut events = Vec::new();
        let title = Some("Auth login fix".to_string());
        assert!(state.announce_with(SESSION, title.clone(), collect(&mut events)));
        assert!(!state.announce_with(SESSION, title.clone(), collect(&mut events)));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, title);
        assert!(state.has_title());
    }

    #[test]
    fn a_renamed_session_is_announced_with_its_new_title() {
        let state = state();
        let mut events = Vec::new();
        state.announce_with(SESSION, Some("Auth login fix".into()), collect(&mut events));
        assert!(state.announce_with(SESSION, Some("Auth fix".into()), collect(&mut events)));
        assert_eq!(events.last().unwrap().title.as_deref(), Some("Auth fix"));
    }

    #[test]
    fn a_new_session_id_resets_the_title_and_the_generated_mark() {
        let state = state();
        let mut events = Vec::new();
        state.announce_with(SESSION, Some("Auth login fix".into()), collect(&mut events));
        state.mark_generated();
        assert!(state.announce_with(OTHER_SESSION, None, collect(&mut events)));
        assert_eq!(events.last().unwrap().session_id, OTHER_SESSION);
        assert_eq!(events.last().unwrap().title, None);
        assert!(
            !state.has_title(),
            "a new session after /clear starts without a title"
        );
    }

    #[test]
    fn a_generated_title_counts_as_a_title_until_the_session_restarts() {
        let state = state();
        assert!(!state.has_title());
        state.mark_generated();
        assert!(state.has_title());
        state.reset();
        assert!(!state.has_title());
    }

    #[test]
    fn only_one_title_request_is_in_flight_per_session() {
        let state = state();
        assert!(state.begin_request());
        assert!(!state.begin_request());
        assert!(state.request_in_flight.load(Ordering::SeqCst));
        state.end_request();
        assert!(state.begin_request());
        state.reset();
        assert!(!state.request_in_flight.load(Ordering::SeqCst));
    }

    #[test]
    fn a_failed_emit_is_logged_not_propagated() {
        let state = state();
        let announced = state.announce_with(SESSION, Some("Auth fix".into()), |_| {
            Err("webview gone".to_string())
        });
        assert!(announced);
        assert!(state.has_title());
    }

    #[test]
    fn a_plain_message_asks_for_a_title_once_and_a_command_never() {
        let state = state();
        let channel = control_channel::ControlChannel::default();
        let mut sink = Vec::new();
        assert!(!state.maybe_request("/model claude-sonnet-5", |_| {
            panic!("a command asks for no title")
        }));
        assert!(state.maybe_request("  pierwsza  ", |description| {
            assert_eq!(description, "pierwsza");
            channel.send_generate_title(&mut sink, description)
        }));
        assert!(
            !state.maybe_request("druga, gdy pierwsze żądanie trwa", |_| {
                panic!("one request at a time")
            })
        );
        channel.close();
        let written = String::from_utf8(sink).unwrap();
        assert!(written.contains("\"subtype\":\"generate_session_title\""));
        assert!(written.contains("\"persist\":true"));
    }

    #[test]
    fn no_request_is_made_once_the_session_has_a_title() {
        let state = state();
        state.announce_with(SESSION, Some("Auth fix".into()), ok);
        assert!(!state.maybe_request("kolejna wiadomość", |_| {
            panic!("no request once the session has a title")
        }));
        assert!(!state.request_in_flight.load(Ordering::SeqCst));
    }

    #[test]
    fn a_request_that_cannot_be_written_frees_the_slot_for_the_next_message() {
        let state = state();
        assert!(!state.maybe_request("pierwsza", |_| Err(ControlError::SessionEnded)));
        assert!(!state.request_in_flight.load(Ordering::SeqCst));
        assert!(!state.has_title());
    }

    #[test]
    fn a_read_failure_keeps_the_known_title_and_announces_nothing() {
        let state = state();
        state.announce_with(SESSION, Some("Auth fix".into()), ok);
        assert!(!state.refresh_with(SESSION, |_| Err(std::io::Error::other("disk"))));
        assert!(state.has_title());
        assert!(state.refresh_with(SESSION, |_| Ok(None)));
        assert!(!state.has_title());
    }

    #[test]
    fn a_generated_title_is_announced_once_its_line_reaches_the_transcript() {
        let transcript = Mutex::new(Some(SESSION.to_string()));
        let mut reads = 0;
        let mut sleeps = 0;
        let mut announced = Vec::new();
        let found = poll_persisted_title(
            |session_id| {
                assert_eq!(session_id, SESSION);
                reads += 1;
                (reads == 3).then(|| "Auth login fix".to_string())
            },
            &transcript,
            || sleeps += 1,
            |session_id, title| {
                announced.push((session_id.to_string(), title));
                true
            },
        );
        assert!(found);
        assert_eq!(reads, 3);
        assert_eq!(sleeps, 2);
        assert_eq!(
            announced,
            vec![(SESSION.to_string(), "Auth login fix".to_string())]
        );
    }

    #[test]
    fn the_poll_gives_up_after_its_budget_and_leaves_the_result_read_to_catch_up() {
        let transcript = Mutex::new(Some(SESSION.to_string()));
        let mut reads = 0;
        let mut sleeps = 0;
        let found = poll_persisted_title(
            |_| {
                reads += 1;
                None
            },
            &transcript,
            || sleeps += 1,
            |_, _| panic!("nothing to announce"),
        );
        assert!(!found);
        assert_eq!(reads, PERSIST_POLLS);
        assert_eq!(sleeps, PERSIST_POLLS - 1);
    }

    #[test]
    fn the_poll_does_nothing_before_the_session_reports_its_id() {
        let transcript = Mutex::new(None);
        let found = poll_persisted_title(
            |_| panic!("no read without a session id"),
            &transcript,
            || panic!("no wait without a session id"),
            |_, _| panic!("nothing to announce"),
        );
        assert!(!found);
    }

    #[test]
    fn title_changed_event_matches_its_ts_mirror() {
        let src = include_str!("../../src/src/app/models/chat.ts");
        assert!(
            src.contains(&format!("'{TITLE_CHANGED_EVENT}'")),
            "chat.ts must name the {TITLE_CHANGED_EVENT} event"
        );
        let sample = TitleChangedEvent {
            project: "proj".into(),
            tab_id: "tab".into(),
            session_id: SESSION.into(),
            title: None,
        };
        assert_eq!(
            crate::ts_mirror::rust_fields(&sample),
            crate::ts_mirror::ts_interface_fields(src, "ChatTitleChangedEvent")
        );
    }
}

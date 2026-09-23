use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use crate::chat::ChatSession;

pub(crate) const MSG_TRANSCRIPT_OPEN_IN_OTHER_TAB: &str =
    "conversation is already open in another tab";

pub(crate) fn validate_tab_id(tab_id: &str) -> Result<(), String> {
    crate::history::validate_session_id(tab_id).map_err(|e| e.to_string())
}

#[derive(Clone)]
pub(crate) struct TabEntry {
    pub(crate) session: Arc<Mutex<ChatSession>>,
    pub(crate) start_serialize: Arc<Mutex<()>>,
    pub(crate) project: String,
    pub(crate) transcript: Arc<Mutex<Option<String>>>,
    seq: u64,
}

#[derive(Default)]
pub struct ChatSessions {
    tabs: Mutex<HashMap<String, TabEntry>>,
    next_seq: AtomicU64,
}

pub type SharedChatSessions = Arc<ChatSessions>;

impl ChatSessions {
    fn lock_tabs(&self) -> std::sync::MutexGuard<'_, HashMap<String, TabEntry>> {
        self.tabs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn prepare(&self, tab_id: &str, project: &str) -> TabEntry {
        let mut tabs = self.lock_tabs();
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        match tabs.get_mut(tab_id) {
            Some(entry) if entry.project == project => {
                entry.seq = seq;
                entry.clone()
            }
            _ => {
                let transcript = Arc::new(Mutex::new(None));
                let entry = TabEntry {
                    session: Arc::new(Mutex::new(ChatSession::new(
                        project,
                        tab_id,
                        transcript.clone(),
                    ))),
                    start_serialize: Arc::new(Mutex::new(())),
                    project: project.to_string(),
                    transcript,
                    seq,
                };
                tabs.insert(tab_id.to_string(), entry.clone());
                entry
            }
        }
    }

    pub(crate) fn entry(&self, tab_id: &str) -> Option<TabEntry> {
        self.lock_tabs().get(tab_id).cloned()
    }

    pub(crate) fn remove(&self, tab_id: &str) -> Option<Arc<Mutex<ChatSession>>> {
        self.lock_tabs().remove(tab_id).map(|e| e.session)
    }

    pub(crate) fn drain_all(&self) -> Vec<Arc<Mutex<ChatSession>>> {
        self.lock_tabs().drain().map(|(_, e)| e.session).collect()
    }

    pub(crate) fn entry_for_project(&self, project: &str) -> Option<TabEntry> {
        self.lock_tabs()
            .values()
            .filter(|e| e.project == project)
            .max_by_key(|e| e.seq)
            .cloned()
    }

    pub(crate) fn any_for_project(&self, project: &str) -> Option<Arc<Mutex<ChatSession>>> {
        self.entry_for_project(project).map(|e| e.session)
    }

    pub(crate) fn claim_transcript(
        &self,
        tab_id: &str,
        transcript: Option<&str>,
    ) -> Result<(), String> {
        let tabs = self.lock_tabs();
        if let Some(sid) = transcript {
            let taken_elsewhere = tabs.iter().any(|(id, e)| {
                id != tab_id
                    && e.transcript
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .as_deref()
                        == Some(sid)
            });
            if taken_elsewhere {
                return Err(MSG_TRANSCRIPT_OPEN_IN_OTHER_TAB.to_string());
            }
        }
        if let Some(entry) = tabs.get(tab_id) {
            *entry
                .transcript
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = transcript.map(str::to_string);
        }
        Ok(())
    }

    pub(crate) fn other_entry_for_project(&self, project: &str, tab_id: &str) -> bool {
        self.lock_tabs()
            .iter()
            .any(|(id, e)| id != tab_id && e.project == project)
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::{Arc, ChatSessions, SharedChatSessions, TabEntry};

    pub(crate) const TEST_TAB_ID: &str = "550e8400-e29b-41d4-a716-446655440000";

    pub(crate) fn registry_with(project: &str) -> (SharedChatSessions, TabEntry) {
        let reg: SharedChatSessions = Arc::new(ChatSessions::default());
        let entry = reg.prepare(TEST_TAB_ID, project);
        (reg, entry)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;

    const TAB_A: &str = "550e8400-e29b-41d4-a716-446655440000";
    const TAB_B: &str = "550e8400-e29b-41d4-a716-446655440001";
    const SID: &str = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

    #[test]
    fn valid_uuid_tab_id_is_accepted_and_junk_is_rejected() {
        assert!(validate_tab_id(TAB_A).is_ok());
        assert!(validate_tab_id("").is_err());
        assert!(validate_tab_id("../../etc/passwd").is_err());
        assert!(validate_tab_id("550E8400-E29B-41D4-A716-446655440000").is_err());
    }

    #[test]
    fn prepare_is_idempotent_per_tab_and_isolated_across_tabs() {
        let reg = ChatSessions::default();
        let a1 = reg.prepare(TAB_A, "acme");
        let a2 = reg.prepare(TAB_A, "acme");
        assert!(Arc::ptr_eq(&a1.session, &a2.session));
        assert!(Arc::ptr_eq(&a1.start_serialize, &a2.start_serialize));
        let b = reg.prepare(TAB_B, "acme");
        assert!(!Arc::ptr_eq(&a1.session, &b.session));
    }

    #[test]
    fn prepare_with_a_different_project_replaces_the_entry() {
        let reg = ChatSessions::default();
        let old = reg.prepare(TAB_A, "acme");
        let new = reg.prepare(TAB_A, "globex");
        assert!(!Arc::ptr_eq(&old.session, &new.session));
        assert_eq!(new.project, "globex");
    }

    #[test]
    fn any_for_project_prefers_the_most_recently_prepared_entry() {
        let reg = ChatSessions::default();
        let a = reg.prepare(TAB_A, "acme");
        let b = reg.prepare(TAB_B, "acme");
        assert!(Arc::ptr_eq(
            &reg.any_for_project("acme").unwrap(),
            &b.session
        ));
        let a_again = reg.prepare(TAB_A, "acme");
        assert!(Arc::ptr_eq(
            &reg.any_for_project("acme").unwrap(),
            &a_again.session
        ));
        assert!(reg.any_for_project("other").is_none());
        let _ = a;
    }

    #[test]
    fn claim_transcript_blocks_a_second_tab_and_frees_on_remove() {
        let reg = ChatSessions::default();
        reg.prepare(TAB_A, "acme");
        reg.prepare(TAB_B, "acme");
        reg.claim_transcript(TAB_A, Some(SID)).unwrap();
        let err = reg.claim_transcript(TAB_B, Some(SID)).unwrap_err();
        assert_eq!(err, MSG_TRANSCRIPT_OPEN_IN_OTHER_TAB);
        reg.claim_transcript(TAB_A, Some(SID)).unwrap();
        reg.remove(TAB_A).unwrap();
        reg.claim_transcript(TAB_B, Some(SID)).unwrap();
    }

    #[test]
    fn claim_transcript_with_none_clears_the_slot() {
        let reg = ChatSessions::default();
        reg.prepare(TAB_A, "acme");
        reg.prepare(TAB_B, "acme");
        reg.claim_transcript(TAB_A, Some(SID)).unwrap();
        reg.claim_transcript(TAB_A, None).unwrap();
        reg.claim_transcript(TAB_B, Some(SID)).unwrap();
    }

    #[test]
    fn drain_all_empties_the_registry() {
        let reg = ChatSessions::default();
        reg.prepare(TAB_A, "acme");
        reg.prepare(TAB_B, "globex");
        assert_eq!(reg.drain_all().len(), 2);
        assert!(reg.entry(TAB_A).is_none());
        assert!(reg.entry(TAB_B).is_none());
    }

    #[test]
    fn other_entry_for_project_sees_only_sibling_tabs_of_the_same_project() {
        let reg = ChatSessions::default();
        reg.prepare(TAB_A, "acme");
        assert!(!reg.other_entry_for_project("acme", TAB_A));
        reg.prepare(TAB_B, "globex");
        assert!(!reg.other_entry_for_project("acme", TAB_A));
        reg.prepare(TAB_B, "acme");
        assert!(reg.other_entry_for_project("acme", TAB_A));
    }

    #[test]
    fn entry_for_project_returns_the_most_recent_full_entry() {
        let reg = ChatSessions::default();
        reg.prepare(TAB_A, "acme");
        let b = reg.prepare(TAB_B, "acme");
        let entry = reg.entry_for_project("acme").unwrap();
        assert!(Arc::ptr_eq(&entry.session, &b.session));
        assert!(Arc::ptr_eq(&entry.start_serialize, &b.start_serialize));
        assert_eq!(entry.project, "acme");
        assert!(reg.entry_for_project("other").is_none());
    }

    #[test]
    fn prepare_assigns_the_seq_under_the_map_lock() {
        let source = include_str!("chat_registry.rs");
        let after_sig = source
            .split("fn prepare(")
            .nth(1)
            .expect("prepare must exist");
        let body = &after_sig[..after_sig.find("\n    }").expect("prepare must close")];
        let lock_pos = body.find("lock_tabs").expect("prepare must lock the map");
        let seq_pos = body.find("fetch_add").expect("prepare must bump the seq");
        assert!(
            lock_pos < seq_pos,
            "the seq must be assigned under the map lock so seq order matches insertion order"
        );
    }

    #[test]
    fn test_support_registry_with_prepares_one_tab_for_the_project() {
        let (reg, entry) = test_support::registry_with("acme");
        assert_eq!(entry.project, "acme");
        assert!(Arc::ptr_eq(
            &reg.entry(test_support::TEST_TAB_ID).unwrap().session,
            &entry.session
        ));
    }
}

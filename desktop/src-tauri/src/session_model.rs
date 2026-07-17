//! Chronological session-model tracking: the LAST init or real assistant model
//! wins, never cumulative-usage dominance (a mid-session /model switch must stick).

pub(crate) const SYNTHETIC_MODEL: &str = "<synthetic>";

#[derive(Default)]
pub(crate) struct SessionModelTracker {
    last: Option<String>,
}

impl SessionModelTracker {
    pub(crate) fn observe_init(&mut self, model: &str) {
        if !model.is_empty() {
            self.last = Some(model.to_string());
        }
    }

    pub(crate) fn observe_assistant(&mut self, model: &str) {
        if !model.is_empty() && model != SYNTHETIC_MODEL {
            self.last = Some(model.to_string());
        }
    }

    pub(crate) fn resolve(&self) -> Option<&str> {
        self.last.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_then_later_init_wins_chronologically() {
        let mut t = SessionModelTracker::default();
        t.observe_init("claude-fable-5");
        t.observe_assistant("claude-fable-5");
        t.observe_init("claude-sonnet-5");
        t.observe_assistant("claude-sonnet-5");
        assert_eq!(t.resolve(), Some("claude-sonnet-5"));
    }

    #[test]
    fn synthetic_and_empty_assistant_models_are_ignored() {
        let mut t = SessionModelTracker::default();
        t.observe_init("claude-fable-5");
        t.observe_assistant(SYNTHETIC_MODEL);
        t.observe_assistant("");
        assert_eq!(t.resolve(), Some("claude-fable-5"));
    }

    #[test]
    fn assistant_model_wins_when_no_init_seen() {
        let mut t = SessionModelTracker::default();
        t.observe_assistant("claude-haiku-4-5");
        assert_eq!(t.resolve(), Some("claude-haiku-4-5"));
    }

    #[test]
    fn resolves_none_when_nothing_observed() {
        assert_eq!(SessionModelTracker::default().resolve(), None);
    }
}

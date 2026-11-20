use chrono::{SecondsFormat, Utc};

use super::RefreshOutcome;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Status {
    Clear,
    ReconnectRequired,
    NetworkError,
}

impl Status {
    pub(super) fn of(outcome: RefreshOutcome) -> Self {
        match outcome {
            RefreshOutcome::ReconnectRequired => Self::ReconnectRequired,
            RefreshOutcome::NetworkError => Self::NetworkError,
            RefreshOutcome::Refreshed | RefreshOutcome::NotDue => Self::Clear,
        }
    }

    pub(super) fn file_content(self) -> String {
        let state = match self {
            Self::Clear => return String::new(),
            Self::ReconnectRequired => "reconnect_required",
            Self::NetworkError => "network_error",
        };
        serde_json::json!({
            "state": state,
            "at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        })
        .to_string()
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    #[test]
    fn failures_carry_their_state_and_a_timestamp() {
        for (outcome, state) in [
            (RefreshOutcome::ReconnectRequired, "reconnect_required"),
            (RefreshOutcome::NetworkError, "network_error"),
        ] {
            let content = Status::of(outcome).file_content();
            let json: serde_json::Value = serde_json::from_str(&content).unwrap();
            assert_eq!(json["state"], state);
            let at = json["at"].as_str().unwrap();
            assert!(chrono::DateTime::parse_from_rfc3339(at).is_ok(), "{at}");
        }
    }

    #[test]
    fn success_or_a_fresh_token_clears_the_status() {
        for outcome in [RefreshOutcome::Refreshed, RefreshOutcome::NotDue] {
            assert_eq!(Status::of(outcome), Status::Clear);
        }
        assert_eq!(Status::Clear.file_content(), "");
    }
}

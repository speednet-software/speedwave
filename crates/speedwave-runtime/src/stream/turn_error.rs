//! Classification of the `error` code on an `assistant` stream-json message.

use serde::{Deserialize, Serialize};

/// Reason a turn ended in an error that the UI handles differently from a plain failure.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnErrorKind {
    /// The provider rejected the credentials.
    AuthenticationFailed,
}

/// Maps the `error` code of an `assistant` message to a kind; other codes stay plain errors.
pub fn classify_turn_error(code: &str) -> Option<TurnErrorKind> {
    match code {
        "authentication_failed" => Some(TurnErrorKind::AuthenticationFailed),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authentication_failed_is_classified() {
        assert_eq!(
            classify_turn_error("authentication_failed"),
            Some(TurnErrorKind::AuthenticationFailed)
        );
    }

    #[test]
    fn other_codes_stay_plain_errors() {
        for code in ["server_error", "rate_limit", "unknown", ""] {
            assert_eq!(classify_turn_error(code), None, "{code}");
        }
    }

    #[test]
    fn kind_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(TurnErrorKind::AuthenticationFailed).unwrap(),
            serde_json::json!("authentication_failed")
        );
    }
}

//! Classification of the `error` code on an `assistant` stream-json message.

use serde::{Deserialize, Serialize};

/// Kind of a turn error.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnErrorKind {
    /// The provider rejected the credentials.
    AuthenticationFailed,
}

/// Maps the `error` code of an `assistant` message to a kind.
pub fn classify_turn_error(code: &str) -> Option<TurnErrorKind> {
    match code {
        "authentication_failed" => Some(TurnErrorKind::AuthenticationFailed),
        _ => None,
    }
}

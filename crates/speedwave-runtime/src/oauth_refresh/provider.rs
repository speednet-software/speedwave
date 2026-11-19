use std::collections::BTreeMap;

use super::{generic, microsoft, slack};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum GrantType {
    RefreshToken,
    ClientCredentials,
}

impl GrantType {
    pub(super) fn parse(raw: &str) -> Option<Self> {
        match raw {
            "refresh_token" => Some(Self::RefreshToken),
            "client_credentials" => Some(Self::ClientCredentials),
            _ => None,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::RefreshToken => "refresh_token",
            Self::ClientCredentials => "client_credentials",
        }
    }
}

pub(super) struct RefreshRequest<'a> {
    pub(super) grant_type: GrantType,
    pub(super) refresh_token: &'a str,
    pub(super) scopes: &'a [String],
    pub(super) provider_data: &'a BTreeMap<String, String>,
}

pub(super) struct RefreshResponse {
    pub(super) access_token: String,
    pub(super) refresh_token: Option<String>,
    pub(super) expires_in: u64,
    pub(super) granted_scopes: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum ErrorCode {
    ScopeMismatch,
    InvalidGrant,
    Network,
    Http,
    Malformed,
    MissingField,
    InvalidConfig,
    MalformedState,
    UnknownProvider,
    PersistFailed,
}

impl ErrorCode {
    pub(super) fn slug(self) -> &'static str {
        match self {
            Self::ScopeMismatch => "scope_mismatch",
            Self::InvalidGrant => "invalid_grant",
            Self::Network => "network",
            Self::Http => "http",
            Self::Malformed => "malformed",
            Self::MissingField => "missing_field",
            Self::InvalidConfig => "invalid_config",
            Self::MalformedState => "malformed_state",
            Self::UnknownProvider => "unknown_provider",
            Self::PersistFailed => "persist_failed",
        }
    }

    pub(super) fn needs_reconnect(self) -> bool {
        match self {
            Self::ScopeMismatch
            | Self::InvalidGrant
            | Self::MissingField
            | Self::InvalidConfig
            | Self::MalformedState
            | Self::UnknownProvider => true,
            Self::Network | Self::Http | Self::Malformed | Self::PersistFailed => false,
        }
    }
}

pub(super) fn refresh(
    provider: &str,
    req: &RefreshRequest<'_>,
) -> Result<RefreshResponse, ErrorCode> {
    match provider {
        "slack" => slack::refresh(req),
        "microsoft" => microsoft::refresh(req),
        "generic" => generic::refresh(req),
        _ => Err(ErrorCode::UnknownProvider),
    }
}

pub(super) fn non_empty<'a>(
    map: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str, ErrorCode> {
    map.get(key)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(ErrorCode::MissingField)
}

pub(super) fn json_str<'a>(
    body: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    body.get(key).and_then(serde_json::Value::as_str)
}

pub(super) fn positive_secs(value: Option<&serde_json::Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().filter(|n| *n > 0).or_else(|| {
        value
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 1.0)
            .map(|f| f as u64)
    })
}

pub(super) fn split_scopes(raw: &str) -> Vec<String> {
    raw.split_whitespace().map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejections_need_a_reconnect_and_transport_failures_do_not() {
        assert!(ErrorCode::InvalidGrant.needs_reconnect());
        assert!(ErrorCode::ScopeMismatch.needs_reconnect());
        assert!(ErrorCode::MalformedState.needs_reconnect());
        assert!(!ErrorCode::Network.needs_reconnect());
        assert!(!ErrorCode::Http.needs_reconnect());
        assert!(!ErrorCode::Malformed.needs_reconnect());
    }

    #[test]
    fn unknown_provider_is_rejected_before_any_request() {
        let data = BTreeMap::new();
        let req = RefreshRequest {
            grant_type: GrantType::RefreshToken,
            refresh_token: "r",
            scopes: &[],
            provider_data: &data,
        };
        assert_eq!(
            refresh("nope", &req).err(),
            Some(ErrorCode::UnknownProvider)
        );
    }

    #[test]
    fn positive_secs_accepts_integers_and_whole_floats_only_when_positive() {
        let int = serde_json::json!(3600);
        let float = serde_json::json!(3600.0);
        let zero = serde_json::json!(0);
        let text = serde_json::json!("3600");
        assert_eq!(positive_secs(Some(&int)), Some(3600));
        assert_eq!(positive_secs(Some(&float)), Some(3600));
        assert_eq!(positive_secs(Some(&zero)), None);
        assert_eq!(positive_secs(Some(&text)), None);
        assert_eq!(positive_secs(None), None);
    }

    #[test]
    fn grant_type_round_trips_its_wire_names() {
        for grant in [GrantType::RefreshToken, GrantType::ClientCredentials] {
            assert_eq!(GrantType::parse(grant.as_str()), Some(grant));
        }
        assert_eq!(GrantType::parse("device_code"), None);
    }
}

use crate::error::CryptoError;
use crate::hex;
use crate::key::Key;
use hkdf::Hkdf;
use sha2::Sha256;

const INFO_PREFIX: &[u8] = b"speedwave-token-v1";

/// Derives a 64-char lowercase hex token bound to purpose, project and service (HKDF-SHA256).
pub fn derive_token(
    key: &Key,
    purpose: &str,
    project: &str,
    service: &str,
) -> Result<String, CryptoError> {
    let mut info = INFO_PREFIX.to_vec();
    for part in [purpose, project, service] {
        push_length_prefixed(&mut info, part.as_bytes())?;
    }
    let hkdf = Hkdf::<Sha256>::new(None, key.as_bytes());
    let mut okm = [0u8; 32];
    hkdf.expand(&info, &mut okm)
        .map_err(|_| CryptoError::Crypto)?;
    Ok(hex::encode(&okm))
}

fn push_length_prefixed(info: &mut Vec<u8>, part: &[u8]) -> Result<(), CryptoError> {
    let len = u32::try_from(part.len()).map_err(|_| CryptoError::Crypto)?;
    info.extend_from_slice(&len.to_be_bytes());
    info.extend_from_slice(part);
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn test_key() -> Key {
        Key::from_bytes([7u8; 32])
    }

    fn token(purpose: &str, project: &str, service: &str) -> String {
        derive_token(&test_key(), purpose, project, service).unwrap()
    }

    #[test]
    fn matches_the_frozen_vector() {
        assert_eq!(
            token("bearer", "demo", "slack"),
            "901cc367bb835503fbbdbedf51dc7576d89835292f6a9d6f1a07148bca3e14f7"
        );
    }

    #[test]
    fn same_inputs_give_the_same_token() {
        assert_eq!(
            token("bearer", "demo", "slack"),
            token("bearer", "demo", "slack")
        );
    }

    #[test]
    fn purpose_project_and_service_each_change_the_token() {
        let base = token("bearer", "demo", "slack");
        assert_ne!(base, token("other", "demo", "slack"));
        assert_ne!(base, token("bearer", "other", "slack"));
        assert_ne!(base, token("bearer", "demo", "other"));
    }

    #[test]
    fn shifting_a_boundary_between_fields_changes_the_token() {
        assert_ne!(token("bearer", "ab", "c"), token("bearer", "a", "bc"));
        assert_ne!(token("ab", "c", "d"), token("a", "bc", "d"));
    }

    #[test]
    fn a_different_key_changes_the_token() {
        let other = Key::from_bytes([8u8; 32]);
        let derived = derive_token(&other, "bearer", "demo", "slack").unwrap();
        assert_ne!(derived, token("bearer", "demo", "slack"));
    }

    #[test]
    fn token_is_64_lowercase_hex_chars() {
        let derived = token("bearer", "demo", "slack");
        assert_eq!(derived.len(), 64);
        assert!(derived
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn empty_fields_still_derive_a_distinct_token() {
        assert_ne!(token("", "", ""), token("bearer", "demo", "slack"));
        assert_eq!(token("", "", "").len(), 64);
    }
}

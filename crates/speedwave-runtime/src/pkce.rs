//! PKCE (RFC 7636) + CSRF `state` generation for the authorization_code flow.

use base64::Engine;
use rand::Rng;
use sha2::{Digest, Sha256};

/// A PKCE code verifier + its S256 challenge.
pub struct PkcePair {
    /// High-entropy secret kept host-side; sent on the token exchange.
    pub verifier: String,
    /// `base64url(sha256(verifier))`; sent on the authorize redirect.
    pub challenge: String,
}

/// 32 random bytes from the thread-local CSPRNG, base64url-no-pad
/// (RFC 7636 §4.1 allows 43–128 chars).
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Generate a fresh PKCE verifier + S256 challenge.
pub fn generate_pkce() -> PkcePair {
    let verifier = random_token();
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    PkcePair {
        verifier,
        challenge,
    }
}

/// Generate a random CSRF `state` value for the authorize redirect.
pub fn generate_state() -> String {
    random_token()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_s256_of_verifier() {
        let pair = generate_pkce();
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(pair.verifier.as_bytes()));
        assert_eq!(pair.challenge, expected);
    }

    #[test]
    fn verifier_length_in_rfc_range() {
        // 32 bytes → 43 base64url chars, within RFC 7636 §4.1 [43,128].
        let pair = generate_pkce();
        assert!((43..=128).contains(&pair.verifier.len()));
    }

    #[test]
    fn tokens_are_url_safe_no_pad() {
        let pair = generate_pkce();
        for s in [&pair.verifier, &pair.challenge, &generate_state()] {
            assert!(
                !s.contains('+') && !s.contains('/') && !s.contains('='),
                "not url-safe: {s}"
            );
        }
    }

    #[test]
    fn successive_values_differ() {
        assert_ne!(generate_pkce().verifier, generate_pkce().verifier);
        assert_ne!(generate_state(), generate_state());
    }
}

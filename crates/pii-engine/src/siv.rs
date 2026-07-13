//! AES-128-SIV (RFC 5297) deterministic authenticated encryption core.
//! Category name is bound in as AAD so ciphertexts cannot be replayed across categories.

use aes_siv::siv::Aes128Siv;
use aes_siv::KeyInit;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use std::fmt;
use zeroize::Zeroize;

/// 32-byte per-project tokenization key (AES-128-SIV per RFC 5297: SIV keys are double-width).
pub struct EngineKey([u8; 32]);

impl EngineKey {
    /// Builds a key from 32 raw bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

impl Drop for EngineKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Sealing, opening, or payload-decoding failure; the variant never reveals which check failed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SivError {
    /// SIV tag verification failed, or the ciphertext is too short to contain a tag.
    Crypto,
    /// base64url payload decoding failed.
    Encoding,
}

impl fmt::Display for SivError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Crypto => write!(f, "SIV authentication or format check failed"),
            Self::Encoding => write!(f, "payload encoding is invalid"),
        }
    }
}

impl std::error::Error for SivError {}

/// Deterministic authenticated encryption: same (key, category, value) => same ciphertext.
pub(crate) fn seal(key: &EngineKey, category: &str, value: &[u8]) -> Result<Vec<u8>, SivError> {
    let mut cipher = Aes128Siv::new(&key.0.into());
    cipher
        .encrypt([category.as_bytes()], value)
        .map_err(|_| SivError::Crypto)
}

/// Verifies the SIV tag; any corruption or category mismatch is an error, never a panic.
pub(crate) fn open(
    key: &EngineKey,
    category: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, SivError> {
    let mut cipher = Aes128Siv::new(&key.0.into());
    cipher
        .decrypt([category.as_bytes()], ciphertext)
        .map_err(|_| SivError::Crypto)
}

/// Encodes a ciphertext as a base64url payload without padding (URL_SAFE_NO_PAD).
pub(crate) fn encode_payload(ciphertext: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(ciphertext)
}

/// Decodes a base64url-without-padding payload back into ciphertext bytes.
pub(crate) fn decode_payload(s: &str) -> Result<Vec<u8>, SivError> {
    URL_SAFE_NO_PAD.decode(s).map_err(|_| SivError::Encoding)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn test_key() -> EngineKey {
        EngineKey::from_bytes([7u8; 32])
    }

    #[test]
    fn seal_is_deterministic() {
        let key = test_key();
        let a = seal(&key, "EMAIL", b"alice@example.com").unwrap();
        let b = seal(&key, "EMAIL", b"alice@example.com").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn tag_flip_fails_open_without_panicking() {
        let key = test_key();
        let mut ciphertext = seal(&key, "EMAIL", b"alice@example.com").unwrap();
        ciphertext[0] ^= 0x01;
        let result = open(&key, "EMAIL", &ciphertext);
        assert_eq!(result, Err(SivError::Crypto));
    }

    #[test]
    fn category_changes_ciphertext_and_is_checked_on_open() {
        let key = test_key();
        let email_ct = seal(&key, "EMAIL", b"same-value").unwrap();
        let phone_ct = seal(&key, "PHONE_PL", b"same-value").unwrap();
        assert_ne!(email_ct, phone_ct);
        assert_eq!(open(&key, "PHONE_PL", &email_ct), Err(SivError::Crypto));
    }

    #[test]
    fn roundtrip_unicode_empty_and_large_values() {
        let key = test_key();
        for value in [
            "żółć@example.pl".as_bytes().to_vec(),
            Vec::new(),
            vec![0x42u8; 1000],
        ] {
            let ciphertext = seal(&key, "EMAIL", &value).unwrap();
            let plaintext = open(&key, "EMAIL", &ciphertext).unwrap();
            assert_eq!(plaintext, value);
        }
    }

    #[test]
    fn ciphertext_overhead_is_exactly_16_bytes() {
        let key = test_key();
        for len in [0usize, 1, 17, 1000] {
            let value = vec![0xABu8; len];
            let ciphertext = seal(&key, "EMAIL", &value).unwrap();
            assert_eq!(ciphertext.len(), value.len() + 16);
        }
    }

    #[test]
    fn payload_roundtrips_and_rejects_invalid_base64() {
        let bytes = vec![0u8, 1, 2, 253, 254, 255];
        let encoded = encode_payload(&bytes);
        assert_eq!(
            decode_payload(&encoded).expect("valid payload must decode"),
            bytes
        );
        assert!(!encoded.contains('='));
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
        assert_eq!(decode_payload("nie-base64!@#"), Err(SivError::Encoding));
    }

    #[test]
    fn different_keys_produce_different_ciphertexts() {
        let key_a = EngineKey::from_bytes([1u8; 32]);
        let key_b = EngineKey::from_bytes([2u8; 32]);
        let ct_a = seal(&key_a, "EMAIL", b"same-value").unwrap();
        let ct_b = seal(&key_b, "EMAIL", b"same-value").unwrap();
        assert_ne!(ct_a, ct_b);
    }
}

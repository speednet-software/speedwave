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

    /// Decodes 64 lowercase-or-uppercase hex chars (trimmed) into a 32-byte key; fails
    /// closed on any length or non-hex mismatch, never carrying key material in the error.
    pub fn from_hex(s: &str) -> Result<Self, SivError> {
        let trimmed = s.trim();
        if trimmed.len() != 64 {
            return Err(SivError::Encoding);
        }
        let mut bytes = [0u8; 32];
        for (i, chunk) in trimmed.as_bytes().chunks(2).enumerate() {
            let pair = std::str::from_utf8(chunk).map_err(|_| SivError::Encoding)?;
            bytes[i] = u8::from_str_radix(pair, 16).map_err(|_| SivError::Encoding)?;
        }
        Ok(Self(bytes))
    }
}

impl Drop for EngineKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Sealing, opening, or payload-decoding failure; the variant never reveals which check failed.
#[derive(Debug, PartialEq, Eq)]
pub enum SivError {
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

    /// Frozen pseudonyms: a crypto-dependency change that alters this output would orphan
    /// every token already written into stored session transcripts.
    #[test]
    fn seal_output_matches_frozen_vectors() {
        let key = test_key();
        for (category, value, expected) in [
            (
                "EMAIL",
                "alice@example.com",
                "DwxnusR1yFfnSg-V-AwbwfYXbo0kqSIEksBkkIpf7v6C",
            ),
            (
                "PHONE_PL",
                "+48123456789",
                "I6m9-JFyYryQqVPHSC88wAjJwzFgHTEuVkVLdg",
            ),
        ] {
            let sealed = seal(&key, category, value.as_bytes()).unwrap();
            assert_eq!(encode_payload(&sealed), expected, "category {category}");
        }
    }

    /// Guards the `zeroize` feature on the `aes-siv` dependency: without it the cipher stops
    /// wiping the encryption key half on drop.
    #[test]
    fn siv_cipher_wipes_its_key_on_drop() {
        fn assert_zeroize_on_drop<T: zeroize::ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<Aes128Siv>();
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

    #[test]
    fn from_hex_trimmed_and_uppercase_decodes_the_expected_bytes() {
        let from_hex_key = EngineKey::from_hex(&format!("  {}  ", "AB".repeat(32)))
            .expect("trimmed uppercase 64-hex decodes");
        let expected_key = EngineKey::from_bytes([0xABu8; 32]);
        assert_eq!(
            seal(&from_hex_key, "EMAIL", b"same-value").unwrap(),
            seal(&expected_key, "EMAIL", b"same-value").unwrap()
        );
    }

    #[test]
    fn from_hex_rejects_wrong_length() {
        assert!(matches!(EngineKey::from_hex(""), Err(SivError::Encoding)));
        assert!(matches!(
            EngineKey::from_hex(&"ab".repeat(31)),
            Err(SivError::Encoding)
        ));
        assert!(matches!(
            EngineKey::from_hex(&"ab".repeat(33)),
            Err(SivError::Encoding)
        ));
    }

    #[test]
    fn from_hex_rejects_non_hex_characters() {
        let bad = format!("{}zz", "a".repeat(62));
        assert!(matches!(EngineKey::from_hex(&bad), Err(SivError::Encoding)));
    }
}

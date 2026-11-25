use crate::error::CryptoError;
use crate::hex;
use aes_siv::siv::Aes128Siv;
use aes_siv::KeyInit;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

/// 32-byte secret key (AES-128-SIV per RFC 5297: SIV keys are double-width).
pub struct Key([u8; 32]);

impl Key {
    /// Builds a key from 32 raw bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Decodes 64 hex chars (trimmed, either case) into a key; fails closed on any
    /// length or non-hex mismatch without carrying key material in the error.
    pub fn from_hex(s: &str) -> Result<Self, CryptoError> {
        let trimmed = s.trim();
        if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CryptoError::Encoding);
        }
        let mut bytes = [0u8; 32];
        for (i, chunk) in trimmed.as_bytes().chunks(2).enumerate() {
            let pair = std::str::from_utf8(chunk).map_err(|_| CryptoError::Encoding)?;
            bytes[i] = u8::from_str_radix(pair, 16).map_err(|_| CryptoError::Encoding)?;
        }
        Ok(Self(bytes))
    }

    /// Public key identifier: the first 4 bytes of SHA-256 over the key as 8 lowercase hex chars.
    pub fn id(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.0);
        let digest = hasher.finalize();
        hex::encode(&digest.as_slice()[..4])
    }

    pub(crate) fn siv_cipher(&self) -> Aes128Siv {
        Aes128Siv::new(&self.0.into())
    }

    pub(crate) fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::siv::seal_deterministic;

    #[test]
    fn siv_cipher_wipes_its_key_on_drop() {
        fn assert_zeroize_on_drop<T: zeroize::ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<Aes128Siv>();
    }

    #[test]
    fn from_hex_trimmed_and_uppercase_decodes_the_expected_bytes() {
        let from_hex_key = Key::from_hex(&format!("  {}  ", "AB".repeat(32))).unwrap();
        let expected_key = Key::from_bytes([0xABu8; 32]);
        assert_eq!(
            seal_deterministic(&from_hex_key, "EMAIL", b"same-value").unwrap(),
            seal_deterministic(&expected_key, "EMAIL", b"same-value").unwrap()
        );
    }

    #[test]
    fn id_matches_the_frozen_vector() {
        assert_eq!(Key::from_bytes([7u8; 32]).id(), "4bb06f8e");
    }

    #[test]
    fn id_is_8_lowercase_hex_chars_and_stable_per_key() {
        let key = Key::from_bytes([0xABu8; 32]);
        let id = key.id();
        assert_eq!(id.len(), 8);
        assert!(id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_eq!(id, Key::from_hex(&"AB".repeat(32)).unwrap().id());
    }

    #[test]
    fn id_differs_between_keys() {
        assert_ne!(
            Key::from_bytes([1u8; 32]).id(),
            Key::from_bytes([2u8; 32]).id()
        );
    }

    #[test]
    fn from_hex_rejects_wrong_length() {
        assert!(matches!(Key::from_hex(""), Err(CryptoError::Encoding)));
        assert!(matches!(
            Key::from_hex(&"ab".repeat(31)),
            Err(CryptoError::Encoding)
        ));
        assert!(matches!(
            Key::from_hex(&"ab".repeat(33)),
            Err(CryptoError::Encoding)
        ));
    }

    #[test]
    fn from_hex_rejects_non_hex_characters() {
        let bad = format!("{}zz", "a".repeat(62));
        assert!(matches!(Key::from_hex(&bad), Err(CryptoError::Encoding)));
        let signed = format!("+a{}", "a".repeat(62));
        assert!(matches!(Key::from_hex(&signed), Err(CryptoError::Encoding)));
    }
}

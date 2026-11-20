use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use speedwave_crypto::CryptoError;

pub(crate) fn encode_payload(ciphertext: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(ciphertext)
}

pub(crate) fn decode_payload(s: &str) -> Result<Vec<u8>, CryptoError> {
    URL_SAFE_NO_PAD.decode(s).map_err(|_| CryptoError::Encoding)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use speedwave_crypto::{seal_deterministic, Key};

    #[test]
    fn payload_roundtrips_and_rejects_invalid_base64() {
        let bytes = vec![0u8, 1, 2, 253, 254, 255];
        let encoded = encode_payload(&bytes);
        assert_eq!(decode_payload(&encoded).unwrap(), bytes);
        assert!(!encoded.contains('='));
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
        assert_eq!(decode_payload("nie-base64!@#"), Err(CryptoError::Encoding));
    }

    #[test]
    fn token_payload_matches_frozen_vectors() {
        let key = Key::from_bytes([7u8; 32]);
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
            let sealed = seal_deterministic(&key, category, value.as_bytes()).unwrap();
            assert_eq!(encode_payload(&sealed), expected, "category {category}");
        }
    }
}

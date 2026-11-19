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
}

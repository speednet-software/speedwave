use crate::error::CryptoError;
use crate::key::Key;
use std::iter;
use zeroize::Zeroizing;

const NONCE_LEN: usize = 16;
const TAG_LEN: usize = 16;

/// Deterministic AES-SIV: same key, category and value give the same ciphertext.
pub fn seal_deterministic(key: &Key, category: &str, value: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut cipher = key.siv_cipher();
    cipher
        .encrypt([category.as_bytes()], value)
        .map_err(|_| CryptoError::Crypto)
}

/// Verifies the tag and category, then decrypts; any mismatch is an error.
pub fn open_deterministic(
    key: &Key,
    category: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let mut cipher = key.siv_cipher();
    cipher
        .decrypt([category.as_bytes()], ciphertext)
        .map_err(|_| CryptoError::Crypto)
}

/// Nonce-based AES-SIV with each `aad` component as its own header; returns nonce then ciphertext.
pub fn seal_with_nonce(
    key: &Key,
    aad: &[&[u8]],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let mut cipher = key.siv_cipher();
    let ciphertext = cipher
        .encrypt(headers(aad, nonce), plaintext)
        .map_err(|_| CryptoError::Crypto)?;
    let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Opens a blob from `seal_with_nonce` under the same key and `aad`; the plaintext is wiped on drop.
pub fn open_with_nonce(
    key: &Key,
    aad: &[&[u8]],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if blob.len() < NONCE_LEN + TAG_LEN {
        return Err(CryptoError::Crypto);
    }
    let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
    let mut cipher = key.siv_cipher();
    cipher
        .decrypt(headers(aad, nonce), ciphertext)
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Crypto)
}

fn headers<'a>(aad: &'a [&'a [u8]], nonce: &'a [u8]) -> impl Iterator<Item = &'a [u8]> {
    aad.iter().copied().chain(iter::once(nonce))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::hex;

    const EMAIL_TOKEN: &[u8] = b"alice@example.com";

    fn test_key() -> Key {
        Key::from_bytes([7u8; 32])
    }

    fn open_err(key: &Key, aad: &[&[u8]], blob: &[u8]) -> CryptoError {
        open_with_nonce(key, aad, blob).err().unwrap()
    }

    #[test]
    fn seal_deterministic_matches_frozen_vectors() {
        let key = test_key();
        for (category, value, expected) in [
            (
                "EMAIL",
                EMAIL_TOKEN,
                "0f0c67bac475c857e74a0f95f80c1bc1f6176e8d24a9220492c064908a5feefe82",
            ),
            (
                "PHONE_PL",
                b"+48123456789".as_slice(),
                "23a9bdf8917262bc90a953c7482f3cc008c9c331601d312e56454b76",
            ),
        ] {
            let sealed = seal_deterministic(&key, category, value).unwrap();
            assert_eq!(hex::encode(&sealed), expected, "category {category}");
        }
    }

    #[test]
    fn seal_deterministic_is_deterministic() {
        let key = test_key();
        let a = seal_deterministic(&key, "EMAIL", EMAIL_TOKEN).unwrap();
        let b = seal_deterministic(&key, "EMAIL", EMAIL_TOKEN).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn tag_flip_fails_open_without_panicking() {
        let key = test_key();
        let mut ciphertext = seal_deterministic(&key, "EMAIL", EMAIL_TOKEN).unwrap();
        ciphertext[0] ^= 0x01;
        assert_eq!(
            open_deterministic(&key, "EMAIL", &ciphertext),
            Err(CryptoError::Crypto)
        );
    }

    #[test]
    fn category_changes_ciphertext_and_is_checked_on_open() {
        let key = test_key();
        let email_ct = seal_deterministic(&key, "EMAIL", b"same-value").unwrap();
        let phone_ct = seal_deterministic(&key, "PHONE_PL", b"same-value").unwrap();
        assert_ne!(email_ct, phone_ct);
        assert_eq!(
            open_deterministic(&key, "PHONE_PL", &email_ct),
            Err(CryptoError::Crypto)
        );
    }

    #[test]
    fn deterministic_roundtrip_unicode_empty_and_large_values() {
        let key = test_key();
        for value in [
            "żółć@example.pl".as_bytes().to_vec(),
            Vec::new(),
            vec![0x42u8; 1000],
        ] {
            let ciphertext = seal_deterministic(&key, "EMAIL", &value).unwrap();
            let plaintext = open_deterministic(&key, "EMAIL", &ciphertext).unwrap();
            assert_eq!(plaintext, value);
        }
    }

    #[test]
    fn deterministic_ciphertext_overhead_is_exactly_16_bytes() {
        let key = test_key();
        for len in [0usize, 1, 17, 1000] {
            let value = vec![0xABu8; len];
            let ciphertext = seal_deterministic(&key, "EMAIL", &value).unwrap();
            assert_eq!(ciphertext.len(), value.len() + 16);
        }
    }

    #[test]
    fn deterministic_different_keys_produce_different_ciphertexts() {
        let key_a = Key::from_bytes([1u8; 32]);
        let key_b = Key::from_bytes([2u8; 32]);
        let ct_a = seal_deterministic(&key_a, "EMAIL", b"same-value").unwrap();
        let ct_b = seal_deterministic(&key_b, "EMAIL", b"same-value").unwrap();
        assert_ne!(ct_a, ct_b);
    }

    #[test]
    fn nonce_roundtrip_returns_the_plaintext() {
        let key = test_key();
        let aad: [&[u8]; 3] = [b"demo", b"slack", b"token"];
        let blob = seal_with_nonce(&key, &aad, &[3u8; 16], b"secret").unwrap();
        assert_eq!(&blob[..16], &[3u8; 16]);
        assert_eq!(
            open_with_nonce(&key, &aad, &blob).unwrap().as_slice(),
            b"secret"
        );
    }

    #[test]
    fn nonce_blob_has_nonce_and_tag_overhead() {
        let key = test_key();
        let blob = seal_with_nonce(&key, &[b"a"], &[0u8; 16], b"12345").unwrap();
        assert_eq!(blob.len(), 16 + 16 + 5);
    }

    #[test]
    fn nonce_roundtrip_with_empty_plaintext_and_empty_aad() {
        let key = test_key();
        let blob = seal_with_nonce(&key, &[], &[9u8; 16], b"").unwrap();
        assert_eq!(blob.len(), 32);
        assert_eq!(open_with_nonce(&key, &[], &blob).unwrap().as_slice(), b"");
    }

    #[test]
    fn different_nonces_give_different_blobs_for_the_same_plaintext() {
        let key = test_key();
        let aad: [&[u8]; 1] = [b"name"];
        let a = seal_with_nonce(&key, &aad, &[1u8; 16], b"secret").unwrap();
        let b = seal_with_nonce(&key, &aad, &[2u8; 16], b"secret").unwrap();
        assert_ne!(a, b);
        assert_ne!(a[16..], b[16..]);
    }

    #[test]
    fn same_nonce_and_inputs_give_the_same_blob() {
        let key = test_key();
        let aad: [&[u8]; 1] = [b"name"];
        let a = seal_with_nonce(&key, &aad, &[1u8; 16], b"secret").unwrap();
        let b = seal_with_nonce(&key, &aad, &[1u8; 16], b"secret").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn open_with_a_different_aad_fails() {
        let key = test_key();
        let blob = seal_with_nonce(&key, &[b"demo", b"slack"], &[5u8; 16], b"secret").unwrap();
        assert_eq!(
            open_err(&key, &[b"demo", b"github"], &blob),
            CryptoError::Crypto
        );
    }

    #[test]
    fn open_with_a_different_component_split_fails() {
        let key = test_key();
        let blob = seal_with_nonce(&key, &[b"ab", b"c"], &[5u8; 16], b"secret").unwrap();
        assert_eq!(open_err(&key, &[b"a", b"bc"], &blob), CryptoError::Crypto);
        assert_eq!(open_err(&key, &[b"abc"], &blob), CryptoError::Crypto);
    }

    #[test]
    fn open_with_a_different_number_of_components_fails() {
        let key = test_key();
        let blob = seal_with_nonce(&key, &[b"demo", b"slack"], &[5u8; 16], b"secret").unwrap();
        assert_eq!(open_err(&key, &[b"demo"], &blob), CryptoError::Crypto);
        assert_eq!(
            open_err(&key, &[b"demo", b"slack", b""], &blob),
            CryptoError::Crypto
        );
        assert_eq!(open_err(&key, &[], &blob), CryptoError::Crypto);
    }

    #[test]
    fn open_with_the_wrong_key_fails() {
        let blob = seal_with_nonce(&test_key(), &[b"demo"], &[5u8; 16], b"secret").unwrap();
        let other = Key::from_bytes([8u8; 32]);
        assert_eq!(open_err(&other, &[b"demo"], &blob), CryptoError::Crypto);
    }

    #[test]
    fn tampering_with_any_byte_of_the_blob_fails() {
        let key = test_key();
        let blob = seal_with_nonce(&key, &[b"demo"], &[5u8; 16], b"secret").unwrap();
        for index in 0..blob.len() {
            let mut tampered = blob.clone();
            tampered[index] ^= 0x01;
            assert_eq!(
                open_err(&key, &[b"demo"], &tampered),
                CryptoError::Crypto,
                "byte {index}"
            );
        }
    }

    #[test]
    fn truncated_blobs_fail() {
        let key = test_key();
        let blob = seal_with_nonce(&key, &[b"demo"], &[5u8; 16], b"secret").unwrap();
        for len in [0usize, 1, 15, 16, 31, blob.len() - 1] {
            assert_eq!(
                open_err(&key, &[b"demo"], &blob[..len]),
                CryptoError::Crypto,
                "length {len}"
            );
        }
    }
}

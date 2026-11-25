use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::TryRng;
use speedwave_crypto::Key;
use zeroize::Zeroizing;

use super::error::{operation_failure, SecretStoreError};
use super::name::SecretName;

const LINE_PREFIX: &str = "speedwave-secret:v1:";
const AAD_DOMAIN: &[u8] = b"speedwave-secret-v1";
const NONCE_LEN: usize = 16;

pub(super) fn seal_line(
    key: &Key,
    name: &SecretName,
    plaintext: &str,
) -> Result<String, SecretStoreError> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::SysRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| operation_failure("read OS entropy"))?;
    let blob = speedwave_crypto::seal_with_nonce(key, &aad(name), &nonce, plaintext.as_bytes())
        .map_err(|_| operation_failure("encrypt secret"))?;
    Ok(format!(
        "{LINE_PREFIX}{}:{}",
        key.id(),
        URL_SAFE_NO_PAD.encode(blob)
    ))
}

pub(super) fn open_line(key: &Key, name: &SecretName, line: &str) -> Option<Zeroizing<String>> {
    let rest = line
        .trim_end_matches(['\r', '\n'])
        .strip_prefix(LINE_PREFIX)?;
    let (key_id, payload) = rest.split_once(':')?;
    if key_id != key.id() {
        return None;
    }
    let blob = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let plaintext = speedwave_crypto::open_with_nonce(key, &aad(name), &blob).ok()?;
    let text = std::str::from_utf8(&plaintext).ok()?;
    Some(Zeroizing::new(text.to_owned()))
}

fn aad(name: &SecretName) -> [&[u8]; 4] {
    [
        AAD_DOMAIN,
        name.project().as_bytes(),
        name.service().as_bytes(),
        name.field().as_bytes(),
    ]
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    const SENTINEL: &str = "SENTINEL-997-format";

    fn key() -> Key {
        Key::from_bytes([7u8; 32])
    }

    fn name(field: &str) -> SecretName {
        SecretName::integration("demo", "slack", field).unwrap()
    }

    #[test]
    fn roundtrip_returns_the_value_including_unicode_and_empty() {
        for value in ["hunter2", "zażółć gęślą jaźń \u{1F512}", "", "line1\nline2"] {
            let line = seal_line(&key(), &name("token"), value).unwrap();
            let opened = open_line(&key(), &name("token"), &line).unwrap();
            assert_eq!(opened.as_str(), value);
        }
    }

    #[test]
    fn line_has_the_versioned_shape_and_hides_the_value() {
        let line = seal_line(&key(), &name("token"), SENTINEL).unwrap();
        assert!(line.starts_with(&format!("speedwave-secret:v1:{}:", key().id())));
        assert!(!line.contains(SENTINEL));
        assert!(!line.contains('\n'));
        assert!(!line.starts_with('{'));
        let payload = line.rsplit(':').next().unwrap();
        assert!(payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }

    #[test]
    fn two_seals_of_the_same_value_differ() {
        let a = seal_line(&key(), &name("token"), "same").unwrap();
        let b = seal_line(&key(), &name("token"), "same").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn trailing_newline_is_accepted() {
        let line = seal_line(&key(), &name("token"), "v").unwrap();
        assert_eq!(
            open_line(&key(), &name("token"), &format!("{line}\n"))
                .unwrap()
                .as_str(),
            "v"
        );
        assert_eq!(
            open_line(&key(), &name("token"), &format!("{line}\r\n"))
                .unwrap()
                .as_str(),
            "v"
        );
    }

    #[test]
    fn another_name_cannot_open_the_line() {
        let line = seal_line(&key(), &name("token"), "v").unwrap();
        assert!(open_line(&key(), &name("other"), &line).is_none());
        let other_project = SecretName::integration("other", "slack", "token").unwrap();
        assert!(open_line(&key(), &other_project, &line).is_none());
        let other_service = SecretName::integration("demo", "github", "token").unwrap();
        assert!(open_line(&key(), &other_service, &line).is_none());
    }

    #[test]
    fn another_key_cannot_open_the_line() {
        let line = seal_line(&key(), &name("token"), "v").unwrap();
        let other = Key::from_bytes([8u8; 32]);
        assert!(open_line(&other, &name("token"), &line).is_none());
    }

    #[test]
    fn a_forged_key_id_still_fails_authentication() {
        let other = Key::from_bytes([8u8; 32]);
        let line = seal_line(&other, &name("token"), "v").unwrap();
        let forged = line.replacen(&other.id(), &key().id(), 1);
        assert!(open_line(&key(), &name("token"), &forged).is_none());
    }

    #[test]
    fn garbage_truncated_and_malformed_lines_are_rejected() {
        let line = seal_line(&key(), &name("token"), "v").unwrap();
        let truncated = &line[..line.len() - 4];
        let bad_base64 = format!("speedwave-secret:v1:{}:!!!not base64!!!", key().id());
        let too_short = format!("speedwave-secret:v1:{}:AAAA", key().id());
        let no_payload = format!("speedwave-secret:v1:{}", key().id());
        let cases = [
            "",
            "\n",
            "garbage",
            "{\"value\":\"x\"}",
            "speedwave-secret:v2:00000000:AAAA",
            "speedwave-secret:v1:",
            truncated,
            bad_base64.as_str(),
            too_short.as_str(),
            no_payload.as_str(),
        ];
        for case in cases {
            assert!(
                open_line(&key(), &name("token"), case).is_none(),
                "{case:?}"
            );
        }
    }

    #[test]
    fn flipping_any_payload_character_is_detected() {
        let line = seal_line(&key(), &name("token"), "value").unwrap();
        let start = line.rfind(':').unwrap() + 1;
        for index in start..line.len() {
            let mut bytes = line.clone().into_bytes();
            bytes[index] = if bytes[index] == b'A' { b'B' } else { b'A' };
            let tampered = String::from_utf8(bytes).unwrap();
            assert!(
                open_line(&key(), &name("token"), &tampered).is_none(),
                "index {index}"
            );
        }
    }

    #[test]
    fn a_non_utf8_plaintext_is_rejected() {
        let nonce = [1u8; NONCE_LEN];
        let blob =
            speedwave_crypto::seal_with_nonce(&key(), &aad(&name("token")), &nonce, &[0xff, 0xfe])
                .unwrap();
        let line = format!(
            "{LINE_PREFIX}{}:{}",
            key().id(),
            URL_SAFE_NO_PAD.encode(blob)
        );
        assert!(open_line(&key(), &name("token"), &line).is_none());
    }
}

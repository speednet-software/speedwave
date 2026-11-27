use rand::TryRng;

const TOKEN_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TokenRotation {
    Keep,
    Rotate,
    WhenSessionStopped,
}

pub(crate) fn generate_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| anyhow::anyhow!("failed to read OS entropy for the caller token: {e}"))?;
    Ok(crate::bundle::bytes_to_hex(&bytes))
}

pub(crate) fn is_token(value: &str) -> bool {
    value.len() == TOKEN_BYTES * 2
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    const STAGED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn is_token_accepts_only_64_lowercase_hex_characters() {
        assert!(is_token(STAGED));
        for bad in [
            "",
            "abc",
            &STAGED.to_uppercase(),
            &STAGED[1..],
            &format!("{STAGED}0"),
            &format!("{}g", &STAGED[1..]),
        ] {
            assert!(!is_token(bad), "{bad:?}");
        }
    }
}

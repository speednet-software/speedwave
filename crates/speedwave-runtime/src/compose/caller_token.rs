use super::secret_slots::{claude_secrets_mount, CALLER_TOKEN_FILE};
use crate::runtime::ContainerRuntime;
use rand::TryRng;
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const READ_SCRIPT: &str = r#"if [ -f "$1" ]; then cat "$1"; fi"#;
const TOKEN_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TokenRotation {
    Keep,
    Rotate,
    WhenSessionStopped,
}

pub(crate) fn token_for_staging(
    runtime: &dyn ContainerRuntime,
    project: &str,
    rotation: TokenRotation,
) -> anyhow::Result<String> {
    if rotation != TokenRotation::Rotate {
        if let Some(staged) = staged_token(runtime, project)? {
            return Ok(staged);
        }
    }
    generate_token()
}

fn staged_token(runtime: &dyn ContainerRuntime, project: &str) -> anyhow::Result<Option<String>> {
    let path = format!(
        "{}/{CALLER_TOKEN_FILE}",
        claude_secrets_mount()?.slot.vm_dir(project)
    );
    let output = runtime
        .vm_exec_as_root("sh", &["-c", READ_SCRIPT, "sh", &path], &[], READ_TIMEOUT)
        .map_err(|e| e.context(format!("reading the caller token of project '{project}'")))?;
    if !output.ok() {
        anyhow::bail!(
            "reading the caller token of project '{project}' from the VM failed ({}): {}",
            output.status,
            output.stderr_str().trim()
        );
    }
    let staged = output.stdout_str().trim().to_string();
    Ok(is_token(&staged).then_some(staged))
}

fn is_token(value: &str) -> bool {
    value.len() == TOKEN_BYTES * 2
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn generate_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| anyhow::anyhow!("failed to read OS entropy for the caller token: {e}"))?;
    Ok(crate::bundle::bytes_to_hex(&bytes))
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;
    const STAGED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn a_generated_token_is_32_random_bytes_as_hex() {
        let first = generate_token().unwrap();
        let second = generate_token().unwrap();
        assert!(is_token(&first), "{first}");
        assert_ne!(first, second);
    }

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

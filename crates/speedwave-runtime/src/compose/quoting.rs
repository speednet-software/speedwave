//! Final compose-YAML hardening pass that re-quotes `environment:` scalars
//! carrying YAML flow indicators libyaml emits unquoted but nerdctl rejects.

/// YAML flow indicators libyaml leaves unquoted in plain scalars but nerdctl's
/// Go parser rejects. Env values containing one MUST be emitted quoted.
const YAML_PLAIN_UNSAFE_CHARS: &[char] = &['[', ']', '{', '}', ','];

/// True when `entry` (a `KEY=VALUE` env line) would round-trip through every
/// conformant YAML parser as a plain scalar. When false the caller must emit a
/// quoted scalar — see [`harden_env_scalar_quoting`].
pub(crate) fn env_entry_needs_quoting(entry: &str) -> bool {
    entry.contains(YAML_PLAIN_UNSAFE_CHARS)
}

/// Re-quotes `environment:` sequence entries whose value carries a YAML flow
/// indicator nerdctl's Go parser rejects. Scoped to `environment:` blocks by
/// indentation; uses `serde_json::to_string` escaping; idempotent.
pub(crate) fn harden_env_scalar_quoting(yaml: &str) -> anyhow::Result<String> {
    let mut out = String::with_capacity(yaml.len());
    // Indentation (column) of the active `environment:` key, if inside one.
    let mut env_indent: Option<usize> = None;
    for line in yaml.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let indent = body.len() - body.trim_start().len();
        let trimmed = body.trim_start();

        // Close the block on an outdent or any non-sequence line.
        if let Some(env_col) = env_indent {
            let is_seq_item = trimmed.starts_with("- ") || trimmed == "-";
            if !body.trim().is_empty() && (indent < env_col || !is_seq_item) {
                env_indent = None;
            }
        }

        if env_indent.is_none() && trimmed == "environment:" {
            env_indent = Some(indent);
            out.push_str(line);
            continue;
        }

        if env_indent.is_some() {
            if let Some(rest) = trimmed.strip_prefix("- ") {
                let value = rest.trim();
                // Only touch bare unquoted `KEY=VALUE` plain scalars.
                let is_bare_plain = !value.starts_with('"')
                    && !value.starts_with('\'')
                    && !value.starts_with('|')
                    && !value.starts_with('>');
                if is_bare_plain && env_entry_needs_quoting(value) {
                    let prefix = &body[..body.len() - rest.len()];
                    out.push_str(prefix);
                    out.push_str(&serde_json::to_string(value)?);
                    if line.ends_with('\n') {
                        out.push('\n');
                    }
                    continue;
                }
            }
        }

        out.push_str(line);
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn env_entry_needs_quoting_flags_flow_indicators() {
        // Happy path: plain values stay plain.
        assert!(!env_entry_needs_quoting("ANTHROPIC_MODEL=claude-opus-4-8"));
        assert!(!env_entry_needs_quoting("PORT=4000"));
        assert!(!env_entry_needs_quoting("TZ=Europe/Warsaw"));
        // A `: ` mid-scalar has no flow indicator, so no quoting.
        assert!(!env_entry_needs_quoting(
            "ANTHROPIC_CUSTOM_HEADERS=X-Tenant-ID: foo"
        ));
        // The flattened multi-header form joins with `, ` — comma needs quoting.
        assert!(env_entry_needs_quoting(
            "ANTHROPIC_CUSTOM_HEADERS=X-Tenant-ID: foo, X-Subscription-ID: bar"
        ));
        // The reported bug: the `[1m]` 1M-context suffix.
        assert!(env_entry_needs_quoting(
            "ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8[1m]"
        ));
        // General: every flow indicator triggers quoting.
        for c in ['[', ']', '{', '}', ','] {
            assert!(
                env_entry_needs_quoting(&format!("K=a{c}b")),
                "char {c:?} must require quoting"
            );
        }
    }

    #[test]
    fn harden_env_scalar_quoting_quotes_bracketed_model_id() {
        let yaml = "services:\n  claude:\n    environment:\n    \
                    - ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8[1m]\n    \
                    - ANTHROPIC_MODEL=claude-opus-4-8\nnetworks: {}\n";
        let hardened = harden_env_scalar_quoting(yaml).unwrap();
        // The bracketed entry is now an explicit double-quoted scalar.
        assert!(
            hardened.contains("- \"ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8[1m]\""),
            "bracketed entry must be double-quoted, got:\n{hardened}"
        );
        // The plain entry is untouched (no needless quoting).
        assert!(
            hardened.contains("- ANTHROPIC_MODEL=claude-opus-4-8\n"),
            "plain entry must stay plain, got:\n{hardened}"
        );
        // Round-trips, and the value survives intact.
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&hardened).unwrap();
        let env = doc["services"]["claude"]["environment"]
            .as_sequence()
            .unwrap();
        assert!(env
            .iter()
            .any(|v| v.as_str() == Some("ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8[1m]")));
    }

    #[test]
    fn harden_env_scalar_quoting_is_idempotent_and_scoped() {
        // Already-quoted entries and non-environment flow indicators stay untouched; idempotent.
        let yaml = "services:\n  claude:\n    image: registry/x:1\n    environment:\n    \
                    - \"ALREADY=quoted[1m]\"\n    - PLAIN=ok\n    volumes:\n    \
                    - /a:/b\nnetworks:\n  net: {}\n";
        let once = harden_env_scalar_quoting(yaml).unwrap();
        let twice = harden_env_scalar_quoting(&once).unwrap();
        assert_eq!(once, twice, "must be idempotent");
        // Volume mounts contain `:` but no flow indicator — untouched.
        assert!(once.contains("- /a:/b\n"));
        // The flow-mapping `net: {}` outside environment is untouched.
        assert!(once.contains("net: {}"));
        // Already-quoted bracket entry not re-wrapped.
        assert!(once.contains("- \"ALREADY=quoted[1m]\""));
        assert!(
            !once.contains("\\\""),
            "no double-escaping of existing quotes"
        );
    }

    #[test]
    fn harden_env_scalar_quoting_reopens_block_for_second_service() {
        // Block closes after svc-a's env and re-opens for svc-b's; both get quoted.
        let yaml = "services:\n  a:\n    environment:\n    \
                    - MODEL_A=x[1m]\n    image: reg/a:1\n  b:\n    environment:\n    \
                    - MODEL_B=y[1m]\nnetworks: {}\n";
        let hardened = harden_env_scalar_quoting(yaml).unwrap();
        assert!(
            hardened.contains("- \"MODEL_A=x[1m]\""),
            "svc-a bracketed entry must be quoted, got:\n{hardened}"
        );
        assert!(
            hardened.contains("- \"MODEL_B=y[1m]\""),
            "svc-b bracketed entry must be quoted (block re-opened), got:\n{hardened}"
        );
        // The intervening non-env line is untouched (block closed before it).
        assert!(hardened.contains("    image: reg/a:1\n"));
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&hardened).unwrap();
        assert_eq!(
            doc["services"]["a"]["environment"][0].as_str(),
            Some("MODEL_A=x[1m]")
        );
        assert_eq!(
            doc["services"]["b"]["environment"][0].as_str(),
            Some("MODEL_B=y[1m]")
        );
    }
}

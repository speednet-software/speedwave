//! Final compose-YAML hardening pass that re-quotes `environment:` scalars
//! carrying YAML flow indicators libyaml emits unquoted but nerdctl rejects.

/// YAML flow indicators that are legal inside a *block-context* plain scalar
/// per the YAML 1.2 spec, so libyaml (serde_yaml_ng's emitter) leaves them
/// unquoted — but nerdctl's Go YAML parser (gopkg.in/yaml.v3 via compose-go)
/// rejects them, failing the whole file with `could not find expected ":"`
/// several lines later. Any env value containing one of these MUST be emitted
/// as an explicitly quoted scalar. `[`/`]` cover the documented `[1m]`
/// 1M-context suffix (anthropics/claude-code#34083 workaround); the rest make
/// the rule general so any future value (`{`, `}`, `,`) is safe too.
const YAML_PLAIN_UNSAFE_CHARS: &[char] = &['[', ']', '{', '}', ','];

/// True when `entry` (a `KEY=VALUE` env line) would round-trip through every
/// conformant YAML parser as a plain scalar. When false the caller must emit a
/// quoted scalar — see [`harden_env_scalar_quoting`].
pub(crate) fn env_entry_needs_quoting(entry: &str) -> bool {
    entry.contains(YAML_PLAIN_UNSAFE_CHARS)
}

/// Final SSOT pass over rendered compose YAML: re-quotes every `environment:`
/// sequence entry whose value contains a YAML flow indicator that libyaml
/// emits unquoted but nerdctl's stricter Go parser rejects.
///
/// Scoped to `environment:` blocks (tracked by indentation) so it never
/// touches images, volumes, or networks. The replacement scalar is produced
/// with `serde_json::to_string`, whose escaping is a valid YAML 1.2
/// double-quoted scalar (YAML is a JSON superset) — no hand-rolled escaping.
/// Idempotent: already-quoted entries (those that don't re-parse as a bare
/// `KEY=VALUE` plain scalar) are left untouched. Assumes the renderer emits no
/// YAML comments inside `environment:` (a same-indent `#` line closes the block).
pub(crate) fn harden_env_scalar_quoting(yaml: &str) -> anyhow::Result<String> {
    let mut out = String::with_capacity(yaml.len());
    // Indentation (column) of the active `environment:` key, if inside one.
    let mut env_indent: Option<usize> = None;
    for line in yaml.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let indent = body.len() - body.trim_start().len();
        let trimmed = body.trim_start();

        // Leaving the active environment block. Compose renders sequence
        // items at the SAME column as the `environment:` key (`- ITEM`
        // aligned under `environment:`), so same-indent `- ` lines stay in
        // the block; any non-sequence line, or a line indented less than the
        // key, closes it.
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
                // Only touch bare (unquoted) `KEY=VALUE` plain scalars that
                // carry an unsafe char; quoted/escaped entries are skipped.
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
mod tests {
    use super::*;

    #[test]
    fn env_entry_needs_quoting_flags_flow_indicators() {
        // Happy path: plain values stay plain.
        assert!(!env_entry_needs_quoting("ANTHROPIC_MODEL=claude-opus-4-8"));
        assert!(!env_entry_needs_quoting("PORT=4000"));
        assert!(!env_entry_needs_quoting("TZ=Europe/Warsaw"));
        // A single `: ` mid-scalar is plain-safe (the Go parser accepts it);
        // no flow indicator means no quoting.
        assert!(!env_entry_needs_quoting(
            "ANTHROPIC_CUSTOM_HEADERS=X-Tenant-ID: foo"
        ));
        // …but the multi-header flattened form joins with `, ` — the comma is
        // a flow indicator, so it must now be quoted too (defends the same
        // nerdctl-compose breakage the multiline headers fix addressed).
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
        // Already-quoted entries and non-environment flow indicators (the
        // `networks: {}` mapping, an image with no brackets) are untouched;
        // running twice is a no-op.
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
        // Two services, each with a bracketed env value separated by the first
        // service's `networks`/`image` lines: the block must CLOSE after svc-a's
        // env and RE-OPEN for svc-b's, so both bracketed values get quoted.
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

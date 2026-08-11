# ADR-084: Policy.json v3 — Open Rule-ID Set Replacing the Fixed Category Enum

**Status:** Accepted

**Date:** 2026-07-19

**Amends:** [ADR-083](ADR-083-vaultless-pii-tokenization.md) — only the `policy.json` wire-contract section ("The policy.json v2 contract: a flag pair, not a bool"). Every other ADR-083 decision — vaultless AES-SIV tokenization, one Rust engine consumed natively by the proxy and via WASM by the hub, union-of-policies resolution, fail-closed enforcement at both egress points, and Desktop-only host-side detokenization at the presentation layer — is unchanged by this ADR and remains in force.

## Context

ADR-083 pinned `policy.json` at `version: 2` with a closed, enum-shaped category set: `PolicyFileV2`'s `categories` field was a map keyed by a fixed list (`EMAIL`, `PHONE_PL`, `PESEL`, `NIP`, `IBAN`, `CARD`, `API_KEY`, `SENSITIVE_FIELD`), mirrored by a Rust `PiiCategory` enum and a TS `PIIType` enum (`mcp-servers/policies/src/types.ts`). Adding a detection rule meant touching the enum in two languages, the serde cross-read test pinning them together, and every consumer keyed on a `PiiCategory` variant — schema churn for what is, functionally, adding one row of data (an id, a pattern set, an optional validator, two flags).

## Decision

### `policy.json` v3: rules are data, not an enum

`policy.json` is bumped to `version: 3`. The fixed `categories` map is replaced by an open `rules` array; each entry is `{id, displayName, patterns, validator?, caseSensitive, tokenize, log}` (`crates/pii-engine/src/policy.rs::RuleV3`, `PolicyFileV3`). A rule id is any string matching `^[A-Z][A-Z0-9_]{0,63}$` (`policy.rs::RULE_ID_RE`) — adding a built-in rule is now a data change to `mcp-servers/policies/rules.yaml`, not a schema, enum, or cross-language-mirror change. `compile_policy_v3` (`policy.rs:144`) hard-rejects any version other than 3, same fail-closed posture ADR-083 established for `compile_policy_v2`.

`mcp-servers/policies/rules.yaml` (`version: 3`, 7 built-in rules: `EMAIL`, `PHONE_PL`, `PESEL`, `NIP`, `IBAN`, `CARD`, `API_KEY`) is the single built-in rule library, embedded verbatim by both `crates/pii-engine::policy.rs::default_policy_json` and `crates/speedwave-runtime::pii_policy.rs` via `include_str!` — one file, never a hand-duplicated rule regex at either call site (`.claude/rules/ssot-registry.md`'s `rules.yaml` entry). `crates/pii-engine/tests/rules_integration_test.rs::rules_yaml_is_valid_and_loadable` guards its shape and rule count.

### Two additions the v2 contract did not have

- **Literal keyword substitution** (`KeywordV3`: `match`/`alias`/`caseSensitive`, `policy.rs:130`) is a new top-level array distinct from regex rules: an exact-text mask (e.g. a customer name) rather than a pattern match. ADR-083's contract had no equivalent.
- **Inline provenance**: the resolved document now carries its own `source: {policies, forced}` (`SourceMeta` in `pii-engine`, `ResolvedPiiPolicySource` in the resolver) recording which policy ids produced it and which were MDM-forced, rather than provenance living only in the mount side-channel.

### Resolver: an open id set, no fixed enum

`crates/speedwave-runtime/src/pii_policy.rs` is rewritten around the open rule-id model: `RuleFlags` (the `{tokenize, log}` pair, unchanged from ADR-083), `OwnRuleV3` (an additive custom rule with its own id/patterns/validator/flags — the v3 replacement for ADR-082/083's `CustomPatternConfig`), `KeywordV3`, `PolicyTemplate`, and `ResolvedPiiPolicy` (`pii_policy.rs:34-246`). There is no `PiiCategory` enum anywhere in this module; `resolve_pii_policy` (`pii_policy.rs:841`) resolves the union of every enabled and MDM-forced policy over whatever rule ids the effective template/user-policy set names, library or additive.

### Migration drops what has no v3 counterpart

`crates/speedwave-runtime/src/config.rs::legacy_categories_to_v3` (`config.rs:884`) maps an old on-disk v1 flat-bool user config onto the v3 `categories` map for the 7 rule ids that still exist. Two v1/v2-era fields are accepted structurally (so an old config still loads under `deny_unknown_fields`) and then silently dropped, not mapped, because neither has a v3 counterpart:

- `SENSITIVE_FIELD` (key-name-based detection): removed from the engine entirely, no v3 rule replaces it (`config.rs::LegacyCategoryFlags`, `config.rs:874-879`).
- the per-custom-pattern `forced` flag (`config.rs::LegacyCustomPiiPattern`, `config.rs:909-920`): dead weight from the v1 custom-pattern shape with no live effect even before this migration.

(This corrects an in-code comment that had mis-cited this drop to ADR-079, an unrelated identity-metadata ADR; the fact belongs here.)

## What is not reversed

ADR-083's vaultless AES-SIV tokenization engine, its dual native-Rust/WASM consumption split, its union-of-policies resolution algorithm, its fail-closed boot and request-time enforcement, and its Desktop-only host-side detokenization at the presentation layer are all unchanged. No proxy-side or in-container detokenization was introduced by this migration; CLI users still see tokens rather than plaintext, for the TTY-passthrough reason ADR-083 already documents.

## Alternatives considered

- **Keep the fixed enum, add an "other" catch-all category for anything not in the set.** Rejected: a catch-all still needs a schema change (or a magic bucket id) for every genuinely new _built-in_ rule, and gives a custom org pattern no way to share the same shape (display name, validator, per-rule flags) as a built-in one.
- **Keep `version: 2` and add rules as a parallel array alongside the fixed `categories` map.** Rejected: two competing representations of "what is detected" (an enum-keyed map and an id-keyed array) is the kind of dual-source-of-truth this codebase's SSOT discipline (`.claude/rules/engineering-principles.md`) exists to prevent.

## Consequences

- **Positive:** a new built-in detection rule is a `mcp-servers/policies/rules.yaml` data change; no enum, no serde cross-read test, no consumer-side match arm to update.
- **Negative — known incomplete consumers.** Several v2-era call sites have not been ported to the v3 API and are expected to fail to compile or to run against types that no longer exist, until a follow-up ports them (tracked, out of this cleanup's scope):
  - `crates/pii-engine-wasm/src/lib.rs` calls `compile_policy_v2`, which no longer exists in `crates/pii-engine`'s public surface (`.claude/rules/ssot-registry.md`).
  - `containers/proxy/src/pii.rs::default_state` is likewise still on the v2 API (`.claude/rules/ssot-registry.md`).
  - `desktop/src-tauri/src/{history.rs, chat.rs, pii_display.rs, containers_cmd.rs, types.rs}` reference `compile_policy_v2`, `PiiCategory`, `PiiCategoryFlags`, and `PiiCategoryPolicies`, none of which exist in `crates/speedwave-runtime::pii_policy` anymore. The cross-read test `pii_category_matches_models_security_policy_ts` (`desktop/src-tauri/src/types.rs:782`) is currently broken (`.claude/rules/alignments.md`).
  - TS `mcp-servers/policies/src/types.ts::PIIType` is an orphaned enum, kept only for that broken cross-read test.
- **Rule-id format is now a runtime contract, not a compile-time enum.** A malformed or duplicate rule id is a `PolicyError::Semantic` at compile-policy time (`policy.rs::rule_id_format_valid`), not a type error caught earlier by the compiler; this trade is accepted because it is exactly what "rules are data" requires.

## Related

- `.claude/rules/ssot-registry.md` — `rules.yaml` and `default_policy_json()` entries.
- `.claude/rules/alignments.md` — the `pii_category_serde_matches_policy_engine_ts` removal note and the currently-broken `pii_category_matches_models_security_policy_ts` note.

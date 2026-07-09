# ADR-079: Policy Engine, PII Tokenization

**Status:** Accepted

**Date:** 2026-07-09

## Context

The MCP Hub has always tokenized PII in tool arguments/results before they reach the model: email, phone, PESEL, NIP, IBAN, card, API key, and key-name-based "sensitive field" detection, replacing matched values with `[TYPE:TOKEN]` placeholders that Claude never sees in cleartext (see [Executor Sandbox](../architecture/security.md#executor-sandbox-mcp-hub)). Until this feature, that behavior lived in one file, `mcp-servers/hub/src/pii-tokenizer.ts`: a hardcoded pattern set and a hardcoded default `PIIContext` with no way for a project to change what gets detected, add a project-specific pattern (an internal employee-ID format, say), or turn a category off. Every project got exactly the same fixed policy.

Two things motivated giving projects control over this policy:

1. **Different projects have different exposure.** A project touching EU customer data cares about GDPR Article 32's security-of-processing obligations;[^2] a project building an AI feature in scope for EU AI Act Article 5's prohibited-practices guardrails[^3] cares about a different (overlapping but not identical) set of categories. A single fixed policy either over-filters (annoying, e.g. tokenizing every API-key-shaped string in a codebase that isn't handling secrets) or under-filters (the actual risk).
2. **Named, swappable policy bundles are an established pattern for exactly this problem.** LiteLLM's proxy guardrail policies group a set of checks under a name and let a request select which bundle applies, instead of one global always-on check list.[^1] The template mechanism here follows the same shape: a small number of named presets, each a bundle of category on/off flags plus additive patterns, selected per project.

The MDM/managed-policy mechanism this repo already has for telemetry ([ADR-076](ADR-076-mdm-enforceable-otlp-telemetry.md), `.claude/rules/managed-policy-config.md`) established a second precedent worth reusing: a policy resolved once, host-side, from layered sources (compiled default, then user, then org), then delivered into the container as a mounted, read-only, digest-versioned file rather than scattered env vars. The PII policy contract below is deliberately shaped the same way, with the MDM layer forward-designed but not yet wired (see "MDM forward design" below).

## Decision

**Extract PII tokenization into a standalone `@speedwave/policy-engine` package (`mcp-servers/policies/`), define its policy templates as YAML read by both the TS engine and the Rust save-gate, and deliver the resolved policy to the hub as a host-rendered JSON file mounted read-only.**

### A standalone package, not `mcp-shared`

`mcp-servers/shared/` is the SSOT for MCP _protocol_ utilities (transport helpers, sanitizer, timestamp format) that every worker needs regardless of domain. PII policy is a product domain: categories, regulation-inspired presets, ReDoS-safe custom patterns, with its own schema, its own template files, and its own Rust-side save-gate. Folding it into `mcp-shared` would mix protocol infrastructure with a policy model that has nothing to do with MCP transport, and would force every worker's dependency tree to carry policy-engine code even though only the hub tokenizes. A separate package (`@speedwave/policy-engine`) keeps the boundary the same way `proxy` (LLM forwarding) and `oauth` (token refresh) are their own domains rather than folded into shared.

### YAML templates as the single source of truth

The three shipped templates (`strict`, `gdpr-art32`, `eu-ai-act-art5`) live once, as YAML, in `mcp-servers/policies/templates/*.yaml`. The TS engine parses them with the `yaml` npm package (a new dependency, zero transitive dependencies per the committed lockfile); Rust embeds the same files verbatim via `include_str!` and parses them with `serde_yaml_ng` (already a workspace dependency, following the embed precedent at `compose/mod.rs:107`), inside a `LazyLock<Result<...>>` so a malformed template fails the specific call site rather than panicking at process start (the no-`.expect()`-outside-tests rule). One YAML file, two readers: never a Rust struct and a TS interface hand-typed independently from the same intent.

### Resolved policy as a host-rendered, mounted, digest-versioned file

The host (Rust, `crates/speedwave-runtime/src/pii_policy.rs::resolve_pii_policy`) merges the user's selection with the (currently empty) MDM slot into one `ResolvedPiiPolicy`, writes it to `<data_dir>/policies/<project>/policy.json` with `fs_perms::write_restricted_file_atomic` (0600, atomic), and the compose renderer mounts that directory read-only into `mcp-hub` at `/policy`, with `POLICY_FILE=/policy/policy.json`. This mirrors how the proxy's per-project config reaches its container (`compose/proxy.rs::proxy_state_digest_in` precedent) rather than inventing a third delivery mechanism. `POLICY_DIGEST` carries a sha256 of the rendered file so a content change forces `mcp-hub` to recreate on the next `up`: a policy edit takes effect on next container start, not by live-reloading a running hub. Both env names pass the hub's existing zero-secrets gate (`NO_TOKENS_HUB`/`check_no_tokens_in_hub`): neither `POLICY_FILE` nor `POLICY_DIGEST` contains `TOKEN`, `KEY`, or `SECRET` as a substring. A dedicated `SecurityCheck` rule, `HubPolicyMount`, makes the mount presence-mandatory: exactly one `<policies dir>:/policy:ro` volume, no other volume targeting the `/policy` area, and `POLICY_FILE` pinned to exactly `/policy/policy.json`, so a rendered compose that dropped the mount, weakened it to `:rw`, or repointed the env fails closed before `compose_up`.

### The resolved-policy JSON contract

`policy.json`'s shape (Rust `#[serde(rename_all = "camelCase")]`, TS `ResolvedPolicy`) is pinned on both sides and tested (`write_policy_config_matches_pinned_contract_shape`, `resolved_pii_policy_json_round_trips_and_uses_camel_case`):

```jsonc
{
  "version": 1, // engine supports exactly 1; other → hard error
  "source": { "mode": "template", "templateId": "gdpr-art32" }, // or mode: "custom"
  "categories": { "EMAIL": true /* ...all 8 PIIType keys, exhaustive, required */ },
  "customPatterns": [
    {
      "id": "EMPLOYEE_ID",
      "displayName": "Employee ID",
      "pattern": "\\bEMP-\\d{4,8}\\b",
      "caseInsensitive": false,
      "forced": false,
    },
  ],
  "sensitiveKeys": { "add": ["salary"], "remove": [], "forcedAdd": [] },
  "limits": { "maxTokens": 1000, "ttlMs": 1800000 }, // optional; defaults preserve today
  "forcedCategories": [], // MDM union slot; empty in v1
}
```

The eight `categories` keys are the exact wire strings of the Rust `PiiCategory` enum and the TS `PIIType` enum, pinned equal by a cross-read test (`pii_category_serde_matches_policy_engine_ts`, `crates/speedwave-runtime/src/pii_policy.rs`) that regex-extracts `enum PIIType { ... }` out of `mcp-servers/policies/src/types.ts` and compares it against `PiiCategory::ALL`'s wire strings. Effective enablement of a category is `categories[c] || forcedCategories.includes(c)`; a `customPatterns` entry with `forced: true`, or a `sensitiveKeys.forcedAdd` entry, always applies regardless of the rest of the document: the engine re-forces both on every compile, the same defense-in-depth pattern as MDM-locked telemetry keys (`.claude/rules/managed-policy-config.md`). Unknown top-level fields in `policy.json` are ignored and logged (forward-compatible with a future field); an unknown or missing category name is a hard parse error on both sides (the category set must stay exhaustive, never partially specified).

### Failure model

| Condition                                                                  | Behavior                                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POLICY_FILE` unset, or the file is absent                                 | `defaultResolvedPolicy()`, all 8 categories on                                                                                   |
| File present but unreadable, not valid JSON, or wrong `version`            | Hub logs and the process exits non-zero at startup, fail-closed; a _present_ policy file never silently degrades to a weaker one |
| An individual custom pattern in an otherwise-valid file fails lint/compile | That one pattern is dropped with an error log; the rest of the policy (built-in categories, other custom patterns) still applies |

The first two rows mirror the managed-config failure matrix (`.claude/rules/managed-policy-config.md`): absence is a defined, safe default; presence-but-broken is a hard stop, never a silent fallback, so a rendering bug cannot quietly turn PII filtering off. The third row is deliberately the odd one out: a single bad custom pattern is additive-only (built-in category coverage is untouched by it), so skipping just that pattern is strictly safer than failing the whole hub over one user-typo'd regex, and the error log gives the operator something to fix.

### ReDoS lint: JS-heuristic layer, Rust-authoritative gate

Custom patterns are user-supplied regex, so both sides defend against ReDoS, catastrophic backtracking from nested/overlapping repetition; OWASP's canonical example is `(a+)+$` against a non-matching input of increasing length.[^4] The contract: length 3..256 characters (Rust additionally caps the _stored_ string at 512 bytes), must compile, no backreferences, no lookahead/lookbehind, group-applied counted quantifiers (the `){n,m}` form) capped at 128 repetitions, enforced by both the TS lint and the Rust save-gate; atom and char-class quantifiers are exempt (linear-time, not a ReDoS risk), no nested unbounded quantifiers (the `(a+)+`-class), no pattern that matches the empty string; the runtime tokenizer additionally advances `lastIndex` on a zero-length match as a backstop against an infinite scan loop. `pattern-lint.ts`'s error codes (`TOO_LONG`, `SYNTAX`, `BACKREF`, `LOOKAROUND`, `UNBOUNDED_REPEAT`, `NESTED_QUANTIFIER`, `EMPTY_MATCH`) are a contract consumed by UI messages; renaming one is a breaking change to whatever surfaces them.

The two sides are not equally authoritative. Rust's save-time validation (`pii_policy.rs::validate_value_pattern` + `scan_nested_quantifiers`) is the gate that actually decides what gets persisted: the `regex` crate rejects backreferences and lookaround by construction (it compiles to a DFA/Pike's-VM, not a backtracking engine, so those constructs have no meaning to accept), and a dedicated scan catches nested open-ended quantifiers including the nested-_group_ form (`((a+)b)+`) that the TS regex-based heuristic misses. TS's `lintPattern` is the defensive layer at _load_ time (skip-with-log for a stored pattern that somehow fails re-validation) and the fast, UI-facing preview: it uses JavaScript's backtracking `RegExp`, a different flavor than Rust's RE2-style `regex` crate, so a pattern that is safe under one engine's semantics is not guaranteed identical under the other's. This flavor gap is accepted and documented rather than solved by unifying engines, the same trade-off this repo already made for plugin `auth_fields` vs. `settings_schema` regex validation ([ADR-015](ADR-015-plugin-system.md)).

### MDM forward design

`ResolvedPiiPolicy.forced_categories` (and `sensitiveKeys.forcedAdd`, and a custom pattern's `forced` flag) exist so a future MDM channel can force categories on across an organization without a schema change: the union (`categories[c] || forcedCategories.includes(c)`) means an MDM addition can only add filtering, never remove a category the user already enabled, and the engine re-forces every forced item on every compile as defense-in-depth against a stale or tampered intermediate value. **None of this is wired to an actual MDM source in v1.** There are two production call sites of `resolve_pii_policy`: the compose-render path (`config.rs`) and the `get_security_policy` Tauri command (`desktop/src-tauri/src/containers_cmd.rs`). Both pass `None` for the managed-policy argument, so `forced_categories` is always empty today. This is the same shape as `ManagedPiiPolicyConfig` in `config.rs`, which today has exactly one optional field. Wiring an actual `managed-config.json` reader for PII policy is future work, not part of this change.

### Infallible resolve: PII policy degrades toward more filtering, not less

`resolve_pii_policy` returns a `ResolvedPiiPolicy` directly, with no `Result` and no error path, unlike telemetry's `resolve_telemetry`, which returns a `Result` that a boot check treats as fatal on failure ([ADR-076](ADR-076-mdm-enforceable-otlp-telemetry.md)). The difference is deliberate and follows from which direction "unresolvable" should degrade. An unknown template id, or templates that fail to parse at all, log a warning and fall back to all-8-categories-on: the _safe_ direction for a PII filter is "detect and tokenize more," because a false positive (a non-sensitive string tokenized) costs UX friction, while a false negative (a sensitive value that reaches the model unfiltered) is the actual harm this feature exists to prevent. Telemetry has no such safe-degrade direction: an unresolvable telemetry policy could mean an org's forced kill-switch silently failed to apply, so it earns a hard, fatal boot check instead. Two different domains, two different failure directions, on purpose.

### Alternatives considered

- **Fold the policy engine into `mcp-shared`.** Rejected: `mcp-shared` is protocol infrastructure every worker links against; PII policy is domain logic only the hub needs. Putting it there would grow every worker's dependency surface for no benefit and blur an otherwise clean SSOT boundary.
- **Ship templates as JSON instead of YAML.** Rejected: the templates are hand-authored and hand-reviewed product artifacts (which categories a "GDPR" preset turns on), not machine-generated data; YAML's comments and readability matter more here than JSON's slightly simpler parsing story, and `serde_yaml_ng` is already a workspace dependency.
- **Resolve the policy hub-side instead of host-side.** Rejected: the hub has zero external credentials and, until this feature, zero project-specific configuration surface at all. Resolving in the container would mean either mounting the raw user-config file into the hub (a new, broader mount than the single resolved JSON needs) or teaching the hub to read `~/.speedwave/config.json` shapes it has no other reason to know about. Resolving host-side keeps the hub's input surface to exactly one small, purpose-built file, the same reasoning that put telemetry resolution host-side.
- **Deliver the resolved policy as environment variables instead of a mounted file.** Rejected: the policy document has nested structure (custom patterns, deltas, limits) that does not fit env-var shape without inventing a serialization scheme, and every other per-project config surface (proxy config, MDM managed-settings) already uses the mounted-file-plus-digest pattern, so a third delivery mechanism for the same problem would be inconsistent for no gain.

### A note on the template category mappings

Which of the 8 categories each shipped template turns on (`gdpr-art32` disables `API_KEY`; `eu-ai-act-art5` disables `NIP` and `API_KEY`) is a **product judgment about what's typically relevant to each regulation's stated concerns, not a legal determination that a given mapping satisfies that regulation**. Nothing in GDPR Article 32[^2] or AI Act Article 5[^3] specifies "detect these 8 PII categories." Renaming a template's description to sound more authoritative than "our best guess at a useful preset" would overstate what this feature does; the one-line YAML files are meant to be edited as that judgment evolves, without a schema change.

## Consequences

- **A policy change takes effect on the next container start, not live.** Because the digest-driven recreate is the propagation mechanism, editing a project's PII policy and expecting an already-running hub to pick it up requires a restart, the same UX as a proxy config change.
- **The MDM slot is inert until a future change wires it.** `forced_categories` round-trips through the JSON contract and is tested, but no code path today can actually populate it from an org policy source; this ADR records the intended shape so that future work extends rather than redesigns the contract.
- **The category set is fixed at 8, changing it is a breaking schema change.** Both sides require the category map to be exhaustive; adding or removing a `PiiCategory`/`PIIType` member means bumping every template YAML, the cross-read test, and the `deny_unknown_fields`/exhaustiveness checks on both sides in the same change.
- **Repo `.speedwave.json` cannot set a PII policy.** `ProjectRepoConfig` (the restricted subset a cloned repo may influence) has no `policy` field: a policy selection is user-config-only, the same restriction already applied to `provider`/`base_url`-class LLM fields, so a malicious cloned repo cannot weaken a project's PII filtering.
- **Settings UI ships behind the beta-features flag.** A Security section in Desktop Settings (template picker plus Custom-mode category toggles, custom patterns, and sensitive-key editing) is included in this change but gated by Settings → Beta features, so it is off by default until the surface is exercised more widely (see `docs/guides/desktop.md` Security section). Removing the gate is a later, one-line change.

## Footnotes

[^1]: https://docs.litellm.ai/docs/proxy/guardrails/guardrail_policies, LiteLLM proxy guardrail policies: named policies group a set of guardrails and control which ones run for a given team/key/model, the inspiration for this feature's named-template-bundle shape (a different selection mechanism: LiteLLM matches per-request by team/key/model attachment, this feature selects per-project by explicit user choice).

[^2]: https://eur-lex.europa.eu/eli/reg/2016/679/oj, Regulation (EU) 2016/679 (GDPR), official consolidated text at EUR-Lex; Article 32 ("Security of processing") is the security-of-processing obligation the `gdpr-art32` template is named after.

[^3]: https://eur-lex.europa.eu/eli/reg/2024/1689/oj, Regulation (EU) 2024/1689 (the AI Act), official text at EUR-Lex; Article 5 ("Prohibited AI practices") lists the practices the `eu-ai-act-art5` template is named after.

[^4]: https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS, OWASP: Regular expression Denial of Service (ReDoS). Explains catastrophic backtracking from "evil regex" patterns such as grouping-with-repetition (`(a+)+`) and overlapping alternation inside a repeated group, the class of pattern this feature's nested-quantifier scan and lookaround/backreference rejection are written to reject.

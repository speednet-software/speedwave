# ADR-081: Vaultless PII Tokenization via a Shared Rust Engine

**Status:** Accepted

**Date:** 2026-07-14

**Supersedes:** [ADR-080](ADR-080-policy-engine-pii-tokenization.md) (map-based tokenizer, v1 contract)

## Context

ADR-080 designed the PII policy feature around a map-based tokenizer: a category hit would be replaced by an opaque token, with the mapping from token back to the original value stored somewhere the hub could look it up later. That design assumed a single consumer (the hub, in TypeScript) and a v1 `policy.json` contract where each category was a plain boolean (on/off).

Implementation diverged from that design in every load-bearing respect once the actual security and cross-language requirements were worked through:

- A persistent token-to-value map is itself a store of the values it exists to protect: whatever holds the map becomes as sensitive as the original data, and it needs its own access control, encryption at rest, and lifecycle (the very risk tokenization exists to avoid).
- The hub is not the only place that needs to see PII: the proxy also has to filter what leaves this machine for the model provider, and a hub-only in-memory map cannot serve a process it never talks to.
- A single boolean per category cannot express "detect but don't tokenize" (an observation/audit-only mode), which the v2 contract deliberately adds.

This ADR records the resulting design: no persisted map, no v1 boolean contract, a single Rust detection/tokenization engine consumed by both the proxy and the hub, and enforcement on two separate network egress paths instead of one.

## Decision

### Vaultless tokenization: deterministic authenticated encryption, not a map

A detected value is sealed with AES-128-SIV[^1] under a per-project key, with the category name bound in as associated data (AAD), and the ciphertext is base64url-encoded into the token span `[CATEGORY:TOKEN_<payload>]` (`crates/pii-engine/src/scan.rs::build_token`, `TOKEN_SPAN_RE`). AES-SIV is deterministic: the same `(key, category, value)` triple always seals to the same ciphertext, so the same PII value tokenizes to the same span everywhere it recurs in a document (`crates/pii-engine/src/siv.rs::seal`, tested by `seal_is_deterministic`) without needing a lookup table to make repeated values consistent. It is also authenticated: any bit flip in the ciphertext, or an attempt to open a token under the wrong category, fails closed rather than returning garbage (`crates/pii-engine/src/siv.rs::open`, tested by `tag_flip_fails_open_without_panicking` and `category_changes_ciphertext_and_is_checked_on_open`).

Detokenization (`crates/pii-engine/src/scan.rs::detokenize_text`/`detokenize_json`) reverses this with the same key: no map is ever written to disk, so there is nothing to steal that isn't already reachable via the key itself. Losing the key makes every token for that project permanently unresolvable; this is the accepted cost of removing the map (see Consequences).

This replaces ADR-080's decision to give the hub a token→value map; nothing from that mechanism survives.

### One Rust engine, two consumption paths

`crates/pii-engine` is the single implementation of detection (`patterns.rs`), checksum validators, the `policy.json` v2 parser/compiler (`policy.rs`), and scan/tokenize/detokenize (`scan.rs`). The proxy (`containers/proxy/`) links it as a native Rust dependency. The hub, being a Node/TypeScript process, consumes the same engine through a `wasm-bindgen` binding crate, `crates/pii-engine-wasm`, built with `wasm-pack --target nodejs`[^2] via `crates/pii-engine-wasm/build-wasm.sh`. `mcp-servers/policies/src/engine.ts` is a thin wrapper over the compiled WASM module: it resolves `POLICY_FILE` and its sibling key file, constructs the WASM engine, and round-trips `tokenize`/`detokenize` calls through `JSON.stringify`/`JSON.parse` (`mcp-servers/policies/src/engine.ts::loadEngine`). The pre-WASM TypeScript pipeline (a parallel tokenizer, pattern set, and validators) is gone; `mcp-servers/policies/src/types.ts` keeps only the `PIIType` enum mirror.

The WASM artifact is built on the host machine (`scripts/bundle-build-context.sh`) and shipped into the hub's build context, because the hub image builds on the end user's machine, which has no Rust toolchain. `crates/pii-engine` itself is vendored into the proxy's isolated build context (`cp -r crates/pii-engine containers/crates/pii-engine`, `scripts/bundle-build-context.sh`) so `containers/proxy/Cargo.toml`'s path dependency resolves inside that context; because the crate is built standalone there with no ancestor workspace, its package metadata and `[lints]` table in `crates/pii-engine/Cargo.toml` are literal values rather than `.workspace = true`, kept byte-identical to the root lint table by the `lint_tables_are_aligned` cross-read test (`.claude/rules/alignments.md`).

Detection logic living in exactly one place, read natively by the proxy and through WASM by the hub, is what makes the two enforcement paths below produce identical tokens for identical input; a second, independently-written engine (JS in the proxy, or a second Rust reimplementation for the hub) could drift from the first with no test catching it.

### The policy.json v2 contract: a flag pair, not a bool

Each built-in category, and each custom pattern, now carries a `{tokenize, log}` flag pair instead of ADR-080's plain boolean (`crates/pii-engine/src/policy.rs::CategoryConfig`, `CategoryFlags`). `tokenize` seals a hit into a token; `log` counts and reports it without touching the text (observation mode), a mode the v1 boolean contract could not express. `sensitiveKeys` is the final, already-merged key-name list (no more separate add/remove deltas at the engine layer; that merge now happens once, host-side, before the document reaches the engine). The document is pinned at `version: 2`; `compile_policy_v2` hard-rejects any other version, and `#[serde(deny_unknown_fields)]` on every level of the contract (`PolicyFileV2`, `CategoryConfig`, `CustomPatternConfig`) rejects an unrecognized field rather than silently ignoring it.

The compiled-in default (all categories tokenize-on, engine's built-in sensitive-key list) lives once, in Rust, as `crates/pii-engine/src/policy.rs::default_policy_json`, and is the SSOT both the WASM-wrapped hub and the native proxy fall back to when no `POLICY_FILE` is supplied (`containers/proxy/src/pii.rs::default_state`, `mcp-servers/policies/src/engine.ts::resolvePolicyAndKey`).

### Policies are a union, not a single selection

A project's effective policy is the union of every policy the user has enabled plus every id an org's MDM channel forces on, resolved host-side by `crates/speedwave-runtime/src/pii_policy.rs::resolve_pii_policy`. The union is computed per flag pair (`or_category_policies`): a category is tokenized or logged if any policy in the effective set says so, so adding a policy can only add filtering, never remove it, the same non-narrowing guarantee ADR-080 established for the single-template MDM slot, now generalized to a set. Custom patterns with the same id across policies must agree on `(pattern, caseInsensitive)` or resolution errors (`resolve_custom_patterns_with_same_id_but_different_pattern_errs`); patterns are merged in the same way with OR'd flags. Sensitive-key removals apply only where every member of the effective set agrees to remove that key (intersection), so the union of policies never narrows protection below what any single member intended.

Unlike ADR-080's `resolve_pii_policy`, which had no error path and always degraded toward "more filtering" on a bad input, this version returns `Result<ResolvedPiiPolicy, String>`: an unknown policy id (user- or MDM-referenced) is an `Err` that names the id, not a silent fall-through. `check_pii_policy_at_boot` (mirroring `check_telemetry_policy_at_boot`, ADR-076) hard-stops project start on that error. The only remaining silent-default path is the genuinely empty case (no user policy and no MDM policy at all), which resolves to the safe all-tokenize default (`safe_default_policy`), not an error, because "the user configured nothing" is a normal, well-defined state rather than a broken one.

### Two enforcement points, one engine keeping them consistent

- **Proxy (A-in + C):** every `/v1/messages` request is scanned before it leaves the machine for the model provider: the `system` field and every `messages[].content` entry, which covers both the fresh prompt (A-in) and any tool-result content replayed from conversation history (C) (`containers/proxy/src/pii.rs::scan_request`, called from `containers/proxy/src/forward.rs`). Detections are written to `audit-proxy.jsonl` (`containers/proxy/src/audit.rs::write_pii_audit`).
- **Hub (B):** the hub tokenizes tool call results at the sandbox executor boundary and scans the sandboxed code's own return value, writing to `audit-hub.jsonl` (`mcp-servers/hub/src/audit-pii.ts`, `AuditLayer = 'B-result' | 'sandbox-return'`).

Because both paths call into the same `crates/pii-engine` (natively or via WASM) with the same compiled policy and the same per-project key, a value tokenized by one path and later replayed through the other produces the identical span. This is what makes the proxy's "scan history too" pass idempotent against tokens the hub already produced, and vice versa (`crates/pii-engine/src/scan.rs::scanning_twice_is_idempotent`).

### Fail-closed everywhere, never cleartext on error

A missing or invalid policy/key is not a degraded pass-through in either process:

- **Proxy:** `PiiEngineState::Failed` at load; every `/v1/messages` call returns a 5xx rather than forwarding unscanned (`containers/proxy/src/pii.rs`).
- **Hub:** `loadEngine`/`loadPolicy` throw on a present-but-invalid policy or missing key file; the hub process exits at its single process-death point (`mcp-servers/hub/src/policy.ts`) rather than serving tool calls with tokenization silently disabled.
- **Project start:** `check_pii_policy_at_boot` hard-stops before the project's containers come up on any unresolvable policy.

### Detection audit trail

Both enforcement points append newline-delimited JSON to a per-project audit file: `audit-proxy.jsonl` and `audit-hub.jsonl` under `<data_dir>/audit/<project>/` (`crates/speedwave-runtime/src/consts.rs::AUDIT_PROXY_FILE`/`AUDIT_HUB_FILE`). Each line is one `(layer, category, action[, tool], count)` aggregate (the proxy's fixed `A-in` layer, or the hub's `B-result`/`sandbox-return`), and carries no scanned value, only counts. Both files are registered in `crates/speedwave-runtime/src/diagnostic_sources.rs::DIAGNOSTIC_SOURCES` so they surface in the `/logs` UI and the diagnostics ZIP like every other operational log.

### SecurityCheck: mandatory mounts, explicit exclusion from claude

`compose::SecurityCheck` gained four rules for this feature (`crates/speedwave-runtime/src/compose/security_check.rs`): `HubPolicyMount` and `ProxyPolicyMount` require exactly one `:ro` mount of the per-project policy directory (which also holds the tokenization key) into `mcp-hub` and `proxy` respectively, at the pinned target and env values; `AuditMount` requires exactly one `:rw` mount of the audit directory into both services (the hub's only writable mount); `NoPolicyOrAuditMountClaude` fails the render if either directory is mounted into the `claude` container at any target. A rendered compose that drops a required mount, weakens `:ro` to `:rw` on the policy side, or lets either directory reach `claude` fails closed before `compose_up`, the same enforcement shape ADR-080 established for its single `HubPolicyMount` rule, now extended to the proxy and to the audit directory.

### Per-project key: generated once, never rotated in v1

`crates/speedwave-runtime/src/pii_key.rs::ensure_project_key_in` generates 32 random bytes on first use and writes them hex-encoded to `<data_dir>/policies/<project>/key`, alongside `policy.json`, so it rides the same `HubPolicyMount`/`ProxyPolicyMount` mount as the policy document. Creation is exclusive-create (`OpenOptions::create_new(true)`): the loser of a race sees `AlreadyExists` and treats it as success rather than overwriting, closing the TOCTOU window where two concurrent first-uses could each generate and write a different key. Desktop reads the same on-disk key directly (`desktop/src-tauri/src/pii_display.rs::load_display_key`) for host-side detokenization; it is never rotated in v1, so losing the key file makes every token the project has ever produced permanently unresolvable, by design (there is no vault to fall back to).

### Presentation: detokenization is a Desktop-only, host-side step

Desktop is the only place tokens are ever resolved back to plaintext, and only at the point of display: the chat stream emitter (`desktop/src-tauri/src/chat.rs::detokenize_chunk`, called from the single `chat_stream` emit chokepoint) and the history/summary readers (`desktop/src-tauri/src/history_cmd.rs`, via `crate::pii_display::detokenize_transcript`/`detokenize_summaries`) detokenize a copy for the webview; the on-disk JSONL history and the model-facing conversation content stay tokenized. This matches ADR-080's original intent for Desktop.

**Correction to both SPEED-311 design documents' stated rationale for the CLI:** both documents assert the CLI shows tokens instead of plaintext in A-out because "the container cannot hold a key." That is not the actual mechanism and this ADR corrects it. The Claude Code process the CLI drives does not need the tokenization key at all: detokenization for display is host logic (`pii_display.rs`), not something the in-container process performs either way. The real reason the CLI shows tokens is architectural: the CLI attaches to the container with a direct TTY passthrough, `nerdctl exec -it` inheriting the terminal's file descriptors (`crates/speedwave-cli/src/main.rs`, "exec -it -> interactive Claude terminal inside container"), so the host CLI process is never on the byte path between the container's output and the user's terminal; there is no stream for a host-side filter to intercept. A host-side PTY-proxy that sits between the real terminal and the container's TTY, filtering tokens back to plaintext as they scroll by, is architecturally feasible, but implementing it is out of scope for this change; CLI users see tokens in v1. This is unrelated to key custody, which the container never needed regardless.

## Rejected alternatives

- **Persistent token→value map** (ADR-080's original design). Rejected: the map becomes as sensitive as the data it protects and needs its own storage security, access control, and lifecycle: the problem tokenization exists to avoid, not solve.
- **HMAC-derived tokens plus a map.** Rejected for the same reason as the plain map: a one-way HMAC token still needs a map to recover the original value, so it inherits the map's custody problem while adding nothing AES-SIV's authenticated, directly-reversible ciphertext doesn't already provide.
- **Redis (or another external store) for the map.** Rejected: it adds an operational dependency (a service to run, back up, and secure) to a desktop application that otherwise has no shared datastore, purely to hold values the feature is designed to keep out of reach.
- **Key-derived tokens with no map, but non-authenticated (plain deterministic encryption without a tag).** Rejected in favor of AES-SIV specifically because it is both deterministic (needed for stable repeated-value tokens) and authenticated (a corrupted or foreign-category token fails to open instead of decoding to a wrong or garbage value).
- **Two independently-implemented detection engines** (Rust for the proxy, TypeScript for the hub). Rejected: the two enforcement paths would drift with no test able to catch it, and identical-input-identical-token behavior between proxy and hub (needed for idempotent re-scanning of history) depends on both paths running the same code, not two implementations kept in sync by hand.
- **`napi-rs` native Node bindings instead of WASM for the hub.** Rejected: a native Node addon needs a prebuilt binary per Node ABI/OS/architecture combination the hub image might run on, the platform matrix ADR-021's zero-install bundling strategy exists to avoid; a WASM module built once with `wasm-pack --target nodejs` has no such matrix.
- **A JavaScript reimplementation of the detection engine in the proxy** (rather than the proxy linking Rust natively). Rejected: the proxy is a Rust binary already; adding a JS runtime to it purely to duplicate logic already available as a native dependency has no benefit and reintroduces the two-engines drift risk above.
- **Three actions per category** (e.g. block/tokenize/log as distinct modes) instead of the two independent `{tokenize, log}` flags. Rejected: the two flags are independently toggleable and already express every combination a three-way enum would: both off, tokenize only, log only, or (a state a single enum cannot represent) both at once, for tokenizing while also counting for audit; a separate enum would need its own mapping back to the two behaviors the engine actually implements.
- **Explicit `enforce`/`shadow` policy-wide modes.** Rejected: the same effect (detect without altering the text) is already expressible per category via `log: true, tokenize: false`, without a second top-level mode that would need its own precedence rules against the per-category flags.
- **Infallible resolve degrading toward a safe default on any error** (ADR-080's original failure model for `resolve_pii_policy`). Rejected for the union-of-policies design specifically: once an unknown policy id can come from either the user or MDM, silently dropping it and falling back to a default policy could mean an org's forced policy silently failed to apply with no signal to the user; `resolve_pii_policy` now returns `Result` and only the genuinely-empty-configuration case (not an error case) resolves to the safe default.

## Consequences

- **Key loss is unrecoverable by design.** There is no map to fall back to if `<data_dir>/policies/<project>/key` is lost or corrupted: every token ever produced for that project becomes permanently unresolvable. This is the direct trade for not persisting a token→value store; the key itself is the only secret that needs protecting, and it is not currently backed up or rotated.
- **CLI users see tokens, not plaintext, in v1.** Fixing this requires a host-side PTY-proxy between the real terminal and the container's TTY (see Presentation, above): a real feature, not a config flag, and explicitly out of scope for this change.
- **The proxy is a Rust dependency of `crates/pii-engine`, vendored per-build.** `containers/proxy`'s isolated build context needs a fresh copy of `crates/pii-engine` on every `scripts/bundle-build-context.sh` run; a future refactor of the crate's public API must keep the proxy's Cargo.toml path dependency and the vendoring script in sync, or the proxy image stops building.
- **The hub's WASM artifact is a host-build-time dependency, not source the hub image compiles itself.** `crates/pii-engine-wasm/build-wasm.sh` must run (via `scripts/bundle-build-context.sh`) before the hub image builds; a machine without the Rust/`wasm-pack` toolchain cannot rebuild the WASM package, only reuse a previously-built one already checked into the build context output.
- **A category's flag pair replaces ADR-080's bool everywhere the contract is read.** Any future consumer of `policy.json` (or a new template) must use `{tokenize, log}`, not a bare boolean; `version: 2` and `deny_unknown_fields` make an accidental v1-shaped document a hard parse error rather than a silent misread.
- **Policy resolution can now fail, and does so at boot.** A future change to policy resolution must preserve the fail-closed contract: an unknown id is an `Err` naming it, never a silent drop, because the effective policy can be influenced by an org's MDM channel as well as the user.

## Footnotes

[^1]: [RFC 5297: Synthetic Initialization Vector (SIV) Authenticated Encryption Using the Advanced Encryption Standard (AES)](https://www.rfc-editor.org/rfc/rfc5297), IETF. Defines AES-SIV as a deterministic, misuse-resistant authenticated encryption mode: encrypting the same (key, associated data, plaintext) always produces the same ciphertext, and any authentication-tag mismatch on decryption is rejected rather than yielding a plaintext. Both properties are why the tokenization scheme uses it: deterministic sealing gives repeated PII values a stable token, and the authentication tag is what makes a corrupted or wrong-category token fail closed instead of decoding to garbage.

[^2]: [wasm-pack documentation](https://rustwasm.github.io/docs/wasm-pack/), Rust and WebAssembly working group. `wasm-pack build --target nodejs` compiles a Rust crate to a WebAssembly module plus a Node-compatible JS wrapper package, which is how `crates/pii-engine-wasm` becomes an importable Node module for the hub without a native (`napi-rs`-style) per-platform binary.

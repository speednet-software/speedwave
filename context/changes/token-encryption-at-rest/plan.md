# Plan: At-rest encryption for host-side API credentials (SPEED-239)

Change-id: `token-encryption-at-rest` · Branch: `feat/token-encryption-at-rest` · ADR: ADR-076

## Background

All user credentials (Slack, GitHub, GitLab, Atlassian, SharePoint, Redmine, LLM keys,
Anthropic key, OAuth refresh/access tokens, plugin credentials) are plaintext on the host.
This plan makes the durable copy ciphertext and materializes plaintext only ephemerally
while containers run.

**Core mechanism (resolved via adversarial analysis of 5 strategies):**
host-decrypt → ephemeral `runtime/` 0600 file BEFORE `compose_up`; `${TOKENS_DIR}` swung to
`runtime/` so the existing `/tokens:ro` mount is reused unchanged. Vault (ciphertext) is a
SEPARATE durable tree. DEK lives only in Desktop RAM (Argon2id from user passphrase).

**Verified blockers the design must respect (checked against source):**
- V1: SharePoint `onNotConfigured:'fail'` → `process.exit(1)` at boot on empty tokens
  (`shared/src/boot.ts:94-96`); litellm entrypoint exports `SPW_KEY_*` before exec
  (`containers/litellm/entrypoint.sh:10-27`). → plaintext must exist BEFORE container start.
- V2: `/dev/shm` not writable (read_only rootfs, uid 1000 exec without `-u`). → no push.
- V3: oauth worker rewrites trees on every refresh with NO DEK (`oauth_process.rs:48-53`).
  → metadata stays plaintext; worker writes plaintext to `runtime-oauth/`; Desktop re-seals.
- V4: `security_check` volume rules key off `tokens_engine_dir()` → `compute` must re-derive.
- V5: host tmpfs infeasible on Lima/WSL2 → mount source must be a real persistent file.

**Honest threat statement:** at-rest buys full ciphertext in idle/stopped + stolen-disk; in
running state it degrades to between-uid-only protection (0600) for the container lifetime —
consistent with the live session holding the DEK in same-user RAM.

---

## Phase 1: Crypto SSOT (`token_crypto.rs`)

### Overview
Isolated foundation: one global DEK per vault (NOT per-file KDF), Argon2id derivation,
XChaCha20-Poly1305 seal/unseal, versioned format, password check-value. No integration yet.

### Changes Required
- NEW `crates/speedwave-runtime/src/token_crypto.rs`:
  - `derive_dek(passphrase, salt, params) -> Zeroizing<[u8;32]>` (Argon2id; PINNED const params,
    not time-calibrated — calibration diverges macOS↔Windows; params always read from header).
  - `seal(dek, aad, plaintext)` / `unseal(dek, aad, blob) -> Zeroizing<Vec<u8>>`.
  - `is_sealed(bytes)` — magic `SPWENC`.
  - Format: `magic SPWENC || version || nonce || ciphertext || tag`; KDF params/salt + a
    sealed check-value live in `vault/.meta` (validate passphrase without decrypting a token).
  - AAD = `{project, svc, key}` (anti-substitution). AEAD = XChaCha20-Poly1305 (192-bit nonce).
  - Secret-bearing structs MUST NOT `derive(Debug)`; `Zeroizing` on buffers.
- `crates/speedwave-runtime/src/consts.rs`: magic, format version, `PASSPHRASE_ENV`.
- Deps (pin-aligned in BOTH workspaces, cross-ref comment like `windows-sys`): `argon2`,
  `chacha20poly1305`, `zeroize` (promote from transitive to direct). Add `rand`/`base64` to
  desktop workspace if desktop touches crypto.

### Success Criteria
- `make test-rust` green; new tests: seal/unseal round-trip; wrong AAD/tag/DEK → distinct
  errors; check-value validates passphrase; format/version; `is_sealed`; no `Debug` on secrets.
- `make check` (clippy/fmt) green.

---

## Phase 2: Consolidate 6 writers → SSOT (no encryption yet)

### Overview
Pure DRY refactor: route ALL credential writes through one SSOT path so encryption later
plugs in at a single seam. Proves every path goes through one place. No behavior change.

### Changes Required
- Route these 6 production writers through a single SSOT write helper:
  1. plugins — `desktop/src-tauri/src/plugin_cmd.rs:641` (+ OAuth seed `:653/676`)
  2. built-in — `desktop/src-tauri/src/setup_wizard.rs:1199` `write_tokens`
  3. built-in per-key + Redmine — `integrations_cmd.rs` (~1044, `save_redmine_credentials` ~290,
     `merge_oauth_state_json` ~1118)
  4. Anthropic key — `desktop/src-tauri/src/auth.rs:16` `save_api_key`
  5. LLM keys — `compose/litellm.rs:222` `write_llm_provider_key_in` + local-llm custom_headers
     `containers_cmd.rs:1328`
  6. OAuth secrets — `oauth_flow.rs:343` `save_credential_file` + `oauth_persist.rs:43`
- Do NOT route: `secrets/<project>/<svc>-auth-token` (machine bearer, hub-only — out of scope).

### Success Criteria
- `make test` green; existing credential-write tests pass through the SSOT unchanged.
- Each writer covered by a test asserting it goes through the SSOT helper.

---

## Phase 3: Vault + unlock + migration + log sanitizer

### Overview
Turn on encryption at the SSOT: writes go to `vault/` (ciphertext), unlock UX holds the DEK,
migration seals existing plaintext, sanitizer covers new secret classes.

### Changes Required
- Desktop vault module: seal/unseal whole-file via `token_crypto`; DEK in RAM (mlock), zeroize
  on lock/quit; `unlock_credentials`/`set_passphrase` Tauri commands (`main.rs invoke_handler`).
- NEW `crates/speedwave-runtime/src/credential_migration.rs`: `run_after_unlock(dek)` — one-shot
  seal of existing plaintext `tokens/`+oauth-secrets → `vault/`+`vault-oauth/`; per-file
  idempotency via `SPWENC` magic-sniff (top-level marker insufficient for many files);
  atomic tmp+fsync+rename per file + dir fsync; serializing lock; DELETE source plaintext on
  success; fail-loud (no delete) on error/missing DEK. Called from the unlock handler, NOT
  `main.rs setup()` (which runs before unlock, has no DEK).
- `log_sanitizer.rs`: add `passphrase|dek|master_key` to alternation + rule
  `\bSPWENC[A-Za-z0-9+/=_-]{16,}`; bump `EXPECTED_RULE_COUNT`; sync duplicated list (:156).

### Success Criteria
- `make test` green; tests: unlock holds DEK; wrong passphrase → fail-loud via check-value;
  migration idempotent (magic-sniff), deletes source on success, fail-loud without DEK,
  covers all 6 writers; sanitizer redacts passphrase/SPWENC + false-positive test.

---

## Phase 4: Materialization (runtime/ + mount swing + oauth + wipe)

### Overview
Wire the ephemeral `runtime/` materialization: decrypt to `runtime/` before compose_up,
swing the mount, repoint the oauth worker, and wipe across all lifecycle paths.

### Changes Required
- `compose/tokens.rs`: `resolve_runtime_dir_in` / `resolve_runtime_oauth_dir_in` + mkdir 0700.
- `compose/mod.rs:286`: swing `${TOKENS_DIR}` → `resolve_runtime_dir_in`.
- `compose/security_check.rs:34`: `SecurityExpectedPaths::compute` re-derive `runtime/`
  (else every builtin/litellm/plugin volume validator blocks compose_up).
- `oauth_process.rs:49,100`: `OAUTH_STATE_DIR`→`runtime-oauth/`, `OAUTH_TOKENS_BASE`→`runtime/`
  (change `OauthWorkerSpec`; the `data_dir.join("tokens")` is hardcoded) + test.
- Desktop: unseal `vault/`→`runtime/` and `vault-oauth/`→`runtime-oauth/` inside `rt.transaction`
  BEFORE `ensure_oauth_running`/`compose_up`; re-seal watcher on `runtime-oauth/` +
  `runtime/<svc>/access_token` (atomic, idempotent) when unlocked; wipe on
  compose_down/lock/quit/**next-start-before-unseal**.
- `compose/workers.rs`: digest no-op-on-equal (read-decrypt-compare-before-write so identical
  plaintext → identical bytes → stable `SPW_CREDENTIALS_DIGEST`).
- Keep OAuth metadata `oauth/<svc>.json` plaintext (locked-Desktop readers at
  `integrations_cmd.rs:69,165,360`).

### Success Criteria
- `make test` green; tests: render with `runtime/` `${TOKENS_DIR}`; `security_check` green vs
  `runtime/`; oauth repoint + refresh round-trip + refresh-while-locked (deferred re-seal);
  metadata read while locked; digest stable on identical plaintext; wipe on all paths incl.
  next-start; cross-platform `to_engine_path`; atomic fsync write.

---

## Phase 5: Downgrade / rollback safety

### Overview
Protect against an old binary (manual reinstall) or an update rollback feeding ciphertext to
a worker as if it were a token.

### Changes Required
- `vault/.format-v1` marker.
- `compose/workers.rs:397,149`: reader fail-loud when it sees leading `SPWENC` (don't
  `read_to_string().trim()` and transmit ciphertext as a token).
- `update.rs` (~259 snapshot-first, ~437 rollback restores only compose): coordinate
  migration↔rollback ordering — don't migrate while the update transaction can still roll back,
  OR make the format downgrade-tolerant.

### Success Criteria
- `make test` green; tests: old reader rejects `SPWENC` fail-loud; rollback over an encrypted
  vault does not produce garbage-credential workers.

---

## Phase 6: Documentation

### Overview
Documentation is a delivery requirement. Update guides + security model.

### Changes Required
- `docs/architecture/security.md`: credential-at-rest model, threat statement, residuals.
- `docs/getting-started/configuration.md`: `SPEEDWAVE_PASSPHRASE`, unlock UX.
- `docs/guides/`: passphrase/unlock flow where relevant.
- `docs/architecture/containers.md`: vault/runtime topology if it touches the narrated dirs.

### Success Criteria
- Docs build/lint passes; no orphan docs; every factual claim that lands in the ADR is
  footnoted there.

---

## Phase 7: ADR-076

### Overview
Document the resolved decisions (ADR-075 is taken by speaker-diarization — use 076).

### Changes Required
- NEW `docs/adr/ADR-076-credential-encryption-at-rest.md` (house style: Status / Context /
  Decision / Consequences + Residual risks / Alternatives / footnotes with URLs):
  - Scheme: passphrase→Argon2id→DEK-in-Desktop-RAM + XChaCha20-Poly1305 + AAD.
  - Rejected: keychain, key-in-binary, file-key, push-to-/dev/shm-after-start (with the
    V1/V2 verified reasons); rejected materialization strategies (tmpfs/fifo/field-level).
  - Revised threat statement (running = between-uid-only); residuals (ephemeral plaintext,
    metadata-oauth-plaintext, guest-swap, downgrade).
- `docs/adr/README.md`: index row. Cross-ref from `security.md`/`containers.md`.

### Success Criteria
- ADR renders; every factual claim has a footnote URL; README index updated; ADR number 076
  (not 075).

---

## Progress

<!-- The only mutable section. First `- [ ]` in document order = next step. -->

### Phase 1: Crypto SSOT

#### Automated
- [ ] 1.1 Add `argon2`/`chacha20poly1305`/`zeroize` deps pin-aligned in both workspaces
- [ ] 1.2 Implement `token_crypto.rs` (derive_dek, seal/unseal, format, check-value, is_sealed)
- [ ] 1.3 Add magic/version/`PASSPHRASE_ENV` to `consts.rs`
- [ ] 1.4 Tests: round-trip, wrong AAD/tag/DEK, check-value, format/version, no-Debug-on-secrets
- [ ] 1.5 `make check test-rust` green

#### Manual
- [ ] 1.6 Confirm Argon2id params chosen (pinned const) and documented for the ADR

### Phase 2: Consolidate 6 writers → SSOT

#### Automated
- [ ] 2.1 Route plugin writer (plugin_cmd.rs) through SSOT helper
- [ ] 2.2 Route built-in (setup_wizard.rs) + per-key/Redmine (integrations_cmd.rs) through SSOT
- [ ] 2.3 Route Anthropic key (auth.rs) + LLM keys (litellm.rs, containers_cmd.rs) through SSOT
- [ ] 2.4 Route OAuth secrets (oauth_flow.rs, oauth_persist.rs) through SSOT
- [ ] 2.5 Per-writer tests assert SSOT path; `make test` green

### Phase 3: Vault + unlock + migration + sanitizer

#### Automated
- [ ] 3.1 Desktop vault module (seal/unseal, DEK-in-RAM mlock+zeroize) + unlock Tauri commands
- [ ] 3.2 `credential_migration.rs` (after-unlock, per-file magic-sniff, delete-on-success, fail-loud)
- [ ] 3.3 `log_sanitizer.rs` passphrase/dek/SPWENC rules + count/list sync
- [ ] 3.4 Tests: unlock/DEK, wrong-passphrase fail-loud, migration idempotency+cleanup, sanitizer
- [ ] 3.5 `make check test` green

#### Manual
- [ ] 3.6 `make dev` (SPEEDWAVE_DATA_DIR=~/.speedwave-dev): set passphrase, save token, `grep` finds no plaintext in `vault/` (sees `SPWENC`); wrong passphrase → fail-loud

### Phase 4: Materialization

#### Automated
- [ ] 4.1 `resolve_runtime_dir_in`/`resolve_runtime_oauth_dir_in` + swing `${TOKENS_DIR}` (mod.rs:286)
- [ ] 4.2 `security_check.rs:34` compute re-derive `runtime/`
- [ ] 4.3 `oauth_process.rs:49,100` repoint OAUTH_STATE_DIR/OAUTH_TOKENS_BASE + test
- [ ] 4.4 Desktop unseal-before-up + re-seal watcher + wipe (down/lock/quit/next-start-before-unseal)
- [ ] 4.5 `compose/workers.rs` digest no-op-on-equal
- [ ] 4.6 Tests: render/security_check green; oauth refresh incl. while-locked; digest stable; wipe; cross-platform
- [ ] 4.7 `make check test` green

#### Manual
- [ ] 4.8 `make dev`: stop project → `runtime/` wiped (idle grep empty); start → SharePoint/litellm boot (no exit(1)); token in container `/tokens`, not on host; DEK absent from compose.yml/inspect/logs; crash → next-start wipe clears residue
- [ ] 4.9 Repeat manual on Windows (cross-platform requirement)

### Phase 5: Downgrade / rollback safety

#### Automated
- [ ] 5.1 `vault/.format-v1` marker + reader fail-loud on leading `SPWENC` (workers.rs:397,149)
- [ ] 5.2 Coordinate migration↔rollback ordering (update.rs)
- [ ] 5.3 Tests: old reader rejects SPWENC; rollback over encrypted vault
- [ ] 5.4 `make check test` green

#### Manual
- [ ] 5.5 `make dev`: simulate old binary over encrypted vault → reader fail-loud, no SPWENC sent to API

### Phase 6: Documentation

#### Automated
- [ ] 6.1 Update security.md, configuration.md, guides, containers.md
- [ ] 6.2 Docs lint / no-orphan check green

### Phase 7: ADR-076

#### Automated
- [ ] 7.1 Write ADR-076 (scheme, rejected options, revised threat statement, residuals, footnotes)
- [ ] 7.2 Update docs/adr/README.md index + cross-refs
- [ ] 7.3 `make check` green (docs)

#### Manual
- [ ] 7.4 Confirm every ADR factual claim has a footnote URL; ADR number is 076 not 075

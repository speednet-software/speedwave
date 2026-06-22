---
change-id: token-encryption-at-rest
title: At-rest encryption for host-side API credentials (SPEED-239)
status: planned
created: 2026-06-21
updated: 2026-06-21
jira: SPEED-239
adr: ADR-076
branch: feat/token-encryption-at-rest
---

# At-rest encryption for host-side API credentials

## Summary

Encrypt all user credentials at rest on the host. Today they are plaintext in
`~/.speedwave/{tokens,oauth,secrets}/`. After this change the durable copy is
ciphertext (XChaCha20-Poly1305, DEK derived from the user's passphrase via Argon2id,
held only in Desktop RAM). Plaintext materializes **ephemerally** to a `runtime/` dir
only while containers run, then is wiped.

## Why

Speedwave markets itself security-first, yet every service token sits plaintext on the
host — readable by any same-user process, including the AI agent's own filesystem access.
On Windows even `0o600` does not apply (`#[cfg(unix)]`). This closes the dormant-credential
gap (stolen disk / backup / sync / idle grep) while honestly accepting that a live session
holds the DEK in RAM so same-uid compromise during a running session is out of scope.

## Scope / Non-goals

- IN: 6 credential write paths consolidated to an SSOT crypto module; vault/runtime split;
  OAuth refresh without giving the worker a DEK; migration; downgrade/rollback safety;
  log sanitizer; ADR-076.
- OUT (residual / follow-up): mlock/MADV_DONTDUMP hardening of running plaintext; keychain;
  hardware-bound keys; `SPEEDWAVE_PASSPHRASE` CI consumer beyond fail-loud stub.

## Key decisions (resolved)

- Passphrase → Argon2id → DEK in Desktop RAM only (never on disk/compose/env/argv/inspect).
- Materialization: host-decrypt → ephemeral `runtime/` 0600 file BEFORE compose_up; existing
  `/tokens:ro` mount reused via `${TOKENS_DIR}` swing. (Push-to-/dev/shm-after-start was
  refuted: eager readers exit/export at boot; /dev/shm not writable for uid 1000.)
- OAuth metadata stays plaintext (locked-Desktop reads it); only secrets encrypted; worker
  writes plaintext to `runtime-oauth/`, Desktop re-seals async → refresh works while locked.
- Recovery: hint + accepted data loss (tokens are re-enterable). No escrow.

## Links

- Plan: ./plan.md
- ADR (to write): docs/adr/ADR-076-credential-encryption-at-rest.md
- Reviews informing v2: 3 independent developer reviews (all verified against source)

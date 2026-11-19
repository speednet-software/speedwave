# ADR-114: Cryptography in one leaf crate

> **Status:** Accepted
> **Date:** 2026-11-19
> **Context:** SPEED-1014. SPEED-1016 (the secret store, fourth sub-issue of step 1 of SPEED-579, secrets at rest) needs authenticated encryption with a random nonce and a derived bearer token. Until now the only cryptography lived inside `crates/pii-engine`.

## Context

`crates/pii-engine/src/siv.rs` held the AES-128-SIV key type, the deterministic seal and open used for PII tokens, and the base64url payload helpers. The secret store and the token derivation need the same cipher and the same key type, but must not depend on the PII engine. The code also has to compile for `wasm32-unknown-unknown`, because `crates/pii-engine-wasm` consumes it.

## Decision

1. **One crate.** `crates/speedwave-crypto` (package `speedwave-crypto`) is a leaf crate with no `std::fs`, no process spawning and no I/O. Its dependencies are `aes-siv`, `hkdf`, `sha2` and `zeroize`. Its `[lints]` tables equal the root ones (`lint_tables_are_aligned`).
2. **Deterministic mode.** `seal_deterministic(key, category, value)` and `open_deterministic` are AES-128-SIV (RFC 5297[^1]) with the category as the only header. The ciphertext is byte-for-byte the one `siv.rs` produced, pinned by frozen vectors, so tokens already written to session transcripts still open.
3. **Nonce mode.** `seal_with_nonce(key, aad, nonce, plaintext)` returns `nonce || ciphertext`. Each `aad` component is its own header, in order, and the nonce is the last header, as RFC 5297[^1] prescribes for nonce-based use. Separate headers keep `["ab", "c"]` and `["a", "bc"]` apart. The caller supplies the 16-byte nonce because the crate must not depend on a random source (it builds for `wasm32-unknown-unknown`). A blob shorter than 32 bytes is rejected, and `open_with_nonce` returns the plaintext in `Zeroizing<Vec<u8>>`, wiped on drop.
4. **Token derivation.** `derive_token(key, purpose, project, service)` is HKDF-SHA256 (RFC 5869[^2]) over the 32 key bytes, no salt, with the info `speedwave-token-v1` followed by each field as a 4-byte big-endian length and its bytes. The output is 32 bytes as 64 lowercase hex characters. It returns `Result` because `Hkdf::expand` does[^4]; the 32-byte request cannot fail. The output buffer is wiped after hex encoding.
5. **`pii-engine` keeps the token format.** The base64url payload encoding stays in `crates/pii-engine/src/payload.rs`. `pii-engine` re-exports `Key` as `EngineKey`, so the proxy, Desktop and the WASM binding compile unchanged; `SivError` and `pii_engine::siv` are gone.
6. **Registration.** The proxy image builds `pii-engine`, which now depends on the new crate by path, so `Containerfile.proxy`, the proxy hash inputs, the bundle scripts and the three lock files list it.

## Consequences

- `hkdf` 0.13.0 depends on `hmac` 0.13[^3], so `hmac` 0.13.0 enters the three lock files; the root and Desktop locks hold `hmac` 0.12.1 as well.
- The secret store (out of scope here) supplies the nonce and the secret name as `aad`.
- A change to the deterministic output breaks the frozen vectors in `crates/speedwave-crypto/src/siv.rs` and orphans stored tokens.

[^1]: RFC 5297, Synthetic Initialization Vector (SIV) Authenticated Encryption Using the Advanced Encryption Standard (AES): https://www.rfc-editor.org/rfc/rfc5297
[^2]: RFC 5869, HMAC-based Extract-and-Expand Key Derivation Function (HKDF): https://www.rfc-editor.org/rfc/rfc5869
[^3]: hkdf 0.13.0 dependencies on crates.io: https://crates.io/crates/hkdf/0.13.0/dependencies
[^4]: hkdf 0.13.0 `GenericHkdf::expand`, which returns `Result<(), InvalidLength>`: https://docs.rs/hkdf/0.13.0/hkdf/struct.GenericHkdf.html

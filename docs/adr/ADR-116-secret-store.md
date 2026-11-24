# ADR-116: Secret store

> **Status:** Accepted
> **Date:** 2026-11-24
> **Context:** SPEED-1016, a step of SPEED-579 (secrets at rest). Every secret Speedwave keeps on the host was a plaintext file in `~/.speedwave`, and each function that wrote or read one chose its own path and format.

## Context

Before this change secrets sat in the data directory as plain files: integration credentials under `tokens/<project>/<service>/`, the local LLM key and custom headers under `tokens/<project>/local-llm/`, provider keys under `tokens/<project>/llm/`, the Anthropic key under `secrets/<project>/anthropic_api_key`, the OAuth refresh token and client secret inside `oauth/<project>/<service>.json`, the PII key under `policies/<project>/key`, and the worker bearers and the proxy caller token under `secrets/<project>/*-auth-token` and `proxy/<project>/caller-token`. A copy of the directory, a backup, or any program of the same user gave direct access to the connected accounts. The plaintext file was the only interface between the code that writes a secret and the code that reads it, so there was no single place to add encryption.

[ADR-114](ADR-114-cryptography-in-one-leaf-crate.md) added the cipher and the token derivation in `crates/speedwave-crypto`. [ADR-115](ADR-115-container-secrets-in-a-vm-tmpfs.md) stopped containers from reading secrets from the host disk. This ADR adds the store that holds the secrets on the host and moves every secret into it. The decision is delivered in two steps. Step 1 (this ADR) puts one encrypted store behind one seam for the key source and keeps the key in a file. Step 2 (SPEED-1012) moves the same key into the macOS keychain and the Windows credential store.

## Decision

1. **One store, one module.** `speedwave_runtime::secret_store` (`crates/speedwave-runtime/src/secret_store/`) is the only code that knows where a secret lives on disk. It exposes a `SecretStore` (open, read, write, delete, exists, read all secrets of a project, lock path, key creation, token derivation, layout check) and a `SecretName`. A `SecretName` is built only by a constructor for a known kind of secret: an integration field, the Anthropic key, an LLM provider key, the local LLM key, the local LLM custom headers, an OAuth refresh token, an OAuth client secret, and the PII key. Callers never build a path.
2. **File layout.** One file per secret: `<data_dir>/secrets/<project>/<service>.<field>.enc`. The built-in kinds map to fixed names: `anthropic.api_key.enc`, `llm.<provider id>_api_key.enc`, `local-llm.api_key.enc`, `local-llm.custom_headers.enc`, `<service>.refresh_token.enc`, `<service>.client_secret.enc`, `pii.key.enc`. A plugin's secret fields use the same `<service>.<field>.enc` shape.
3. **Line format.** A file holds one line, `speedwave-secret:v1:<8 hex key id>:<base64url(nonce + ciphertext + tag)>`. The key id is the first 8 hex characters of the SHA-256 of the install key, so a file sealed under another key is recognised before decryption. The payload is base64url without padding[^3]. A write is atomic (`fs_perms::write_restricted_file_atomic`) and owner-only.
4. **Cipher.** The line is sealed with AES-SIV (RFC 5297[^1]) through `speedwave-crypto::seal_with_nonce`, with a random 16-byte nonce and the secret name as authenticated data: project, service and field are three separate headers, in that order, so a file renamed or copied under another name fails to open. The decrypted value is held in `Zeroizing<String>`.
5. **Install key.** `<data_dir>/secret-store.key` holds 32 random bytes as 64 hex characters, one key per data directory (so one per `SPEEDWAVE_DATA_DIR` instance). It is created on the first write, and only when nothing in `secrets/` could be a ciphertext: no entry named `*.enc` of any type (file, directory or symlink, in `secrets/` or in a project directory) and no symlinked or non-UTF-8 project directory (otherwise the store reports `KeyMissing`). Other loose files, such as `.DS_Store`, do not block the key; `verify_layout` reports them as plaintext in the store. The key is published atomically: the 64 characters are written to a uniquely named temporary file in the same directory (owner-only before the first byte, fsync), then published with a hard link to `secret-store.key`, then the temporary file is removed. The link fails when another creator was first, and that creator's key is loaded. The temporary file is written and synced (`sync_all` plus the platform fsync) before the link, so `secret-store.key` appears only with complete content; a crash leaves at most a temporary file, and a stale one with the same name is replaced on the next attempt. A concurrent Desktop and CLI start cannot produce two keys. A malformed key file is `KeyUnreadable` and is never deleted or replaced. `SecretStore::open` never creates it. Reset of the settings and the uninstaller remove it together with the data.
6. **A key source seam.** The store reads the key through the `KeySource` trait (`load`, `create`). Step 1 has one implementation, `FileKeySource`. Step 2 adds a keychain and a Windows store implementation and moves the same 32 bytes there; the key id in each line stays valid, so no secret is re-encrypted and no integration key is entered again.
7. **Derived tokens are not stored.** The bearer of each built-in worker and the caller token of the proxy are `SecretStore::derive_token(purpose, project, service)`: HKDF-SHA256 (RFC 5869[^2], ADR-114 item 4) over the install key, with the purposes `bearer` (service is the built-in config key) and `caller` (service `proxy`). The value is stable per install, so the CLI, Desktop and a restart agree without a file, and no migration of values is needed. A new install key changes every derived token and the workers are recreated at the next start. Plugin workers keep their bearer as compose env (ADR-115), now with the derived value.
8. **OAuth refresh state is split.** The refresh token, the access token and the client secret are three separate secrets in the store. `oauth/<project>/<service>.json` stays a plain file with the non-secret metadata (provider, grant type, scopes, granted scopes, `expiresAt`, `lastRefreshAt`, the non-secret `providerData` keys), so the Desktop readers of that file need no key. A refresh and a first sign-in write the refresh token first, the access token second, the plain metadata last, and the copy to the tmpfs after that. A crash before the metadata leaves the old `expiresAt`, so the next check refreshes again with the newest refresh token.
9. **The lock sits next to the file it guards.** The refresh lock is `secrets/<project>/<service>.refresh_token.enc.lock` (`SecretStore::lock_path`), an empty file, replacing `oauth/<project>/<service>.lock`. This is the general rule of `.claude/rules/engineering-principles.md`.
10. **Containers get secrets only through the tmpfs payload.** `compose/secret_payload.rs` builds the slots from the non-secret files on disk plus the values read from the store; slot file names and the container side do not change.
11. **Failure behaviour.** A secret that is corrupt, tampered with or sealed under another key breaks only its integration: the project starts without it, a warning with names and no values is logged, and the user sees `secret_store::unreadable_secret_message`. When `.enc` files exist and `secret-store.key` does not, the store reports `KeyMissing` and the project refuses to start (the decision uses the same wide check as item 5: any `*.enc`-named entry or a symlinked project directory counts as a possible ciphertext); the code never creates a new key beside existing ciphertext and never falls back to plaintext. Hot paths that only ask whether an integration is configured (config resolution, status in the UI) check that the `.enc` file exists and do not decrypt, so they work without the key.
12. **Layout check at start.** Any plaintext file in `secrets/` is an error. Allowed entries are `.enc` files, empty `.lock` files and the temporary files of an atomic write. While a migration is pending or failed, `verify_layout` also tolerates the legacy plaintext names `anthropic_api_key` and `*-auth-token` directly in a project directory: the runtime never reads them, and a failed migration is reported to the user, so refusing to start would only hide the report.
13. **Migration.** `secrets_at_rest` in `crates/speedwave-migrations` ([ADR-113](ADR-113-startup-migrations-in-one-crate.md)) moves the old plaintext into the store and runs before `legacy_files`. Its rules:
    - When a plaintext value and a `.enc` file both exist, the `.enc` file wins and the plaintext is removed. An integration reconnected in an older version after an update returns to the value in the `.enc`.
    - When a plaintext secret exists and the `.enc` file is unreadable (corrupt, or sealed under another key), the migration replaces the `.enc` from the plaintext. This also recovers a PII key sealed under another key. A readable `.enc` still wins.
    - An empty plaintext file is removed without encrypting.
    - OAuth state: the `.enc` files for the refresh token and the client secret are written first, then `oauth/<project>/<service>.json` is rewritten atomically without them; the client secret in `oauth/<project>/<slug>.seed.json` moves to the store.
    - The old `compose/<project>/compose.yml` and `snapshots/<project>/snapshot.json` are deleted, because they may hold the plaintext Anthropic key.
    - The worker bearers and the caller token files are deleted; their values are derived from now on.
    - A failed migration of one secret leaves the plaintext in place, the project starts without that integration and Speedwave retries at the next start.
    - A failed migration of the PII key blocks the project. While `policies/<project>/key` exists and the store has no PII key, creating a key is an error, because a new key makes every token in the history unreadable.
    - The install key is created by the migration when there is something to migrate, exclusively.
14. **No downgrade support.** An older version does not read `.enc` files. After a manual reinstall of an older version the integrations show as not configured and must be connected again, and that version creates a new PII key, so the PII history from before the downgrade is unreadable there. Speedwave does not install an older version itself; the update rollback in `update.rs` restores containers only.

## What this protects against and what it does not

This section is the protection statement of the secret store. It describes step 1.

Protects against:

- A copy of the secrets without the key. A file from `secrets/`, a screenshot of a directory listing or a leaked single file is ciphertext that does not open without `secret-store.key`.
- Another operating system user. Both the key and the secret files are owner-only, so another account on the machine reads neither.

Does not protect against:

- A copy of the whole `~/.speedwave` in step 1. The key sits next to the ciphertext, so anyone who copies the directory has both. A backup, a synchronisation client or a disk image of the directory carries the key. Step 2 changes this by moving the key out of the directory into the OS store.
- A process of the same user. It reads the key file and the secret files, and in step 2 it can still ask the OS store for the key within the limits of the OS.
- Someone with access to the VM during a session. The tmpfs of [ADR-115](ADR-115-container-secrets-in-a-vm-tmpfs.md) holds plaintext copies of the secrets of running containers, and a person in the VM can enter a container.
- Swap and hibernation. tmpfs pages can be swapped out[^4], and a hibernation image of the host holds the memory of the Speedwave processes, including decrypted values.
- The Claude Code credentials. `.credentials.json` of Claude Code (Anthropic subscription sign-in) belongs to Claude Code, lives in its own home directory (`claude-home/<project>/`) and is not written by Speedwave ([ADR-052](ADR-052-anthropic-oauth-login-flow.md)).
- The bearers of plugin workers. They stay compose env because the plugin code lives in the sibling repository `speedwave-plugins` and reads env (ADR-115), so they appear in `compose.yml` and in the container description. They are derived values, not stored, but the value is on disk in the compose file.
- The token in `mcp-os.lock.json` and `pii-ner.lock.json`. It lives as long as the host process and is regenerated at every start; the CLI finds a running process by reading this file ([ADR-074](ADR-074-cli-host-bridge-reconstruction.md)), so it has to be readable without the key. The token in `proxy.json` is staged in the tmpfs only.
- The plugin bridge token in `plugin-state/<slug>/bridge-token`. It is stable on purpose, because the external application stores its own copy once ([ADR-063](ADR-063-host-bridge-generic.md)), so a derived or rotating value does not fit.
- Time Machine and other backup copies. The key file is not excluded from backups, because the number of affected people is small and the key beside the ciphertext in the same backup is the same exposure as in item one.
- `claude.env` and the OTLP headers in `config.json`. These are user-entered values in the user config that Speedwave passes on; they are not integration secrets and are not moved into the store. `NoTokensClaude` rejects the four names that carry secrets.

## Release note

Text for the release notes:

- Secrets (integration tokens, API keys, OAuth refresh tokens, the PII key) are now stored encrypted under `~/.speedwave/secrets/`, with the key in `~/.speedwave/secret-store.key`. If you have backups of `~/.speedwave` made before this version, rotate the keys of your integrations: the old backups hold them in plain text.
- Downgrade to an older version is not supported. After you reinstall an older version, integrations must be reconnected, and the PII history from before the downgrade is unreadable there.
- If you update from a version before v0.14.1, the local LLM key is lost and must be entered again (the migration that moved it was removed in ADR-113).

## Consequences

- A missing or replaced `secret-store.key` makes every integration of every project unreadable. Because the key is also the source of the derived tokens, the workers and the proxy token change with it. PII tokens already written to history stay unreadable once the PII key is lost, as in [ADR-083](ADR-083-vaultless-pii-tokenization.md).
- Reading a secret costs one file read and one AES-SIV open. Hot paths that only check configuration use file existence and do not decrypt.
- A new kind of secret needs a `SecretName` constructor and a decision in the consts descriptor (`is_secret`) or the plugin manifest (`AuthFieldDef.is_secret`); a new plaintext secret file is a rule violation.
- The layout check refuses a start when `secrets/` holds a plaintext file, which also catches a regression of the code that writes secrets.
- Step 2 needs no change in the files and no change in the callers. Its work is a `KeySource` implementation, a keychain access window for the CLI and the move of the key.

## Alternatives rejected

- **A key derived from a password.** A password at every start, or an unlock window, changes how every person starts a project. The product owner required no extra password, and the OS store in step 2 gives the same protection from a copied directory without a prompt.
- **The OS keychain first.** It is the target, but it needs a keychain access design for the CLI, `make dev` and the host processes on macOS and a separate store on Windows. Putting the seam first delivers the single place for secrets now and makes step 2 a key move.
- **Secrets in `config.json`.** The file is read by many components and mirrored in the frontend; a secret there spreads to every reader and every log of that file.
- **One key file per project.** It does not protect against a copy of the directory either, and it multiplies the places that must be created, backed up and removed. The PII key is already per project and keeps its own value inside the store.
- **Encrypting whole token directories.** The containers and the Desktop readers need single non-secret files (URLs, emails, ids). One encrypted blob per directory forces a decrypt for every status check and hides which fields are secret.
- **Storing the derived tokens.** More names in `SecretName`, a migration of existing values, deletion on disconnect, and a value that differs between a CLI and a Desktop that wrote it at different times. Derivation gives the same value everywhere without a file.

[^1]: RFC 5297, Synthetic Initialization Vector (SIV) Authenticated Encryption Using the Advanced Encryption Standard (AES): https://www.rfc-editor.org/rfc/rfc5297
[^2]: RFC 5869, HMAC-based Extract-and-Expand Key Derivation Function (HKDF): https://www.rfc-editor.org/rfc/rfc5869
[^3]: RFC 4648, section 5, Base 64 Encoding with URL and Filename Safe Alphabet: https://www.rfc-editor.org/rfc/rfc4648#section-5
[^4]: Linux kernel documentation, tmpfs (swap): https://www.kernel.org/doc/html/latest/filesystems/tmpfs.html

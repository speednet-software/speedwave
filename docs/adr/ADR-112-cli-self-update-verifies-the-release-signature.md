# ADR-112: `speedwave self-update` verifies the release signature

> **Status:** Accepted
> **Date:** 2026-11-19
> **Context:** SPEED-508 reverses the won't-fix of SPEED-51. The standalone CLI archives were packed and uploaded to the GitHub release unsigned, and `run_self_update()` installed whatever GitHub served over HTTPS. The release gave the CLI no trust anchor beyond GitHub. Desktop already verifies every update against a minisign key.

## Context

- Desktop updates through `tauri-plugin-updater`, which checks each artifact against `plugins.updater.pubkey` in `desktop/src-tauri/tauri.conf.json`. The artifacts are signed with `TAURI_SIGNING_PRIVATE_KEY` during `tauri build`.
- `.github/workflows/build-publish.yml` packed `speedwave-v<version>-<target>.{tar.gz,zip}` and uploaded it with `gh release upload`. `scripts/verify-release-assets.sh` listed both archives under `UNSIGNED_ASSETS`.
- `self_update::backends::github::Update` was configured without a verification step, so a compromised GitHub account, release or transport path could replace the binary a user runs with their own privileges.

## Decision

1. **One scheme, one key.** The CLI archives are signed with the Desktop updater key in the format `tauri signer sign` writes: a base64 wrapper around a minisign signature.[^1][^2] The signature is the `<archive>.sig` asset next to the archive. The Tauri CLI signs the BLAKE2b-512 hash of the file, and the global signature covers the signature and the trusted comment.[^3]
2. **The public key has one source.** `crates/speedwave-cli/build.rs` reads `plugins.updater.pubkey` from `tauri.conf.json` and emits it as `SPEEDWAVE_UPDATER_PUBKEY`; the CLI embeds it with `env!`. The build re-runs when `tauri.conf.json` changes. A key rotation therefore changes Desktop and CLI verification together.
3. **Verification runs before extraction and fails closed.** `run_self_update()` resolves the release for the target tag, finds the archive asset for `self_update::get_target()` (never a `.sig` file) and its `<archive>.sig` asset, and downloads the signature. A missing signature asset aborts. The archive is then downloaded by `self_update`, and its `verify_archive` hook runs `release_signature::verify_archive` on the downloaded file before anything is extracted or replaced.[^4] A rejection leaves the installed binary unchanged.
4. **The signature is bound to the release version.** CI passes `--app-version <version>` to `tauri signer sign`, which writes `version:<version>` into the trusted comment.[^2] The CLI requires that value to equal the target tag's version. Without this check, a signed archive of an older release could be served under a newer tag and pass the downgrade guard (`tag_is_newer_than`), which compares tag names. The Tauri updater applies the same comparison when configured with `requireSignedVersion`.
5. **The release gate.** `verify-release-assets.sh` lists both CLI archives under `SIGNED_ASSETS`, so a release without their `.sig` assets, or with an empty one, is not published.

The `minisign-verify` crate does the verification; it is the library `tauri-plugin-updater` uses.

## Consequences

- Installed CLIs have no key. They update without verification up to the first release that ships signed archives. From the version with this change on, `speedwave self-update` is fail-closed: a release without a valid signature cannot be installed by it.
- The check protects against a replaced archive. It does not protect against a compromised signing key, and the key has no offline copy or rotation procedure; both are out of scope here.
- `latest.json` stays unsigned (SPEED-328). `self-update` does not read it: it takes the target tag from the release channel and the assets from that release.
- The Homebrew and apt install paths are unchanged.

## Rejected alternatives

- **A second CLI-only key and format.** Two keys to store, rotate and embed, and two verification paths.
- **Checksums published in the release.** They come from the same place as the archive, so they prove nothing against a compromised release.
- **Verification after extraction.** The archive is untrusted input to the extractor until it is verified.

[^1]: [Tauri CLI reference, `signer sign`](https://v2.tauri.app/reference/cli/): options `-k/--private-key`, `-f/--private-key-path`, `-p/--password`, `--app-version`, and the matching `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PATH` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` environment variables.
[^2]: [`tauri-cli` `signer/sign.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/signer/sign.rs) and [`helpers/updater_signature.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs): `sign_file` writes `<file>.<ext>.sig` containing the base64 of the minisign signature text, and appends `version:<app version>` to the trusted comment.
[^3]: [Minisign](https://jedisct1.github.io/minisign/): the hashed signature is `ed25519(Blake2b-512(<file data>))` and the global signature is `ed25519(<signature> || <trusted_comment>)`.
[^4]: [`self_update` 1.3.3, `verify_archive`](https://docs.rs/self_update/1.3.3/self_update/): the hook runs on the downloaded archive after the crate's own content gates and before extraction; an `Err` aborts the update with nothing installed.

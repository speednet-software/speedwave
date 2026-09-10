# ADR-037: Code Signing and Bundled Binary Signing

> **Status:** Accepted
> **Context:** macOS notarization rejects a bundle if any nested Mach-O is unsigned[^1], but Tauri signs only the main executable (unverified) — so every binary Speedwave ships inside `Contents/Resources/` must be signed individually before bundling.

## Decision

Sign every Mach-O binary bundled into `Speedwave.app` individually, before Tauri wraps the bundle, via a `beforeBundleCommand` hook that runs `scripts/sign-bundled-binaries.sh`. Each binary gets a Developer ID Application signature with Hardened Runtime (`--options runtime`) and a secure timestamp (`--timestamp`); binaries that use restricted platform APIs additionally get a per-binary entitlements plist. The script is a no-op when `APPLE_SIGNING_IDENTITY` is unset, so dev builds need no Apple credentials. Notarization and stapling remain handled by `tauri-action` when the Apple credentials are present.

## Why

- Apple Notary Service requires every Mach-O in a submitted bundle to be signed with Developer ID, use Hardened Runtime, and carry a secure timestamp.[^1] `tauri-bundler` signs only `Contents/MacOS/<main>` and the outer `.app`; nested resources are copied in unsigned, so notarization fails until they are signed too (unverified).
- Lima, Node.js, and other upstream binaries cannot be signed at their own build time — we do not control their build, so signing must happen at bundle time after download.
- Even our own Rust/Swift binaries are ad-hoc signed by the compiler on Apple Silicon; `--force` replaces those with the Developer ID signature.
- A single explicit target list (no recursive globbing) gives a known inventory of exactly what ships signed in `Contents/Resources/`.

## Where it lives in code

- **Signing script (SSOT)** — `scripts/sign-bundled-binaries.sh`. Holds the `SIGN_TARGETS` array (each entry is `<source-path>:<entitlements-path>`, entitlements optional). It signs, then verifies the signature and, for the native CLIs, cross-checks the embedded `CFBundleIdentifier`. Exits 0 on non-Darwin and when `APPLE_SIGNING_IDENTITY` is unset.
- **Bundle resource list** — `desktop/src-tauri/tauri.macos.conf.json` (`bundle.resources`). `SIGN_TARGETS` must stay aligned with this list — they are an SSOT-alignment pair (see root `CLAUDE.md`); adding a Mach-O resource here without adding it to `SIGN_TARGETS` ships an unsigned binary.
- **Build hook** — `desktop/src-tauri/tauri.conf.json` (`build.beforeBundleCommand`): runs `bash scripts/sign-bundled-binaries.sh` with `cwd` set to `../..`. Because the config file lives in `desktop/src-tauri/`, that relative `cwd` resolves to the repo root, where the script path is valid. The hook fires after `cargo build`/`swift build` but before Tauri seals the `.app`, which is the only point where the binaries are present but not yet covered by the outer signature.
- **Entitlements plists** — `desktop/src-tauri/entitlements/`. One minimal plist per capability.

### Entitlements inventory

Hardened Runtime disables several capabilities by default; binaries that use restricted APIs opt back in via an entitlements plist.[^5] The current targets:

| Binary              | Entitlements plist     | Key(s)                                                                                      | Reason                                                                                   |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `cli/speedwave`     | none                   | —                                                                                           | AOT Rust, no restricted APIs                                                             |
| `nodejs/bin/node`   | `node.plist`           | `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory` | V8 JIT engine                                                                            |
| `lima/bin/limactl`  | `virtualization.plist` | `com.apple.security.virtualization`                                                         | Apple Virtualization.framework (`vmType: vz`)                                            |
| `calendar-cli`      | `calendars.plist`      | `com.apple.security.personal-information.calendars`                                         | EventKit Calendar access (see [ADR-010](ADR-010-mcp-os-as-host-process-per-platform.md)) |
| `reminders-cli`     | `reminders.plist`      | `com.apple.security.personal-information.reminders`                                         | EventKit Reminders access                                                                |
| `mail-cli`          | `apple-events.plist`   | `com.apple.security.automation.apple-events`                                                | Apple Events to Mail/Outlook via osascript                                               |
| `notes-cli`         | `apple-events.plist`   | `com.apple.security.automation.apple-events`                                                | Apple Events to Notes via osascript                                                      |
| `audio-capture-cli` | `audio-capture.plist`  | `com.apple.security.device.audio-input`                                                     | Host-side audio capture (see [ADR-056](ADR-056-host-side-audio-transcription.md))        |

Entitlements grant capability at codesign time; TCC still needs a matching `NS*UsageDescription` key in `Info.plist` before macOS shows the consent prompt. The two surfaces are parallel but distinct — missing either silently breaks the feature. The required usage-description keys track the restricted APIs actually used (EventKit calendar/reminders legacy + full-access keys per Apple TN3153[^4], Apple Events, microphone, and a FileProvider key so virtiofs reads from `~/Library/CloudStorage/` are not blocked).

Adding a future bundled binary that needs a restricted API = add its entitlements plist under `desktop/src-tauri/entitlements/` and reference it from `SIGN_TARGETS` (and any required `Info.plist` usage key) in the same commit.

## Rejected alternatives

- **Fork `tauri-action` for recursive bundled-binary signing.** Maintaining a fork of a large TypeScript action is ongoing work; `beforeBundleCommand` is the official extension point for exactly this.[^2]
- **Post-bundle signing (sign binaries inside the finished `.app`).** Re-signing nested binaries after the outer `.app` is sealed invalidates the outer signature, and re-signing the bundle afterward is brittle.
- **Skip notarization, ship Gatekeeper-bypass instructions.** Right-click → Open is acceptable for internal betas, not for external users, and it forgoes Apple's malware scanning.

## Notes

- macOS only — the script has no Windows branch. Windows signing lives in [ADR-086](ADR-086-windows-code-signing-azure-artifact-signing.md): a sibling script, `scripts/sign-windows-binaries.ps1`, hooked from `tauri.windows.conf.json`.
- Per-architecture signing: builds are per-arch (aarch64 + x86_64), so universal-binary slice signing is not needed.
- Developer ID Application certificates expire after 5 years[^3]; an expired cert blocks new releases until reissued.

[^1]: [Notarizing macOS software before distribution - Apple Developer Documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution): every executable must be signed with a valid Developer ID certificate, Hardened Runtime must be enabled, and the signature must include a secure timestamp, or notarization fails.

[^2]: [Tauri Configuration reference](https://v2.tauri.app/reference/config/): `build.beforeBundleCommand` runs a shell command before the bundling phase in `tauri build`.

[^3]: [Developer ID - Apple Developer](https://developer.apple.com/support/developer-id/): "Developer ID certificates are valid for 5 years from the date of creation."

[^4]: [TN3153: Adopting API changes for EventKit in iOS 17, macOS 14, and watchOS 10 - Apple Developer Documentation](https://developer.apple.com/documentation/technotes/tn3153-adopting-api-changes-for-eventkit-in-ios-macos-and-watchos)

[^5]: [Hardened Runtime - Apple Developer Documentation](https://developer.apple.com/documentation/security/hardened-runtime)

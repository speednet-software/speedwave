# ADR-037: Code Signing and Bundled Binary Signing

> **Status:** Accepted

---

## Context

Speedwave is distributed as a single installable desktop application on macOS, Windows, and Linux. Without code signing:

- **macOS Gatekeeper** blocks the app from launching — users see "Speedwave cannot be opened because the developer cannot be verified"[^1]
- **Windows SmartScreen** warns "Windows protected your PC — Unknown publisher", forcing a "More info → Run anyway" click-through[^2]
- Auto-update is unsafe — binaries cannot be cryptographically attributed to Speednet, enabling supply-chain tampering

`tauri-bundler` (invoked by `tauri-action`) signs the **main application executable** and the outer `.app` bundle but does not recursively sign executable resources inside `Contents/Resources/`[^10]. The macOS bundle's `tauri.macos.conf.json → bundle.resources` lists additional Mach-O executables that Tauri copies into `Contents/Resources/` verbatim:

- `cli/speedwave` — main Rust CLI that calls into `speedwave-runtime`
- `calendar-cli`, `mail-cli`, `notes-cli`, `reminders-cli` — Swift-built native helpers for macOS personal information management (see [ADR-010](ADR-010-mcp-os-as-host-process-per-platform.md))
- `lima/bin/limactl` — bundled Lima VM manager (see [ADR-002](ADR-002-lima-as-vm-manager-on-macos.md), [ADR-021](ADR-021-bundled-dependencies-and-zero-install-strategy.md))
- `nodejs/bin/node` — bundled Node.js runtime used by mcp-os

Apple Notary Service enforces a strict rule: **every Mach-O executable inside a bundle submitted for notarization must itself be signed with a Developer ID Application certificate, use Hardened Runtime, and carry a secure timestamp.**[^3] If any nested binary is unsigned, notarization returns `status: Invalid` with specific error codes[^4], and Gatekeeper continues to block the app even though the outer bundle is signed.

The first notarization attempt (2026-04-14) failed with:

```
The binary is not signed with a valid Developer ID certificate.
The signature does not include a secure timestamp.
The executable does not have the hardened runtime enabled.
```

— affecting all seven Mach-O resources listed above.

## Decision

**Sign every Mach-O binary bundled into `Speedwave.app` individually before Tauri wraps the bundle.** The tauri-action-provided signing of the main executable is not sufficient; bundled tools require their own signatures.

### Implementation

Three coordinated changes:

**1. `scripts/sign-bundled-binaries.sh` (new)** — signs each Mach-O resource listed in `tauri.macos.conf.json → bundle.resources` with an explicit target list (no recursive globbing). The base `codesign` invocation is:

```bash
codesign --force \
  --options runtime \
  --timestamp \
  --sign "$APPLE_SIGNING_IDENTITY" \
  "$binary"
```

The three flags encode three non-negotiable notarization requirements:

| Flag                | Purpose                                                                                                                                                               | Required by        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `--options runtime` | Enables Hardened Runtime — disables DYLD injection, JIT without entitlement, and dynamic library loading from unsigned paths                                          | Notary Service[^5] |
| `--timestamp`       | RFC 3161 timestamp from Apple's timestamp server — proves the binary was signed while the certificate was valid                                                       | Notary Service[^6] |
| `--force`           | Overwrites pre-existing signatures (upstream vendor signatures on `limactl` and `node`, ad-hoc signatures Apple Silicon `cargo build` writes into Rust binaries[^14]) | Build determinism  |

The script is a no-op when `APPLE_SIGNING_IDENTITY` is not set, so dev builds on developer machines work without Apple credentials.

**1a. Per-binary entitlements for Node.js.** Node.js is the only bundled binary that needs additional `codesign --entitlements` — V8 allocates executable+writable memory pages for JIT-compiled bytecode, and Hardened Runtime blocks those allocations by default. Without `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`, `node` crashes at startup with `Fatal process out of memory: Failed to reserve virtual memory for CodeRange`[^15]. The entitlements plist lives at `desktop/src-tauri/entitlements/node.plist`.

**2. `tauri.conf.json` — `beforeBundleCommand` hook** — Tauri v2 runs a pre-bundle script after `cargo build` but before `tauri bundle` wraps binaries into `.app`[^7]. This is the correct integration point because all dependencies are already copied into `desktop/src-tauri/{cli,lima,nodejs,*-cli}` but not yet sealed into the bundle.

```json
{
  "build": {
    "beforeBundleCommand": "bash -c 'cd \"$(git rev-parse --show-toplevel)\" && scripts/sign-bundled-binaries.sh'"
  }
}
```

Using `git rev-parse --show-toplevel` resolves the repo root deterministically regardless of where Tauri executes the hook from — Tauri's cwd for `beforeBundleCommand` is not a documented stable contract[^8].

Notarization and stapling are already handled by `tauri-action` when `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` are set — no workflow changes required. Apple returns `Accepted` once every Mach-O in the bundle passes the three requirements above, and stapling embeds the resulting ticket into the `.app` so Gatekeeper validates offline[^9].

### Rationale

#### Why not sign binaries individually in their respective build scripts?

Three reasons:

1. **Single source of truth.** Lima, Node.js, and nerdctl come from upstream vendors — we cannot modify their build. Signing must happen at bundle-time, after download.
2. **Re-signs after `cargo build` / `swift build`.** Even our own binaries get ad-hoc signed locally by the compiler; those signatures must be replaced with Developer ID signatures + Hardened Runtime.
3. **Consistency with dev builds.** When `APPLE_SIGNING_IDENTITY` is unset (dev builds), no signing runs — the same code path works locally without Apple setup.

#### Why not rely on `tauri-action`'s built-in signing exclusively?

tauri-action's macOS signing logic was designed assuming the Tauri app has no bundled external binaries. It signs `Contents/MacOS/<main>` and the `.app` bundle root, but does not recursively sign `Contents/Resources/**/*` Mach-O files[^10]. This is a known limitation — PRs to extend it upstream have stalled. Implementing it ourselves via `beforeBundleCommand` is more maintainable than carrying a fork.

#### Why Node.js needs entitlements and other binaries do not

Hardened Runtime disables several legacy behaviors by default (JIT, DYLD env vars, library validation). `limactl` is a Go binary with no JIT; our Swift and Rust CLIs are AOT-compiled. Only Node.js (V8 engine) needs `allow-jit` + `allow-unsigned-executable-memory` entitlements[^11]. If a future bundled binary requires JIT (e.g. a Python runtime with PyPy) or DYLD injection, add its entitlements plist under `desktop/src-tauri/entitlements/` and reference it from the `SIGN_TARGETS` table in the script.

## Consequences

### Positive

- macOS users can launch Speedwave without Gatekeeper warnings on first run
- Auto-update integrity — Tauri's Ed25519 updater signature chain combines with OS-level Developer ID signature chain for defense in depth
- CI builds are reproducibly signed — no manual codesign step per release
- Dev builds on developer machines remain unsigned (no Apple credentials required locally)
- Explicit inventory of every signed binary: we know exactly what ships in `Contents/Resources/`

### Negative

- **Release-time Apple API dependency.** If Apple Notary Service is down (rare, ~99.9% SLA[^12]), releases cannot be notarized. Workaround: release as unsigned, with a known UX degradation.
- **Cost floor.** Apple Developer Program ($99/yr) is required for any signed macOS distribution.
- **Per-architecture signing.** Universal binaries would require signing per architecture slice; current builds are per-arch (aarch64 + x86_64) so this is transparent.
- **Certificate renewal risk.** Developer ID Application certificates expire after 5 years. A calendar reminder is required; expired cert = no new releases until reissued.

### Neutral

- **macOS only.** The script exits 0 on non-Darwin platforms. `beforeBundleCommand` runs on every platform, but the script itself has no Linux or Windows branch today.
- **Windows signing (Azure Trusted Signing)** is tracked separately in issue #376 and has a distinct architecture (HSM-backed cloud signing, no local `.pfx`[^13]). When implemented, it will add a Windows branch to this script or a sibling script — the hook itself already runs on Windows.
- **Linux signing** (AppImage / .deb) is not planned. Linux does not enforce runtime signature verification at the OS level; the existing Tauri updater's Ed25519 signature protects update integrity.

## Alternatives Considered

### 1. Fork tauri-action to support recursive bundled-binary signing

Rejected. Maintaining a fork of a ~3000-line TypeScript action is ongoing work. The `beforeBundleCommand` hook is an official Tauri extension point designed for exactly this kind of pre-bundle customization — using it keeps us on the supported upstream path.

### 2. Post-bundle signing — sign binaries inside the final `.app`

Rejected. `codesign` of nested binaries after the outer `.app` is sealed invalidates the outer signature (the bundle's code signature covers all contained files). Re-signing the outer bundle after nested edits works but is brittle — easy to leave a stale intermediate signature behind.

### 3. Skip notarization, rely on Gatekeeper bypass instructions

Rejected. Requiring users to right-click → Open → Open Anyway for first launch is acceptable for internal betas but not for a platform sold to external users. It also bypasses Apple's malware scanning — a value-add Speednet gets for the $99/yr Developer Program fee.

---

[^1]: [Apple Developer — "Protecting users against malware" — Gatekeeper enforcement of Developer ID](https://developer.apple.com/documentation/security/updating-mac-software)

[^2]: [Microsoft Learn — "Microsoft Defender SmartScreen overview" — unsigned binaries trigger the Unknown Publisher prompt](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)

[^3]: [Apple Developer — "Resolving common notarization issues" — all executables must be signed with Developer ID and timestamped](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution/resolving_common_notarization_issues)

[^4]: [Apple Developer — notarization error codes for unsigned binaries, missing timestamps, disabled hardened runtime](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution/resolving_common_notarization_issues#3087721)

[^5]: [Apple Developer — "Enabling Hardened Runtime" — required for notarized apps distributed outside the App Store](https://developer.apple.com/documentation/security/hardened_runtime)

[^6]: [Apple Developer — "Include a secure timestamp" — `codesign --timestamp` uses Apple's RFC 3161 Time Stamp Authority](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution/customizing_the_notarization_workflow)

[^7]: [Tauri v2 docs — `beforeBundleCommand` runs after cargo build and before platform-specific bundling (DMG, NSIS, deb)](https://v2.tauri.app/reference/config/#beforebundlecommand)

[^8]: [Tauri v2 docs — build hooks accept shell commands; cwd is not specified as part of the stable API contract](https://v2.tauri.app/reference/config/#buildconfig)

[^9]: [Apple Developer — "Stapling a ticket to your app" — required so Gatekeeper validates offline](https://developer.apple.com/documentation/security/customizing_the_notarization_workflow)

[^10]: [tauri-bundler source — `sign_app` signs the main binary and outer bundle; resources under `Contents/Resources/` are copied in unsigned](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/sign.rs)

[^11]: [Apple Developer — "Hardened Runtime entitlements" — list of entitlements that opt back into disabled capabilities](https://developer.apple.com/documentation/security/hardened_runtime#3098734)

[^12]: [Apple System Status — Developer services uptime record](https://developer.apple.com/system-status/)

[^13]: [Microsoft Learn — "Azure Trusted Signing: HSM-backed cloud signing for Windows apps" (formerly in /trusted-signing/, redirects now handled by MS Learn)](https://learn.microsoft.com/en-us/azure/trusted-signing/overview)

[^14]: [Apple Developer — `kSecCodeSignatureAdhoc` flag — binaries on Apple Silicon are ad-hoc signed at link time (`Signature=adhoc, flags=0x20002(adhoc,linker-signed)`); `codesign --force` replaces the ad-hoc signature with a Developer ID signature](https://developer.apple.com/documentation/security/seccodesignatureflags/kseccodesignatureadhoc)

[^15]: [Apple Developer — `com.apple.security.cs.allow-jit` entitlement — required for processes that generate executable code at runtime (e.g. V8, JavaScriptCore)](https://developer.apple.com/documentation/bundleresources/entitlements/com_apple_security_cs_allow-jit)

# Release Code Signing

Operational guide for setting up and maintaining macOS and Windows code signing for Speedwave releases. For the architectural rationale (why every Mach-O in `Contents/Resources/` is signed individually, entitlements required for Node.js, choice of flags), see [ADR-037](../adr/ADR-037-code-signing-and-bundled-binary-signing.md).

## When this matters

Code signing only affects **release builds**, not dev builds. You only need to read this document if you are:

- Setting up a new signing environment from scratch (first macOS release, certificate rotation)
- Adding a new bundled binary that ships in `Contents/Resources/` (see below)
- Debugging a notarization failure in CI

Dev builds (`make dev`, local `cargo tauri build` without `APPLE_SIGNING_IDENTITY`) are a no-op for signing — the script in `scripts/sign-bundled-binaries.sh` exits immediately when the identity env var is unset.

## macOS signing — one-time setup

### 1. Apple Developer Program enrollment

Prerequisites:

- Organization enrollment (not Individual) — required for `Developer ID Application` certificates issued under a legal entity
- D-U-N-S number for the company (free, 1–5 business days to obtain at https://developer.apple.com/enroll/duns-lookup/)
- The enrolling Apple ID must hold the **Account Holder** role — only Account Holder can create `Developer ID Application` certificates, even Admins cannot

### 2. Generate a Certificate Signing Request (CSR)

macOS Keychain Assistant occasionally fails with "specified item could not be found" when generating CSRs — use `openssl` instead for reproducibility:

```bash
mkdir -p ~/apple-signing
cd ~/apple-signing

openssl genrsa -out speedwave.key 2048
openssl req -new -key speedwave.key -out speedwave.csr \
  -subj "/emailAddress=<account-holder-email>/CN=<Legal Entity Name>/C=<ISO-country-code>"
# Example C value: PL (ISO 3166-1 alpha-2). Not a country name.
```

Keep `speedwave.key` — it is the long-lived private key. If you lose it, you cannot renew the certificate without generating a new keypair (invalidating all prior signed artifacts trust chains for new releases).

### 3. Create the Developer ID Application certificate

1. Sign in as Account Holder at https://developer.apple.com/account
2. **Certificates, IDs & Profiles → Certificates → "+"**
3. Select **Developer ID Application** (NOT "Mac App Distribution")
4. Profile Type: **G2 Sub-CA (Xcode 11.4.1 or later)** — older Sub-CA is deprecated
5. Upload the CSR from step 2
6. Download the resulting `.cer` file

### 4. Build the `.p12` bundle

The `.p12` is the combined certificate + private key that CI systems import. Generate it without exposing the password to shell history:

```bash
cd ~/apple-signing

# Convert the Apple-issued .cer to PEM
openssl x509 -inform DER -in developerID_application.cer -out developerID_application.pem

# Bundle into .p12 — openssl prompts interactively for Export Password
openssl pkcs12 -export -legacy \
  -out speedwave.p12 \
  -inkey speedwave.key \
  -in developerID_application.pem
# Enter Export Password: <strong password, 20+ random chars>
# Verifying - Enter Export Password: <same>
```

**On `-legacy`.** OpenSSL 3.x (available via Homebrew) defaults to encrypting `.p12` with AES-256-CBC + PBKDF2, which older importers including macOS Keychain `security import` cannot read. The `-legacy` flag selects the older RC2/SHA1 encoding that Keychain and Apple's notary toolchain accept[^legacy-flag]. macOS ships LibreSSL as `/usr/bin/openssl`, which does not have `-legacy` and always writes the legacy format — if you use the system binary, drop the flag.

### 5. Import into local Keychain (for local signed builds)

Omit `-P` so `security` prompts for the password instead of accepting it from the command line (which lands in shell history):

```bash
security import speedwave.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
# Enter password: <paste the .p12 password>
security import speedwave.key -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign

# Apple's Developer ID G2 intermediate CA — required so find-identity sees the identity
security import <(curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer) \
  -k ~/Library/Keychains/login.keychain-db

# Verify
security find-identity -v -p codesigning | grep "Developer ID"
# Expected: 1) <SHA1> "Developer ID Application: <Legal Entity> (TEAMID)"
```

If you must pass the password on the command line (e.g. in a script), prefix the command with a space when `HISTCONTROL=ignorespace` (default in zsh) or `setopt HIST_IGNORE_SPACE` is active, and unset `HISTFILE` for the session.

### 6. Generate an app-specific password for notarization

The notary service rejects the regular Apple ID password when 2FA is enabled. Generate a dedicated app-specific password:

1. Sign in at https://account.apple.com (not developer.apple.com)
2. **Sign-In and Security → App-Specific Passwords → Generate**
3. Label: `Speedwave CI`
4. Store the value — you cannot retrieve it again, only regenerate

### 7. Configure GitHub Secrets

All six secrets must be set on the repository or — preferably — within a [production environment with required reviewers](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment).

Use `gh secret set` with stdin (`--body -` or redirection) to avoid putting secret values on the command line, which lands them in shell history:

```bash
# .p12 → base64 (file stays local, gh reads from stdin)
base64 < speedwave.p12 | gh secret set APPLE_CERTIFICATE --repo <org>/<repo> --body -

# Non-sensitive values — safe to pass inline
gh secret set APPLE_SIGNING_IDENTITY --repo <org>/<repo> \
  --body 'Developer ID Application: <Legal Entity> (TEAMID)'
gh secret set APPLE_ID --repo <org>/<repo> --body '<account-holder-email>'
gh secret set APPLE_TEAM_ID --repo <org>/<repo> --body '<TEAMID>'

# Sensitive values — read from tty, no history exposure
read -rs pw && printf %s "$pw" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo <org>/<repo> --body -
read -rs pw && printf %s "$pw" | gh secret set APPLE_PASSWORD --repo <org>/<repo> --body -
unset pw
```

### 8. Secure backup

After setup, move `speedwave.p12`, `speedwave.key`, and `speedwave.csr` to an encrypted credential store (1Password, Bitwarden, corporate password manager). Then delete the local working directory:

```bash
rm -rf ~/apple-signing
```

`.gitignore` already excludes `*.p12`, `*.pfx`, `*.cer`, `*.key`, `*.csr`, and `apple-signing/` paths — signing materials cannot be accidentally committed. Never override the ignore list (`git add -f`) for these files.

## macOS signing — local verification

After running `make build-tauri` with `APPLE_SIGNING_IDENTITY` set in the environment, verify the signed `.app`:

```bash
APP=desktop/src-tauri/target/release/bundle/macos/Speedwave.app

# 1. Signature is valid
codesign --verify --deep --strict --verbose=2 "$APP"
# Expected: valid on disk + satisfies its Designated Requirement

# 2. Certificate chain is correct
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier"
# Expected chain: Speedwave → Developer ID Certification Authority → Apple Root CA

# 3. All bundled binaries have Hardened Runtime
codesign -d --verbose=4 "$APP/Contents/Resources/cli/speedwave" 2>&1 | grep flags
# Expected: flags=0x10000(runtime)
```

Without notarization, Gatekeeper will report `rejected (Unnotarized Developer ID)` — this is expected for local builds. CI notarizes every release.

## macOS signing — local notarization (optional)

You can notarize locally to test the full flow before pushing to CI. Store credentials in Keychain once:

```bash
# Interactive — prompts for the app-specific password, never in history
xcrun notarytool store-credentials "speedwave-notary" \
  --apple-id "<account-holder-email>" \
  --team-id "<TEAMID>"
# Enter the password when prompted
```

Then submit and staple:

```bash
APP=desktop/src-tauri/target/release/bundle/macos/Speedwave.app
ZIP=/tmp/Speedwave.zip
ditto -c -k --keepParent "$APP" "$ZIP"

xcrun notarytool submit "$ZIP" --keychain-profile "speedwave-notary" --wait
# Expected: status: Accepted

xcrun stapler staple "$APP"
spctl -a -vvv -t exec "$APP"
# Expected: accepted — source=Notarized Developer ID
```

If notarization fails, fetch the diagnostic log:

```bash
xcrun notarytool log <submission-id> --keychain-profile "speedwave-notary"
```

Common failure modes:

| Log message                                                      | Fix                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `The binary is not signed with a valid Developer ID certificate` | A bundled binary in `Contents/Resources/` was missed — add its path to `scripts/sign-bundled-binaries.sh` |
| `The signature does not include a secure timestamp`              | `codesign` was called without `--timestamp` — check the script                                            |
| `The executable does not have the hardened runtime enabled`      | `codesign` was called without `--options runtime`                                                         |
| `The signature of the binary is invalid`                         | Binary was modified after signing — re-run the build                                                      |

## Adding a new bundled binary

When a PR introduces a new executable resource in `tauri.macos.conf.json → bundle.resources`:

1. Add its source path to the `SIGN_TARGETS` array in `scripts/sign-bundled-binaries.sh` with an entitlements suffix: `"$SRC_TAURI/<path>:"` for no entitlements, or `"$SRC_TAURI/<path>:$SOME_PLIST"` for a plist
2. If the binary is a language runtime with JIT (Python with PyPy, Ruby YARV, another Node variant), create a plist in `desktop/src-tauri/entitlements/` with `com.apple.security.cs.allow-jit` and reference it in step 1
3. Verify locally with `make build-tauri` + the notarization test above — if Apple rejects, the log says which binary is missing
4. Update [ADR-037](../adr/ADR-037-code-signing-and-bundled-binary-signing.md) inventory if the binary is architecturally significant

Binaries that don't need signing (no change required):

- Shell scripts (`*.sh`) — notarization only checks Mach-O files
- Images, icons, static data files
- JavaScript files inside `mcp-os/` — executed by the already-signed bundled Node.js, not loaded as native code
- Files under `Contents/Resources/build-context/` that will be built inside containers at runtime

## Windows signing

Tracked in issue #376. Windows will use Azure Trusted Signing (HSM-backed cloud signing) — no local `.pfx` file. See [Azure Trusted Signing overview](https://learn.microsoft.com/en-us/azure/trusted-signing/overview) for the architecture.

Current status: the `beforeBundleCommand` hook runs on Windows, but `scripts/sign-bundled-binaries.sh` exits 0 immediately on non-Darwin platforms. The Windows branch will either live in the same script (conditional on `uname` / `$OS`) or in a sibling `sign-bundled-binaries.ps1` — decision deferred to the Windows implementation PR.

## Certificate rotation

### Developer ID Application certificate — 5-year expiry

Apple-issued Developer ID Application certificates are valid for 5 years from issuance. To rotate:

1. Reuse the same `speedwave.key` — no need to regenerate the keypair
2. Re-submit `speedwave.csr` to Apple via the developer portal (new certificate, same public key)
3. Rebuild `.p12` from the new `.cer` + existing `.key`
4. Update `APPLE_CERTIFICATE` secret in GitHub
5. No workflow changes required

Set a calendar reminder 30 days before expiry. The current certificate's expiry date is recorded in the secure credential store.

### App-specific password — rotate whenever compromised

App-specific passwords have no expiry but should be rotated if:

- The CI environment is compromised
- A team member with access leaves
- Annually as a defensive hygiene measure

Revoke the old password at https://account.apple.com and regenerate. Update `APPLE_PASSWORD` secret.

### Account Holder transfer

If the Account Holder leaves the organization:

1. Current Account Holder transfers the role via https://developer.apple.com → Membership details → Transfer Account Holder Role
2. New Account Holder re-confirms access to certificate backup
3. No certificate re-issuance is required — the certificate is tied to the legal entity (Team ID), not the individual

### `.p12` or private key compromise

If the certificate private key leaks (stolen laptop, accidental git commit, compromised backup):

1. **Revoke immediately** at https://developer.apple.com → Certificates, IDs & Profiles → select the certificate → Revoke. Revocation takes effect within hours via OCSP; notarized artifacts signed with the revoked cert stop passing Gatekeeper for new installs, though already-installed copies continue to work until the stapled ticket expires
2. **Issue a new certificate.** Generate a new keypair (do not reuse the leaked `speedwave.key`), new CSR, new cert. See steps 2–4 above
3. **Update CI secrets.** Replace `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` with the new `.p12` and password
4. **Re-release.** Any outstanding releases signed with the old cert are now untrusted — cut a new patch release to distribute re-signed artifacts
5. **Rotate co-dependent credentials.** If the leak was through a compromised machine, also rotate the app-specific password and any GitHub tokens on that machine

There is no Apple-side "revocation list" notification — Speednet must detect leaks through its own monitoring (scanning git history, credential store access logs, code review).

## Troubleshooting

### `security find-identity -v -p codesigning` shows 0 identities

The Apple Developer ID intermediate CA is missing. Install it:

```bash
curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer | \
  security import /dev/stdin -k ~/Library/Keychains/login.keychain-db
```

### `codesign` succeeds but notarization rejects with "invalid signature"

The bundled binary was modified after signing (e.g., a later build step stripped symbols). Move the signing step to after all modifications — `beforeBundleCommand` in `tauri.conf.json` is the correct hook.

### Notarization stuck "In Progress" for more than 15 minutes

Apple's median notarization time is 2–5 minutes, 99th percentile is 15 minutes[^1]. Longer means either an outage (check https://developer.apple.com/system-status/) or a large bundle. Do not re-submit — each submission gets a unique ID and re-submitting wastes the notary quota.

### Gatekeeper still rejects after successful notarization

Stapling was skipped. Re-run `xcrun stapler staple <path>.app`. Without stapling, Gatekeeper must contact Apple's servers at first launch — if the user is offline, the app won't open.

[^1]: [Apple Developer — "About notarization for macOS apps" — typical processing time](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)

[^legacy-flag]: [OpenSSL 3.0 migration guide — `-legacy` flag required for PKCS#12 files that older tools must read (RC2 + SHA1 MAC vs the new AES-256-CBC + PBKDF2 default)](https://wiki.openssl.org/index.php/OpenSSL_3.0#PKCS12_Changes)

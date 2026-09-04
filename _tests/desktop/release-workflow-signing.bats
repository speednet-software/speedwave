#!/usr/bin/env bats

# Guards .github/workflows/desktop-release.yml against the macOS signing regression from PR #458/
# v0.7.2-draft: without keychain-import before tauri-action, codesign hits an empty keychain and fails.

WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/desktop-release.yml"
VERIFY_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/verify-release-assets.sh"

@test "desktop-release.yml exists" {
    [ -f "$WORKFLOW" ]
}

@test "workflow imports Apple certificate into keychain before tauri-action" {
    # Grab line numbers of the keychain-import step and the tauri-action step.
    import_line=$(grep -n "Import Apple signing certificate to keychain" "$WORKFLOW" | head -1 | cut -d: -f1)
    tauri_line=$(grep -n "tauri-apps/tauri-action@" "$WORKFLOW" | head -1 | cut -d: -f1)

    [ -n "$import_line" ]
    [ -n "$tauri_line" ]
    # Import must come before tauri-action, or beforeBundleCommand sees an empty keychain.
    [ "$import_line" -lt "$tauri_line" ]
}

@test "keychain import uses the prescribed security commands" {
    # create-keychain + import + set-key-partition-list: the pattern Tauri/Apple require for
    # codesign to find a Developer ID identity on a headless CI runner. All three must be present.
    grep -q "security create-keychain" "$WORKFLOW"
    grep -q "security import" "$WORKFLOW"
    grep -q "security set-key-partition-list" "$WORKFLOW"
}

@test "keychain import grants codesign access to the imported key" {
    # `-T /usr/bin/codesign` lets codesign read the private key without a GUI password prompt;
    # missing it is a common silent-failure mode.
    grep -q -- "-T /usr/bin/codesign" "$WORKFLOW"
}

@test "keychain import prepends build keychain to search list" {
    # codesign resolves identities via the keychain search list; if the build keychain isn't added,
    # `find-identity` returns empty. `security list-keychains -s` is the fix.
    grep -q "security list-keychains" "$WORKFLOW"
}

@test "keychain import fails fast if identity is not resolvable" {
    # `security import` exiting 0 isn't enough — a malformed .p12 can import without a usable
    # codesigning identity. `find-identity` after import is the canonical smoke test.
    grep -q "security find-identity" "$WORKFLOW"
}

@test "keychain import uses fixed-string grep for identity verification" {
    # Identity contains `(TEAM)` — grep without -F mis-treats parens as regex; without -F and an
    # empty-identity guard, `grep -q ""` matches every line and passes silently when unset.
    grep -qF 'grep -qF' "$WORKFLOW"
}

@test "keychain import guards against empty APPLE_SIGNING_IDENTITY" {
    # If APPLE_CERTIFICATE is set but APPLE_SIGNING_IDENTITY isn't, the downstream grep would
    # match every line and silently succeed; must fail fast before find-identity.
    grep -qF 'APPLE_SIGNING_IDENTITY is empty' "$WORKFLOW"
}

@test "keychain import uses while-read loop for safe keychain list expansion" {
    # `security list-keychains -d user` output must read into an array without word splitting;
    # macOS ships bash 3.2 which lacks mapfile, so a while-read loop is the compatible equivalent.
    grep -qF 'while IFS= read -r' "$WORKFLOW"
}

@test "keychain import step gates on matrix.platform == 'macos-latest'" {
    # Must not run on Linux/Windows jobs — security commands don't exist there. Search forward
    # from the step name for the next `if:` line rather than assume a fixed offset.
    import_line=$(grep -n "Import Apple signing certificate to keychain" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$import_line" ]
    guard_line=$(awk -v start="$import_line" 'NR>start && /^        if:/ { print NR; exit }' "$WORKFLOW")
    [ -n "$guard_line" ]
    sed -n "${guard_line}p" "$WORKFLOW" | grep -q "matrix.platform == 'macos-latest'"
}

@test "workflow passes releaseAssetNamePattern to tauri-action" {
    # tauri-action >= 1.0.0 input name; the old assetNamePattern is silently ignored,
    # dropping the arch-labeled asset names verify-release-assets.sh enumerates.
    grep -qF 'releaseAssetNamePattern:' "$WORKFLOW"
}

@test "workflow uses no tauri-action inputs removed in 1.0.0" {
    # Removed inputs produce only a warning, never a fail — absence must be pinned here.
    for input in assetNamePattern includeUpdaterJson updaterJsonKeepUniversal includeRelease includeDebug; do
        if grep -qE "^[[:space:]]+${input}:" "$WORKFLOW"; then
            echo "ERROR: '${input}' is not an input of the pinned tauri-action version" >&2
            return 1
        fi
    done
}

@test "verify-release-assets.sh enumerates macOS updater assets" {
    # Anti-removal guard: the release-gate script must enumerate macOS updater
    # archive names explicitly so a missing asset fails the release before publish.
    grep -qF "macOS_Apple_Silicon.app.tar.gz" "$VERIFY_SCRIPT"
}

@test "verify-release-assets.sh enumerates Windows updater assets" {
    # Anti-removal guard: Windows updater asset names must appear explicitly so
    # a missing .sig fails the release before publish.
    grep -qF "x64-setup.nsis.zip" "$VERIFY_SCRIPT"
    grep -qF "x64_en-US.msi.zip" "$VERIFY_SCRIPT"
}

@test "verify-release-assets.sh verifies .sig non-emptiness" {
    # Anti-removal guard: an empty .sig file (size == 0) must cause a release
    # failure before publish — the error message is the stable semantic marker.
    grep -qF "signature file empty" "$VERIFY_SCRIPT"
}

@test "verify-release-assets.sh enforces required latest.json platform keys" {
    # Anti-removal guard: all 7 required platform keys must appear in the
    # script so missing keys are caught before the release publishes.
    grep -qF '"darwin-x86_64"' "$VERIFY_SCRIPT"
    grep -qF '"darwin-x86_64-app"' "$VERIFY_SCRIPT"
    grep -qF '"darwin-aarch64"' "$VERIFY_SCRIPT"
    grep -qF '"darwin-aarch64-app"' "$VERIFY_SCRIPT"
    grep -qF '"windows-x86_64"' "$VERIFY_SCRIPT"
    grep -qF '"windows-x86_64-msi"' "$VERIFY_SCRIPT"
    grep -qF '"windows-x86_64-nsis"' "$VERIFY_SCRIPT"
}

SIGN_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/sign-bundled-binaries.sh"

@test "SIGN_TARGETS uses REMINDERS_ENTITLEMENTS for reminders-cli (not CALENDARS)" {
    # Verifies the step-3 fix: reminders-cli must use the separate reminders.plist,
    # not the calendars.plist. Wrong plist = Hardened Runtime rejects Reminders access.
    grep -qF 'reminders-cli:$REMINDERS_ENTITLEMENTS' "$SIGN_SCRIPT"
}

@test "SIGN_TARGETS does NOT use CALENDARS_ENTITLEMENTS for reminders-cli" {
    # Ensures the old wrong wiring is gone.
    if grep -qF '"$SRC_TAURI/reminders-cli:$CALENDARS_ENTITLEMENTS"' "$SIGN_SCRIPT"; then
        echo "ERROR: reminders-cli must use REMINDERS_ENTITLEMENTS, not CALENDARS_ENTITLEMENTS" >&2
        return 1
    fi
}

@test "REMINDERS_ENTITLEMENTS variable is defined in signing script" {
    grep -qF 'REMINDERS_ENTITLEMENTS=' "$SIGN_SCRIPT"
}

@test "bundle ID in tauri.conf.json matches fallback literal in Utilities.swift" {
    # Cross-check the bundle identifier SSOT (tauri.conf.json) against the Swift fallback literal,
    # only used in standalone runs (runtime normally uses Bundle.main.bundleIdentifier).
    local tauri_conf="$BATS_TEST_DIRNAME/../../desktop/src-tauri/tauri.conf.json"
    local utilities_swift="$BATS_TEST_DIRNAME/../../native/macos/shared/Sources/SharedCLI/Utilities.swift"
    [ -f "$tauri_conf" ]
    [ -f "$utilities_swift" ]

    local tauri_id
    tauri_id=$(python3 -c "import json,sys; print(json.load(open('$tauri_conf'))['identifier'])")
    [ -n "$tauri_id" ]

    grep -qF "\"$tauri_id\"" "$utilities_swift"
}

# ── Windows signing (ADR-086): OIDC login + Azure Artifact Signing ──────────────────────

SIGNING_LOGIN_ACTION="$BATS_TEST_DIRNAME/../../.github/actions/azure-signing-login/action.yml"

@test "workflow configures Windows signing before tauri-action" {
    # Both beforeBundleCommand and signCommand run inside tauri-action; the login must precede it.
    login_line=$(grep -n "name: Configure Windows code signing" "$WORKFLOW" | head -1 | cut -d: -f1)
    tauri_line=$(grep -n "tauri-apps/tauri-action@" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$login_line" ]
    [ -n "$tauri_line" ]
    [ "$login_line" -lt "$tauri_line" ]
}

@test "Windows signing step gates on matrix.platform == 'windows-latest'" {
    login_line=$(grep -n "name: Configure Windows code signing" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$login_line" ]
    guard_line=$(awk -v start="$login_line" 'NR>start && /^        if:/ { print NR; exit }' "$WORKFLOW")
    [ -n "$guard_line" ]
    sed -n "${guard_line}p" "$WORKFLOW" | grep -q "matrix.platform == 'windows-latest'"
}

@test "both Windows-building jobs use the shared azure-signing-login action" {
    [ "$(grep -c "uses: ./.github/actions/azure-signing-login" "$WORKFLOW")" -eq 2 ]
}

@test "jobs that sign grant id-token: write and run in the release environment" {
    # OIDC needs id-token: write; the federated credential trusts only the release-environment subject.
    [ "$(grep -c "^      id-token: write$" "$WORKFLOW")" -eq 2 ]
    [ "$(grep -c "^    environment: release$" "$WORKFLOW")" -eq 2 ]
}

@test "cli job signs the Windows CLI before packaging it" {
    sign_line=$(grep -n "name: Sign CLI binary (windows)" "$WORKFLOW" | head -1 | cut -d: -f1)
    pack_line=$(grep -n "name: Package CLI (windows)" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$sign_line" ]
    [ -n "$pack_line" ]
    [ "$sign_line" -lt "$pack_line" ]
    grep -qF 'sign-windows-binaries.ps1 "target\$env:TARGET\release\speedwave.exe"' "$WORKFLOW"
}

@test "no PFX-based Windows signing remains in the release workflow" {
    # Tauri never read WINDOWS_CERTIFICATE; a leftover would look configured while signing nothing.
    if grep -q "WINDOWS_CERTIFICATE" "$WORKFLOW"; then
        echo "ERROR: WINDOWS_CERTIFICATE is dead config; Windows signing is Azure Artifact Signing (ADR-086)" >&2
        return 1
    fi
}

@test "azure-signing-login pins azure/login by commit SHA" {
    [ -f "$SIGNING_LOGIN_ACTION" ]
    grep -qE "uses: azure/login@[0-9a-f]{40}" "$SIGNING_LOGIN_ACTION"
}

@test "azure-signing-login exports the env the signing script reads" {
    grep -qF "AZURE_ARTIFACT_SIGNING_ENDPOINT=" "$SIGNING_LOGIN_ACTION"
    grep -qF "AZURE_ARTIFACT_SIGNING_ACCOUNT=" "$SIGNING_LOGIN_ACTION"
    grep -qF "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE=" "$SIGNING_LOGIN_ACTION"
}

@test "azure-signing-login fails loudly on a half-configured signing target" {
    # A client id without endpoint/account/profile must not silently produce an unsigned release.
    grep -qF "::error::" "$SIGNING_LOGIN_ACTION"
    grep -qF "allow-no-subscriptions: true" "$SIGNING_LOGIN_ACTION"
}

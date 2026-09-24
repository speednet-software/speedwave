#!/usr/bin/env bats


WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/desktop-release.yml"
VERIFY_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/verify-release-assets.sh"

@test "desktop-release.yml exists" {
    [ -f "$WORKFLOW" ]
}

@test "workflow imports Apple certificate into keychain before tauri-action" {
    import_line=$(grep -n "Import Apple signing certificate to keychain" "$WORKFLOW" | head -1 | cut -d: -f1)
    tauri_line=$(grep -n "tauri-apps/tauri-action@" "$WORKFLOW" | head -1 | cut -d: -f1)

    [ -n "$import_line" ]
    [ -n "$tauri_line" ]
    [ "$import_line" -lt "$tauri_line" ]
}

@test "keychain import uses the prescribed security commands" {
    grep -q "security create-keychain" "$WORKFLOW"
    grep -q "security import" "$WORKFLOW"
    grep -q "security set-key-partition-list" "$WORKFLOW"
}

@test "keychain import grants codesign access to the imported key" {
    grep -q -- "-T /usr/bin/codesign" "$WORKFLOW"
}

@test "keychain import prepends build keychain to search list" {
    grep -q "security list-keychains" "$WORKFLOW"
}

@test "keychain import fails fast if identity is not resolvable" {
    grep -q "security find-identity" "$WORKFLOW"
}

@test "keychain import uses fixed-string grep for identity verification" {
    grep -qF 'grep -qF' "$WORKFLOW"
}

@test "keychain import guards against empty APPLE_SIGNING_IDENTITY" {
    grep -qF 'APPLE_SIGNING_IDENTITY is empty' "$WORKFLOW"
}

@test "keychain import uses while-read loop for safe keychain list expansion" {
    grep -qF 'while IFS= read -r' "$WORKFLOW"
}

@test "keychain import step gates on matrix.platform == 'macos-latest'" {
    import_line=$(grep -n "Import Apple signing certificate to keychain" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$import_line" ]
    guard_line=$(awk -v start="$import_line" 'NR>start && /^        if:/ { print NR; exit }' "$WORKFLOW")
    [ -n "$guard_line" ]
    sed -n "${guard_line}p" "$WORKFLOW" | grep -q "matrix.platform == 'macos-latest'"
}

@test "workflow passes releaseAssetNamePattern to tauri-action" {
    grep -qF 'releaseAssetNamePattern:' "$WORKFLOW"
}

@test "workflow uses no tauri-action inputs removed in 1.0.0" {
    for input in assetNamePattern includeUpdaterJson updaterJsonKeepUniversal includeRelease includeDebug; do
        if grep -qE "^[[:space:]]+${input}:" "$WORKFLOW"; then
            echo "ERROR: '${input}' is not an input of the pinned tauri-action version" >&2
            return 1
        fi
    done
}

@test "verify-release-assets.sh enumerates macOS updater assets" {
    grep -qF "macOS_Apple_Silicon.app.tar.gz" "$VERIFY_SCRIPT"
}

@test "verify-release-assets.sh enumerates Windows updater assets" {
    grep -qF "x64-setup.nsis.zip" "$VERIFY_SCRIPT"
    grep -qF "x64_en-US.msi.zip" "$VERIFY_SCRIPT"
}

@test "verify-release-assets.sh verifies .sig non-emptiness" {
    grep -qF "signature file empty" "$VERIFY_SCRIPT"
}

@test "verify-release-assets.sh enforces required latest.json platform keys" {
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
    grep -qF 'reminders-cli:$REMINDERS_ENTITLEMENTS' "$SIGN_SCRIPT"
}

@test "SIGN_TARGETS does NOT use CALENDARS_ENTITLEMENTS for reminders-cli" {
    if grep -qF '"$SRC_TAURI/reminders-cli:$CALENDARS_ENTITLEMENTS"' "$SIGN_SCRIPT"; then
        echo "ERROR: reminders-cli must use REMINDERS_ENTITLEMENTS, not CALENDARS_ENTITLEMENTS" >&2
        return 1
    fi
}

@test "REMINDERS_ENTITLEMENTS variable is defined in signing script" {
    grep -qF 'REMINDERS_ENTITLEMENTS=' "$SIGN_SCRIPT"
}

@test "bundle ID in tauri.conf.json matches fallback literal in Utilities.swift" {
    local tauri_conf="$BATS_TEST_DIRNAME/../../desktop/src-tauri/tauri.conf.json"
    local utilities_swift="$BATS_TEST_DIRNAME/../../native/macos/shared/Sources/SharedCLI/Utilities.swift"
    [ -f "$tauri_conf" ]
    [ -f "$utilities_swift" ]

    local tauri_id
    tauri_id=$(python3 -c "import json,sys; print(json.load(open('$tauri_conf'))['identifier'])")
    [ -n "$tauri_id" ]

    grep -qF "\"$tauri_id\"" "$utilities_swift"
}


SIGNING_LOGIN_ACTION="$BATS_TEST_DIRNAME/../../.github/actions/azure-signing-login/action.yml"
RELEASE_PLEASE_WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/release-please.yml"

@test "workflow configures Windows signing before tauri-action" {
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
    [ "$(grep -c "^      id-token: write$" "$WORKFLOW")" -eq 2 ]
    [ "$(grep -c "^    environment: release$" "$WORKFLOW")" -eq 2 ]
}

@test "release-please grants the release build every permission its jobs request" {
    caller=$(awk '/^  build-and-publish:$/ { found = 1; next } found && /^  [^ ]/ { exit } found' "$RELEASE_PLEASE_WORKFLOW")
    echo "$caller" | grep -qxF "    uses: ./.github/workflows/desktop-release.yml"
    requested=$(grep -E "^      [a-z-]+: (read|write)$" "$WORKFLOW" | sed 's/^ *//' | sort -u)
    [ -n "$requested" ]
    while IFS= read -r perm; do
        name=${perm%%:*}
        if [ "${perm#*: }" = "read" ]; then
            granted="^      $name: (read|write)$"
        else
            granted="^      $name: write$"
        fi
        if ! echo "$caller" | grep -qE "$granted"; then
            echo "ERROR: desktop-release.yml requests '$perm' but release-please.yml build-and-publish does not grant it" >&2
            return 1
        fi
    done <<EOF
$requested
EOF
}

@test "every signing login is followed at once by the Artifact Signing token fetch" {
    token_run="run: az account get-access-token --resource https://codesigning.azure.net --output none"
    [ "$(grep -cF "$token_run" "$WORKFLOW")" -eq 2 ]
    logins=$(grep -n "uses: ./.github/actions/azure-signing-login" "$WORKFLOW" | cut -d: -f1)
    [ -n "$logins" ]
    for login_line in $logins; do
        next_step=$(awk -v start="$login_line" 'NR>start && /^      - / { print; exit }' "$WORKFLOW")
        if [ "$next_step" != "      - name: Cache the Artifact Signing token (Windows)" ]; then
            echo "ERROR: the step after the signing login at line $login_line is '$next_step', not the token fetch" >&2
            return 1
        fi
    done
}

@test "the Artifact Signing token fetch is skipped when signing is not configured" {
    grep -A1 "name: Cache the Artifact Signing token (Windows)" "$WORKFLOW" | grep "if:" > "$BATS_TEST_TMPDIR/guards"
    [ "$(wc -l < "$BATS_TEST_TMPDIR/guards")" -eq 2 ]
    [ "$(grep -cF "&& vars.AZURE_CLIENT_ID != ''" "$BATS_TEST_TMPDIR/guards")" -eq 2 ]
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
    grep -qF "::error::" "$SIGNING_LOGIN_ACTION"
    grep -qF "allow-no-subscriptions: true" "$SIGNING_LOGIN_ACTION"
}

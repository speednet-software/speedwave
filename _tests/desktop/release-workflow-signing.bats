#!/usr/bin/env bats


WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/build-publish.yml"
VERIFY_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/verify-release-assets.sh"

@test "build-publish.yml exists" {
    [ -f "$WORKFLOW" ]
}

@test "build-publish.yml is a reusable workflow with no other trigger" {
    grep -qF "workflow_call:" "$WORKFLOW"
    ! grep -qE "^  (push|pull_request|workflow_dispatch):" "$WORKFLOW"
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

@test "tauri-action never gets a tagName/releaseDraft input (the draft job owns release creation)" {
    for input in tagName releaseDraft releaseName releaseBody; do
        if grep -qE "^[[:space:]]+${input}:" "$WORKFLOW"; then
            echo "ERROR: '${input}' belongs to the old create-on-demand flow; the draft job always creates the release first" >&2
            return 1
        fi
    done
}

@test "the build never produces a macOS Intel or Windows ARM leg" {
    if grep -qF "x86_64-apple-darwin" "$WORKFLOW"; then
        echo "ERROR: macOS Intel target found in build-publish.yml; the new process never builds it" >&2
        return 1
    fi
    if grep -qF "macOS_Intel" "$WORKFLOW"; then
        echo "ERROR: macOS Intel asset label found in build-publish.yml" >&2
        return 1
    fi
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

@test "verify-release-assets.sh never expects a macOS Intel asset" {
    if grep -qF "Intel" "$VERIFY_SCRIPT"; then
        echo "ERROR: verify-release-assets.sh still expects a macOS Intel asset" >&2
        return 1
    fi
}

@test "verify-release-assets.sh enforces required latest.json platform keys" {
    grep -qF '"darwin-aarch64"' "$VERIFY_SCRIPT"
    grep -qF '"darwin-aarch64-app"' "$VERIFY_SCRIPT"
    grep -qF '"windows-x86_64"' "$VERIFY_SCRIPT"
    grep -qF '"windows-x86_64-msi"' "$VERIFY_SCRIPT"
    grep -qF '"windows-x86_64-nsis"' "$VERIFY_SCRIPT"
}

@test "verify-release-assets.sh no longer requires the darwin-x86_64 platform keys" {
    if grep -qF '"darwin-x86_64"' "$VERIFY_SCRIPT"; then
        echo "ERROR: darwin-x86_64 is a dropped Intel platform key" >&2
        return 1
    fi
}

@test "the publish job runs verify-release-assets.sh exactly once (no post-publish revert-to-draft)" {
    [ "$(grep -cF 'verify-release-assets.sh' "$WORKFLOW")" -eq 1 ]
    if grep -qF 'draft=true' "$WORKFLOW"; then
        echo "ERROR: a revert-to-draft step remains; immutable releases + delete-draft-on-failure replace it" >&2
        return 1
    fi
}

@test "a failed run deletes its own draft release instead of leaving it for manual cleanup" {
    job_line=$(grep -n "^  delete-draft-on-failure:$" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$job_line" ]
    block=$(awk -v start="$job_line" 'NR>=start && NR<=start+6' "$WORKFLOW")
    echo "$block" | grep -qF 'if: failure()'
    grep -qF 'gh release delete' "$WORKFLOW"
}

@test "the delete-draft-on-failure job needs every other job (sees every possible failure)" {
    job_line=$(grep -n "^  delete-draft-on-failure:$" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$job_line" ]
    block=$(awk -v start="$job_line" 'NR>=start && NR<=start+2' "$WORKFLOW")
    for j in draft publish-tauri cli publish; do
        echo "$block" | grep -qF "$j" || { echo "ERROR: delete-draft-on-failure does not need '$j'" >&2; return 1; }
    done
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
BETA_WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/beta.yml"
RELEASE_WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/release.yml"

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

@test "jobs that sign grant id-token: write and run in the caller's environment" {
    [ "$(grep -c "^      id-token: write$" "$WORKFLOW")" -eq 2 ]
    [ "$(grep -cF '    environment: ${{ inputs.environment }}' "$WORKFLOW")" -eq 4 ]
}

@test "every caller of build-publish.yml grants it contents: read and id-token: write" {
    for caller in "$BETA_WORKFLOW" "$RELEASE_WORKFLOW"; do
        [ -f "$caller" ]
        call_line=$(grep -n "uses: ./.github/workflows/build-publish.yml" "$caller" | head -1 | cut -d: -f1)
        [ -n "$call_line" ]
        job_start=$(awk -v stop="$call_line" '/^  [a-zA-Z0-9_-]+:$/ { line = NR } NR==stop { print line; exit }' "$caller")
        [ -n "$job_start" ]
        job_block=$(awk -v start="$job_start" -v stop="$call_line" 'NR>=start && NR<=stop' "$caller")
        echo "$job_block" | grep -qE "^      contents: read$" || { echo "ERROR: $(basename "$caller") does not grant contents: read to its build-publish.yml caller job" >&2; return 1; }
        echo "$job_block" | grep -qE "^      id-token: write$" || { echo "ERROR: $(basename "$caller") does not grant id-token: write to its build-publish.yml caller job" >&2; return 1; }
    done
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
    grep -qF 'sign-windows-binaries.ps1 "$env:GITHUB_WORKSPACE\target\$env:TARGET\release\speedwave.exe"' "$WORKFLOW"
}

@test "every file the workflow hands to the signing script is a rooted path" {
    grep -F 'sign-windows-binaries.ps1 "' "$WORKFLOW" > "$BATS_TEST_TMPDIR/calls"
    [ -s "$BATS_TEST_TMPDIR/calls" ]
    if grep -vF 'sign-windows-binaries.ps1 "$env:GITHUB_WORKSPACE\' "$BATS_TEST_TMPDIR/calls"; then
        echo "ERROR: Invoke-ArtifactSigning rejects a relative path ('is not rooted'); pass \$env:GITHUB_WORKSPACE\\..." >&2
        return 1
    fi
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

@test "the cli job builds with SPEEDWAVE_VERSION from the caller's computed version, so the released CLI version matches the release tag" {
    build_line=$(grep -n "name: Build CLI" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$build_line" ]
    block=$(awk -v start="$build_line" 'NR>=start && NR<=start+6' "$WORKFLOW")
    echo "$block" | grep -qF 'SPEEDWAVE_VERSION: ${{ inputs.version }}'
    echo "$block" | grep -qF 'cargo build --release'
}

@test "the publish-tauri job builds with SPEEDWAVE_VERSION from the caller's computed version, so the released CLI/crates version matches the Tauri app version" {
    tauri_line=$(grep -n "tauri-apps/tauri-action@" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$tauri_line" ]
    block=$(awk -v start="$tauri_line" 'NR>=start && NR<=start+6' "$WORKFLOW")
    echo "$block" | grep -qF 'SPEEDWAVE_VERSION: ${{ inputs.version }}'
}

@test "GH_AUTOMATION_PAT is used for every release write; RELEASE_TOKEN is gone" {
    if grep -qF 'RELEASE_TOKEN' "$WORKFLOW"; then
        echo "ERROR: RELEASE_TOKEN must not appear; GH_AUTOMATION_PAT replaces it (SPEED-674 ticket 13)" >&2
        return 1
    fi
    grep -qF 'secrets.GH_AUTOMATION_PAT' "$WORKFLOW"
}

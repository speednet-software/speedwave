#!/usr/bin/env bats

# Static sanity checks on .github/workflows/desktop-release.yml to prevent the
# macOS signing regression that shipped in PR #458 / v0.7.2-draft: without a
# keychain-import step before tauri-action, `beforeBundleCommand` runs
# `codesign --sign "$APPLE_SIGNING_IDENTITY"` against an empty keychain and the
# entire macOS matrix fails with "item could not be found in the keychain".
#
# These tests guard the contract between the workflow and
# scripts/sign-bundled-binaries.sh: by the time tauri-action starts on macOS,
# the identity must already be importable and the script's `codesign` call must
# be able to resolve it.

WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/desktop-release.yml"
VERIFY_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/verify-release-assets.sh"

@test "desktop-release.yml exists" {
    [ -f "$WORKFLOW" ]
}

@test "workflow imports Apple certificate into keychain before tauri-action" {
    # Grab line numbers of the keychain-import step and the tauri-action step.
    # `grep -n` prints "LINE:content"; cut to just the line number.
    import_line=$(grep -n "Import Apple signing certificate to keychain" "$WORKFLOW" | head -1 | cut -d: -f1)
    tauri_line=$(grep -n "tauri-apps/tauri-action@" "$WORKFLOW" | head -1 | cut -d: -f1)

    [ -n "$import_line" ]
    [ -n "$tauri_line" ]
    # Import must come before tauri-action, otherwise beforeBundleCommand sees
    # an empty keychain on the ephemeral GitHub runner.
    [ "$import_line" -lt "$tauri_line" ]
}

@test "keychain import uses the prescribed security commands" {
    # security create-keychain + import + set-key-partition-list is the
    # pattern Tauri and Apple require for codesign to find a Developer ID
    # identity on a headless CI runner. All three must be present.
    grep -q "security create-keychain" "$WORKFLOW"
    grep -q "security import" "$WORKFLOW"
    grep -q "security set-key-partition-list" "$WORKFLOW"
}

@test "keychain import grants codesign access to the imported key" {
    # `-T /usr/bin/codesign` is what lets codesign read the private key from
    # the build keychain without triggering a GUI password prompt. Missing
    # this flag is a common silent-failure mode.
    grep -q -- "-T /usr/bin/codesign" "$WORKFLOW"
}

@test "keychain import prepends build keychain to search list" {
    # codesign resolves identities via the user's keychain search list; if the
    # build keychain is created but not added to that list, `find-identity`
    # returns empty and signing fails. `security list-keychains -s` is the
    # single command that fixes this.
    grep -q "security list-keychains" "$WORKFLOW"
}

@test "keychain import fails fast if identity is not resolvable" {
    # The step must verify the identity is actually importable, not just
    # that `security import` exited 0 — a malformed .p12 can import without
    # producing a usable codesigning identity. `find-identity` after import
    # is the canonical smoke test.
    grep -q "security find-identity" "$WORKFLOW"
}

@test "keychain import uses fixed-string grep for identity verification" {
    # The identity string contains `(TEAM)` — grep without -F treats the
    # parentheses as regex metacharacters. More importantly, `grep -q ""`
    # matches every line, so without `-F` and an empty-identity guard the
    # verification silently passes when APPLE_SIGNING_IDENTITY is unset.
    grep -qF 'grep -qF' "$WORKFLOW"
}

@test "keychain import guards against empty APPLE_SIGNING_IDENTITY" {
    # If APPLE_CERTIFICATE is set but APPLE_SIGNING_IDENTITY isn't, the
    # downstream grep verification would match every line (empty pattern) and
    # silently report success — then tauri-action would fail cryptically
    # inside the bundle step. The step must fail fast before find-identity.
    grep -qF 'APPLE_SIGNING_IDENTITY is empty' "$WORKFLOW"
}

@test "keychain import uses while-read loop for safe keychain list expansion" {
    # `security list-keychains -d user` output must be read into an array
    # without word splitting. macOS ships bash 3.2 which lacks mapfile, so
    # a while-read loop is the bash 3.2-compatible equivalent.
    grep -qF 'while IFS= read -r' "$WORKFLOW"
}

@test "keychain import step gates on matrix.platform == 'macos-latest'" {
    # Must not run on Linux/Windows matrix jobs — security commands don't
    # exist there and the step would error out the entire matrix. Search
    # forward from the step name for the next `if:` line instead of assuming
    # a fixed offset — tolerates blank lines or comments between them.
    import_line=$(grep -n "Import Apple signing certificate to keychain" "$WORKFLOW" | head -1 | cut -d: -f1)
    [ -n "$import_line" ]
    guard_line=$(awk -v start="$import_line" 'NR>start && /^        if:/ { print NR; exit }' "$WORKFLOW")
    [ -n "$guard_line" ]
    sed -n "${guard_line}p" "$WORKFLOW" | grep -q "matrix.platform == 'macos-latest'"
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

@test "verify-release-assets.sh documents Linux auto-update exclusion" {
    # Anti-removal guard: the inline comment explaining why Linux is excluded
    # from asset verification must remain so future maintainers don't add Linux
    # assets incorrectly. The semantic intent string is stable across refactors.
    grep -qF "Linux is excluded: updater.rs disables auto-update" "$VERIFY_SCRIPT"
}

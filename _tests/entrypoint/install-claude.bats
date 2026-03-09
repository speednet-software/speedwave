#!/usr/bin/env bats
# Tests for containers/install-claude.sh
# Runs on the host (macOS/Linux) — no container required.
# Stubs out 'curl' and 'bash' execution to avoid network calls.

INSTALL_SCRIPT="$BATS_TEST_DIRNAME/../../containers/install-claude.sh"

# Portable SHA256: same logic as install-claude.sh
compute_sha256() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo "FATAL: no sha256sum or shasum" >&2
        exit 1
    fi
}

setup() {
    TEST_HOME="$(mktemp -d)"
    export HOME="$TEST_HOME"

    mkdir -p "$HOME/.cache/speedwave-install"

    # Stubs dir goes first in PATH
    STUBS_DIR="$(mktemp -d)"
    export PATH="$STUBS_DIR:$PATH"

    # Default curl stub — writes predictable content to the -o target
    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
# Parse -o flag to find output file
OUTPUT_FILE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) OUTPUT_FILE="$2"; shift 2 ;;
        *) shift ;;
    esac
done
if [ -n "$OUTPUT_FILE" ]; then
    echo '#!/bin/bash' > "$OUTPUT_FILE"
    echo 'echo "installed $1"' >> "$OUTPUT_FILE"
fi
EOF
    chmod +x "$STUBS_DIR/curl"
}

teardown() {
    rm -rf "$TEST_HOME" "$STUBS_DIR"
}

# ---------------------------------------------------------------------------
# SHA256 verification — checksum match (success)
# ---------------------------------------------------------------------------

@test "install-claude.sh verifies checksum and succeeds on match" {
    # curl stub writes known content; compute its SHA256
    local probe
    probe="$(mktemp)"
    # Simulate what curl stub writes
    printf '#!/bin/bash\necho "installed $1"\n' > "$probe"
    local expected_sha
    expected_sha="$(compute_sha256 "$probe")"
    rm -f "$probe"

    export CLAUDE_INSTALLER_SHA256="$expected_sha"
    run bash "$INSTALL_SCRIPT" "latest"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Installer checksum verified: $expected_sha"* ]]
    [[ "$output" == *"installed latest"* ]]
}

# ---------------------------------------------------------------------------
# SHA256 verification — checksum mismatch (failure)
# ---------------------------------------------------------------------------

@test "install-claude.sh fails on checksum mismatch" {
    export CLAUDE_INSTALLER_SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    run bash "$INSTALL_SCRIPT" "latest"
    [ "$status" -eq 1 ]
    [[ "$output" == *"SECURITY: installer checksum mismatch!"* ]]
    [[ "$output" == *"expected: $CLAUDE_INSTALLER_SHA256"* ]]
    [[ "$output" == *"actual:"* ]]
    # Must NOT contain "installed" — the installer should not have run
    [[ "$output" != *"installed latest"* ]]
}

# ---------------------------------------------------------------------------
# SHA256 verification — skipped when empty (opt-in, backwards-compatible)
# ---------------------------------------------------------------------------

@test "install-claude.sh warns and skips verification when CLAUDE_INSTALLER_SHA256 is empty" {
    export CLAUDE_INSTALLER_SHA256=""
    run bash "$INSTALL_SCRIPT" "latest"
    [ "$status" -eq 0 ]
    # Should NOT print verification message
    [[ "$output" != *"Installer checksum verified"* ]]
    # Should print warning about skipping verification
    [[ "$output" == *"WARNING: CLAUDE_INSTALLER_SHA256 not set"* ]]
    # Should still install
    [[ "$output" == *"installed latest"* ]]
}

# ---------------------------------------------------------------------------
# Version argument passthrough
# ---------------------------------------------------------------------------

@test "install-claude.sh passes version argument to installer" {
    unset CLAUDE_INSTALLER_SHA256
    run bash "$INSTALL_SCRIPT" "stable"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed stable"* ]]
}

@test "install-claude.sh defaults version to latest" {
    unset CLAUDE_INSTALLER_SHA256
    run bash "$INSTALL_SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed latest"* ]]
}

# ---------------------------------------------------------------------------
# Curl failure handling
# ---------------------------------------------------------------------------

@test "install-claude.sh fails when curl fails" {
    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
exit 1
EOF
    chmod +x "$STUBS_DIR/curl"

    unset CLAUDE_INSTALLER_SHA256
    run bash "$INSTALL_SCRIPT" "latest"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Temp file cleanup (uses isolated TMPDIR for reliability)
# ---------------------------------------------------------------------------

@test "install-claude.sh cleans up temp file on success" {
    unset CLAUDE_INSTALLER_SHA256

    run bash "$INSTALL_SCRIPT" "latest"
    [ "$status" -eq 0 ]

    # The install dir should have no leftover install-claude.* files
    local leftover
    leftover="$(ls "$HOME/.cache/speedwave-install"/install-claude.* 2>/dev/null | wc -l || echo 0)"
    [ "$leftover" -eq 0 ]
}

@test "install-claude.sh cleans up temp file on failure (checksum mismatch)" {
    export CLAUDE_INSTALLER_SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    run bash "$INSTALL_SCRIPT" "latest"
    [ "$status" -eq 1 ]

    local leftover
    leftover="$(ls "$HOME/.cache/speedwave-install"/install-claude.* 2>/dev/null | wc -l || echo 0)"
    [ "$leftover" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Curl uses HTTPS-only with --proto flag
# ---------------------------------------------------------------------------

@test "install-claude.sh uses --proto =https in curl invocation" {
    grep -q -- "--proto '=https'" "$INSTALL_SCRIPT"
}

# ---------------------------------------------------------------------------
# Installer URL is correct
# ---------------------------------------------------------------------------

@test "install-claude.sh downloads from claude.ai" {
    grep -q 'INSTALLER_URL="https://claude.ai/install.sh"' "$INSTALL_SCRIPT"
}

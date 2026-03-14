#!/usr/bin/env bats
# Tests for containers/install-claude.sh
# Runs on the host (macOS/Linux) — no container required.
# Stubs out 'curl' and 'bash' execution to avoid network calls.

INSTALL_SCRIPT="$BATS_TEST_DIRNAME/../../containers/install-claude.sh"

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
# Version argument is required — no default
# ---------------------------------------------------------------------------

@test "install-claude.sh fails without version argument" {
    run bash "$INSTALL_SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Usage: install-claude.sh"* ]]
}

# ---------------------------------------------------------------------------
# Version argument passthrough
# ---------------------------------------------------------------------------

@test "install-claude.sh passes version argument to installer" {
    run bash "$INSTALL_SCRIPT" "2.1.76"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed 2.1.76"* ]]
}

@test "install-claude.sh passes arbitrary semver to installer" {
    run bash "$INSTALL_SCRIPT" "3.0.0"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed 3.0.0"* ]]
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

    run bash "$INSTALL_SCRIPT" "2.1.76"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Temp file cleanup (uses isolated TMPDIR for reliability)
# ---------------------------------------------------------------------------

@test "install-claude.sh cleans up temp file on success" {
    run bash "$INSTALL_SCRIPT" "2.1.76"
    [ "$status" -eq 0 ]

    # The install dir should have no leftover install-claude.* files
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

# ---------------------------------------------------------------------------
# Containerfile.claude does not contain curl | bash (DRY regression guard)
# ---------------------------------------------------------------------------

@test "Containerfile.claude does not pipe curl to bash" {
    local containerfile="$BATS_TEST_DIRNAME/../../containers/Containerfile.claude"
    ! grep -q 'curl.*|.*bash' "$containerfile"
}

@test "Containerfile.claude uses install-claude.sh" {
    local containerfile="$BATS_TEST_DIRNAME/../../containers/Containerfile.claude"
    grep -q 'install-claude.sh' "$containerfile"
}

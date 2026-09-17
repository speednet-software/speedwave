#!/usr/bin/env bats

INSTALL_SCRIPT="$BATS_TEST_DIRNAME/../../containers/install-claude.sh"
DEFAULTS_RS="$BATS_TEST_DIRNAME/../../crates/speedwave-runtime/src/defaults.rs"

PINNED_VERSION="$(grep 'pub const CLAUDE_VERSION' "$DEFAULTS_RS" | sed 's/.*"\(.*\)".*/\1/')"
[[ -n "$PINNED_VERSION" ]] || { echo "ERROR: could not extract CLAUDE_VERSION from defaults.rs" >&2; exit 1; }

setup() {
    TEST_HOME="$(mktemp -d)"
    export HOME="$TEST_HOME"

    mkdir -p "$HOME/.cache/speedwave-install"

    STUBS_DIR="$(mktemp -d)"
    export PATH="$STUBS_DIR:$PATH"

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


@test "install-claude.sh fails without version argument" {
    run bash "$INSTALL_SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Usage: install-claude.sh"* ]]
}


@test "install-claude.sh passes version argument to installer" {
    run bash "$INSTALL_SCRIPT" "$PINNED_VERSION"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed ${PINNED_VERSION}"* ]]
}

@test "install-claude.sh passes arbitrary semver to installer" {
    run bash "$INSTALL_SCRIPT" "3.0.0"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed 3.0.0"* ]]
}


@test "install-claude.sh fails when curl fails" {
    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
exit 1
EOF
    chmod +x "$STUBS_DIR/curl"

    run bash "$INSTALL_SCRIPT" "$PINNED_VERSION"
    [ "$status" -ne 0 ]
}


@test "install-claude.sh cleans up temp file on success" {
    run bash "$INSTALL_SCRIPT" "$PINNED_VERSION"
    [ "$status" -eq 0 ]

    local leftover
    leftover="$(ls "$HOME/.cache/speedwave-install"/install-claude.* 2>/dev/null | wc -l || echo 0)"
    [ "$leftover" -eq 0 ]
}


@test "install-claude.sh uses --proto =https in curl invocation" {
    grep -q -- "--proto '=https'" "$INSTALL_SCRIPT"
}


@test "install-claude.sh downloads from claude.ai" {
    grep -q 'INSTALLER_URL="https://claude.ai/install.sh"' "$INSTALL_SCRIPT"
}


@test "Containerfile.claude does not pipe curl to bash" {
    local containerfile="$BATS_TEST_DIRNAME/../../containers/Containerfile.claude"
    ! grep -q 'curl.*|.*bash' "$containerfile"
}

@test "Containerfile.claude uses install-claude.sh" {
    local containerfile="$BATS_TEST_DIRNAME/../../containers/Containerfile.claude"
    grep -q 'install-claude.sh' "$containerfile"
}

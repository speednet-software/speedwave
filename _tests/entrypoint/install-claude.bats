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

    cat > "$STUBS_DIR/sleep" << 'EOF'
#!/bin/bash
echo "$1" >> "$(dirname "$0")/sleep.log"
EOF
    chmod +x "$STUBS_DIR/sleep"
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


@test "install-claude.sh gives up after four attempts with curl's exit code" {
    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
echo x >> "$(dirname "$0")/curl.log"
echo "curl: (22) The requested URL returned error: 429" >&2
exit 22
EOF
    chmod +x "$STUBS_DIR/curl"

    run bash "$INSTALL_SCRIPT" "$PINNED_VERSION"
    [ "$status" -eq 22 ]
    [ "$(wc -l < "$STUBS_DIR/curl.log")" -eq 4 ]
    [ "$(cat "$STUBS_DIR/sleep.log")" = "$(printf '30\n30\n30')" ]
    [[ "$output" == *"Claude Code install failed after 4 attempts"* ]]
}

@test "install-claude.sh retries a failed download and installs on a later attempt" {
    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
log="$(dirname "$0")/curl.log"
echo x >> "$log"
[ "$(wc -l < "$log")" -ge 3 ] || exit 92
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) printf '#!/bin/bash\necho "installed $1"\n' > "$2"; shift 2 ;;
        *) shift ;;
    esac
done
EOF
    chmod +x "$STUBS_DIR/curl"

    run bash "$INSTALL_SCRIPT" "$PINNED_VERSION"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed ${PINNED_VERSION}"* ]]
    [[ "$output" == *"attempt 2 of 4 failed (exit 92), retrying in 30s"* ]]
    [ "$(wc -l < "$STUBS_DIR/sleep.log")" -eq 2 ]
}

@test "install-claude.sh retries when the downloaded installer fails" {
    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
stubs="$(dirname "$0")"
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o)
            cat > "$2" << INSTALLER
#!/bin/bash
echo x >> "$stubs/installer.log"
[ "\$(wc -l < "$stubs/installer.log")" -ge 2 ] || { echo "Download failed" >&2; exit 1; }
echo "installed \$1"
INSTALLER
            shift 2 ;;
        *) shift ;;
    esac
done
EOF
    chmod +x "$STUBS_DIR/curl"

    run bash "$INSTALL_SCRIPT" "$PINNED_VERSION"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Download failed"* ]]
    [[ "$output" == *"installed ${PINNED_VERSION}"* ]]
    [ "$(wc -l < "$STUBS_DIR/installer.log")" -eq 2 ]
    [ "$(cat "$STUBS_DIR/sleep.log")" = "30" ]
}

@test "install-claude.sh does not wait when the first attempt succeeds" {
    run bash "$INSTALL_SCRIPT" "$PINNED_VERSION"
    [ "$status" -eq 0 ]
    [ ! -e "$STUBS_DIR/sleep.log" ]
}


@test "install-claude.sh cleans up temp file on success" {
    run bash "$INSTALL_SCRIPT" "$PINNED_VERSION"
    [ "$status" -eq 0 ]

    local leftover
    leftover="$(ls "$HOME/.cache/speedwave-install"/install-claude.* 2>/dev/null | wc -l || echo 0)"
    [ "$leftover" -eq 0 ]
}

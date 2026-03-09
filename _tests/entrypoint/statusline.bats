#!/usr/bin/env bats
# Tests for containers/claude-resources/statusline.sh
# Runs on the host (macOS/Linux) — no container required.

STATUSLINE="$BATS_TEST_DIRNAME/../../containers/claude-resources/statusline.sh"

setup() {
    TEST_HOME="$(mktemp -d)"
    export HOME="$TEST_HOME"
    mkdir -p "$HOME/.claude"
}

teardown() {
    rm -rf "$TEST_HOME"
}

# ---------------------------------------------------------------------------
# Empty stdin — fallback to defaults
# ---------------------------------------------------------------------------

@test "empty stdin outputs default model name 'Claude'" {
    run bash "$STATUSLINE" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

@test "empty stdin shows thinking status" {
    run bash "$STATUSLINE" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"thinking"* ]]
}

# ---------------------------------------------------------------------------
# Valid JSON input — model name extraction
# ---------------------------------------------------------------------------

@test "extracts display_name from JSON" {
    local input='{"model":{"display_name":"Opus 4"},"tokens_used":1000,"tokens_max":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Opus 4"* ]]
}

@test "falls back to name when display_name absent" {
    local input='{"model":{"name":"claude-sonnet-4-6"},"tokens_used":500,"tokens_max":100000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"claude-sonnet-4-6"* ]]
}

# ---------------------------------------------------------------------------
# Token usage display
# ---------------------------------------------------------------------------

@test "shows token usage with progress bar" {
    local input='{"display_name":"Opus","tokens_used":50000,"tokens_max":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # Should show formatted tokens and percentage
    [[ "$output" == *"50.0K"* ]] || [[ "$output" == *"50"* ]]
    [[ "$output" == *"200.0K"* ]] || [[ "$output" == *"200"* ]]
}

@test "shows only used tokens when max is zero" {
    local input='{"display_name":"Opus","tokens_used":12345,"tokens_max":0}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"12,345"* ]]
}

@test "no token section when both used and max are zero" {
    local input='{"display_name":"Opus","tokens_used":0,"tokens_max":0}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # Should NOT contain "tokens" or progress bar characters
    [[ "$output" != *"tokens:"* ]]
}

# ---------------------------------------------------------------------------
# Thinking status from settings.json
# ---------------------------------------------------------------------------

@test "thinking shows 'on' by default" {
    run bash "$STATUSLINE" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"thinking"* ]]
    [[ "$output" != *"thinking off"* ]]
}

@test "thinking shows 'off' when disabled in user-level settings" {
    cat > "$HOME/.claude/settings.json" << 'EOF'
{
  "thinking": false
}
EOF
    run bash "$STATUSLINE" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"thinking off"* ]]
}

@test "thinking shows 'on' when explicitly enabled in user-level settings" {
    cat > "$HOME/.claude/settings.json" << 'EOF'
{
  "thinking": true
}
EOF
    run bash "$STATUSLINE" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"thinking"* ]]
    [[ "$output" != *"thinking off"* ]]
}

@test "thinking shows 'off' when disabled in project-level settings" {
    local workspace="$TEST_HOME/workspace"
    mkdir -p "$workspace/.claude"
    cat > "$workspace/.claude/settings.json" << 'EOF'
{
  "thinking": false
}
EOF
    # Patch script to use temp workspace path (cleaned by teardown via $TEST_HOME)
    local patched
    patched="$(mktemp "$TEST_HOME/patched.XXXXXX")"
    sed "s|/workspace/.claude/settings.json|$workspace/.claude/settings.json|" "$STATUSLINE" > "$patched"
    run bash "$patched" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"thinking off"* ]]
}

@test "project-level thinking setting takes precedence over user-level" {
    # User-level has no thinking key (bundled settings.json)
    cat > "$HOME/.claude/settings.json" << 'EOF'
{
  "statusLine": {"type": "command", "command": "~/.claude/statusline.sh"}
}
EOF
    # Project-level disables thinking
    local workspace="$TEST_HOME/workspace"
    mkdir -p "$workspace/.claude"
    cat > "$workspace/.claude/settings.json" << 'EOF'
{
  "thinking": false
}
EOF
    local patched
    patched="$(mktemp "$TEST_HOME/patched.XXXXXX")"
    sed "s|/workspace/.claude/settings.json|$workspace/.claude/settings.json|" "$STATUSLINE" > "$patched"
    run bash "$patched" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"thinking off"* ]]
}

@test "thinking defaults to 'on' when bundled settings.json has no thinking key" {
    # Simulate the real bundled settings.json (statusLine only, no thinking key)
    cat > "$HOME/.claude/settings.json" << 'EOF'
{
  "statusLine": {"type": "command", "command": "~/.claude/statusline.sh"}
}
EOF
    run bash "$STATUSLINE" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"thinking"* ]]
    [[ "$output" != *"thinking off"* ]]
}

# ---------------------------------------------------------------------------
# Missing / partial JSON fields — graceful fallback
# ---------------------------------------------------------------------------

@test "missing tokens_max defaults to zero gracefully" {
    local input='{"display_name":"Opus","tokens_used":500}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Opus"* ]]
}

@test "missing model name defaults to Claude" {
    local input='{"tokens_used":1000,"tokens_max":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

@test "completely empty JSON object does not crash" {
    run bash -c "echo '{}' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

# ---------------------------------------------------------------------------
# format_tokens — verified via full script with specific token values
# ---------------------------------------------------------------------------

@test "format_tokens renders millions correctly" {
    local input='{"display_name":"Test","tokens_used":1234567,"tokens_max":5000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"1.2M"* ]]
    [[ "$output" == *"5.0M"* ]]
}

@test "format_tokens renders thousands correctly" {
    local input='{"display_name":"Test","tokens_used":45600,"tokens_max":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"45.6K"* ]]
    [[ "$output" == *"200.0K"* ]]
}

# ---------------------------------------------------------------------------
# build_bar color thresholds
# ---------------------------------------------------------------------------

@test "progress bar is yellow at 75% usage" {
    # 150000/200000 = 75%
    local input='{"display_name":"Test","tokens_used":150000,"tokens_max":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # Yellow ANSI escape: \033[33m
    [[ "$output" == *$'\033[33m'* ]]
    [[ "$output" == *"25%"* ]]
}

@test "progress bar is red at 90% usage" {
    # 180000/200000 = 90%
    local input='{"display_name":"Test","tokens_used":180000,"tokens_max":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # Red ANSI escape: \033[31m
    [[ "$output" == *$'\033[31m'* ]]
    [[ "$output" == *"10%"* ]]
}

@test "progress bar is green below 75% usage" {
    # 50000/200000 = 25%
    local input='{"display_name":"Test","tokens_used":50000,"tokens_max":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # Green ANSI escape: \033[32m — appears in the bar (not just thinking)
    [[ "$output" == *$'\033[32m'* ]]
    [[ "$output" == *"75%"* ]]
}

@test "format_commas used for small token counts without max" {
    local input='{"display_name":"Test","tokens_used":999,"tokens_max":0}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"999"* ]]
}

# ---------------------------------------------------------------------------
# Security: no network calls, no credential access
# ---------------------------------------------------------------------------

@test "script does not use curl" {
    ! grep -q 'curl' "$STATUSLINE"
}

@test "script does not access tokens or credentials" {
    # Strip comments, then check for credential-accessing commands
    ! grep -v '^\s*#' "$STATUSLINE" | grep -qE 'security |secret-tool|keychain|oauth|/tokens|api\.anthropic\.com'
}

@test "script does not write to /tmp cache" {
    ! grep -qE 'mkdir.*\/tmp\/claude|\/tmp\/claude' "$STATUSLINE"
}

@test "script does not use wget or network tools" {
    ! grep -qE 'wget|nc |netcat|fetch ' "$STATUSLINE"
}

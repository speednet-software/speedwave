#!/usr/bin/env bats
# Tests for containers/claude-resources/statusline.sh
# Runs on the host (macOS/Linux) — no container required.

STATUSLINE="$BATS_TEST_DIRNAME/../../containers/claude-resources/statusline.sh"

# Full rate-limited JSON for reuse across multiple tests.
# resets_at values are Unix epoch seconds (not ISO strings).
# 1775580120 = some future timestamp, 1776186000 = ~7 days later.
FULL_RATE_LIMITED_JSON='{"model":{"display_name":"Opus 4.6 (1M context)","name":"claude-opus-4-6"},"used_percentage":38,"context_window_size":1000000,"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120},"seven_day":{"used_percentage":82,"resets_at":1776186000}}}'

# ---------------------------------------------------------------------------
# Happy path tests
# ---------------------------------------------------------------------------

@test "empty stdin outputs default model name 'Claude'" {
    run bash "$STATUSLINE" < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

@test "empty stdin does not crash" {
    run bash "$STATUSLINE" < /dev/null
    [ "$status" -eq 0 ]
}

@test "full rate-limited JSON produces correct format" {
    run bash -c "echo '$FULL_RATE_LIMITED_JSON' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Opus 4.6 (1M context)"* ]]
    [[ "$output" == *"CTX"* ]]
    [[ "$output" == *"38%"* ]]
    [[ "$output" == *"5h"* ]]
    [[ "$output" == *"12%"* ]]
    [[ "$output" == *"reset"* ]]
    [[ "$output" == *"7d"* ]]
    [[ "$output" == *"82%"* ]]
}

@test "API key mode shows cost instead of rate limits" {
    local input='{"model":{"display_name":"Opus 4.6 (1M context)"},"used_percentage":38,"context_window_size":1000000,"cost":{"total_cost_usd":0.42}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$0.42'* ]]
    [[ "$output" != *"5h"* ]]
    [[ "$output" != *"7d"* ]]
}

@test "API key mode with top-level total_cost_usd" {
    local input='{"model":{"display_name":"Opus"},"used_percentage":38,"context_window_size":1000000,"total_cost_usd":1.23}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$1.23'* ]]
}

@test "extracts display_name from JSON" {
    local input='{"model":{"display_name":"Sonnet 4.6 (200K context)"},"used_percentage":10,"context_window_size":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Sonnet 4.6 (200K context)"* ]]
}

@test "falls back to name when display_name absent" {
    local input='{"model":{"name":"claude-sonnet-4-6"},"used_percentage":10,"context_window_size":200000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"claude-sonnet-4-6"* ]]
}

@test "CTX label with percentage" {
    local input='{"model":{"display_name":"Test"},"used_percentage":38,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"CTX"* ]]
    [[ "$output" == *"38%"* ]]
}

@test "5h reset time formatted from epoch" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"5h"* ]]
    [[ "$output" == *"reset"* ]]
    # Reset time should be HH:MM format
    [[ "$output" =~ [0-9]{2}:[0-9]{2} ]]
}

@test "7d reset date formatted from epoch" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120},"seven_day":{"used_percentage":82,"resets_at":1776186000}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"7d"* ]]
    [[ "$output" == *"reset"* ]]
    # Reset date should be dd.mm format
    [[ "$output" =~ [0-9]{2}\.[0-9]{2} ]]
}

@test "sections separated by dim │" {
    run bash -c "echo '$FULL_RATE_LIMITED_JSON' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"│"* ]]
}

# ---------------------------------------------------------------------------
# Color threshold tests
# ---------------------------------------------------------------------------

@test "green below 50%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":25,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[32m'* ]]
}

@test "green at 49%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":49,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[32m'* ]]
}

@test "yellow at 50%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":50,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[33m'* ]]
}

@test "yellow at 75%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":75,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[33m'* ]]
}

@test "red at 76%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":76,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[31m'* ]]
}

@test "red at 89%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":89,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[31m'* ]]
}

@test "bold red at 90%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":90,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[1m'* ]]
    [[ "$output" == *$'\033[31m'* ]]
}

@test "bold red at 95%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":95,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[1m'* ]]
    [[ "$output" == *$'\033[31m'* ]]
}

@test "5h rate limit bar uses correct color at 60%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"rate_limits":{"five_hour":{"used_percentage":60,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[33m'* ]]
}

@test "7d rate limit bar uses correct color at 85%" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":1775580120},"seven_day":{"used_percentage":85,"resets_at":1776186000}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[31m'* ]]
}

# ---------------------------------------------------------------------------
# Bar width tests
# ---------------------------------------------------------------------------

@test "CTX bar 40% has 2 filled, 3 empty" {
    local input='{"model":{"display_name":"Test"},"used_percentage":40,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"██░░░"* ]]
}

@test "CTX bar 100% is fully filled" {
    local input='{"model":{"display_name":"Test"},"used_percentage":100,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"█████"* ]]
    [[ "$output" == *"100%"* ]]
}

@test "CTX bar 0% is fully empty" {
    local input='{"model":{"display_name":"Test"},"used_percentage":0,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"░░░░░"* ]]
}

# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

@test "completely empty JSON object does not crash" {
    run bash -c "echo '{}' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

@test "missing model name defaults to Claude" {
    local input='{"used_percentage":50,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

@test "7d section hidden when seven_day data absent" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"5h"* ]]
    [[ "$output" != *"7d"* ]]
}

@test "cost hidden when total_cost_usd is 0" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"cost":{"total_cost_usd":0}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *'$'* ]]
}

@test "cost hidden when total_cost_usd is 0.0" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"cost":{"total_cost_usd":0.0}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *'$'* ]]
}

@test "cost hidden when total_cost_usd is 0.00" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"cost":{"total_cost_usd":0.00}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *'$'* ]]
}

@test "cost hidden when rate limits present" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}},"cost":{"total_cost_usd":0.42}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *'$'* ]]
    [[ "$output" == *"5h"* ]]
}

@test "no CTX section when used_percentage absent" {
    local input='{"model":{"display_name":"Test"}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *"CTX"* ]]
}

@test "cost with decimal places passed through" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"cost":{"total_cost_usd":12.345}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$12.345'* ]]
}

# ---------------------------------------------------------------------------
# Git branch tests
# ---------------------------------------------------------------------------

@test "shows git branch when workspace is a git repo" {
    [[ -n "${GIT_DIR:-}" ]] && skip "git commands unreliable inside git hooks"
    local repo="$(mktemp -d)"
    git -C "$repo" init -q
    git -C "$repo" config user.email "test@test.com"
    git -C "$repo" config user.name "Test"
    git -C "$repo" commit --allow-empty -m "init" -q
    git -C "$repo" checkout -b feat/my-feature -q
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000}'
    export STATUSLINE_WORKSPACE_DIR="$repo"
    run bash -c "echo '$input' | bash $STATUSLINE"
    unset STATUSLINE_WORKSPACE_DIR
    rm -rf "$repo"
    [ "$status" -eq 0 ]
    [[ "$output" == *"feat/my-feature"* ]]
}

@test "shows short SHA on detached HEAD" {
    [[ -n "${GIT_DIR:-}" ]] && skip "git commands unreliable inside git hooks"
    local repo="$(mktemp -d)"
    git -C "$repo" init -q
    git -C "$repo" config user.email "test@test.com"
    git -C "$repo" config user.name "Test"
    git -C "$repo" commit --allow-empty -m "init" -q
    local sha
    sha="$(git -C "$repo" rev-parse --short HEAD)"
    git -C "$repo" checkout --detach -q
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000}'
    export STATUSLINE_WORKSPACE_DIR="$repo"
    run bash -c "echo '$input' | bash $STATUSLINE"
    unset STATUSLINE_WORKSPACE_DIR
    rm -rf "$repo"
    [ "$status" -eq 0 ]
    [[ "$output" == *"$sha"* ]]
}

@test "no branch shown when workspace is not a git repo" {
    local repo="$(mktemp -d)"
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000}'
    export STATUSLINE_WORKSPACE_DIR="$repo"
    run bash -c "echo '$input' | bash $STATUSLINE"
    unset STATUSLINE_WORKSPACE_DIR
    rm -rf "$repo"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Test"* ]]
}

@test "branch appears between model and CTX in correct order" {
    [[ -n "${GIT_DIR:-}" ]] && skip "git commands unreliable inside git hooks"
    local repo="$(mktemp -d)"
    git -C "$repo" init -q
    git -C "$repo" config user.email "test@test.com"
    git -C "$repo" config user.name "Test"
    git -C "$repo" commit --allow-empty -m "init" -q
    local branch
    branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000}'
    export STATUSLINE_WORKSPACE_DIR="$repo"
    run bash -c "echo '$input' | bash $STATUSLINE"
    unset STATUSLINE_WORKSPACE_DIR
    rm -rf "$repo"
    [ "$status" -eq 0 ]
    # Branch name must appear between model and CTX
    [[ "$output" =~ Test.*"$branch".*CTX ]]
}

# ---------------------------------------------------------------------------
# Float handling tests
# ---------------------------------------------------------------------------

@test "used_percentage as float truncated to integer" {
    local input='{"model":{"display_name":"Test"},"used_percentage":38.7,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"38%"* ]]
    [[ "$output" != *"38.7%"* ]]
}

@test "used_percentage as integer works" {
    local input='{"model":{"display_name":"Test"},"used_percentage":38,"context_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"38%"* ]]
}

@test "rate limit percentage as float truncated" {
    local input='{"model":{"display_name":"Test"},"used_percentage":10,"context_window_size":1000000,"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"12%"* ]]
}

# ---------------------------------------------------------------------------
# Malformed / broken JSON error path tests
# ---------------------------------------------------------------------------

@test "malformed JSON with extra braces does not crash" {
    run bash -c "echo '{\"rate_limits\":{\"five_hour\":{\"used_percentage\":12}}}}' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

@test "truncated JSON does not crash" {
    run bash -c 'echo "{\"rate_limits\":{\"five_hour\":{\"use" | bash '"$STATUSLINE"
    [ "$status" -eq 0 ]
}

@test "deeply nested JSON beyond expected depth does not crash" {
    local input='{"rate_limits":{"five_hour":{"nested":{"deep":1},"used_percentage":12,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
}

@test "empty nested objects handled gracefully" {
    run bash -c "echo '{\"rate_limits\":{\"five_hour\":{}}}' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
}

@test "empty rate_limits object handled — no bars but cost suppressed" {
    run bash -c "echo '{\"rate_limits\":{},\"cost\":{\"total_cost_usd\":1.0}}' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *"5h"* ]]
    [[ "$output" != *"7d"* ]]
    # rate_limits key present = subscription mode, so cost is hidden
    [[ "$output" != *'$'* ]]
}

@test "JSON with only cost block, no rate_limits key" {
    run bash -c "echo '{\"cost\":{\"total_cost_usd\":1.50}}' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$1.50'* ]]
}

@test "pretty-printed multi-line JSON parses correctly" {
    run bash "$STATUSLINE" << 'JSON'
{
  "model": {
    "display_name": "Opus 4.6 (1M context)",
    "name": "claude-opus-4-6"
  },
  "used_percentage": 38,
  "context_window_size": 1000000,
  "rate_limits": {
    "five_hour": {
      "used_percentage": 12,
      "resets_at": 1775580120
    },
    "seven_day": {
      "used_percentage": 82,
      "resets_at": 1776186000
    }
  }
}
JSON
    [ "$status" -eq 0 ]
    [[ "$output" == *"Opus 4.6 (1M context)"* ]]
    [[ "$output" == *"CTX"* ]]
    [[ "$output" == *"38%"* ]]
    [[ "$output" == *"5h"* ]]
    [[ "$output" == *"12%"* ]]
    [[ "$output" == *"7d"* ]]
    [[ "$output" == *"82%"* ]]
}

# ---------------------------------------------------------------------------
# Security tests
# ---------------------------------------------------------------------------

@test "script does not use curl" {
    ! grep -q 'curl' "$STATUSLINE"
}

@test "script does not access tokens or credentials" {
    ! grep -v '^\s*#' "$STATUSLINE" | grep -qE '\bsecurity\b|secret-tool|keychain|oauth|/tokens|api\.anthropic\.com'
}

@test "script does not write to /tmp cache" {
    ! grep -qE 'mkdir.*\/tmp\/claude|\/tmp\/claude' "$STATUSLINE"
}

@test "script does not use wget or network tools" {
    ! grep -qE 'wget|nc |netcat|fetch ' "$STATUSLINE"
}

@test "script does not read settings.json" {
    ! grep -q 'settings.json' "$STATUSLINE"
}

@test "script does not use jq" {
    ! grep -v '^\s*#' "$STATUSLINE" | grep -qE '\bjq\b'
}

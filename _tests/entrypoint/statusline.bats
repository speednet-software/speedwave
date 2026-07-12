#!/usr/bin/env bats
# Tests for containers/claude-resources/statusline.sh, run on the host (macOS) — no container required.

STATUSLINE="$BATS_TEST_DIRNAME/../../containers/claude-resources/statusline.sh"

# Full rate-limited JSON for reuse across tests; resets_at values are Unix epoch seconds (not ISO).
FULL_RATE_LIMITED_JSON='{"model":{"display_name":"Opus 4.6 (1M context)","name":"claude-opus-4-6"},"context_window":{"used_percentage":38,"context_window_size":1000000},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120},"seven_day":{"used_percentage":82,"resets_at":1776186000}}}'

# ── Happy path tests ────────────────────────────────────────────────────────────

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
    local input='{"model":{"display_name":"Opus 4.6 (1M context)"},"context_window":{"used_percentage":38,"context_window_size":1000000},"cost":{"total_cost_usd":0.42}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$0.42'* ]]
    [[ "$output" != *"5h"* ]]
    [[ "$output" != *"7d"* ]]
}

@test "API key mode with top-level total_cost_usd" {
    local input='{"model":{"display_name":"Opus"},"context_window":{"used_percentage":38,"context_window_size":1000000},"total_cost_usd":1.23}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$1.23'* ]]
}

@test "proxy SSOT cost from cost-cache.jsonl overrides the CC value" {
    local usage_dir="$BATS_TEST_TMPDIR/usage"
    mkdir -p "$usage_dir"
    printf '%s\n' \
        '{"response_id":"m1","cost_usd":0.0200,"cost_source":"catalog"}' \
        '{"response_id":"m2","cost_usd":0.0300,"cost_source":"actual"}' \
        > "$usage_dir/cost-cache.jsonl"
    local input='{"model":{"display_name":"Opus"},"context_window":{"used_percentage":38,"context_window_size":1000000},"total_cost_usd":1.23}'
    run bash -c "echo '$input' | STATUSLINE_USAGE_DIR='$usage_dir' bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # 0.02 + 0.03 = 0.05 from the sidecar, not the CC 1.23.
    [[ "$output" == *'$0.0500'* ]]
    [[ "$output" != *'1.23'* ]]
}

@test "missing /usage keeps the CC cost value" {
    local input='{"model":{"display_name":"Opus"},"context_window":{"used_percentage":38,"context_window_size":1000000},"total_cost_usd":1.23}'
    run bash -c "echo '$input' | STATUSLINE_USAGE_DIR='$BATS_TEST_TMPDIR/nope' bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$1.23'* ]]
}

@test "SSOT cost parses serde_json scientific-notation floats" {
    local usage_dir="$BATS_TEST_TMPDIR/usage"
    mkdir -p "$usage_dir"
    # serde_json emits small f64 in exponent form; must not truncate at 'e'.
    printf '%s\n' \
        '{"response_id":"m1","cost_usd":2.5e-6,"cost_source":"catalog"}' \
        '{"response_id":"m2","cost_usd":0.0100,"cost_source":"catalog"}' \
        > "$usage_dir/cost-cache.jsonl"
    local input='{"model":{"display_name":"Opus"},"context_window":{"used_percentage":38,"context_window_size":1000000},"total_cost_usd":1.23}'
    run bash -c "echo '$input' | STATUSLINE_USAGE_DIR='$usage_dir' bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # 0.0000025 + 0.01 = 0.0100 (4dp), NOT 2.5 + 0.01 = 2.51 from a truncated 'e'.
    [[ "$output" == *'$0.0100'* ]]
    [[ "$output" != *'2.51'* ]]
}

@test "SSOT all-zero sidecar shows \$0, not the CC fallback" {
    local usage_dir="$BATS_TEST_TMPDIR/usage"
    mkdir -p "$usage_dir"
    # A free-local session: every priced line is 0.0 — must show the SSOT $0.
    printf '%s\n' \
        '{"response_id":"m1","cost_usd":0.0,"cost_source":"free"}' \
        '{"response_id":"m2","cost_usd":0.0,"cost_source":"free"}' \
        > "$usage_dir/cost-cache.jsonl"
    local input='{"model":{"display_name":"Local"},"context_window":{"used_percentage":38,"context_window_size":1000000},"total_cost_usd":1.23}'
    run bash -c "echo '$input' | STATUSLINE_USAGE_DIR='$usage_dir' bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # Priced lines exist and sum to 0 → SSOT wins, CC 1.23 is suppressed.
    [[ "$output" != *'1.23'* ]]
}

@test "SSOT dedups duplicate response_id, last write wins" {
    local usage_dir="$BATS_TEST_TMPDIR/usage"
    mkdir -p "$usage_dir"
    # Re-enrichment appended a second line for msg_1: only the last (0.05) counts.
    printf '%s\n' \
        '{"response_id":"msg_1","cost_usd":0.0200,"cost_source":"catalog"}' \
        '{"response_id":"msg_1","cost_usd":0.0500,"cost_source":"actual"}' \
        > "$usage_dir/cost-cache.jsonl"
    local input='{"model":{"display_name":"Opus"},"context_window":{"used_percentage":38,"context_window_size":1000000},"total_cost_usd":1.23}'
    run bash -c "echo '$input' | STATUSLINE_USAGE_DIR='$usage_dir' bash $STATUSLINE"
    [ "$status" -eq 0 ]
    # Last write wins: $0.05, NOT 0.02+0.05=0.07.
    [[ "$output" == *'$0.0500'* ]]
    [[ "$output" != *'0.0700'* ]]
    [[ "$output" != *'1.23'* ]]
}

@test "SSOT excludes failed/null lines from the cost sum" {
    local usage_dir="$BATS_TEST_TMPDIR/usage"
    mkdir -p "$usage_dir"
    # A failed and a subscription line carry cost_usd:null → not summed; only
    # the priced 0.04 catalog line counts.
    printf '%s\n' \
        '{"response_id":"m_ok","cost_usd":0.0400,"cost_source":"catalog"}' \
        '{"response_id":"m_fail","cost_usd":null,"cost_source":"failed"}' \
        '{"response_id":"m_sub","cost_usd":null,"cost_source":"subscription"}' \
        > "$usage_dir/cost-cache.jsonl"
    local input='{"model":{"display_name":"Opus"},"context_window":{"used_percentage":38,"context_window_size":1000000},"total_cost_usd":1.23}'
    run bash -c "echo '$input' | STATUSLINE_USAGE_DIR='$usage_dir' bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$0.0400'* ]]
    [[ "$output" != *'1.23'* ]]
}

@test "extracts display_name from JSON" {
    local input='{"model":{"display_name":"Sonnet 4.6 (200K context)"},"context_window":{"used_percentage":10,"context_window_size":200000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Sonnet 4.6 (200K context)"* ]]
}

@test "falls back to name when display_name absent" {
    local input='{"model":{"name":"claude-sonnet-4-6"},"context_window":{"used_percentage":10,"context_window_size":200000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"claude-sonnet-4-6"* ]]
}

@test "CTX label with percentage" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":38,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"CTX"* ]]
    [[ "$output" == *"38%"* ]]
}

@test "5h reset time formatted from epoch" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"5h"* ]]
    [[ "$output" == *"reset"* ]]
    # Reset time should be HH:MM format
    [[ "$output" =~ [0-9]{2}:[0-9]{2} ]]
}

@test "7d reset date formatted from epoch" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120},"seven_day":{"used_percentage":82,"resets_at":1776186000}}}'
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

# ── Color threshold tests ───────────────────────────────────────────────────────

@test "green below 50%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":25,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[32m'* ]]
}

@test "green at 49%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":49,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[32m'* ]]
}

@test "yellow at 50%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":50,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[33m'* ]]
}

@test "yellow at 75%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":75,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[33m'* ]]
}

@test "red at 76%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":76,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[31m'* ]]
}

@test "red at 89%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":89,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[31m'* ]]
}

@test "bold red at 90%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":90,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[1m'* ]]
    [[ "$output" == *$'\033[31m'* ]]
}

@test "bold red at 95%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":95,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[1m'* ]]
    [[ "$output" == *$'\033[31m'* ]]
}

@test "5h rate limit bar uses correct color at 60%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"rate_limits":{"five_hour":{"used_percentage":60,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[33m'* ]]
}

@test "7d rate limit bar uses correct color at 85%" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":1775580120},"seven_day":{"used_percentage":85,"resets_at":1776186000}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *$'\033[31m'* ]]
}

# ── Bar width tests ─────────────────────────────────────────────────────────────

@test "CTX bar 40% has 2 filled, 3 empty" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":40,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"██░░░"* ]]
}

@test "CTX bar 100% is fully filled" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":100,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"█████"* ]]
    [[ "$output" == *"100%"* ]]
}

@test "CTX bar 0% is fully empty" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":0,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"░░░░░"* ]]
}

# ── Edge cases ──────────────────────────────────────────────────────────────────

@test "completely empty JSON object does not crash" {
    run bash -c "echo '{}' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

@test "missing model name defaults to Claude" {
    local input='{"context_window":{"used_percentage":50,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Claude"* ]]
}

@test "7d section hidden when seven_day data absent" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"5h"* ]]
    [[ "$output" != *"7d"* ]]
}

@test "cost hidden when total_cost_usd is 0" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"cost":{"total_cost_usd":0}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *'$'* ]]
}

@test "cost hidden when total_cost_usd is 0.0" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"cost":{"total_cost_usd":0.0}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *'$'* ]]
}

@test "cost hidden when total_cost_usd is 0.00" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"cost":{"total_cost_usd":0.00}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *'$'* ]]
}

@test "cost hidden when rate limits present" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}},"cost":{"total_cost_usd":0.42}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *'$'* ]]
    [[ "$output" == *"5h"* ]]
}

@test "no CTX section when context_window absent" {
    local input='{"model":{"display_name":"Test"}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *"CTX"* ]]
}

@test "legacy top-level used_percentage (no context_window object) hides CTX" {
    # Pre-nesting shape never emitted by the pinned CC — must not leak a bar.
    local input='{"model":{"display_name":"Test"},"used_percentage":38,"legacy_window_size":1000000}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" != *"CTX"* ]]
}

@test "null used_percentage with rate limits shows CTX 0%, never the 5h value" {
    # Early session: context_window.used_percentage is null (documented). The
    # scan must not skip ahead and read rate_limits' 12% as context usage.
    local input='{"model":{"display_name":"Test"},"context_window":{"total_input_tokens":0,"context_window_size":200000,"used_percentage":null,"current_usage":null},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" =~ CTX.*0%.*5h.*12% ]]
}

@test "current_usage nested before used_percentage still parses CTX" {
    # Key order inside context_window is not contractual; a nested object
    # ahead of used_percentage must not break the scoped scan.
    local input='{"model":{"display_name":"Test"},"context_window":{"current_usage":{"input_tokens":2,"output_tokens":1660,"cache_creation_input_tokens":4920,"cache_read_input_tokens":66844},"total_input_tokens":71766,"context_window_size":200000,"used_percentage":37,"remaining_percentage":63}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"CTX"* ]]
    [[ "$output" == *"37%"* ]]
}

@test "rate_limits serialized before context_window still parses CTX" {
    local input='{"model":{"display_name":"Test"},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}},"context_window":{"used_percentage":38,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" =~ CTX.*38% ]]
}

@test "rate_limits before context_window AND used_percentage absent shows CTX 0%, never a trailing key" {
    # Reversed key order (rate_limits first) combined with a missing used_percentage in
    # context_window: a substring-scoped scan with no jq falls through to unrelated trailing JSON.
    local input='{"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1775580120}},"context_window":{"context_window_size":1000000},"trailing":{"used_percentage":77}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" =~ CTX.*0%.*5h.*12% ]]
    [[ "$output" != *"77%"* ]]
}

@test "context extraction falls back to regex scan when jq is unavailable" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":38,"context_window_size":1000000}}'
    local fake_bin="$BATS_TEST_TMPDIR/nojq-bin"
    mkdir -p "$fake_bin"
    for tool in bash cat tr date git awk grep sed mkdir rm mktemp printf; do
        [ -x "/usr/bin/$tool" ] && ln -sf "/usr/bin/$tool" "$fake_bin/$tool" 2>/dev/null
        [ -x "/bin/$tool" ] && ln -sf "/bin/$tool" "$fake_bin/$tool" 2>/dev/null
    done
    run bash -c "echo '$input' | PATH='$fake_bin' bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"CTX"* ]]
    [[ "$output" == *"38%"* ]]
}

@test "cost with decimal places passed through" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"cost":{"total_cost_usd":12.345}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'$12.345'* ]]
}

# ── Git branch tests ────────────────────────────────────────────────────────────

@test "shows git branch when workspace is a git repo" {
    [[ -n "${GIT_DIR:-}" ]] && skip "git commands unreliable inside git hooks"
    local repo="$(mktemp -d)"
    git -C "$repo" init -q
    git -C "$repo" config user.email "test@test.com"
    git -C "$repo" config user.name "Test"
    git -C "$repo" commit --allow-empty -m "init" -q
    git -C "$repo" checkout -b feat/my-feature -q
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000}}'
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
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000}}'
    export STATUSLINE_WORKSPACE_DIR="$repo"
    run bash -c "echo '$input' | bash $STATUSLINE"
    unset STATUSLINE_WORKSPACE_DIR
    rm -rf "$repo"
    [ "$status" -eq 0 ]
    [[ "$output" == *"$sha"* ]]
}

@test "no branch shown when workspace is not a git repo" {
    local repo="$(mktemp -d)"
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000}}'
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
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000}}'
    export STATUSLINE_WORKSPACE_DIR="$repo"
    run bash -c "echo '$input' | bash $STATUSLINE"
    unset STATUSLINE_WORKSPACE_DIR
    rm -rf "$repo"
    [ "$status" -eq 0 ]
    # Branch name must appear between model and CTX
    [[ "$output" =~ Test.*"$branch".*CTX ]]
}

# ── Float handling tests ────────────────────────────────────────────────────────

@test "used_percentage as float truncated to integer" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":38.7,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"38%"* ]]
    [[ "$output" != *"38.7%"* ]]
}

@test "used_percentage as integer works" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":38,"context_window_size":1000000}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"38%"* ]]
}

@test "rate limit percentage as float truncated" {
    local input='{"model":{"display_name":"Test"},"context_window":{"used_percentage":10,"context_window_size":1000000},"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1775580120}}}'
    run bash -c "echo '$input' | bash $STATUSLINE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"12%"* ]]
}

# ── Malformed / broken JSON error path tests ────────────────────────────────────

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
  "context_window": {
    "used_percentage": 38,
    "context_window_size": 1000000
  },
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

# ── Security tests ──────────────────────────────────────────────────────────────

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

@test "script uses jq only for local JSON parsing, never as a network/exec sink" {
    grep -qE '\bjq\b' "$STATUSLINE"
    ! grep -v '^\s*#' "$STATUSLINE" | grep -qE 'jq[^|]*(-r?[a-zA-Z]*\s+)?["\x27]\s*\$\('
}

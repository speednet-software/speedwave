#!/bin/bash
# Speedwave statusline for Claude Code — reads JSON state from stdin, outputs a single status-bar
# line (model, context usage, rate limits, cost).

set -f

# ── ANSI colors ──────────────────────────────────────────────────────────────

RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
CYAN='\033[36m'
WHITE='\033[37m'

# ── Helpers ──────────────────────────────────────────────────────────────────

# build_bar <percent> → colored bar "██░░░" (5 chars); sets global BAR_COLOR.
BAR_COLOR=""
build_bar() {
    local pct="$1"
    local width=5
    local filled=$(( pct * width / 100 ))
    local empty=$(( width - filled ))

    BAR_COLOR="$GREEN"
    if (( pct >= 90 )); then
        BAR_COLOR="${BOLD}${RED}"
    elif (( pct >= 76 )); then
        BAR_COLOR="$RED"
    elif (( pct >= 50 )); then
        BAR_COLOR="$YELLOW"
    fi

    local bar=""
    local i
    for (( i=0; i<filled; i++ )); do bar+="█"; done
    for (( i=0; i<empty; i++ )); do bar+="░"; done

    printf '%b%s%b' "$BAR_COLOR" "$bar" "$RESET"
}

# format_reset_time <epoch_seconds> → "16:42" (local time)
format_reset_time() {
    local epoch="$1"
    if [[ -n "$epoch" ]] && (( epoch > 0 )); then
        date -r "$epoch" '+%H:%M' 2>/dev/null || date -d "@$epoch" '+%H:%M' 2>/dev/null
    fi
}

# format_reset_date <epoch_seconds> → "14.04" (local time)
format_reset_date() {
    local epoch="$1"
    if [[ -n "$epoch" ]] && (( epoch > 0 )); then
        date -r "$epoch" '+%d.%m' 2>/dev/null || date -d "@$epoch" '+%d.%m' 2>/dev/null
    fi
}

# ── Read JSON from stdin ──────────────────────────────────────────────────────

INPUT=""
if [ ! -t 0 ]; then
    INPUT="$(cat)"
fi

# Collapse to single line for regex extraction.
INPUT="$(printf '%s' "$INPUT" | tr '\n' ' ')"

# ── JSON extraction helpers ──────────────────────────────────────────────────

# JSON field extraction via regex, no jq — operates on single-line input.
extract_json_string() {
    local json="$1" key="$2"
    local pattern="\"${key}\"[[:space:]]*:[[:space:]]*\""
    if [[ "$json" =~ $pattern ]]; then
        local after="${json#*\"${key}\"*:*\"}"
        printf '%s' "${after%%\"*}"
    fi
}

extract_json_number() {
    local json="$1" key="$2"
    local pattern="\"${key}\"[[:space:]]*:[[:space:]]*([0-9]+)"
    if [[ "$json" =~ $pattern ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

extract_json_float() {
    local json="$1" key="$2"
    local pattern="\"${key}\"[[:space:]]*:[[:space:]]*([0-9]+\.?[0-9]*)"
    if [[ "$json" =~ $pattern ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

# extract_block "json" "key" → content between { and } for "key": { ... }
# Handles 1 level of nesting only.
extract_block() {
    local json="$1" key="$2"
    local pattern="\"${key}\"[[:space:]]*:[[:space:]]*\{"
    if [[ "$json" =~ $pattern ]]; then
        local after="${json#*\"${key}\"*\{}"
        printf '%s' "${after%%\}*}"
    fi
}

# ── Extract fields ───────────────────────────────────────────────────────────

# Model name — from display_name or name
model_name=""
if [[ -n "$INPUT" ]]; then
    model_name="$(extract_json_string "$INPUT" "display_name")"
    if [[ -z "$model_name" ]]; then
        model_name="$(extract_json_string "$INPUT" "name")"
    fi
fi
model_name="${model_name:-Claude}"

# Context fields live under "context_window" (CC >=2.1.132). jq parses the real object
# regardless of key order; the regex scope-scan is a fallback for a missing/broken jq.
context_window_size=0
used_pct=0
have_context_window=false
if command -v jq >/dev/null 2>&1; then
    cw_json="$(printf '%s' "$INPUT" | jq -e -c '.context_window | select(type == "object")' 2>/dev/null)"
    if [[ -n "$cw_json" ]]; then
        have_context_window=true
        context_window_size="$(printf '%s' "$cw_json" | jq -r '.context_window_size // 0' 2>/dev/null)"
        used_pct_raw="$(printf '%s' "$cw_json" | jq -r '.used_percentage // 0' 2>/dev/null)"
    fi
fi
if [[ "$have_context_window" == false ]]; then
    cw_pattern='"context_window"[[:space:]]*:[[:space:]]*\{'
    if [[ "$INPUT" =~ $cw_pattern ]]; then
        cw_scope="${INPUT#*\"context_window\"}"
        cw_scope="${cw_scope%%\"rate_limits\"*}"
        context_window_size="$(extract_json_number "$cw_scope" "context_window_size")"
        used_pct_raw="$(extract_json_float "$cw_scope" "used_percentage")"
    fi
fi
context_window_size="${context_window_size:-0}"
[[ "$context_window_size" =~ ^[0-9]+$ ]] || context_window_size=0
used_pct="${used_pct_raw%%.*}"
used_pct="${used_pct:-0}"
[[ "$used_pct" =~ ^[0-9]+$ ]] || used_pct=0

# Rate limits — detect rate_limits key, then extract five_hour/seven_day from INPUT.
has_rl_key=false
rl_pattern='"rate_limits"[[:space:]]*:[[:space:]]*\{'
if [[ "$INPUT" =~ $rl_pattern ]]; then
    has_rl_key=true
fi

five_hour_pct=""
five_hour_resets_at=""
if [[ "$has_rl_key" == true ]]; then
    fh_block="$(extract_block "$INPUT" "five_hour")"
    if [[ -n "$fh_block" ]]; then
        five_hour_pct="$(extract_json_float "$fh_block" "used_percentage")"
        five_hour_resets_at="$(extract_json_number "$fh_block" "resets_at")"
    fi
fi

seven_day_pct=""
seven_day_resets_at=""
if [[ "$has_rl_key" == true ]]; then
    sd_block="$(extract_block "$INPUT" "seven_day")"
    if [[ -n "$sd_block" ]]; then
        seven_day_pct="$(extract_json_float "$sd_block" "used_percentage")"
        seven_day_resets_at="$(extract_json_number "$sd_block" "resets_at")"
    fi
fi

# Truncate rate limit percentages to integer for bash arithmetic
five_hour_pct="${five_hour_pct%%.*}"
seven_day_pct="${seven_day_pct%%.*}"

# Cost — try nested "cost": { "total_cost_usd": ... } first, then top-level
total_cost=""
cost_block="$(extract_block "$INPUT" "cost")"
if [[ -n "$cost_block" ]]; then
    total_cost="$(extract_json_float "$cost_block" "total_cost_usd")"
fi
if [[ -z "$total_cost" ]]; then
    total_cost="$(extract_json_float "$INPUT" "total_cost_usd")"
fi

# Proxy SSOT (ADR-073): cumulative cost from the sidecar overrides the CC value.
# STATUSLINE_USAGE_DIR overrides /usage for tests. Missing/unreadable → CC value.
USAGE_DIR="${STATUSLINE_USAGE_DIR:-/usage}"
cost_cache="$USAGE_DIR/cost-cache.jsonl"
# No usage-window filter here (the shell can't read the full JSONL cheaply);
# prune_cost_cache_in drops orphans, so this may briefly exceed the dashboard.
if [[ -r "$cost_cache" ]]; then
    # LC_ALL=C forces '.' as decimal point; pattern accepts scientific notation. Dedup by
    # response_id (last write wins); `n` counts priced ids so an all-zero sidecar still shows $0.
    ssot_cost="$(LC_ALL=C awk '
        {
            id = ""
            if (match($0, /"response_id"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
                seg = substr($0, RSTART, RLENGTH)
                sub(/^.*:[[:space:]]*"/, "", seg); sub(/"$/, "", seg)
                id = seg
            }
        }
        match($0, /"cost_usd"[[:space:]]*:[[:space:]]*-?[0-9.]+([eE][-+]?[0-9]+)?/) {
            seg = substr($0, RSTART, RLENGTH)
            sub(/^.*:[[:space:]]*/, "", seg)
            cost[id] = seg + 0
        }
        END {
            n = 0
            for (k in cost) { sum += cost[k]; n++ }
            if (n > 0) printf "%.4f", sum
        }
    ' "$cost_cache" 2>/dev/null)"
    if [[ -n "$ssot_cost" ]]; then
        total_cost="$ssot_cost"
    fi
fi

# ── Git branch ───────────────────────────────────────────────────────────────
# No [ -d .git ] check (worktrees: .git is a file); STATUSLINE_WORKSPACE_DIR overrides for tests.

WORKSPACE="${STATUSLINE_WORKSPACE_DIR:-/workspace}"
git_branch=""
if command -v git >/dev/null 2>&1; then
    git_branch="$(git -C "$WORKSPACE" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    # Detached HEAD returns "HEAD" — show short SHA instead
    if [[ "$git_branch" == "HEAD" ]]; then
        git_branch="$(git -C "$WORKSPACE" rev-parse --short HEAD 2>/dev/null)"
    fi
fi

# ── Build output ─────────────────────────────────────────────────────────────

parts=()

# Part 1: Model — bold cyan (display_name already includes context info)
parts+=("$(printf '%b%b%s%b' "$BOLD" "$CYAN" "$model_name" "$RESET")")

# Part 2: Git branch — dim white (omitted if not in a git repo)
if [[ -n "$git_branch" ]]; then
    parts+=("$(printf '%b%s%b' "$DIM" "$git_branch" "$RESET")")
fi

# Part 3: CTX — context usage bar and percentage (same color as bar)
if (( used_pct > 0 || context_window_size > 0 )); then
    ctx_bar="$(build_bar "$used_pct")"
    parts+=("$(printf '%bCTX%b %s %b%s%%%b' "$DIM" "$RESET" "$ctx_bar" "$BAR_COLOR" "$used_pct" "$RESET")")
fi

# Determine mode — use has_rl_key so seven_day-only input is still rate-limit mode
has_rate_limits="$has_rl_key"

# Part 4: 5h rate limit — only when data available
if [[ "$has_rate_limits" == true ]] && [[ -n "$five_hour_pct" ]]; then
    five_bar="$(build_bar "$five_hour_pct")"
    reset_str=""
    if [[ -n "$five_hour_resets_at" ]]; then
        reset_time="$(format_reset_time "$five_hour_resets_at")"
        if [[ -n "$reset_time" ]]; then
            reset_str="$(printf ' %breset%b %s' "$DIM" "$RESET" "$reset_time")"
        fi
    fi
    parts+=("$(printf '%b5h%b %s %b%s%%%b%s' "$DIM" "$RESET" "$five_bar" "$BAR_COLOR" "$five_hour_pct" "$RESET" "$reset_str")")
fi

# Part 5: 7d rate limit — only when data available
if [[ "$has_rate_limits" == true ]] && [[ -n "$seven_day_pct" ]]; then
    seven_bar="$(build_bar "$seven_day_pct")"
    reset_str=""
    if [[ -n "$seven_day_resets_at" ]]; then
        reset_date="$(format_reset_date "$seven_day_resets_at")"
        if [[ -n "$reset_date" ]]; then
            reset_str="$(printf ' %breset%b %s' "$DIM" "$RESET" "$reset_date")"
        fi
    fi
    parts+=("$(printf '%b7d%b %s %b%s%%%b%s' "$DIM" "$RESET" "$seven_bar" "$BAR_COLOR" "$seven_day_pct" "$RESET" "$reset_str")")
fi

# Part 6: Cost — only in API key mode (no rate limits), only when > 0
# Cost is zero if it matches 0, 0.0, 0.00, etc.
cost_is_zero=true
if [[ -n "$total_cost" ]]; then
    cost_check="${total_cost//0/}"
    cost_check="${cost_check/./}"
    if [[ -n "$cost_check" ]]; then
        cost_is_zero=false
    fi
fi
if [[ "$has_rate_limits" == false ]] && [[ "$cost_is_zero" == false ]]; then
    parts+=("$(printf '%b$%s%b' "$DIM" "$total_cost" "$RESET")")
fi

# Join with dim │ separator
output=""
for (( i=0; i<${#parts[@]}; i++ )); do
    if (( i > 0 )); then
        output+="$(printf ' %b│%b ' "$DIM" "$RESET")"
    fi
    output+="${parts[$i]}"
done

printf '%s\n' "$output"

#!/bin/bash
# Speedwave statusline for Claude Code — displays model, context usage,
# rate limits, and cost. Reads JSON from stdin (Claude Code pipes
# conversation state). Outputs a single line for the status bar.
#
# Security: no network calls, no token access, no credentials — safe for the
# Speedwave container (cap_drop: ALL, no-new-privileges). Reads .git for
# branch name only (no secrets in .git/HEAD).
#
# JSON parsing: regex-based, no jq dependency. Handles flat and 2-level
# nested keys. Input is collapsed to a single line before extraction
# to handle both minified and pretty-printed JSON from Claude Code.

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

# build_bar <percent> → colored bar "██░░░" (5 chars)
# Sets global BAR_COLOR for caller to reuse on percentage text.
# Thresholds: <50% green, 50-75% yellow, 76-90% red, >90% bold red.
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

# Collapse to single line — makes regex extraction safe for both
# minified and pretty-printed JSON. This is the key simplification:
# instead of building a multi-line-aware parser, normalize the input.
INPUT="$(printf '%s' "$INPUT" | tr '\n' ' ')"

# ── JSON extraction helpers ──────────────────────────────────────────────────

# Safe JSON field extraction using regex — no jq dependency.
# Works on single-line JSON (input is collapsed above).
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

# extract_block "json" "key" → returns content between { and } for "key": { ... }
# Limitation: handles 1 level of nesting only. Sufficient for rate_limits.five_hour
# and cost objects. If Claude Code ever nests deeper, this needs revisiting.
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

# Context window size
context_window_size="$(extract_json_number "$INPUT" "context_window_size")"
context_window_size="${context_window_size:-0}"

# Context usage percentage — truncate to integer for bash arithmetic
used_pct_raw="$(extract_json_float "$INPUT" "used_percentage")"
used_pct="${used_pct_raw%%.*}"
used_pct="${used_pct:-0}"

# Rate limits — detect presence of rate_limits key, then extract five_hour/seven_day
# directly from INPUT. Extracting sub-blocks directly avoids the %%\}* limitation
# (which would stop at the first } inside a nested object when extracting rl_block).
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

# ── Git branch ───────────────────────────────────────────────────────────────
# Read current branch from workspace if it's a git repo. Graceful fallback:
# no git, no repo, worktree, detached HEAD — all handled silently.
# Skips the [ -d .git ] check: in git worktrees .git is a file, not a dir.
# STATUSLINE_WORKSPACE_DIR allows tests to override the workspace path.

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

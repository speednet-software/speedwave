#!/bin/bash
# Speedwave statusline for Claude Code — displays model, tokens, and thinking status.
# Reads JSON from stdin (Claude Code pipes conversation state).
# Outputs a single line for the status bar.
#
# Security: no network calls, no token access, no OAuth — safe for the
# Speedwave container (cap_drop: ALL, no-new-privileges, no credentials).

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

# format_commas 1234567 → "1,234,567"
format_commas() {
    local n="$1"
    local result=""
    local count=0
    local i
    for (( i=${#n}-1; i>=0; i-- )); do
        if (( count > 0 && count % 3 == 0 )); then
            result=",${result}"
        fi
        result="${n:$i:1}${result}"
        (( count++ ))
    done
    printf '%s' "$result"
}

# format_tokens 1234567 → "1.2M"
format_tokens() {
    local n="$1"
    if (( n >= 1000000 )); then
        local major=$(( n / 1000000 ))
        local minor=$(( (n % 1000000) / 100000 ))
        printf '%s.%sM' "$major" "$minor"
    elif (( n >= 1000 )); then
        local major=$(( n / 1000 ))
        local minor=$(( (n % 1000) / 100 ))
        printf '%s.%sK' "$major" "$minor"
    else
        printf '%s' "$n"
    fi
}

# build_bar <percent> → colored bar "████░░░░░░"
build_bar() {
    local pct="$1"
    local width=10
    local filled=$(( pct * width / 100 ))
    local empty=$(( width - filled ))

    local color="$GREEN"
    if (( pct >= 90 )); then
        color="$RED"
    elif (( pct >= 75 )); then
        color="$YELLOW"
    fi

    local bar=""
    local i
    for (( i=0; i<filled; i++ )); do bar+="█"; done
    for (( i=0; i<empty; i++ )); do bar+="░"; done

    printf '%b%s%b' "$color" "$bar" "$RESET"
}

# ── Read JSON from stdin ─────────────────────────────────────────────────────

INPUT=""
if [ ! -t 0 ]; then
    INPUT="$(cat)"
fi

# ── Extract fields ───────────────────────────────────────────────────────────

# Safe JSON field extraction using parameter expansion — no jq dependency.
# Handles the flat JSON structure Claude Code pipes to statusline commands.
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

extract_json_bool() {
    local json="$1" key="$2"
    local pattern="\"${key}\"[[:space:]]*:[[:space:]]*(true|false)"
    if [[ "$json" =~ $pattern ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

# Model name — from nested model.display_name or model.name
model_name=""
if [[ -n "$INPUT" ]]; then
    # Try display_name first, then name
    model_name="$(extract_json_string "$INPUT" "display_name")"
    if [[ -z "$model_name" ]]; then
        model_name="$(extract_json_string "$INPUT" "name")"
    fi
fi
model_name="${model_name:-Claude}"

# Token usage
tokens_used="$(extract_json_number "$INPUT" "tokens_used")"
tokens_used="${tokens_used:-0}"

tokens_max="$(extract_json_number "$INPUT" "tokens_max")"
tokens_max="${tokens_max:-0}"

# ── Thinking status ───────────────────────────────────────────────────────────
# Check project-level settings first (higher precedence), then user-level.
# User-level ~/.claude/settings.json is a symlink to the bundled read-only
# resource (statusLine config only, no thinking key), so project-level
# /workspace/.claude/settings.json is where teams configure thinking.

thinking="on"
PROJECT_SETTINGS="/workspace/.claude/settings.json"
USER_SETTINGS="${HOME}/.claude/settings.json"
for settings_file in "$PROJECT_SETTINGS" "$USER_SETTINGS"; do
    if [ -f "$settings_file" ]; then
        thinking_enabled="$(extract_json_bool "$(cat "$settings_file")" "thinking")"
        if [[ "$thinking_enabled" == "false" ]]; then
            thinking="off"
            break
        elif [[ "$thinking_enabled" == "true" ]]; then
            break
        fi
    fi
done

# ── Build output ─────────────────────────────────────────────────────────────

parts=()

# Model
parts+=("$(printf '%b%b%s%b' "$BOLD" "$CYAN" "$model_name" "$RESET")")

# Tokens
if (( tokens_max > 0 )); then
    used_fmt="$(format_tokens "$tokens_used")"
    max_fmt="$(format_tokens "$tokens_max")"
    pct_used=$(( tokens_used * 100 / tokens_max ))
    pct_remain=$(( 100 - pct_used ))
    bar="$(build_bar "$pct_used")"
    parts+=("$(printf '%b%s/%s%b %s %b%s%%%b' "$DIM" "$used_fmt" "$max_fmt" "$RESET" "$bar" "$WHITE" "$pct_remain" "$RESET")")
elif (( tokens_used > 0 )); then
    used_fmt="$(format_commas "$tokens_used")"
    parts+=("$(printf '%btokens: %s%b' "$DIM" "$used_fmt" "$RESET")")
fi

# Thinking
if [[ "$thinking" == "on" ]]; then
    parts+=("$(printf '%b⚡thinking%b' "$GREEN" "$RESET")")
else
    parts+=("$(printf '%b⚡thinking off%b' "$DIM" "$RESET")")
fi

# Join with separator
OLD_IFS="$IFS"
IFS=''; output=""
for (( i=0; i<${#parts[@]}; i++ )); do
    if (( i > 0 )); then
        output+="$(printf ' %b│%b ' "$DIM" "$RESET")"
    fi
    output+="${parts[$i]}"
done
IFS="$OLD_IFS"

printf '%s\n' "$output"

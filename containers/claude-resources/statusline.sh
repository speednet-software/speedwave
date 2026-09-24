#!/bin/bash

set -f


RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
CYAN='\033[36m'
WHITE='\033[37m'


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

format_reset_time() {
    local epoch="$1"
    if [[ -n "$epoch" ]] && (( epoch > 0 )); then
        date -r "$epoch" '+%H:%M' 2>/dev/null || date -d "@$epoch" '+%H:%M' 2>/dev/null
    fi
}

format_reset_date() {
    local epoch="$1"
    if [[ -n "$epoch" ]] && (( epoch > 0 )); then
        date -r "$epoch" '+%d.%m' 2>/dev/null || date -d "@$epoch" '+%d.%m' 2>/dev/null
    fi
}


INPUT=""
if [ ! -t 0 ]; then
    INPUT="$(cat)"
fi

INPUT="$(printf '%s' "$INPUT" | tr '\n' ' ')"


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

extract_block() {
    local json="$1" key="$2"
    local pattern="\"${key}\"[[:space:]]*:[[:space:]]*\{"
    if [[ "$json" =~ $pattern ]]; then
        local after="${json#*\"${key}\"*\{}"
        printf '%s' "${after%%\}*}"
    fi
}


model_name=""
if [[ -n "$INPUT" ]]; then
    model_name="$(extract_json_string "$INPUT" "display_name")"
    if [[ -z "$model_name" ]]; then
        model_name="$(extract_json_string "$INPUT" "name")"
    fi
fi
model_name="${model_name:-Claude}"

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

five_hour_pct="${five_hour_pct%%.*}"
seven_day_pct="${seven_day_pct%%.*}"

total_cost=""
cost_block="$(extract_block "$INPUT" "cost")"
if [[ -n "$cost_block" ]]; then
    total_cost="$(extract_json_float "$cost_block" "total_cost_usd")"
fi
if [[ -z "$total_cost" ]]; then
    total_cost="$(extract_json_float "$INPUT" "total_cost_usd")"
fi

USAGE_DIR="${STATUSLINE_USAGE_DIR:-/usage}"
cost_cache="$USAGE_DIR/cost-cache.jsonl"
if [[ -r "$cost_cache" ]]; then
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


WORKSPACE="${STATUSLINE_WORKSPACE_DIR:-/workspace}"
git_branch=""
if command -v git >/dev/null 2>&1; then
    git_branch="$(git -C "$WORKSPACE" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    if [[ "$git_branch" == "HEAD" ]]; then
        git_branch="$(git -C "$WORKSPACE" rev-parse --short HEAD 2>/dev/null)"
    fi
fi


parts=()

parts+=("$(printf '%b%b%s%b' "$BOLD" "$CYAN" "$model_name" "$RESET")")

if [[ -n "$git_branch" ]]; then
    parts+=("$(printf '%b%s%b' "$DIM" "$git_branch" "$RESET")")
fi

if (( used_pct > 0 || context_window_size > 0 )); then
    ctx_bar="$(build_bar "$used_pct")"
    parts+=("$(printf '%bCTX%b %s %b%s%%%b' "$DIM" "$RESET" "$ctx_bar" "$BAR_COLOR" "$used_pct" "$RESET")")
fi

has_rate_limits="$has_rl_key"

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

output=""
for (( i=0; i<${#parts[@]}; i++ )); do
    if (( i > 0 )); then
        output+="$(printf ' %b│%b ' "$DIM" "$RESET")"
    fi
    output+="${parts[$i]}"
done

printf '%s\n' "$output"

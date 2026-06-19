#!/usr/bin/env bash
# plan-loop-context.sh — pure helpers for building the project-context block
# that plan-loop.sh inlines into every agent's system prompt.
#
# Sourced by plan-loop.sh (production) and _tests/ci/plan-loop-context.bats.

# emit_file_block: cat $1 with trailing newlines preserved.
emit_file_block() {
    local content
    content="$(cat "$1"; printf 'X')"
    printf '%s' "${content%X}"
}

# list_rule_files: emit *.md paths under $1/.claude/rules, sorted, symlinks
# followed, dotfiles excluded; no output and success when dir is missing.
list_rule_files() {
    local root="$1"
    [[ -d "$root/.claude/rules" ]] || return 0
    find -L "$root/.claude/rules" -maxdepth 1 \( -type f -o -type l \) -name '*.md' \
        ! -name '.*' | LC_ALL=C sort
}

# build_project_context: print CLAUDE.md + every $1/.claude/rules file, marker-
# separated. Caller MUST set RULE_FILE_MARKER_PREFIX/RULE_FILE_MARKER_SUFFIX.
build_project_context() {
    local root="$1"
    local out=""
    if [[ -f "$root/CLAUDE.md" ]]; then
        out+="${RULE_FILE_MARKER_PREFIX}CLAUDE.md${RULE_FILE_MARKER_SUFFIX}"$'\n\n'
        out+="$(emit_file_block "$root/CLAUDE.md")"$'\n\n'
    fi
    local f
    while IFS= read -r f; do
        out+="${RULE_FILE_MARKER_PREFIX}$(basename "$f")${RULE_FILE_MARKER_SUFFIX}"$'\n\n'
        out+="$(emit_file_block "$f")"$'\n\n'
    done < <(list_rule_files "$root")
    printf '%s' "$out"
}

# validate_rules_compliance: compare rule_file basenames in JSON at $1 against
# expected args; print report on mismatch/short-note, else exit 0 no output.
validate_rules_compliance() {
    local result_file="$1"
    shift
    local expected_files=("$@")
    local issues=""

    # `|| true` keeps malformed JSON (jq non-zero) from aborting under set -euo pipefail.
    local actual_files
    actual_files=$(jq -r '.structured_output.rules_compliance // [] | .[].rule_file' "$result_file" 2>/dev/null | LC_ALL=C sort -u || true)
    local expected_sorted
    expected_sorted=$(printf '%s\n' "${expected_files[@]}" | LC_ALL=C sort -u)

    local missing
    missing=$(comm -23 <(printf '%s\n' "$expected_sorted") <(printf '%s\n' "$actual_files"))
    local extra
    extra=$(comm -13 <(printf '%s\n' "$expected_sorted") <(printf '%s\n' "$actual_files"))
    if [[ -n "$missing" ]]; then
        issues+="missing rule_file entries: $(echo "$missing" | tr '\n' ' ')"$'\n'
    fi
    if [[ -n "$extra" ]]; then
        issues+="unexpected rule_file entries (not in .claude/rules/): $(echo "$extra" | tr '\n' ' ')"$'\n'
    fi
    local short_notes
    short_notes=$(jq -r '.structured_output.rules_compliance // [] | .[] | select((.note // "") | length < 30) | .rule_file' "$result_file" 2>/dev/null || true)
    if [[ -n "$short_notes" ]]; then
        issues+="rule_file entries with notes shorter than 30 chars: $(echo "$short_notes" | tr '\n' ' ')"$'\n'
    fi
    [[ -n "$issues" ]] && printf '%s' "$issues"
    return 0
}

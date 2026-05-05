#!/usr/bin/env bash
# plan-loop-context.sh — pure helpers for building the project-context block
# that plan-loop.sh inlines into every agent's system prompt.
#
# Sourced by:
#   - .claude/scripts/plan-loop.sh (production)
#   - _tests/ci/plan-loop-context.bats (unit tests)
#
# Functions defined here are pure (no globals mutated, no side effects beyond
# stdout) and depend only on the caller setting RULE_FILE_MARKER_PREFIX and
# RULE_FILE_MARKER_SUFFIX before invocation.

# emit_file_block: cat $1 with trailing newlines preserved.
# Plain $(cat …) command substitution strips trailing newlines, which would
# glue the last line of one rule file to the next file's marker. Append a
# sentinel byte and strip it afterwards.
emit_file_block() {
    local content
    content="$(cat "$1"; printf 'X')"
    printf '%s' "${content%X}"
}

# list_rule_files: emit basenames-stripped paths of every rule file under
# $1/.claude/rules, deterministically sorted, following symlinks, excluding
# dotfiles. Returns no output (and success) when the directory is missing.
list_rule_files() {
    local root="$1"
    [[ -d "$root/.claude/rules" ]] || return 0
    find -L "$root/.claude/rules" -maxdepth 1 \( -type f -o -type l \) -name '*.md' \
        ! -name '.*' | LC_ALL=C sort
}

# build_project_context: print CLAUDE.md + every rule file from
# $1/.claude/rules, separated by per-run markers. Caller MUST set
# RULE_FILE_MARKER_PREFIX and RULE_FILE_MARKER_SUFFIX before calling.
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

# validate_rules_compliance: compare a JSON array of rule_file basenames
# (read from stdin) against an expected list (passed as args). Prints a
# multi-line report to stdout when there is a problem; exits 0 with no
# output when the actual set matches expected and no notes are too short.
#
# Usage:
#   echo "$RESULT_JSON" | validate_rules_compliance "${EXPECTED_RULE_FILES[@]}"
#
# Reads from $RESULT_FILE_VAR (env var holding a path), not stdin, because
# we need both rule_file extraction and short-note detection from the same
# source. The caller sets RESULT_FILE_VAR before invoking.
validate_rules_compliance() {
    local result_file="$1"
    shift
    local expected_files=("$@")
    local issues=""

    local actual_files
    actual_files=$(jq -r '.structured_output.rules_compliance // [] | .[].rule_file' "$result_file" 2>/dev/null | LC_ALL=C sort -u)
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
    short_notes=$(jq -r '.structured_output.rules_compliance // [] | .[] | select((.note // "") | length < 30) | .rule_file' "$result_file" 2>/dev/null)
    if [[ -n "$short_notes" ]]; then
        issues+="rule_file entries with notes shorter than 30 chars: $(echo "$short_notes" | tr '\n' ' ')"$'\n'
    fi
    [[ -n "$issues" ]] && printf '%s' "$issues"
    return 0
}

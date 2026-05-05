#!/usr/bin/env bats
# Tests for .claude/scripts/plan-loop-context.sh — the pure helpers that
# build the AUTHORITATIVE PROJECT CONTEXT block injected into every
# plan-loop agent's system prompt.
#
# These helpers are load-bearing: a bug here means agents either miss
# rules (security regression) or read corrupted concatenated text
# (correctness regression). The plan-loop orchestrator mode is hard to
# test end-to-end, so we cover the helpers in isolation.

LIB="$BATS_TEST_DIRNAME/../../.claude/scripts/plan-loop-context.sh"

setup() {
    # Per-test scratch root that doubles as a fake project root.
    TMP="$(mktemp -d)"
    export RULE_FILE_MARKER_PREFIX="--- BEGIN_RULE_FILE_test: "
    export RULE_FILE_MARKER_SUFFIX=" ---"
    # shellcheck source=/dev/null
    source "$LIB"
}

teardown() {
    rm -rf "$TMP"
}

# ---------------------------------------------------------------------------
# emit_file_block — trailing newline preservation (B2 from review)
# ---------------------------------------------------------------------------

@test "emit_file_block preserves trailing newline" {
    printf 'line1\nline2\n' > "$TMP/a.txt"
    # Cannot use $(emit_file_block …) — command substitution itself strips
    # trailing newlines, which would defeat the test. Redirect to a file.
    emit_file_block "$TMP/a.txt" > "$TMP/out"
    [ "$(wc -c < "$TMP/out" | tr -d ' ')" = "12" ]
    # Last byte must be a newline (0x0a).
    [ "$(tail -c 1 "$TMP/out" | od -An -tx1 | tr -d ' ')" = "0a" ]
}

@test "emit_file_block preserves multiple trailing newlines" {
    printf 'x\n\n\n' > "$TMP/a.txt"
    emit_file_block "$TMP/a.txt" > "$TMP/out"
    [ "$(wc -c < "$TMP/out" | tr -d ' ')" = "4" ]
}

@test "emit_file_block on empty file yields empty string" {
    : > "$TMP/empty.txt"
    out="$(emit_file_block "$TMP/empty.txt")"
    [ -z "$out" ]
}

@test "emit_file_block preserves binary-ish content (special chars)" {
    printf 'a\tb\x01c\n' > "$TMP/x.txt"
    out="$(emit_file_block "$TMP/x.txt")"
    [ "$(printf '%s' "$out" | wc -c | tr -d ' ')" = "5" ]
}

# ---------------------------------------------------------------------------
# list_rule_files — discovery semantics
# ---------------------------------------------------------------------------

@test "list_rule_files returns empty (success) when .claude/rules missing" {
    run list_rule_files "$TMP"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "list_rule_files lists *.md files sorted" {
    mkdir -p "$TMP/.claude/rules"
    : > "$TMP/.claude/rules/zebra.md"
    : > "$TMP/.claude/rules/alpha.md"
    : > "$TMP/.claude/rules/middle.md"
    run list_rule_files "$TMP"
    [ "$status" -eq 0 ]
    # Sorted: alpha, middle, zebra
    [[ "$(echo "$output" | sed -n '1p')" == *"alpha.md" ]]
    [[ "$(echo "$output" | sed -n '2p')" == *"middle.md" ]]
    [[ "$(echo "$output" | sed -n '3p')" == *"zebra.md" ]]
}

@test "list_rule_files excludes dotfiles" {
    mkdir -p "$TMP/.claude/rules"
    : > "$TMP/.claude/rules/normal.md"
    : > "$TMP/.claude/rules/.hidden.md"
    run list_rule_files "$TMP"
    [ "$status" -eq 0 ]
    [[ "$output" == *"normal.md"* ]]
    [[ "$output" != *".hidden.md"* ]]
}

@test "list_rule_files excludes non-md files" {
    mkdir -p "$TMP/.claude/rules"
    : > "$TMP/.claude/rules/keep.md"
    : > "$TMP/.claude/rules/skip.txt"
    : > "$TMP/.claude/rules/skip.yaml"
    run list_rule_files "$TMP"
    [ "$status" -eq 0 ]
    [[ "$output" == *"keep.md"* ]]
    [[ "$output" != *"skip.txt"* ]]
    [[ "$output" != *"skip.yaml"* ]]
}

@test "list_rule_files follows symlinks into rules dir" {
    mkdir -p "$TMP/.claude/rules" "$TMP/external"
    printf 'symlinked\n' > "$TMP/external/linked.md"
    ln -s "$TMP/external/linked.md" "$TMP/.claude/rules/linked.md"
    run list_rule_files "$TMP"
    [ "$status" -eq 0 ]
    [[ "$output" == *"linked.md"* ]]
}

@test "list_rule_files does NOT recurse into subdirectories" {
    mkdir -p "$TMP/.claude/rules/sub"
    : > "$TMP/.claude/rules/top.md"
    : > "$TMP/.claude/rules/sub/nested.md"
    run list_rule_files "$TMP"
    [ "$status" -eq 0 ]
    [[ "$output" == *"top.md"* ]]
    [[ "$output" != *"nested.md"* ]]
}

# ---------------------------------------------------------------------------
# build_project_context — assembly + edge cases
# ---------------------------------------------------------------------------

@test "build_project_context returns empty when neither CLAUDE.md nor rules exist" {
    out="$(build_project_context "$TMP")"
    [ -z "$out" ]
}

@test "build_project_context emits CLAUDE.md alone when rules dir missing" {
    printf 'project root content\n' > "$TMP/CLAUDE.md"
    out="$(build_project_context "$TMP")"
    [[ "$out" == *"CLAUDE.md"*"$RULE_FILE_MARKER_SUFFIX"* ]]
    [[ "$out" == *"project root content"* ]]
}

@test "build_project_context emits rules without CLAUDE.md" {
    mkdir -p "$TMP/.claude/rules"
    printf 'rule body\n' > "$TMP/.claude/rules/r.md"
    out="$(build_project_context "$TMP")"
    [[ "$out" == *"r.md"*"$RULE_FILE_MARKER_SUFFIX"* ]]
    [[ "$out" == *"rule body"* ]]
}

@test "build_project_context never glues last line of one file to next file's marker (B2)" {
    printf 'CLAUDE root\n' > "$TMP/CLAUDE.md"
    mkdir -p "$TMP/.claude/rules"
    # File without trailing newline — most aggressive case for the bug.
    printf 'no trailing newline' > "$TMP/.claude/rules/a.md"
    printf 'b body\n' > "$TMP/.claude/rules/b.md"
    out="$(build_project_context "$TMP")"
    # The marker for b.md must appear on its own line, not glued to "newline".
    # Two newlines between file body and next marker means the marker line
    # starts at column 1.
    [[ "$out" == *"no trailing newline"*$'\n\n'*"b.md"*"$RULE_FILE_MARKER_SUFFIX"* ]]
}

@test "build_project_context output uses caller-supplied marker prefix/suffix" {
    export RULE_FILE_MARKER_PREFIX="<<RULE: "
    export RULE_FILE_MARKER_SUFFIX=">>"
    mkdir -p "$TMP/.claude/rules"
    : > "$TMP/.claude/rules/x.md"
    out="$(build_project_context "$TMP")"
    [[ "$out" == *"<<RULE: x.md>>"* ]]
}

@test "build_project_context emits CLAUDE.md before rule files" {
    printf 'ROOT_CONTENT\n' > "$TMP/CLAUDE.md"
    mkdir -p "$TMP/.claude/rules"
    printf 'RULE_CONTENT\n' > "$TMP/.claude/rules/r.md"
    build_project_context "$TMP" > "$TMP/out"
    root_pos=$(grep -n 'ROOT_CONTENT' "$TMP/out" | head -1 | cut -d: -f1)
    rule_pos=$(grep -n 'RULE_CONTENT' "$TMP/out" | head -1 | cut -d: -f1)
    [ -n "$root_pos" ]
    [ -n "$rule_pos" ]
    [ "$root_pos" -lt "$rule_pos" ]
}

# ---------------------------------------------------------------------------
# validate_rules_compliance — post-validation that defends the schema
# ---------------------------------------------------------------------------

write_result() {
    # Helper: write a fake reviewer result file with a rules_compliance array.
    # Args: path, then JSON array string (or "[]" for empty).
    cat > "$1" <<EOF
{ "structured_output": { "rules_compliance": $2 } }
EOF
}

@test "validate_rules_compliance: perfect match returns no output" {
    write_result "$TMP/r.json" '[
        {"rule_file":"CLAUDE.md","addressed":true,"note":"covered in plan section A.1 about architecture"},
        {"rule_file":"security.md","addressed":true,"note":"covered in plan section A.2 about threat model"}
    ]'
    run validate_rules_compliance "$TMP/r.json" CLAUDE.md security.md
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "validate_rules_compliance: missing entries reported" {
    write_result "$TMP/r.json" '[{"rule_file":"CLAUDE.md","addressed":true,"note":"this is a sufficiently long justification text"}]'
    run validate_rules_compliance "$TMP/r.json" CLAUDE.md security.md plugins.md
    [ "$status" -eq 0 ]
    [[ "$output" == *"missing rule_file entries"* ]]
    [[ "$output" == *"security.md"* ]]
    [[ "$output" == *"plugins.md"* ]]
}

@test "validate_rules_compliance: extra entries reported" {
    write_result "$TMP/r.json" '[
        {"rule_file":"CLAUDE.md","addressed":true,"note":"sufficiently long justification text here"},
        {"rule_file":"made-up.md","addressed":true,"note":"sufficiently long justification text here"}
    ]'
    run validate_rules_compliance "$TMP/r.json" CLAUDE.md
    [ "$status" -eq 0 ]
    [[ "$output" == *"unexpected rule_file entries"* ]]
    [[ "$output" == *"made-up.md"* ]]
}

@test "validate_rules_compliance: short notes (< 30 chars) reported" {
    write_result "$TMP/r.json" '[
        {"rule_file":"CLAUDE.md","addressed":true,"note":"ok"},
        {"rule_file":"security.md","addressed":true,"note":"sufficiently long justification text here"}
    ]'
    run validate_rules_compliance "$TMP/r.json" CLAUDE.md security.md
    [ "$status" -eq 0 ]
    [[ "$output" == *"shorter than 30 chars"* ]]
    [[ "$output" == *"CLAUDE.md"* ]]
}

@test "validate_rules_compliance: empty array reports all expected as missing" {
    write_result "$TMP/r.json" '[]'
    run validate_rules_compliance "$TMP/r.json" CLAUDE.md security.md
    [ "$status" -eq 0 ]
    [[ "$output" == *"missing rule_file entries"* ]]
    [[ "$output" == *"CLAUDE.md"* ]]
    [[ "$output" == *"security.md"* ]]
}

@test "validate_rules_compliance: missing rules_compliance field treated as empty array" {
    cat > "$TMP/r.json" <<EOF
{ "structured_output": { "overall_verdict": "READY_TO_IMPLEMENT" } }
EOF
    run validate_rules_compliance "$TMP/r.json" CLAUDE.md
    [ "$status" -eq 0 ]
    [[ "$output" == *"missing rule_file entries"* ]]
}

@test "validate_rules_compliance: malformed JSON does not crash" {
    printf 'not json at all' > "$TMP/r.json"
    run validate_rules_compliance "$TMP/r.json" CLAUDE.md
    # jq returns 4 on parse error but our 2>/dev/null + // []
    # fallback should keep us alive. The function must always return 0.
    [ "$status" -eq 0 ]
    [[ "$output" == *"missing rule_file entries"* ]]
}

@test "validate_rules_compliance: missing note field treated as empty (short)" {
    write_result "$TMP/r.json" '[{"rule_file":"CLAUDE.md","addressed":true}]'
    run validate_rules_compliance "$TMP/r.json" CLAUDE.md
    [ "$status" -eq 0 ]
    [[ "$output" == *"shorter than 30 chars"* ]]
    [[ "$output" == *"CLAUDE.md"* ]]
}

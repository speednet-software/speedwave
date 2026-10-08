#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/audit-gate.py"
FIXTURES="$REPO_ROOT/_tests/ci/fixtures/audit"

setup() {
  export PYTHON=python3
}

@test "npm extraction reads the GHSA id out of the advisory url" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem npm --in "$FIXTURES/npm-minimatch.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "GHSA-f8q6-p94x-37v3" ]]
  [[ "$output" =~ "GHSA-3ppc-4f35-3m26" ]]
}

@test "npm extraction on a clean report yields no advisories" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem npm --in "$FIXTURES/npm-clean.json"
  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "npm extraction skips a transitive via entry that is a bare package name" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem npm --in "$FIXTURES/npm-transitive-via-string.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "GHSA-c2qf-rxjj-qqgw" ]]
  advisory_count="$(echo "$output" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
  [ "$advisory_count" -eq 1 ]
}

@test "npm extraction drops a moderate advisory under the default high threshold" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem npm --in "$FIXTURES/npm-moderate.json"
  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "npm extraction keeps a moderate advisory when the threshold is lowered" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem npm --in "$FIXTURES/npm-moderate.json" --npm-min-severity moderate
  [ "$status" -eq 0 ]
  [[ "$output" =~ "GHSA-moda-tex4-test" ]]
}

@test "cargo extraction reads the RUSTSEC id" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem cargo --in "$FIXTURES/cargo-quick-xml.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "RUSTSEC-2026-0194" ]]
}

@test "cargo extraction on a clean report yields no advisories" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem cargo --in "$FIXTURES/cargo-clean.json"
  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "diff: advisory present in both base and head is green" {
  run "$PYTHON" "$SCRIPT" diff --exceptions "$FIXTURES/exceptions-empty.json" \
    --base "npm:$FIXTURES/npm-minimatch.json" --head "npm:$FIXTURES/npm-minimatch.json"
  [ "$status" -eq 0 ]
}

@test "diff: advisory only in head is red with the named failure" {
  run "$PYTHON" "$SCRIPT" diff --exceptions "$FIXTURES/exceptions-empty.json" \
    --base "npm:$FIXTURES/npm-clean.json" --head "npm:$FIXTURES/npm-minimatch.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "GHSA-f8q6-p94x-37v3" ]]
  [[ "$output" =~ "PR introduces a dependency with a known vulnerability" ]]
}

@test "diff: advisory only in base (fixed by the PR) is green" {
  run "$PYTHON" "$SCRIPT" diff --exceptions "$FIXTURES/exceptions-empty.json" \
    --base "npm:$FIXTURES/npm-minimatch.json" --head "npm:$FIXTURES/npm-clean.json"
  [ "$status" -eq 0 ]
}

@test "diff: a new advisory covered by a valid exception is green" {
  run "$PYTHON" "$SCRIPT" diff --exceptions "$FIXTURES/exceptions-valid.json" \
    --base "cargo:$FIXTURES/cargo-clean.json" --head "cargo:$FIXTURES/cargo-quick-xml.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "SPEED-9001" ]]
}

@test "diff: a new advisory with an expired exception is red" {
  run "$PYTHON" "$SCRIPT" diff --exceptions "$FIXTURES/exceptions-expired.json" \
    --base "cargo:$FIXTURES/cargo-clean.json" --head "cargo:$FIXTURES/cargo-quick-xml.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "RUSTSEC-2026-0194" ]]
  [[ "$output" =~ "expired" ]]
}

@test "diff: merges multiple base and head reports across ecosystems" {
  run "$PYTHON" "$SCRIPT" diff --exceptions "$FIXTURES/exceptions-empty.json" \
    --base "npm:$FIXTURES/npm-clean.json" --base "cargo:$FIXTURES/cargo-clean.json" \
    --head "npm:$FIXTURES/npm-minimatch.json" --head "cargo:$FIXTURES/cargo-quick-xml.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "GHSA-f8q6-p94x-37v3" ]]
  [[ "$output" =~ "RUSTSEC-2026-0194" ]]
}

@test "absolute: an advisory with no exception is red" {
  run "$PYTHON" "$SCRIPT" absolute --exceptions "$FIXTURES/exceptions-empty.json" \
    --report "cargo:$FIXTURES/cargo-quick-xml.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "RUSTSEC-2026-0194" ]]
}

@test "absolute: an advisory with a valid exception is green" {
  run "$PYTHON" "$SCRIPT" absolute --exceptions "$FIXTURES/exceptions-valid.json" \
    --report "cargo:$FIXTURES/cargo-quick-xml.json"
  [ "$status" -eq 0 ]
}

@test "absolute: an advisory whose exception expired is red" {
  run "$PYTHON" "$SCRIPT" absolute --exceptions "$FIXTURES/exceptions-expired.json" \
    --report "cargo:$FIXTURES/cargo-quick-xml.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "expired" ]]
}

@test "absolute: a clean report is green" {
  run "$PYTHON" "$SCRIPT" absolute --exceptions "$FIXTURES/exceptions-empty.json" \
    --report "cargo:$FIXTURES/cargo-clean.json" --report "npm:$FIXTURES/npm-clean.json"
  [ "$status" -eq 0 ]
}

@test "absolute: a malformed exception entry fails loudly" {
  bad="$BATS_TEST_TMPDIR/bad-exceptions.json"
  echo '[{"id": "RUSTSEC-2026-0194"}]' > "$bad"
  run "$PYTHON" "$SCRIPT" absolute --exceptions "$bad" --report "cargo:$FIXTURES/cargo-clean.json"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "malformed exception entry" ]]
}

@test "absolute writes a markdown advisory list for the schedule issue body" {
  out="$BATS_TEST_TMPDIR/report.md"
  run "$PYTHON" "$SCRIPT" absolute --exceptions "$FIXTURES/exceptions-empty.json" \
    --report "cargo:$FIXTURES/cargo-quick-xml.json" --markdown-out "$out"
  [ "$status" -eq 1 ]
  [ -f "$out" ]
  grep -q "RUSTSEC-2026-0194" "$out"
}

@test "lockfiles-touched: true when package-lock.json changed" {
  run "$PYTHON" "$SCRIPT" lockfiles-touched --changed "$FIXTURES/changed-with-lockfile.json"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
}

@test "lockfiles-touched: true when the root Cargo.lock changed" {
  run "$PYTHON" "$SCRIPT" lockfiles-touched --changed "$FIXTURES/changed-with-root-cargo-lock.json"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
}

@test "lockfiles-touched: false when the diff never touches a lockfile" {
  run "$PYTHON" "$SCRIPT" lockfiles-touched --changed "$FIXTURES/changed-without-lockfile.json"
  [ "$status" -eq 0 ]
  [ "$output" = "false" ]
}

@test "issue-plan: creates when no matching open issue exists" {
  run "$PYTHON" "$SCRIPT" issue-plan --existing "$FIXTURES/issues-none.json" \
    --title "audit-schedule: known vulnerabilities on dev"
  [ "$status" -eq 0 ]
  [ "$output" = '{"action": "create"}' ]
}

@test "issue-plan: updates the existing open issue instead of creating a second one" {
  run "$PYTHON" "$SCRIPT" issue-plan --existing "$FIXTURES/issues-one-open.json" \
    --title "audit-schedule: known vulnerabilities on dev"
  [ "$status" -eq 0 ]
  [ "$output" = '{"action": "update", "number": 42}' ]
}

@test "issue-plan: a closed issue with a matching title does not block a new one" {
  run "$PYTHON" "$SCRIPT" issue-plan --existing "$FIXTURES/issues-one-closed.json" \
    --title "audit-schedule: known vulnerabilities on dev"
  [ "$status" -eq 0 ]
  [ "$output" = '{"action": "create"}' ]
}

@test "issue-plan: two open duplicates still resolve to exactly one issue, the oldest" {
  run "$PYTHON" "$SCRIPT" issue-plan --existing "$FIXTURES/issues-two-open-duplicates.json" \
    --title "audit-schedule: known vulnerabilities on dev"
  [ "$status" -eq 0 ]
  [ "$output" = '{"action": "update", "number": 10}' ]
}

@test "print-npm-default-severity: prints the one severity threshold" {
  run "$PYTHON" "$SCRIPT" print-npm-default-severity
  [ "$status" -eq 0 ]
  [ "$output" = "high" ]
}

@test "extract: an empty cargo audit report fails with a named error, not a traceback" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem cargo --in "$FIXTURES/cargo-empty.json"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "audit-gate: empty cargo audit report" ]]
  [[ "$output" != *"Traceback"* ]]
}

@test "extract: an empty npm audit report fails with a named error, not a traceback" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem npm --in "$FIXTURES/npm-empty.json"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "audit-gate: empty npm audit report" ]]
  [[ "$output" != *"Traceback"* ]]
}

@test "extract: npm audit error object fails loudly instead of being read as a clean report" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem npm --in "$FIXTURES/npm-error.json"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "audit-gate: npm audit reported an error instead of a report" ]]
  [[ "$output" =~ "ENOTFOUND" ]]
}

@test "extract: cargo audit output missing vulnerabilities fails with a named error" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem cargo --in "$FIXTURES/cargo-malformed.json"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "missing 'vulnerabilities'" ]]
}

@test "extract: invalid JSON fails with a named error, not a traceback" {
  run "$PYTHON" "$SCRIPT" extract --ecosystem npm --in "$FIXTURES/npm-not-json.json"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "is not valid JSON" ]]
  [[ "$output" != *"Traceback"* ]]
}

@test "diff: a base side that is an empty report fails loudly instead of silently passing" {
  run "$PYTHON" "$SCRIPT" diff --exceptions "$FIXTURES/exceptions-empty.json" \
    --base "cargo:$FIXTURES/cargo-empty.json" --head "cargo:$FIXTURES/cargo-clean.json"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "audit-gate: empty cargo audit report" ]]
}

@test "absolute: an npm error object fails loudly instead of green" {
  run "$PYTHON" "$SCRIPT" absolute --exceptions "$FIXTURES/exceptions-empty.json" \
    --report "npm:$FIXTURES/npm-error.json"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "audit-gate: npm audit reported an error instead of a report" ]]
}

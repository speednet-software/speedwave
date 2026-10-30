#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

_init_audit_root() {
  FIXTURE="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$FIXTURE/scripts" "$FIXTURE/mcp-servers" "$FIXTURE/desktop/src" "$FIXTURE/desktop/src-tauri" "$FIXTURE/desktop/e2e" "$FIXTURE/mcp-servers/playwright" "$FIXTURE/mcp-servers/office"
  cp "$REPO_ROOT/scripts/audit-issue.sh" "$REPO_ROOT/scripts/audit-run.sh" "$REPO_ROOT/scripts/audit-gate.py" \
    "$REPO_ROOT/scripts/python-tool.sh" "$REPO_ROOT/scripts/build-tool-versions.env" "$FIXTURE/scripts/"
  chmod +x "$FIXTURE"/scripts/*.sh
  echo '{}' >"$FIXTURE/Cargo.lock"
  echo '{}' >"$FIXTURE/desktop/src-tauri/Cargo.lock"
  echo '{}' >"$FIXTURE/mcp-servers/package-lock.json"
  echo '{}' >"$FIXTURE/desktop/src/package-lock.json"
  echo '{}' >"$FIXTURE/package-lock.json"
  echo '{}' >"$FIXTURE/desktop/e2e/package-lock.json"
  echo '{}' >"$FIXTURE/mcp-servers/playwright/package-lock.json"
  echo 'numpy==2.2.2' >"$FIXTURE/mcp-servers/office/requirements.txt"
  echo '[]' >"$FIXTURE/scripts/audit-exceptions.json"

  FAKE_BIN="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKE_BIN"
  TOOL_CACHE="$BATS_TEST_TMPDIR/toolcache"
  export SPEEDWAVE_TOOL_CACHE="$TOOL_CACHE"
  PIP_AUDIT_STUB="$TOOL_CACHE/pip-audit-$(awk -F= '$1 == "PIP_AUDIT_VERSION" { print $2 }' "$REPO_ROOT/scripts/build-tool-versions.env")/bin/pip-audit"
  mkdir -p "$(dirname "$PIP_AUDIT_STUB")"
  GH_LOG="$BATS_TEST_TMPDIR/gh.log"
  : >"$GH_LOG"
}

_stub_clean_tools() {
  cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
echo '{"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}'
EOF
  cat >"$FAKE_BIN/cargo" <<'EOF'
#!/usr/bin/env bash
echo '{"vulnerabilities": {"found": false, "count": 0, "list": []}}'
EOF
  cat >"$PIP_AUDIT_STUB" <<'EOF'
#!/usr/bin/env bash
echo '{"dependencies": [{"name": "numpy", "version": "2.2.2", "vulns": []}], "fixes": []}'
EOF
  chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/cargo" "$PIP_AUDIT_STUB"
}

_stub_red_tools() {
  cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
echo '{"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}'
EOF
  cat >"$FAKE_BIN/cargo" <<'EOF'
#!/usr/bin/env bash
echo '{"vulnerabilities": {"found": true, "count": 1, "list": [{"advisory": {"id": "RUSTSEC-2099-0001", "title": "test advisory", "url": "https://example.test"}}]}}'
EOF
  cat >"$PIP_AUDIT_STUB" <<'EOF'
#!/usr/bin/env bash
echo '{"dependencies": [{"name": "numpy", "version": "2.2.2", "vulns": []}], "fixes": []}'
EOF
  chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/cargo" "$PIP_AUDIT_STUB"
}

_stub_gh() {
  local issues_json="$1"
  cat >"$FAKE_BIN/gh" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$GH_LOG"
case "\$1 \$2" in
  "issue list") cat <<'ISSUES'
$issues_json
ISSUES
    ;;
  "issue create") echo "https://github.com/test/test/issues/999" ;;
  "issue edit") : ;;
  "issue close") : ;;
esac
EOF
  chmod +x "$FAKE_BIN/gh"
}

@test "a clean absolute audit reports nothing and never calls gh" {
  _init_audit_root
  _stub_clean_tools
  _stub_gh '[]'

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "nothing to report" ]]
  [ ! -s "$GH_LOG" ]
}

@test "a red audit with no existing issue creates one" {
  _init_audit_root
  _stub_red_tools
  _stub_gh '[]'

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  grep -q "issue create" "$GH_LOG"
  ! grep -q "issue close" "$GH_LOG"
}

@test "a red audit with one existing open issue updates it instead of creating a second one" {
  _init_audit_root
  _stub_red_tools
  _stub_gh '[{"number": 42, "title": "audit-schedule: known vulnerabilities on dev", "state": "OPEN"}]'

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  grep -q "issue edit 42" "$GH_LOG"
  run grep -cE 'issue (create|close)' "$GH_LOG"
  [ "$output" = "0" ]
}

@test "a red audit with duplicate open issues updates the oldest and closes the rest" {
  _init_audit_root
  _stub_red_tools
  _stub_gh '[{"number": 55, "title": "audit-schedule: known vulnerabilities on dev", "state": "OPEN"}, {"number": 10, "title": "audit-schedule: known vulnerabilities on dev", "state": "OPEN"}]'

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  grep -q "issue edit 10" "$GH_LOG"
  grep -q "issue close 55" "$GH_LOG"
  ! grep -q "issue create" "$GH_LOG"
}

@test "the scheduled audit runs npm audit in all five npm lockfile directories" {
  _init_audit_root
  _stub_clean_tools
  _stub_gh '[]'
  NPM_LOG="$BATS_TEST_TMPDIR/npm.log"
  cat >"$FAKE_BIN/npm" <<EOF
#!/usr/bin/env bash
echo "\$PWD \$*" >>"$NPM_LOG"
echo '{"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}'
EOF
  chmod +x "$FAKE_BIN/npm"

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  for suffix in "" /mcp-servers /mcp-servers/playwright /desktop/src /desktop/e2e; do
    [ "$(grep -c "^$FIXTURE$suffix audit" "$NPM_LOG")" -eq 1 ]
  done
}

@test "the scheduled audit reports an advisory found only in desktop/e2e" {
  _init_audit_root
  _stub_clean_tools
  _stub_gh '[]'
  cp "$REPO_ROOT/_tests/ci/fixtures/audit/npm-minimatch.json" "$BATS_TEST_TMPDIR/npm-vuln.json"
  cat >"$FAKE_BIN/npm" <<EOF
#!/usr/bin/env bash
case "\$PWD" in
  */desktop/e2e) cat "$BATS_TEST_TMPDIR/npm-vuln.json" ;;
  *) echo '{"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}' ;;
esac
EOF
  chmod +x "$FAKE_BIN/npm"

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  grep -q "issue create" "$GH_LOG"
}

@test "the scheduled audit reports an advisory found only in the office Python lock" {
  _init_audit_root
  _stub_clean_tools
  _stub_gh '[]'
  cat >"$PIP_AUDIT_STUB" <<'EOF'
#!/usr/bin/env bash
echo '{"dependencies": [{"name": "pypdf", "version": "6.0.0", "vulns": [{"id": "PYSEC-2099-1", "aliases": [], "description": "test advisory"}]}], "fixes": []}'
exit 1
EOF
  chmod +x "$PIP_AUDIT_STUB"

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  grep -q "issue create" "$GH_LOG"
}

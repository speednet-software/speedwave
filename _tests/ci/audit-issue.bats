#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

_init_audit_root() {
  FIXTURE="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$FIXTURE/scripts" "$FIXTURE/mcp-servers" "$FIXTURE/desktop/src" "$FIXTURE/desktop/src-tauri"
  cp "$REPO_ROOT/scripts/audit-issue.sh" "$REPO_ROOT/scripts/audit-run.sh" "$REPO_ROOT/scripts/audit-gate.py" \
    "$FIXTURE/scripts/"
  chmod +x "$FIXTURE"/scripts/*.sh
  echo '{}' >"$FIXTURE/Cargo.lock"
  echo '{}' >"$FIXTURE/desktop/src-tauri/Cargo.lock"
  echo '{}' >"$FIXTURE/mcp-servers/package-lock.json"
  echo '{}' >"$FIXTURE/desktop/src/package-lock.json"
  echo '[]' >"$FIXTURE/scripts/audit-exceptions.json"

  FAKE_BIN="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKE_BIN"
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
  chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/cargo"
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
  chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/cargo"
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
  _stub_gh '[{"number": 42, "title": "audit-schedule: known vulnerabilities on dev", "state": "open"}]'

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  grep -q "issue edit 42" "$GH_LOG"
  ! grep -q "issue create" "$GH_LOG"
  ! grep -q "issue close" "$GH_LOG"
}

@test "a red audit with duplicate open issues updates the oldest and closes the rest" {
  _init_audit_root
  _stub_red_tools
  _stub_gh '[{"number": 55, "title": "audit-schedule: known vulnerabilities on dev", "state": "open"}, {"number": 10, "title": "audit-schedule: known vulnerabilities on dev", "state": "open"}]'

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' GH_REPO='test/test' ./scripts/audit-issue.sh"
  [ "$status" -eq 0 ]
  grep -q "issue edit 10" "$GH_LOG"
  grep -q "issue close 55" "$GH_LOG"
  ! grep -q "issue create" "$GH_LOG"
}

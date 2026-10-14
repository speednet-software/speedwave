#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

_init_audit_repo() {
  FIXTURE="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$FIXTURE/scripts" "$FIXTURE/mcp-servers" "$FIXTURE/desktop/src" "$FIXTURE/desktop/src-tauri" "$FIXTURE/desktop/e2e" "$FIXTURE/mcp-servers/playwright"
  cp "$REPO_ROOT/scripts/audit-diff.sh" "$REPO_ROOT/scripts/audit-changed-files.sh" \
    "$REPO_ROOT/scripts/audit-run.sh" "$REPO_ROOT/scripts/audit-gate.py" "$FIXTURE/scripts/"
  chmod +x "$FIXTURE"/scripts/*.sh
  echo '{}' >"$FIXTURE/Cargo.lock"
  echo '{}' >"$FIXTURE/desktop/src-tauri/Cargo.lock"
  echo '{}' >"$FIXTURE/mcp-servers/package.json"
  echo '{}' >"$FIXTURE/mcp-servers/package-lock.json"
  echo '{}' >"$FIXTURE/desktop/src/package.json"
  echo '{}' >"$FIXTURE/desktop/src/package-lock.json"
  echo '{}' >"$FIXTURE/package.json"
  echo '{}' >"$FIXTURE/package-lock.json"
  echo '{}' >"$FIXTURE/desktop/e2e/package.json"
  echo '{}' >"$FIXTURE/desktop/e2e/package-lock.json"
  echo '{}' >"$FIXTURE/mcp-servers/playwright/package.json"
  echo '{}' >"$FIXTURE/mcp-servers/playwright/package-lock.json"
  echo '[]' >"$FIXTURE/scripts/audit-exceptions.json"
  echo "readme" >"$FIXTURE/README.md"
  git -C "$FIXTURE" init -q
  git -C "$FIXTURE" config user.email ci-test-no-reply.invalid
  git -C "$FIXTURE" config user.name test
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m base
  BASE="$(git -C "$FIXTURE" rev-parse HEAD)"

  FAKE_BIN="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKE_BIN"
  cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
echo '{"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}'
EOF
  cat >"$FAKE_BIN/cargo" <<'EOF'
#!/usr/bin/env bash
file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$file" ] && grep -q VULN-MARKER "$file" 2>/dev/null; then
  echo '{"vulnerabilities": {"found": true, "count": 1, "list": [{"advisory": {"id": "RUSTSEC-2099-0001", "title": "test advisory", "url": "https://example.test"}}]}}'
else
  echo '{"vulnerabilities": {"found": false, "count": 0, "list": []}}'
fi
EOF
  chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/cargo"
}

@test "a diff that never touches a lockfile is green without running an audit tool" {
  _init_audit_repo
  echo "more readme" >>"$FIXTURE/README.md"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head

  run bash -c "cd '$FIXTURE' && AUDIT_BASE_SHA='$BASE' ./scripts/audit-diff.sh"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "green without auditing" ]]
}

@test "a diff that touches a lockfile but introduces no new advisory is green" {
  _init_audit_repo
  echo '{"changed": true}' >"$FIXTURE/Cargo.lock"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' AUDIT_BASE_SHA='$BASE' ./scripts/audit-diff.sh"
  [ "$status" -eq 0 ]
}

@test "a diff that introduces a new advisory in the PR head is red with the named failure" {
  _init_audit_repo
  echo 'VULN-MARKER' >"$FIXTURE/Cargo.lock"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' AUDIT_BASE_SHA='$BASE' ./scripts/audit-diff.sh"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "RUSTSEC-2099-0001" ]]
  [[ "$output" =~ "PR introduces a dependency with a known vulnerability" ]]
}

@test "a PR touching only desktop/e2e/package-lock.json audits all five npm lockfiles on base and head" {
  _init_audit_repo
  NPM_LOG="$BATS_TEST_TMPDIR/npm.log"
  cat >"$FAKE_BIN/npm" <<EOF
#!/usr/bin/env bash
echo "\$PWD \$*" >>"$NPM_LOG"
echo '{"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}'
EOF
  chmod +x "$FAKE_BIN/npm"
  echo '{"changed": true}' >"$FIXTURE/desktop/e2e/package-lock.json"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' AUDIT_BASE_SHA='$BASE' ./scripts/audit-diff.sh"
  [ "$status" -eq 0 ]
  for suffix in "" /mcp-servers /mcp-servers/playwright /desktop/src /desktop/e2e; do
    [ "$(grep -c "^$FIXTURE$suffix audit" "$NPM_LOG")" -eq 1 ]
    [ "$(grep -c "/base$suffix audit" "$NPM_LOG")" -eq 1 ]
  done
  run grep -c -e '--omit' "$NPM_LOG"
  [ "$output" = "0" ]
}

@test "a PR touching only the root package-lock.json is not skipped" {
  _init_audit_repo
  echo '{"changed": true}' >"$FIXTURE/package-lock.json"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head

  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' AUDIT_BASE_SHA='$BASE' ./scripts/audit-diff.sh"
  [ "$status" -eq 0 ]
  [[ ! "$output" =~ "green without auditing" ]]
}

@test "a change to any lockfile audit-run.sh lists triggers the audit" {
  _init_audit_repo
  while read -r _ _ lockfile; do
    git -C "$FIXTURE" reset -q --hard "$BASE"
    echo '{"changed": true}' >"$FIXTURE/$lockfile"
    git -C "$FIXTURE" add -A
    git -C "$FIXTURE" commit -q -m head
    run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' AUDIT_BASE_SHA='$BASE' ./scripts/audit-diff.sh"
    [ "$status" -eq 0 ]
    [[ ! "$output" =~ "green without auditing" ]]
  done < <("$REPO_ROOT/scripts/audit-run.sh" --list)
}

@test "a lockfile outside audit-run.sh's list does not trigger the audit" {
  _init_audit_repo
  mkdir -p "$FIXTURE/containers/proxy"
  echo '{}' >"$FIXTURE/containers/proxy/Cargo.lock"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head
  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' AUDIT_BASE_SHA='$BASE' ./scripts/audit-diff.sh"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "green without auditing" ]]
}

@test "the audited targets come from audit-run.sh --list: a removed target is no longer audited or fetched" {
  _init_audit_repo
  sed -i.bak '/^npm-e2e /d' "$FIXTURE/scripts/audit-run.sh"
  rm "$FIXTURE/desktop/e2e/package.json"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m base2
  BASE="$(git -C "$FIXTURE" rev-parse HEAD)"
  echo '{"changed": true}' >"$FIXTURE/Cargo.lock"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head
  run bash -c "cd '$FIXTURE' && PATH='$FAKE_BIN:$PATH' AUDIT_BASE_SHA='$BASE' ./scripts/audit-diff.sh"
  [ "$status" -eq 0 ]
}

#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/audit-run.sh"

setup() {
  FAKE_BIN="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKE_BIN"
  ROOT="$BATS_TEST_TMPDIR/root"
  mkdir -p "$ROOT/desktop/src-tauri" "$ROOT/mcp-servers" "$ROOT/desktop/src" "$ROOT/desktop/e2e" "$ROOT/mcp-servers/playwright"
  : >"$ROOT/Cargo.lock"
  : >"$ROOT/desktop/src-tauri/Cargo.lock"
  : >"$ROOT/mcp-servers/package-lock.json"
  : >"$ROOT/desktop/src/package-lock.json"
  : >"$ROOT/package-lock.json"
  : >"$ROOT/desktop/e2e/package-lock.json"
  : >"$ROOT/mcp-servers/playwright/package-lock.json"
}

_stub_cargo_ok() {
  cat >"$FAKE_BIN/cargo" <<'EOF'
#!/usr/bin/env bash
echo '{"vulnerabilities": {"found": false, "count": 0, "list": []}}'
EOF
  chmod +x "$FAKE_BIN/cargo"
}

_stub_cargo_broken() {
  cat >"$FAKE_BIN/cargo" <<'EOF'
#!/usr/bin/env bash
echo "error: failed to fetch advisory database" >&2
exit 1
EOF
  chmod +x "$FAKE_BIN/cargo"
}

_stub_npm_ok() {
  cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
echo '{"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}'
EOF
  chmod +x "$FAKE_BIN/npm"
}

_stub_npm_recording() {
  NPM_LOG="$BATS_TEST_TMPDIR/npm.log"
  : >"$NPM_LOG"
  cat >"$FAKE_BIN/npm" <<EOF
#!/usr/bin/env bash
echo "\$PWD \$*" >>"$NPM_LOG"
echo '{"vulnerabilities": {}, "metadata": {"vulnerabilities": {"total": 0}}}'
EOF
  chmod +x "$FAKE_BIN/npm"
}

_stub_npm_broken() {
  cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm error: getaddrinfo ENOTFOUND registry.npmjs.org" >&2
exit 1
EOF
  chmod +x "$FAKE_BIN/npm"
}

@test "cargo-root: writes the cargo audit JSON for the given root" {
  _stub_cargo_ok
  out="$BATS_TEST_TMPDIR/out.json"
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" cargo-root "$out" "$ROOT"
  [ "$status" -eq 0 ]
  grep -q '"vulnerabilities"' "$out"
}

@test "cargo-desktop: a cargo-audit that fails with no stdout fails loudly, named error" {
  _stub_cargo_broken
  out="$BATS_TEST_TMPDIR/out.json"
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" cargo-desktop "$out" "$ROOT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "audit-run: cargo audit produced no output" ]]
  [[ "$output" =~ "failed to fetch advisory database" ]]
}

@test "npm-mcp: writes the npm audit JSON for the given root" {
  _stub_npm_ok
  out="$BATS_TEST_TMPDIR/out.json"
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" npm-mcp "$out" "$ROOT"
  [ "$status" -eq 0 ]
  grep -q '"vulnerabilities"' "$out"
}

@test "npm-desktop: an npm that fails with no stdout fails loudly, named error" {
  _stub_npm_broken
  out="$BATS_TEST_TMPDIR/out.json"
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" npm-desktop "$out" "$ROOT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "audit-run: npm audit produced no output" ]]
  [[ "$output" =~ "ENOTFOUND" ]]
}

@test "unknown target fails with usage" {
  out="$BATS_TEST_TMPDIR/out.json"
  run "$SCRIPT" bogus-target "$out"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unknown target" ]]
}

@test "ROOT defaults to the repository root when omitted" {
  _stub_npm_ok
  out="$BATS_TEST_TMPDIR/out.json"
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" npm-mcp "$out"
  [ "$status" -eq 0 ]
  grep -q '"vulnerabilities"' "$out"
}

@test "npm-root: audits the repository root lockfile directory" {
  _stub_npm_recording
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" npm-root "$BATS_TEST_TMPDIR/out.json" "$ROOT"
  [ "$status" -eq 0 ]
  [ "$(cut -d' ' -f1 "$NPM_LOG")" = "$ROOT" ]
}

@test "npm-e2e: audits desktop/e2e" {
  _stub_npm_recording
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" npm-e2e "$BATS_TEST_TMPDIR/out.json" "$ROOT"
  [ "$status" -eq 0 ]
  [ "$(cut -d' ' -f1 "$NPM_LOG")" = "$ROOT/desktop/e2e" ]
}

@test "npm-playwright: audits mcp-servers/playwright" {
  _stub_npm_recording
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" npm-playwright "$BATS_TEST_TMPDIR/out.json" "$ROOT"
  [ "$status" -eq 0 ]
  [ "$(cut -d' ' -f1 "$NPM_LOG")" = "$ROOT/mcp-servers/playwright" ]
}

@test "every npm target audits devDependencies too, never passing --omit=dev" {
  _stub_npm_recording
  for target in npm-root npm-mcp npm-desktop npm-e2e npm-playwright; do
    PATH="$FAKE_BIN:$PATH" run "$SCRIPT" "$target" "$BATS_TEST_TMPDIR/$target.json" "$ROOT"
    [ "$status" -eq 0 ]
  done
  [ "$(wc -l <"$NPM_LOG")" -eq 5 ]
  run grep -c -e '--omit' "$NPM_LOG"
  [ "$output" = "0" ]
}

@test "npm targets keep the high threshold and lockfile-only mode" {
  _stub_npm_recording
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT" npm-e2e "$BATS_TEST_TMPDIR/out.json" "$ROOT"
  [ "$status" -eq 0 ]
  [[ "$(cat "$NPM_LOG")" =~ "audit --audit-level=high --package-lock-only --json" ]]
}

@test "--list prints one target, kind and lockfile path per line" {
  run "$SCRIPT" --list
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "cargo-root cargo Cargo.lock" ]
  [[ "$output" =~ "npm-e2e npm desktop/e2e/package-lock.json" ]]
  [ "${#lines[@]}" -eq 7 ]
}

@test "every listed target runs against its listed lockfile directory" {
  _stub_npm_recording
  _stub_cargo_ok
  while read -r target kind lockfile; do
    PATH="$FAKE_BIN:$PATH" run "$SCRIPT" "$target" "$BATS_TEST_TMPDIR/$target.json" "$ROOT"
    [ "$status" -eq 0 ]
  done < <("$SCRIPT" --list)
  [ "$(cut -d' ' -f1 "$NPM_LOG" | sort)" = "$(printf '%s\n' "$ROOT" "$ROOT/desktop/e2e" "$ROOT/desktop/src" "$ROOT/mcp-servers" "$ROOT/mcp-servers/playwright" | sort)" ]
}

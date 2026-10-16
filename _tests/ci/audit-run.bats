#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/audit-run.sh"

setup() {
  FAKE_BIN="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKE_BIN"
  ROOT="$BATS_TEST_TMPDIR/root"
  mkdir -p "$ROOT/desktop/src-tauri" "$ROOT/mcp-servers" "$ROOT/desktop/src"
  : >"$ROOT/Cargo.lock"
  : >"$ROOT/desktop/src-tauri/Cargo.lock"
  : >"$ROOT/mcp-servers/package-lock.json"
  : >"$ROOT/desktop/src/package-lock.json"
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

#!/usr/bin/env bats
# Tests for scripts/verify-release-assets.sh using a gh shim on PATH.
# All fixtures hardcode version 0.8.1 / tag v0.8.1 / repo test/repo / RID 12345.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/verify-release-assets.sh"
FIXTURES="$REPO_ROOT/_tests/desktop/fixtures/verify-release-assets"

_install_gh_shim() {
  cat > "$BATS_SHIM_BIN/gh" <<'SHIM'
#!/usr/bin/env bash
# gh shim — accepts exactly the two command shapes used by verify-release-assets.sh.
# Increments a call counter on every invocation for idempotency testing.
COUNT_FILE="${BATS_TEST_TMPDIR}/gh_call_count"
count=0
[ -f "$COUNT_FILE" ] && count=$(cat "$COUNT_FILE")
echo $((count + 1)) > "$COUNT_FILE"

cmd="$1"

if [ "$cmd" = "api" ]; then
  # Expected: gh api "repos/<REPO>/releases/<RID>/assets" --jq '.[].name'
  endpoint="$2"
  expected_endpoint="repos/${REPO}/releases/${RID}/assets"
  if [ "$endpoint" != "$expected_endpoint" ]; then
    echo "shim: unexpected api endpoint: $endpoint (expected: $expected_endpoint)" >&2
    exit 2
  fi
  # Find --jq flag
  jq_val=""
  i=3
  while [ $i -le $# ]; do
    eval "arg=\${$i}"
    if [ "$arg" = "--jq" ]; then
      j=$((i + 1))
      eval "jq_val=\${$j}"
      break
    fi
    i=$((i + 1))
  done
  if [ "$jq_val" != '.[].name' ]; then
    echo "shim: unexpected --jq value: $jq_val" >&2
    exit 2
  fi
  if [ -z "$FIXTURE_ASSETS_JSON" ]; then
    echo "shim: FIXTURE_ASSETS_JSON not set" >&2
    exit 2
  fi
  jq -r '.[].name' "$FIXTURE_ASSETS_JSON"
  exit $?

elif [ "$cmd" = "release" ]; then
  subcmd="$2"
  if [ "$subcmd" != "download" ]; then
    echo "shim: unexpected release subcommand: $subcmd" >&2
    exit 2
  fi
  # Parse: gh release download <TAG> --repo <REPO> --pattern <NAME> --dir <DIR>
  tag=""
  repo_val=""
  pattern_val=""
  dir_val=""
  i=3
  while [ $i -le $# ]; do
    eval "arg=\${$i}"
    case "$arg" in
      --repo)
        j=$((i + 1)); eval "repo_val=\${$j}"; i=$((i + 2));;
      --pattern)
        j=$((i + 1)); eval "pattern_val=\${$j}"; i=$((i + 2));;
      --dir)
        j=$((i + 1)); eval "dir_val=\${$j}"; i=$((i + 2));;
      *)
        if [ -z "$tag" ]; then tag="$arg"; fi
        i=$((i + 1));;
    esac
  done

  if [ "$tag" != "$TAG_NAME" ]; then
    echo "shim: unexpected tag: $tag (expected: $TAG_NAME)" >&2
    exit 2
  fi
  if [ "$repo_val" != "$REPO" ]; then
    echo "shim: unexpected repo: $repo_val (expected: $REPO)" >&2
    exit 2
  fi
  if [ -z "$pattern_val" ]; then
    echo "shim: missing --pattern" >&2
    exit 2
  fi
  if [ -z "$dir_val" ]; then
    echo "shim: missing --dir" >&2
    exit 2
  fi

  if [ "$pattern_val" = "latest.json" ]; then
    if [ -z "$FIXTURE_LATEST_JSON" ]; then
      echo "shim: FIXTURE_LATEST_JSON not set" >&2
      exit 2
    fi
    cp "$FIXTURE_LATEST_JSON" "$dir_val/latest.json"
    exit 0
  fi

  # .sig file handling
  if [[ "$pattern_val" == *.sig ]]; then
    outfile="$dir_val/$pattern_val"
    if [ -n "$EMPTY_SIG_NAME" ] && [ "$pattern_val" = "$EMPTY_SIG_NAME" ]; then
      # Write zero-byte file for empty-sig test
      : > "$outfile"
    else
      printf 'signature-bytes' > "$outfile"
    fi
    exit 0
  fi

  # Unknown pattern
  echo "shim: unexpected pattern: $pattern_val" >&2
  exit 2

else
  echo "shim: unexpected invocation: $*" >&2
  exit 2
fi
SHIM
  chmod +x "$BATS_SHIM_BIN/gh"
}

setup() {
  export VERSION=0.8.1
  export REPO=test/repo
  export RID=12345
  export TAG_NAME=v0.8.1
  export GH_TOKEN=fake-token
  export BATS_SHIM_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BATS_SHIM_BIN"
  export PATH="$BATS_SHIM_BIN:$PATH"
  export FIXTURE_ASSETS_JSON=""
  export FIXTURE_LATEST_JSON=""
  export EMPTY_SIG_NAME=""
  _install_gh_shim
}

# ── Case 1: Happy path ───────────────────────────────────────────────────────

@test "happy path: all assets present and latest.json valid" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

# ── Case 2: Missing latest.json ──────────────────────────────────────────────

@test "missing latest.json asset fails with expected message" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-missing-latest.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "missing release asset: latest.json" ]]
}

# ── Case 3: Missing macOS .sig ───────────────────────────────────────────────

@test "missing macOS Apple Silicon sig fails with exact sig name" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-missing-macos-sig.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Speedwave_0.8.1_macOS_Apple_Silicon.app.tar.gz.sig" ]]
}

# ── Case 4: Missing MSI .sig ─────────────────────────────────────────────────

@test "missing MSI sig fails with exact sig name" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-missing-msi-sig.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Speedwave_0.8.1_x64_en-US.msi.sig" ]]
}

# ── Case 5: Empty latest.json version ────────────────────────────────────────

@test "empty latest.json version fails with version mismatch message" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-empty-version.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "version '' != expected '0.8.1'" ]]
}

# ── Case 6: Invalid JSON in latest.json ──────────────────────────────────────

@test "invalid JSON in latest.json fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-invalid.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

# ── Case 7: Empty .sig file ───────────────────────────────────────────────────

@test "empty sig file fails with 'signature file empty' message" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  export EMPTY_SIG_NAME="Speedwave_0.8.1_macOS_Intel.app.tar.gz.sig"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "signature file empty:" ]]
}

# ── Case 8: Idempotency ───────────────────────────────────────────────────────

@test "script is idempotent: two successful runs produce consistent gh call counts" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"

  # First run
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  count_after_first=$(cat "$BATS_TEST_TMPDIR/gh_call_count")

  # Reset counter
  echo 0 > "$BATS_TEST_TMPDIR/gh_call_count"

  # Second run
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  count_after_second=$(cat "$BATS_TEST_TMPDIR/gh_call_count")

  # Both runs must make the same number of gh calls (no cached state divergence)
  [ "$count_after_first" -eq "$count_after_second" ]
  # Both counts must be > 0 (gh was actually called)
  [ "$count_after_first" -gt 0 ]
}

# ── Case 9: v prefix in latest.json version ───────────────────────────────────

@test "v-prefixed version in latest.json rejected (bare semver required)" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-v-prefix.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "version 'v0.8.1' != expected '0.8.1'" ]]
}

# ── Case 10: latest.json missing 'notes' field ────────────────────────────────

@test "latest.json missing 'notes' field fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-missing-notes.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json missing field: notes" ]]
}

# ── Case 11: empty platforms dict ─────────────────────────────────────────────

@test "latest.json empty platforms dict fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-empty-platforms.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json platforms is empty" ]]
}

# ── Case 12: missing required platform key ────────────────────────────────────

@test "latest.json missing required platform key fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-missing-platform-key.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json missing required platform key: darwin-x86_64" ]]
}

# ── Case 13: empty platform signature ─────────────────────────────────────────

@test "latest.json empty platform signature fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-empty-signature.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json platforms.darwin-aarch64.signature is empty" ]]
}

# ── Case 14: wrong URL prefix on platform entry ───────────────────────────────

@test "latest.json wrong URL prefix fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-wrong-url-prefix.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "does not start with https://github.com/test/repo/releases/" ]]
}

# ── Case 15: empty platform url ───────────────────────────────────────────────

@test "latest.json empty platform url fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-empty-url.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json platforms.darwin-aarch64.url is empty" ]]
}

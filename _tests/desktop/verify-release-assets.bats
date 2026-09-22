#!/usr/bin/env bats

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


@test "happy path: all assets present and latest.json valid" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}


@test "missing latest.json asset fails with expected message" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-missing-latest.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "missing release asset: latest.json" ]]
}


@test "missing macOS Apple Silicon sig fails with exact sig name" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-missing-macos-sig.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Speedwave_0.8.1_macOS_Apple_Silicon.app.tar.gz.sig" ]]
}


@test "missing MSI sig fails with exact sig name" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-missing-msi-sig.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Speedwave_0.8.1_x64_en-US.msi.sig" ]]
}


@test "empty latest.json version fails with version mismatch message" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-empty-version.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "version '' != expected '0.8.1'" ]]
}


@test "invalid JSON in latest.json fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-invalid.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}


@test "empty sig file fails with 'signature file empty' message" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"
  export EMPTY_SIG_NAME="Speedwave_0.8.1_macOS_Intel.app.tar.gz.sig"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "signature file empty:" ]]
}


@test "script is idempotent: two successful runs produce consistent gh call counts" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-happy.json"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  count_after_first=$(cat "$BATS_TEST_TMPDIR/gh_call_count")

  echo 0 > "$BATS_TEST_TMPDIR/gh_call_count"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  count_after_second=$(cat "$BATS_TEST_TMPDIR/gh_call_count")

  [ "$count_after_first" -eq "$count_after_second" ]
  [ "$count_after_first" -gt 0 ]
}


@test "v-prefixed version in latest.json rejected (bare semver required)" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-v-prefix.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "version 'v0.8.1' != expected '0.8.1'" ]]
}


@test "latest.json missing 'notes' field fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-missing-notes.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json missing field: notes" ]]
}


@test "latest.json empty platforms dict fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-empty-platforms.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json platforms is empty" ]]
}


@test "latest.json missing required platform key fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-missing-platform-key.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json missing required platform key: darwin-x86_64" ]]
}


@test "latest.json empty platform signature fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-empty-signature.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json platforms.darwin-aarch64.signature is empty" ]]
}


@test "latest.json wrong URL prefix fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-wrong-url-prefix.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "does not start with https://api.github.com/repos/test/repo/releases/assets/" ]]
}


@test "latest.json browser download URL rejected (API asset URL required)" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-browser-download-url.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "platforms.darwin-x86_64.url does not start with" ]]
}


@test "latest.json empty platform url fails" {
  export FIXTURE_ASSETS_JSON="$FIXTURES/assets-happy.json"
  export FIXTURE_LATEST_JSON="$FIXTURES/latest-empty-url.json"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "latest.json platforms.darwin-aarch64.url is empty" ]]
}


@test "unset VERSION fails with required-message" {
  unset VERSION
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "VERSION required" ]]
}


@test "empty VERSION fails with required-message" {
  export VERSION=""
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "VERSION required" ]]
}


@test "invalid VERSION format fails" {
  export VERSION="0.8"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Invalid VERSION format" ]]
}


@test "invalid REPO format fails" {
  export REPO="badrepo"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Invalid REPO format" ]]
}


@test "invalid TAG_NAME format fails" {
  export TAG_NAME="0.8.1"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Invalid TAG_NAME format" ]]
}


@test "unset RID fails with required-message" {
  unset RID
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "RID required" ]]
}


@test "empty RID fails with required-message" {
  export RID=""
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "RID required" ]]
}


@test "invalid RID format fails" {
  export RID="abc"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Invalid RID format" ]]
}


@test "unset REPO fails with required-message" {
  unset REPO
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "REPO required" ]]
}


@test "empty REPO fails with required-message" {
  export REPO=""
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "REPO required" ]]
}

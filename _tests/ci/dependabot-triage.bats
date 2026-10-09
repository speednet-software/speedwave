#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
TRIAGE="$REPO_ROOT/scripts/dependabot-triage.py"

setup() {
  FAKE_BIN="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKE_BIN"
  GH_LOG="$BATS_TEST_TMPDIR/gh.log"
  ALERTS_FILE="$BATS_TEST_TMPDIR/alerts.jsonl"
  EXISTING_FILE="$BATS_TEST_TMPDIR/existing"
  : >"$GH_LOG"
  : >"$ALERTS_FILE"
  : >"$EXISTING_FILE"
  cat >"$FAKE_BIN/gh" <<EOF
#!/usr/bin/env bash
printf 'token=%s %s\n' "\$GH_TOKEN" "\$*" >> "$GH_LOG"
case "\$1 \$2" in
  "api "*) cat "$ALERTS_FILE" ;;
  "issue list") cat "$EXISTING_FILE" ;;
  "issue create") echo "https://github.com/test/test/issues/7" ;;
esac
EOF
  chmod +x "$FAKE_BIN/gh"

  export PATH="$FAKE_BIN:$PATH"
  export GH_TOKEN="workflow-token"
  export ALERTS_TOKEN="alerts-token"
  export GH_REPO="test/test"
  export PR_NUMBER="42"
  export PR_URL="https://github.com/test/test/pull/42"
  export UPDATED_DEPENDENCIES='[{"dependencyName":"serde","directory":"/","updateType":"version-update:semver-patch"}]'
}

_refute_log() {
  if grep -q "$1" "$GH_LOG"; then
    echo "unexpected gh call matching: $1"
    return 1
  fi
}

_alert() {
  local number="$1" package="$2" manifest="$3" scope="$4" cvss="$5" epss="$6"
  printf '{"number":%s,"html_url":"https://github.com/test/test/security/dependabot/%s","dependency":{"package":{"name":"%s"},"manifest_path":"%s","scope":"%s"},"security_advisory":{"ghsa_id":"GHSA-aaaa-bbbb-%04d","cve_id":"CVE-2026-%s","summary":"test advisory","cvss_severities":{"cvss_v3":{"score":%s},"cvss_v4":{"score":null}},"epss":{"percentage":0.1,"percentile":%s}}}\n' \
    "$number" "$number" "$package" "$manifest" "$scope" "$number" "$number" "$cvss" "$epss" >>"$ALERTS_FILE"
}

@test "a version update with no open alert only turns on auto-merge" {
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  _refute_log "issue create"
  _refute_log "add-label"
  grep -q "pr merge 42 --repo test/test --squash --auto" "$GH_LOG"
}

@test "alerts are read with the alerts token, writes with the workflow token" {
  _alert 1 serde Cargo.lock runtime 9.8 0.1
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  grep -q "^token=alerts-token api --paginate repos/test/test/dependabot/alerts?state=open" "$GH_LOG"
  grep -q "^token=workflow-token issue create" "$GH_LOG"
  grep -q "^token=workflow-token pr edit 42" "$GH_LOG"
}

@test "a runtime alert with CVSS 9 or more files an issue and labels the PR security" {
  _alert 1 serde Cargo.lock runtime 9.0 0.1
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  grep -q "issue create --repo test/test --title Dependabot: GHSA-aaaa-bbbb-0001 in serde (Cargo.lock) --label dependencies" "$GH_LOG"
  grep -q "pr edit 42 --repo test/test --add-label security" "$GH_LOG"
}

@test "a runtime alert below CVSS 9 with a low EPSS files an issue without the security label" {
  _alert 1 serde Cargo.lock runtime 8.9 0.94
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  grep -q "issue create" "$GH_LOG"
  _refute_log "add-label"
  grep -q "pr merge 42" "$GH_LOG"
}

@test "a runtime alert at the EPSS threshold is critical whatever its CVSS" {
  _alert 1 serde Cargo.lock runtime 5.0 0.95
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  grep -q "add-label security" "$GH_LOG"
}

@test "an EPSS percentile on the 0-100 scale is read as a percent" {
  _alert 1 serde Cargo.lock runtime 5.0 96
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  grep -q "add-label security" "$GH_LOG"
}

@test "an EPSS percentile on the 0-100 scale below 95 is not critical" {
  _alert 1 serde Cargo.lock runtime 5.0 50
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  _refute_log "add-label"
}

@test "a development-scope alert is never critical" {
  _alert 1 serde Cargo.lock development 10.0 0.99
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  grep -q "issue create" "$GH_LOG"
  _refute_log "add-label"
}

@test "an alert for the same package in another directory is not this PR's" {
  _alert 1 serde desktop/src-tauri/Cargo.lock runtime 9.8 0.99
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  _refute_log "issue create"
  _refute_log "add-label"
}

@test "a dependency without a directory matches the package in any manifest" {
  export UPDATED_DEPENDENCIES='[{"dependencyName":"serde","directory":"","updateType":"version-update:semver-patch"}]'
  _alert 1 serde desktop/src-tauri/Cargo.lock runtime 9.8 0.1
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  grep -q "issue create" "$GH_LOG"
}

@test "an issue that already exists for the advisory is not filed again" {
  _alert 1 serde Cargo.lock runtime 9.8 0.1
  echo 12 >"$EXISTING_FILE"
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  _refute_log "issue create"
  [[ "$output" == *"already exists: #12"* ]]
  grep -q "add-label security" "$GH_LOG"
}

@test "two dependencies fixing one alert file one issue" {
  export UPDATED_DEPENDENCIES='[{"dependencyName":"serde","directory":"/","updateType":"version-update:semver-patch"},{"dependencyName":"serde","directory":"/","updateType":"version-update:semver-minor"}]'
  _alert 1 serde Cargo.lock runtime 9.8 0.1
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  [ "$(grep -c "issue create" "$GH_LOG")" -eq 1 ]
}

@test "a major update leaves auto-merge off and names the package" {
  export UPDATED_DEPENDENCIES='[{"dependencyName":"vitest","directory":"/desktop/src","updateType":"version-update:semver-major"},{"dependencyName":"serde","directory":"/","updateType":"version-update:semver-patch"}]'
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  _refute_log "pr merge"
  [[ "$output" == *"auto-merge not enabled: vitest"* ]]
}

@test "the issue body carries the scores, the verdict and both links" {
  _alert 1 serde Cargo.lock runtime 9.8 0.5
  run python3 "$TRIAGE"
  [ "$status" -eq 0 ]
  grep -q "CVSS: 9.8" "$GH_LOG"
  grep -q "EPSS percentile: 50.0" "$GH_LOG"
  grep -q "Verdict: critical" "$GH_LOG"
  grep -q "Fix PR: https://github.com/test/test/pull/42" "$GH_LOG"
  grep -q "Alert: https://github.com/test/test/security/dependabot/1" "$GH_LOG"
}

@test "a missing alerts token fails before any GitHub call and names the secret" {
  unset ALERTS_TOKEN
  run python3 "$TRIAGE"
  [ "$status" -ne 0 ]
  [[ "$output" == *"ALERTS_TOKEN is not set"* ]]
  [ ! -s "$GH_LOG" ]
}

@test "a failing gh call fails the triage" {
  cat >"$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
echo "HTTP 403: Resource not accessible" >&2
exit 1
EOF
  run python3 "$TRIAGE"
  [ "$status" -ne 0 ]
  [[ "$output" == *"HTTP 403"* ]]
}

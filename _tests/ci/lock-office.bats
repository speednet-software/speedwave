#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/lock-office.sh"

setup() {
  FAKE_BIN="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$FAKE_BIN"
  ENGINE_LOG="$BATS_TEST_TMPDIR/engine.log"
  cat >"$FAKE_BIN/fake-engine" <<EOT
#!/usr/bin/env bash
echo "\$*" >>"$ENGINE_LOG"
EOT
  chmod +x "$FAKE_BIN/fake-engine"
}

@test "runs the lock inside the office runtime base image taken from the Dockerfile" {
  base="$(sed -n 's/^FROM \(node:24-bookworm-slim@sha256:[0-9a-f]*\)$/\1/p' "$REPO_ROOT/mcp-servers/office/Dockerfile")"
  [ -n "$base" ]
  CONTAINER_ENGINE="$FAKE_BIN/fake-engine" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$(cat "$ENGINE_LOG")" =~ "run --rm -v $REPO_ROOT:$REPO_ROOT $base bash $REPO_ROOT/scripts/lock-office.sh --in-container" ]]
}

@test "picks the first container engine on PATH when CONTAINER_ENGINE is unset" {
  cp "$FAKE_BIN/fake-engine" "$FAKE_BIN/podman"
  PATH="$FAKE_BIN:$PATH" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$(cat "$ENGINE_LOG")" =~ "run --rm" ]]
}

@test "fails with a named error when no container engine exists" {
  empty="$BATS_TEST_TMPDIR/empty"
  mkdir -p "$empty"
  PATH="$empty:/usr/bin:/bin" run env -u CONTAINER_ENGINE "$BASH" "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "lock-office: no container engine found" ]]
}

@test "in the container it installs uv and compiles the hashed lock next to requirements.in" {
  mkdir -p "$BATS_TEST_TMPDIR/repo/scripts" "$BATS_TEST_TMPDIR/repo/mcp-servers/office"
  cp "$SCRIPT" "$BATS_TEST_TMPDIR/repo/scripts/lock-office.sh"
  echo "numpy==2.2.2" >"$BATS_TEST_TMPDIR/repo/mcp-servers/office/requirements.in"
  CALLS="$BATS_TEST_TMPDIR/calls.log"
  cat >"$FAKE_BIN/apt-get" <<EOT
#!/usr/bin/env bash
echo "apt-get \$*" >>"$CALLS"
EOT
  cat >"$FAKE_BIN/python3" <<EOT
#!/usr/bin/env bash
venv="\$3"
mkdir -p "\$venv/bin"
cat >"\$venv/bin/pip" <<'PIP'
#!/usr/bin/env bash
echo "pip \$*" >>"$CALLS"
PIP
cat >"\$venv/bin/uv" <<'COMPILE'
#!/usr/bin/env bash
echo "uv \$* in \$PWD" >>"$CALLS"
echo "numpy==2.2.2 --hash=sha256:00" >requirements.txt
COMPILE
chmod +x "\$venv/bin/pip" "\$venv/bin/uv"
EOT
  cat >"$FAKE_BIN/chown" <<EOT
#!/usr/bin/env bash
echo "chown \$*" >>"$CALLS"
EOT
  chmod +x "$FAKE_BIN/apt-get" "$FAKE_BIN/python3" "$FAKE_BIN/chown"

  PATH="$FAKE_BIN:$PATH" run "$BATS_TEST_TMPDIR/repo/scripts/lock-office.sh" --in-container
  [ "$status" -eq 0 ]
  grep -q "pip install --no-cache-dir uv==" "$CALLS"
  grep -q "uv pip compile --generate-hashes --python-version 3.11 --python-platform linux --output-file=requirements.txt requirements.in in $BATS_TEST_TMPDIR/repo/mcp-servers/office" "$CALLS"
  grep -q "^numpy==2.2.2 --hash" "$BATS_TEST_TMPDIR/repo/mcp-servers/office/requirements.txt"
  grep -q "chown --reference=requirements.in requirements.txt" "$CALLS"
}

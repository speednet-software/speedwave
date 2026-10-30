#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

setup() {
  FAKE_BIN="$BATS_TEST_TMPDIR/fakebin"
  REPO="$BATS_TEST_TMPDIR/repo"
  CALLS="$BATS_TEST_TMPDIR/calls.log"
  mkdir -p "$FAKE_BIN" "$REPO/scripts" "$REPO/mcp-servers/office"
  cp "$REPO_ROOT/scripts/lock-office.sh" "$REPO_ROOT/scripts/python-tool.sh" "$REPO_ROOT/scripts/build-tool-versions.env" "$REPO/scripts/"
  chmod +x "$REPO"/scripts/*.sh
  echo "numpy==2.2.2" >"$REPO/mcp-servers/office/requirements.in"
  UV_VERSION="$(awk -F= '$1 == "UV_VERSION" { print $2 }' "$REPO_ROOT/scripts/build-tool-versions.env")"
  export SPEEDWAVE_TOOL_CACHE="$BATS_TEST_TMPDIR/cache"
  : >"$CALLS"
}

stub_python_creating_venv() {
  local layout="$1" suffix="${2:-}"
  cat >"$FAKE_BIN/python3" <<EOT
#!/usr/bin/env bash
echo "python3 \$*" >>"$CALLS"
venv="\$3"
mkdir -p "\$venv/$layout"
cat >"\$venv/$layout/pip$suffix" <<'PIP'
#!/usr/bin/env bash
echo "pip \$*" >>"$CALLS"
PIP
cat >"\$venv/$layout/uv$suffix" <<'UV'
#!/usr/bin/env bash
echo "uv \$* in \$PWD" >>"$CALLS"
echo "numpy==2.2.2 --hash=sha256:00" >requirements.txt
UV
chmod +x "\$venv/$layout/pip$suffix" "\$venv/$layout/uv$suffix"
EOT
  chmod +x "$FAKE_BIN/python3"
}

@test "builds a venv, installs the pinned uv and compiles the hashed lock next to requirements.in" {
  stub_python_creating_venv bin

  PATH="$FAKE_BIN:$PATH" run "$REPO/scripts/lock-office.sh"
  [ "$status" -eq 0 ]
  grep -q "^python3 -m venv $SPEEDWAVE_TOOL_CACHE/uv-$UV_VERSION" "$CALLS"
  grep -q "^pip install .* uv==$UV_VERSION" "$CALLS"
  grep -q "^uv pip compile --generate-hashes --python-version 3.11 --python-platform linux --output-file=requirements.txt requirements.in in $REPO/mcp-servers/office" "$CALLS"
  grep -q "^numpy==2.2.2 --hash" "$REPO/mcp-servers/office/requirements.txt"
}

@test "uses the Scripts layout of a Windows venv" {
  stub_python_creating_venv Scripts .exe

  PATH="$FAKE_BIN:$PATH" run "$REPO/scripts/lock-office.sh"
  [ "$status" -eq 0 ]
  grep -q "^uv pip compile" "$CALLS"
}

@test "reuses the cached venv without installing again" {
  stub_python_creating_venv bin
  PATH="$FAKE_BIN:$PATH" run "$REPO/scripts/lock-office.sh"
  [ "$status" -eq 0 ]
  : >"$CALLS"

  PATH="$FAKE_BIN:$PATH" run "$REPO/scripts/lock-office.sh"
  [ "$status" -eq 0 ]
  ! grep -q "^python3\|^pip" "$CALLS"
  grep -q "^uv pip compile" "$CALLS"
}

@test "removes the venv and fails with a named error when the pinned install fails" {
  stub_python_creating_venv bin
  sed -i 's|^echo "pip |exit 1; echo "pip |' "$FAKE_BIN/python3"
  chmod +x "$FAKE_BIN/python3"

  PATH="$FAKE_BIN:$PATH" run "$REPO/scripts/lock-office.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"python-tool: could not install uv==$UV_VERSION"* ]]
  [ ! -d "$SPEEDWAVE_TOOL_CACHE/uv-$UV_VERSION" ]
}

@test "needs no container engine on PATH" {
  stub_python_creating_venv bin

  PATH="$FAKE_BIN:/usr/bin:/bin" run "$REPO/scripts/lock-office.sh"
  [ "$status" -eq 0 ]
}

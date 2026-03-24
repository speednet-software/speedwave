#!/usr/bin/env bash
# Speedwave CLI diagnostic script
# Run on a machine where `speedwave` command is not working.

set -uo pipefail

echo "=== Speedwave CLI Diagnostics ==="
echo "Date: $(date)"
echo ""

echo "--- System ---"
echo "OS: $(uname -s)"
echo "Arch: $(uname -m)"
echo "Shell: $SHELL"
echo ""

echo "--- Binary ---"
CLI="$HOME/.local/bin/speedwave"
if [ -f "$CLI" ]; then
  echo "File: EXISTS"
  ls -la "$CLI"
  file "$CLI"
  echo ""
  echo "Version:"
  "$CLI" --version 2>&1 || echo "(failed to run)"
else
  echo "File: NOT FOUND at $CLI"
fi
echo ""

echo "--- PATH ---"
if echo "$PATH" | tr ':' '\n' | grep -q '\.local/bin'; then
  echo "\$PATH contains .local/bin: YES"
else
  echo "\$PATH contains .local/bin: NO  <-- likely cause"
fi
echo ""
echo "Full \$PATH:"
echo "$PATH" | tr ':' '\n'
echo ""

echo "--- Shell config files ---"
for f in .bashrc .bash_profile .zshrc .zprofile .profile; do
  fp="$HOME/$f"
  if [ -f "$fp" ]; then
    match=$(grep -n "local/bin" "$fp" 2>/dev/null || true)
    if [ -n "$match" ]; then
      echo "$f: EXISTS, has local/bin entry -> $match"
    else
      echo "$f: EXISTS, NO local/bin entry"
    fi
  else
    echo "$f: NOT FOUND"
  fi
done
echo ""

echo "--- Speedwave data dir ---"
DATA="$HOME/.speedwave"
if [ -d "$DATA" ]; then
  echo "$DATA: EXISTS"
  echo "Contents:"
  ls -la "$DATA/"
  echo ""
  echo "setup_state.json:"
  cat "$DATA/setup_state.json" 2>/dev/null || echo "(not found)"
  echo ""
  echo "resources-dir marker:"
  cat "$DATA/resources-dir" 2>/dev/null || echo "(not found)"
  echo ""
  echo "config.json:"
  cat "$DATA/config.json" 2>/dev/null || echo "(not found)"
else
  echo "$DATA: NOT FOUND  <-- setup wizard never completed?"
fi
echo ""

echo "--- Speedwave.app process ---"
pgrep -fl Speedwave 2>/dev/null || echo "Speedwave.app is NOT running"
echo ""

echo "--- Direct CLI run ---"
echo "Running: speedwave check 2>&1"
speedwave check 2>&1 || true
echo ""

echo "=== Done ==="

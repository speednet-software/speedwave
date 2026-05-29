#!/usr/bin/env bash
# generate-installer-nsh.sh — Build a single installer-hooks.nsh by inlining
# materialize macros for sweep.ps1 and firewall.ps1 into a hand-written template.
#
# SSOT inputs (hand-written):
#   desktop/src-tauri/windows/installer-hooks-template.nsh
#   desktop/src-tauri/windows/sweep.ps1
#   desktop/src-tauri/windows/firewall.ps1
#
# Output (generated, committed):
#   desktop/src-tauri/windows/installer-hooks.nsh
#
# Why this shape: Tauri inlines installerHooks content into a generated .nsi
# placed in target/release/bundle/nsis/<arch>/. `!include` of sibling .nsh
# files does not work (Tauri does not copy them). makensis CWD is the bundle
# temp dir, so `File "windows\sweep.ps1"` cannot resolve either. The only
# working pattern is single-file installerHooks with everything inline.
#
# Drift detector: SSOT pin tests in installer_hooks.rs re-derive the embedded
# macros from the current .ps1 files and assert byte-for-byte equality with
# installer-hooks.nsh. If you edit any .ps1, run:
#
#   make generate-installer-nsh
#
# and commit installer-hooks.nsh alongside the .ps1 changes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIN_DIR="$REPO_ROOT/desktop/src-tauri/windows"
TEMPLATE="$WIN_DIR/installer-hooks-template.nsh"
OUT="$WIN_DIR/installer-hooks.nsh"
MARKER="@@SPEEDWAVE_EMBEDDED_MACROS@@"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: $TEMPLATE missing" >&2
  exit 1
fi
if ! grep -q "$MARKER" "$TEMPLATE"; then
  echo "ERROR: template missing marker $MARKER" >&2
  exit 1
fi

# Emit one !macro SPEEDWAVE_MATERIALIZE_<NAME> that writes <name>.ps1 to
# $PLUGINSDIR\<name>.ps1 at install time via FileWrite literals.
emit_materialize_macro() {
  local name="$1"
  local upper="${name^^}"
  local src="$WIN_DIR/${name}.ps1"

  if [[ ! -f "$src" ]]; then
    echo "ERROR: $src missing" >&2
    exit 1
  fi

  # A backtick is the NSIS FileWrite string delimiter and has no escape, so a
  # literal backtick in the .ps1 silently truncates the NSIS string and aborts
  # makensis. Fail loudly here instead. Use splatting, not backtick-continuation.
  if grep -q '`' "$src"; then
    echo "ERROR: $src contains a backtick — breaks NSIS FileWrite. Use splatting." >&2
    exit 1
  fi

  # Strip UTF-8 BOM before embedding — NSIS writes literal bytes, and the
  # materialized .ps1 does not need a BOM (PowerShell handles ASCII fine).
  local stripped
  stripped="$(mktemp)"
  if head -c 3 "$src" | od -An -t x1 | tr -d ' \n' | grep -qi '^efbbbf$'; then
    tail -c +4 "$src" > "$stripped"
  else
    cp "$src" "$stripped"
  fi

  # Labels are uniquified per !insertmacro site via __LINE__ so the macro
  # can be inserted multiple times in the same NSIS context (e.g. firewall
  # is inserted in both POSTINSTALL and POSTUNINSTALL).
  echo "!macro SPEEDWAVE_MATERIALIZE_${upper}"
  echo "  !define SW_${upper}_ID \${__LINE__}"
  echo "  InitPluginsDir"
  echo "  ClearErrors"
  echo "  FileOpen \$0 \"\$PLUGINSDIR\\${name}.ps1\" w"
  echo "  IfErrors 0 sw_${name}_write_ok_\${SW_${upper}_ID}"
  echo "    DetailPrint \"Speedwave: could not create ${name}.ps1 in \$PLUGINSDIR — skipping.\""
  echo "    Goto sw_${name}_write_done_\${SW_${upper}_ID}"
  echo "  sw_${name}_write_ok_\${SW_${upper}_ID}:"

  # Escape each line for NSIS backtick-delimited FileWrite literal:
  #   $  -> $$
  #   "  -> $\"  (NSIS escape for double quote)
  # Backticks are rejected upstream (no NSIS escape exists). Backslashes are
  # literal in backtick strings. Line endings emitted as $\r$\n.
  local line esc
  while IFS= read -r line || [[ -n "$line" ]]; do
    esc="$line"
    esc="${esc//\$/\$\$}"
    esc="${esc//\"/\$\\\"}"
    printf '  FileWrite $0 `%s$\\r$\\n`\n' "$esc"
  done < "$stripped"

  echo "  FileClose \$0"
  echo "  sw_${name}_write_done_\${SW_${upper}_ID}:"
  echo "  !undef SW_${upper}_ID"
  echo "!macroend"

  rm -f "$stripped"
}

# Build the embedded block (two macros + leading banner).
EMBED="$(mktemp)"
trap 'rm -f "$EMBED"' EXIT

{
  echo "; ============================================================================"
  echo "; GENERATED CONTENT BELOW — DO NOT EDIT BY HAND."
  echo "; Sources: windows/sweep.ps1, windows/firewall.ps1"
  echo "; Regenerate: make generate-installer-nsh"
  echo "; ============================================================================"
  echo ""
  emit_materialize_macro sweep
  echo ""
  emit_materialize_macro firewall
} > "$EMBED"

# Replace the marker line in the template with the embedded block.
# awk avoids sed pitfalls with multi-line replacement and special chars.
awk -v marker="$MARKER" -v embed_file="$EMBED" '
  BEGIN {
    while ((getline line < embed_file) > 0) {
      embed = embed line "\n"
    }
    close(embed_file)
  }
  {
    if (index($0, marker) > 0) {
      printf "%s", embed
    } else {
      print
    }
  }
' "$TEMPLATE" > "$OUT"

echo "generated: $OUT"

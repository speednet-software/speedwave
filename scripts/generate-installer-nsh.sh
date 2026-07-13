#!/usr/bin/env bash
# generate-installer-nsh.sh — Inlines sweep.ps1/firewall.ps1 macros into the template (Tauri
# won't copy .nsh siblings); pinned by installer_hooks.rs — rerun after editing a .ps1.

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

# Emit !macro SPEEDWAVE_MATERIALIZE_<NAME> writing <name>.<ext> to $PLUGINSDIR at install time.
# Args: <name> [<ext>]  (ext defaults to ps1; e.g. "run-hidden" "vbs").
emit_materialize_macro() {
  local name="$1"
  local ext="${2:-ps1}"
  local file="${name}.${ext}"
  # NSIS !define / label tokens cannot contain '-', so normalize for the id.
  local upper
  upper="$(echo "$name" | tr '[:lower:]-' '[:upper:]_')"
  local src="$WIN_DIR/${file}"

  if [[ ! -f "$src" ]]; then
    echo "ERROR: $src missing" >&2
    exit 1
  fi

  # A literal backtick truncates the NSIS FileWrite delimiter (no escape exists). Fail loudly.
  if grep -q '`' "$src"; then
    echo "ERROR: $src contains a backtick — breaks NSIS FileWrite. Use splatting." >&2
    exit 1
  fi

  # Strip UTF-8 BOM (NSIS writes literal bytes; wscript requires no BOM for .vbs).
  local stripped
  stripped="$(mktemp)"
  if head -c 3 "$src" | od -An -t x1 | tr -d ' \n' | grep -qi '^efbbbf$'; then
    tail -c +4 "$src" > "$stripped"
  else
    cp "$src" "$stripped"
  fi

  # Labels uniquified per !insertmacro site via __LINE__ (firewall is inserted twice).
  echo "!macro SPEEDWAVE_MATERIALIZE_${upper}"
  echo "  !define SW_${upper}_ID \${__LINE__}"
  echo "  InitPluginsDir"
  echo "  ClearErrors"
  echo "  FileOpen \$0 \"\$PLUGINSDIR\\${file}\" w"
  echo "  IfErrors 0 sw_${upper}_write_ok_\${SW_${upper}_ID}"
  echo "    DetailPrint \"Speedwave: could not create ${file} in \$PLUGINSDIR — skipping.\""
  echo "    Goto sw_${upper}_write_done_\${SW_${upper}_ID}"
  echo "  sw_${upper}_write_ok_\${SW_${upper}_ID}:"

  # Escape for NSIS backtick FileWrite: $ -> $$, " -> $\"; line ends $\r$\n.
  local line esc
  while IFS= read -r line || [[ -n "$line" ]]; do
    esc="$line"
    esc="${esc//\$/\$\$}"
    esc="${esc//\"/\$\\\"}"
    printf '  FileWrite $0 `%s$\\r$\\n`\n' "$esc"
  done < "$stripped"

  echo "  FileClose \$0"
  echo "  sw_${upper}_write_done_\${SW_${upper}_ID}:"
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
  echo "; Sources: windows/sweep.ps1, windows/firewall.ps1, windows/run-hidden.vbs"
  echo "; Regenerate: make generate-installer-nsh"
  echo "; ============================================================================"
  echo ""
  emit_materialize_macro sweep
  echo ""
  emit_materialize_macro firewall
  echo ""
  emit_materialize_macro run-hidden vbs
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

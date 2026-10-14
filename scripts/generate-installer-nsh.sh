#!/usr/bin/env bash

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

emit_materialize_macro() {
  local name="$1"
  local file="${name}.ps1"
  local upper
  upper="$(echo "$name" | tr '[:lower:]-' '[:upper:]_')"
  local src="$WIN_DIR/${file}"

  if [[ ! -f "$src" ]]; then
    echo "ERROR: $src missing" >&2
    exit 1
  fi

  if grep -q '`' "$src"; then
    echo "ERROR: $src contains a backtick — breaks NSIS FileWrite. Use splatting." >&2
    exit 1
  fi

  local stripped
  stripped="$(mktemp)"
  if head -c 3 "$src" | od -An -t x1 | tr -d ' \n' | grep -qi '^efbbbf$'; then
    tail -c +4 "$src" > "$stripped"
  else
    cp "$src" "$stripped"
  fi

  echo "!macro SPEEDWAVE_MATERIALIZE_${upper}"
  echo "  !define SW_${upper}_ID \${__LINE__}"
  echo "  InitPluginsDir"
  echo "  ClearErrors"
  echo "  FileOpen \$0 \"\$PLUGINSDIR\\${file}\" w"
  echo "  IfErrors 0 sw_${upper}_write_ok_\${SW_${upper}_ID}"
  echo "    DetailPrint \"Speedwave: could not create ${file} in \$PLUGINSDIR — skipping.\""
  echo "    Goto sw_${upper}_write_done_\${SW_${upper}_ID}"
  echo "  sw_${upper}_write_ok_\${SW_${upper}_ID}:"

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

EMBED="$(mktemp)"
trap 'rm -f "$EMBED"' EXIT

{
  emit_materialize_macro sweep
  echo ""
  emit_materialize_macro firewall
  echo ""
  emit_materialize_macro reset
} > "$EMBED"

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

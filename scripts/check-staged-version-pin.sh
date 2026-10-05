#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/release-please-config.json"
PINNED_VERSION="0.0.0"

is_staged() {
  [ -n "$(git -C "$REPO_ROOT" diff --cached --name-only -- "$1")" ]
}

extract_toml_version() {
  awk '
    /^\[package\]/ { in_pkg = 1; next }
    /^\[/ { in_pkg = 0 }
    in_pkg && /^version[[:space:]]*=/ { print; exit }
  ' | sed -E 's/^version[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/'
}

extract_generic_version() {
  grep "x-release-please-version" | head -n1 | sed -E 's/.*<string>([^<]*)<\/string>.*/\1/'
}

entries="$(jq -r '
  .packages["."]["extra-files"][] |
  if type == "string" then "json:" + .
  elif .type == "toml" then "toml:" + .path
  elif .type == "generic" then "generic:" + .path
  else empty end
' "$CONFIG")"
entries="${entries}
manifest:.release-please-manifest.json"

status=0

while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  entry_type="${entry%%:*}"
  entry_path="${entry#*:}"

  is_staged "$entry_path" || continue

  content="$(git -C "$REPO_ROOT" show ":$entry_path" 2>/dev/null)" || continue

  case "$entry_type" in
    json)
      actual="$(printf '%s' "$content" | jq -r '.version // empty')"
      ;;
    manifest)
      actual="$(printf '%s' "$content" | jq -r '.["."] // empty')"
      ;;
    toml)
      actual="$(printf '%s' "$content" | extract_toml_version)"
      ;;
    generic)
      actual="$(printf '%s' "$content" | extract_generic_version)"
      ;;
    *)
      continue
      ;;
  esac

  if [ "$actual" != "$PINNED_VERSION" ]; then
    echo "error: $entry_path: staged version '$actual' is not pinned to $PINNED_VERSION" >&2
    status=1
  fi
done <<EOF
$entries
EOF

exit "$status"

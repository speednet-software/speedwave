#!/bin/sh

[ "${1:-}" = "get" ] || exit 0

cat > /dev/null

token_file="${SPEEDWAVE_SECRETS_DIR:-/run/speedwave/secrets}/caller-token"
[ -f "$token_file" ] || exit 0
token="$(cat "$token_file" 2>/dev/null)" || exit 0
[ -n "$token" ] || exit 0

printf 'username=speedwave\npassword=%s\n' "$token"

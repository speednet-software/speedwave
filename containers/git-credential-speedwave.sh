#!/bin/sh

[ "${1:-}" = "get" ] || exit 0

cat > /dev/null

token_file="${SPEEDWAVE_SECRETS_DIR:-/run/speedwave/secrets}/caller-token"
token="$(cat "$token_file" 2>/dev/null)"
if [ -z "$token" ]; then
    echo "quit=1"
    exit 0
fi

printf 'username=speedwave\npassword=%s\n' "$token"

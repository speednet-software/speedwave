#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
    echo "speedwave-exec: usage: speedwave-exec VAR=value... command [args...]" >&2
    exit 2
fi

. "$(dirname "$0")/speedwave-secret-env.sh"
speedwave_export_secrets

exec env "$@"

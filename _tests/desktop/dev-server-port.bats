#!/usr/bin/env bats
# `make dev` must land Tauri on the port `ng serve` binds: angular.json's serve port equals
# tauri.conf.json's devUrl, and both launch paths strip PORT (Angular 22 lets it override angular.json).

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
MAKEFILE="$REPO_ROOT/Makefile"
WINDOWS_LAUNCHER="$REPO_ROOT/scripts/dev-tauri-windows.sh"

_angular_serve_port() {
    python3 -c '
import json, sys
ws = json.load(open(sys.argv[1]))
ports = {p["architect"]["serve"]["options"]["port"] for p in ws["projects"].values()}
assert len(ports) == 1, ports
print(ports.pop())
' "$REPO_ROOT/desktop/src/angular.json"
}

_tauri_dev_port() {
    python3 -c '
import json, sys
from urllib.parse import urlparse
print(urlparse(json.load(open(sys.argv[1]))["build"]["devUrl"]).port)
' "$REPO_ROOT/desktop/src-tauri/tauri.conf.json"
}

# The non-Windows `dev` recipe line that launches Tauri.
_unix_dev_launch_line() {
    awk '/^dev:/ { in_dev = 1 } in_dev && /cargo tauri dev/ { print; exit }' "$MAKEFILE"
}

@test "angular.json serve port matches tauri.conf.json devUrl port" {
    [ "$(_angular_serve_port)" = "$(_tauri_dev_port)" ]
}

@test "unix make dev launches Tauri with PORT stripped" {
    line="$(_unix_dev_launch_line)"
    [ -n "$line" ]
    [[ "$line" == *"env -u PORT "* ]]
}

@test "windows dev launcher execs Tauri with PORT stripped" {
    run grep -E '^exec env -u PORT cargo tauri dev$' "$WINDOWS_LAUNCHER"
    [ "$status" -eq 0 ]
}

@test "env -u PORT actually removes an inherited PORT from the child" {
    PORT=3000 run env -u PORT sh -c 'echo "${PORT:-unset}"'
    [ "$status" -eq 0 ]
    [ "$output" = "unset" ]
}

#!/usr/bin/env bats
# `make dev` must land Tauri on the port `ng serve` binds: angular.json's serve port equals
# tauri.conf.json's devUrl, and both launch paths strip PORT (Angular 22 lets it override angular.json).
# DEV_INSTANCE/DEV_PORT (ADR-031) move that pair, plus the data dir and the bundle identifier,
# so several worktrees can run `make dev` at once.

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

# Resolved dev-instance settings. SPEEDWAVE_DATA_DIR is unset so the Makefile's
# own default applies: bats itself runs under a `make` that exports it.
_dev_config() {
    env -u SPEEDWAVE_DATA_DIR -u DEV_TAURI_CONFIG make -C "$REPO_ROOT" dev-config "$@"
}

@test "angular.json serve port matches tauri.conf.json devUrl port" {
    [ "$(_angular_serve_port)" = "$(_tauri_dev_port)" ]
}

@test "unix make dev launches Tauri with PORT stripped" {
    line="$(_unix_dev_launch_line)"
    [ -n "$line" ]
    [[ "$line" == *"env -u PORT "* ]]
}

@test "unix make dev passes the instance config to both the build script and the CLI" {
    line="$(_unix_dev_launch_line)"
    [[ "$line" == *'TAURI_CONFIG="$$DEV_TAURI_CONFIG"'* ]]
    [[ "$line" == *'cargo tauri dev --config "$$DEV_TAURI_CONFIG"'* ]]
}

@test "windows dev launcher execs Tauri with PORT stripped and the instance config" {
    run grep -E '^exec env -u PORT cargo tauri dev --config "\$TAURI_CONFIG"$' "$WINDOWS_LAUNCHER"
    [ "$status" -eq 0 ]
}

@test "windows dev launcher has no config of its own to drift from the Makefile" {
    run grep -c 'pl.speedwave.desktop' "$WINDOWS_LAUNCHER"
    [ "$output" = "0" ]
    run grep -q 'DEV_TAURI_CONFIG:?' "$WINDOWS_LAUNCHER"
    [ "$status" -eq 0 ]
}

@test "env -u PORT actually removes an inherited PORT from the child" {
    PORT=3000 run env -u PORT sh -c 'echo "${PORT:-unset}"'
    [ "$status" -eq 0 ]
    [ "$output" = "unset" ]
}

@test "default instance keeps today's data dir, identifier and product name" {
    run _dev_config
    [ "$status" -eq 0 ]
    [[ "$output" == *"DEV_INSTANCE=dev"* ]]
    [[ "$output" == *"SPEEDWAVE_DATA_DIR=$HOME/.speedwave-dev"* ]]
    [[ "$output" == *'TAURI_CONFIG={"identifier":"pl.speedwave.desktop.dev","productName":"Speedwave Dev"}'* ]]
}

@test "default instance overrides no port, so angular.json stays the source" {
    run _dev_config
    [ "$status" -eq 0 ]
    [[ "$output" != *"devUrl"* ]]
}

@test "a named instance gets its own data dir, identifier and dev-server port" {
    run _dev_config DEV_INSTANCE=speed-533 DEV_PORT=4271
    [ "$status" -eq 0 ]
    [[ "$output" == *"SPEEDWAVE_DATA_DIR=$HOME/.speedwave-speed-533"* ]]
    [[ "$output" == *'"identifier":"pl.speedwave.desktop.speed-533"'* ]]
    [[ "$output" == *'"devUrl":"http://localhost:4271"'* ]]
    [[ "$output" == *'"script":"npx ng serve --port 4271"'* ]]
}

# The derived port is what makes a second instance a one-word command, so pin the
# formula: 24 bits of sha256 over the name, folded into 20000-39999.
@test "a named instance derives its port from its name" {
    run _dev_config DEV_INSTANCE=speed-533
    [ "$status" -eq 0 ]
    [[ "$output" == *'"devUrl":"http://localhost:22441"'* ]]
    [[ "$output" == *'"script":"npx ng serve --port 22441"'* ]]
}

@test "the derived port is stable per name and differs between names" {
    run _dev_config DEV_INSTANCE=speed-466
    [ "$status" -eq 0 ]
    first="$(printf '%s\n' "$output" | sed -n 's/.*localhost:\([0-9]*\)".*/\1/p')"
    run _dev_config DEV_INSTANCE=speed-466
    second="$(printf '%s\n' "$output" | sed -n 's/.*localhost:\([0-9]*\)".*/\1/p')"
    [ "$first" = "$second" ]
    [ "$first" -ge 20000 ]
    [ "$first" -lt 40000 ]
    run _dev_config DEV_INSTANCE=speed-516
    other="$(printf '%s\n' "$output" | sed -n 's/.*localhost:\([0-9]*\)".*/\1/p')"
    [ "$first" != "$other" ]
}

@test "DEV_INSTANCE must match the data-dir basename rule" {
    run _dev_config DEV_INSTANCE=Speed533 DEV_PORT=4271
    [ "$status" -ne 0 ]
    run _dev_config DEV_INSTANCE=533-speed DEV_PORT=4271
    [ "$status" -ne 0 ]
    run _dev_config DEV_INSTANCE=speed_533 DEV_PORT=4271
    [ "$status" -ne 0 ]
}

@test "DEV_PORT must be a port number" {
    run _dev_config DEV_INSTANCE=speed-533 DEV_PORT=4271abc
    [ "$status" -ne 0 ]
}

@test "the derived data dir never hits the production one" {
    run env -u SPEEDWAVE_DATA_DIR make -C "$REPO_ROOT" guard-not-prod-data-dir DEV_INSTANCE=speed-533 DEV_PORT=4271
    [ "$status" -eq 0 ]
}

#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

_dev_config() {
    env -u SPEEDWAVE_DATA_DIR -u DEV_TAURI_CONFIG make -C "$REPO_ROOT" dev-config "$@"
}

@test "default instance keeps today's data dir, identifier and product name" {
    run _dev_config
    [ "$status" -eq 0 ]
    [[ "$output" == *"DEV_INSTANCE=dev"* ]]
    [[ "$output" == *"SPEEDWAVE_DATA_DIR=$HOME/.speedwave-dev"* ]]
    [[ "$output" == *'TAURI_CONFIG={"version":"'* ]]
    [[ "$output" == *'","identifier":"pl.speedwave.desktop.dev","productName":"Speedwave Dev"}'* ]]
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

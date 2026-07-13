#!/usr/bin/env bats
# Tests for desktop build configuration.
# Catches regressions where Angular output path and Tauri frontendDist diverge.

TAURI_CONF="$BATS_TEST_DIRNAME/../../desktop/src-tauri/tauri.conf.json"
ANGULAR_JSON="$BATS_TEST_DIRNAME/../../desktop/src/angular.json"

# ── Static checks (no build required) ──

@test "frontendDist is set in tauri.conf.json" {
    run python3 -c "
import json, sys
conf = json.load(open('$TAURI_CONF'))
fd = conf.get('build', {}).get('frontendDist', '')
if not fd:
    print('frontendDist is missing or empty', file=sys.stderr)
    sys.exit(1)
print(fd)
"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
}

@test "frontendDist includes /browser suffix" {
    run python3 -c "
import json, sys
conf = json.load(open('$TAURI_CONF'))
fd = conf['build']['frontendDist']
if not fd.endswith('/browser'):
    print(f'Expected /browser suffix, got: {fd}', file=sys.stderr)
    sys.exit(1)
print(fd)
"
    [ "$status" -eq 0 ]
}

@test "angular.json disables CLI analytics prompt (cli.analytics must be boolean false)" {
    # Without this, Angular CLI shows an interactive telemetry prompt on first run that hangs
    # non-interactive shells; must be boolean false (a string "false" is a user-id, === false check).
    run python3 -c "
import json, sys
cfg = json.load(open('$ANGULAR_JSON'))
v = cfg.get('cli', {}).get('analytics', None)
if not isinstance(v, bool):
    print(f'cli.analytics must be a boolean, got: {v!r}', file=sys.stderr)
    sys.exit(1)
if v is not False:
    print('cli.analytics must be false to suppress the interactive analytics prompt', file=sys.stderr)
    sys.exit(1)
print('ok')
"
    [ "$status" -eq 0 ]
}

# ── Build verification (requires prior `ng build`) ──

@test "index.html exists at frontendDist path after Angular build" {
    run python3 -c "
import json, os, sys
conf = json.load(open('$TAURI_CONF'))
fd = conf['build']['frontendDist']
# frontendDist is relative to src-tauri/, resolve from repo root
tauri_dir = os.path.dirname('$TAURI_CONF')
resolved = os.path.normpath(os.path.join(tauri_dir, fd))
index = os.path.join(resolved, 'index.html')
if not os.path.isfile(index):
    print(f'Missing: {index}', file=sys.stderr)
    sys.exit(1)
print(f'OK: {index}')
"
    [ "$status" -eq 0 ]
}

# ── CLI binary declared in platform-specific Tauri configs ──

TAURI_DIR="$BATS_TEST_DIRNAME/../../desktop/src-tauri"

@test "CLI binary declared in tauri.macos.conf.json resources" {
    run python3 -c "
import json, sys
conf = json.load(open('$TAURI_DIR/tauri.macos.conf.json'))
resources = conf.get('bundle', {}).get('resources', {})
assert 'cli/speedwave' in resources, f'CLI missing from macos bundle resources: {list(resources.keys())}'
"
    [ "$status" -eq 0 ]
}

@test "macOS native helpers declared in tauri.macos.conf.json resources" {
    run python3 -c "
import json, sys
conf = json.load(open('$TAURI_DIR/tauri.macos.conf.json'))
resources = conf.get('bundle', {}).get('resources', {})
required = ['reminders-cli', 'calendar-cli', 'mail-cli', 'notes-cli', 'audio-capture-cli']
missing = [key for key in required if key not in resources]
assert not missing, f'macOS helpers missing from bundle resources: {missing}; have {list(resources.keys())}'
"
    [ "$status" -eq 0 ]
}

@test "CLI binary declared in tauri.windows.conf.json resources" {
    run python3 -c "
import json, sys
conf = json.load(open('$TAURI_DIR/tauri.windows.conf.json'))
resources = conf.get('bundle', {}).get('resources', {})
assert 'cli/speedwave.exe' in resources, f'CLI missing from windows bundle resources: {list(resources.keys())}'
"
    [ "$status" -eq 0 ]
}

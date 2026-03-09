#!/usr/bin/env bats
# Tests for desktop build configuration.
# Catches regressions where Angular output path and Tauri frontendDist diverge.

TAURI_CONF="$BATS_TEST_DIRNAME/../../desktop/src-tauri/tauri.conf.json"

# ---------------------------------------------------------------------------
# Static checks (no build required)
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Build verification (requires prior `ng build`)
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# CLI binary declared in platform-specific Tauri configs
# ---------------------------------------------------------------------------

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

@test "CLI binary declared in tauri.linux.conf.json resources" {
    run python3 -c "
import json, sys
conf = json.load(open('$TAURI_DIR/tauri.linux.conf.json'))
resources = conf.get('bundle', {}).get('resources', {})
assert 'cli/speedwave' in resources, f'CLI missing from linux bundle resources: {list(resources.keys())}'
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

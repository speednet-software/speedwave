#!/usr/bin/env bats
# SSOT-alignment test: each native macOS CLI binary carries an embedded
# `__TEXT,__info_plist` section with the right id, usage description, version. macOS-only.

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
# Mirrors scripts/build-native-macos.sh::PACKAGES. Word-split on use: macOS ships
# bash 3.2, which has no associative arrays.
SERVICES="calendar reminders mail notes audio-capture"

setup() {
    if [ "$(uname)" != "Darwin" ]; then
        skip "macOS-only: requires segedit/lipo and macOS-native CLI binaries"
    fi
}

# Must match SharedCLI/Utilities.swift::subBundleIdentifier (and, for
# audio-capture, native/macos/audio-capture/Resources/Info.plist).
expected_bundle_id() {
    case "$1" in
        calendar) echo "pl.speedwave.desktop.calendar" ;;
        reminders) echo "pl.speedwave.desktop.reminders" ;;
        mail) echo "pl.speedwave.desktop.mail" ;;
        notes) echo "pl.speedwave.desktop.notes" ;;
        audio-capture) echo "pl.speedwave.desktop.audio-capture" ;;
        *) echo "unmapped service: $1" >&2; return 1 ;;
    esac
}

expected_usage_key() {
    case "$1" in
        calendar) echo "NSCalendarsFullAccessUsageDescription" ;;
        reminders) echo "NSRemindersFullAccessUsageDescription" ;;
        mail | notes) echo "NSAppleEventsUsageDescription" ;;
        audio-capture) echo "NSAudioCaptureUsageDescription" ;;
        *) echo "unmapped service: $1" >&2; return 1 ;;
    esac
}

# Mirrors scripts/build-native-macos.sh::resolve_binary_path; empty when nothing is built.
resolve_binary() {
    local svc="$1"
    local pkg_dir="$REPO_ROOT/native/macos/$svc"
    local candidate
    for candidate in \
        "$pkg_dir/.build/apple/Products/Release/$svc-cli" \
        "$pkg_dir/.build/universal-apple-macosx/release/$svc-cli" \
        "$pkg_dir/.build/release/$svc-cli"; do
        if [ -f "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done
    find "$pkg_dir/.build" -type f -name "$svc-cli" \
        \( -path "*universal*" -o -path "*release*" -o -path "*Release*" \) \
        ! -path "*.dSYM*" ! -path "*Intermediates*" 2>/dev/null | head -n 1
}

# All-or-nothing gate: skipping per-service mid-loop would report `ok` for a run
# that covered fewer services than SERVICES lists.
require_built_binaries() {
    local svc missing=""
    for svc in $SERVICES; do
        [ -n "$(resolve_binary "$svc")" ] || missing="$missing $svc"
    done
    [ -z "$missing" ] || skip "built binaries missing for:$missing — run 'make build-native-macos' first"
}

# segedit reads single-arch Mach-O only, so thin a universal binary to the host arch first.
extract_embedded_plist() {
    local bin="$1"
    local out="$2"
    local arch rc=0
    if file "$bin" | grep -q "Mach-O universal"; then
        arch="$(uname -m)"
        lipo -thin "$arch" "$bin" -output "$out.$arch" 2>/dev/null || return 1
        segedit "$out.$arch" -extract __TEXT __info_plist "$out" 2>/dev/null || rc=1
        rm -f "$out.$arch"
        return "$rc"
    fi
    segedit "$bin" -extract __TEXT __info_plist "$out" 2>/dev/null
}

tauri_conf_version() {
    local conf="$REPO_ROOT/desktop/src-tauri/tauri.conf.json"
    if command -v jq >/dev/null 2>&1; then
        jq -r '.version' "$conf"
        return 0
    fi
    grep -E '"version"' "$conf" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

# Extracts one embedded plist key for a service, or fails naming the binary.
embedded_key() {
    local bin="$1" key="$2" out="$3"
    extract_embedded_plist "$bin" "$out" || {
        echo "Failed to extract embedded plist from $bin" >&2
        return 1
    }
    plutil -extract "$key" raw "$out" 2>/dev/null
}

@test "every native CLI exists in build output (run make build-native-macos first)" {
    require_built_binaries
}

@test "every native CLI has __TEXT __info_plist section" {
    require_built_binaries
    local svc bin lines
    for svc in $SERVICES; do
        bin="$(resolve_binary "$svc")"
        # otool -s prints a section header plus hex lines; under 3 lines means absent.
        lines=$(otool -s __TEXT __info_plist "$bin" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$lines" -lt 3 ]; then
            echo "$svc-cli has no __TEXT __info_plist section (otool reported $lines lines)" >&2
            echo "  Likely cause: linkerSettings in $svc/Package.swift missing or stale .build cache" >&2
            return 1
        fi
    done
}

@test "embedded CFBundleIdentifier matches sub-identifier scheme" {
    require_built_binaries
    local svc bin tmp expected actual
    tmp="$BATS_TEST_TMPDIR/sw-plist"
    for svc in $SERVICES; do
        bin="$(resolve_binary "$svc")"
        actual="$(embedded_key "$bin" CFBundleIdentifier "$tmp")" || return 1
        expected="$(expected_bundle_id "$svc")"
        if [ "$actual" != "$expected" ]; then
            echo "$svc-cli embedded CFBundleIdentifier='$actual', expected '$expected'" >&2
            echo "  TCC will bind the permission to the wrong identifier." >&2
            return 1
        fi
    done
}

@test "embedded CFBundleExecutable matches binary basename" {
    require_built_binaries
    local svc bin tmp actual
    tmp="$BATS_TEST_TMPDIR/sw-plist"
    for svc in $SERVICES; do
        bin="$(resolve_binary "$svc")"
        actual="$(embedded_key "$bin" CFBundleExecutable "$tmp")" || return 1
        if [ "$actual" != "$svc-cli" ]; then
            echo "$svc-cli embedded CFBundleExecutable='$actual', expected '$svc-cli'" >&2
            return 1
        fi
    done
}

@test "embedded CFBundleShortVersionString matches tauri.conf.json version" {
    require_built_binaries
    # build-native-macos.sh stamps tauri.conf.json's version into each
    # CLI's Resources/Info.plist before swift build.
    local tauri_version svc bin tmp actual
    tauri_version="$(tauri_conf_version)"
    [ -n "$tauri_version" ] || skip "cannot read version from tauri.conf.json"
    tmp="$BATS_TEST_TMPDIR/sw-plist"
    for svc in $SERVICES; do
        bin="$(resolve_binary "$svc")"
        actual="$(embedded_key "$bin" CFBundleShortVersionString "$tmp")" || return 1
        if [ "$actual" != "$tauri_version" ]; then
            echo "$svc-cli embedded CFBundleShortVersionString='$actual', expected '$tauri_version'" >&2
            echo "  Run 'make build-native-macos' to re-stamp from tauri.conf.json." >&2
            return 1
        fi
    done
}

@test "each CLI Info.plist has correct UsageDescription key" {
    # Source Info.plist files (read directly, not from binary) must
    # carry the right TCC usage description for each service.
    local svc plist key val
    for svc in $SERVICES; do
        plist="$REPO_ROOT/native/macos/$svc/Resources/Info.plist"
        [ -f "$plist" ] || {
            echo "Missing source Info.plist: $plist" >&2
            return 1
        }
        key="$(expected_usage_key "$svc")"
        val="$(python3 -c "import plistlib;print(plistlib.load(open('$plist','rb')).get('$key',''))")"
        if [ -z "$val" ]; then
            echo "$svc/Resources/Info.plist missing or empty $key" >&2
            return 1
        fi
        if ! echo "$val" | grep -qE 'Speedwave|Claude'; then
            echo "$svc/Resources/Info.plist $key does not mention Speedwave/Claude: $val" >&2
            return 1
        fi
    done
}

@test "Resources/Info.plist files exist for every native CLI" {
    local svc plist
    for svc in $SERVICES; do
        plist="$REPO_ROOT/native/macos/$svc/Resources/Info.plist"
        if [ ! -f "$plist" ]; then
            echo "Missing $plist — required by Package.swift linker -sectcreate flag" >&2
            return 1
        fi
    done
}

@test "Package.swift files declare Info.plist linker flags for every CLI" {
    # Every CLI's Package.swift must carry the -sectcreate __TEXT
    # __info_plist flags pointing at Resources/Info.plist.
    local svc pkg
    for svc in $SERVICES; do
        pkg="$REPO_ROOT/native/macos/$svc/Package.swift"
        [ -f "$pkg" ] || { echo "Missing $pkg" >&2; return 1; }
        if ! grep -q -- "-sectcreate" "$pkg" \
            || ! grep -q "__info_plist" "$pkg" \
            || ! grep -q "Resources/Info.plist" "$pkg"; then
            echo "$pkg is missing -sectcreate __TEXT __info_plist linker flags" >&2
            return 1
        fi
    done
}

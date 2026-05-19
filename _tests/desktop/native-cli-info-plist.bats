#!/usr/bin/env bats
# SSOT-alignment test: verifies that each native macOS CLI binary
# (calendar-cli, reminders-cli, mail-cli, notes-cli) carries an embedded
# `__TEXT,__info_plist` Mach-O section with the right CFBundleIdentifier,
# usage description, and version.
#
# Without this section, EventKit's `requestFullAccessToEvents` silently
# rejects on macOS 14+ (the Calendar TCC bug fixed by this PR), and TCC
# binds the permission row to the codesign-default identifier (e.g.
# `calendar-cli`) instead of the sub-identifier the troubleshooting docs
# reference (`pl.speedwave.desktop.calendar`).
#
# This test is macOS-only because:
# - `segedit` (extracts Mach-O sections) ships only with macOS Xcode tools
# - `lipo` (thins universal binaries) is macOS-only
# - The binaries themselves are only built on macOS via build-native-macos.sh
#
# The test reads the source-of-truth Info.plist files directly (not the
# embedded section) for everything except the existence-of-section check —
# the build script (build-native-macos.sh) is responsible for stamping
# tauri.conf.json's version into them, so this test follows the same
# files SwiftPM linker reads at build time.

setup() {
    if [ "$(uname)" != "Darwin" ]; then
        skip "macOS-only: requires segedit/lipo and macOS-native CLI binaries"
    fi
    REPO_ROOT="$BATS_TEST_DIRNAME/../.."
    # Sub-identifier mapping — must match SharedCLI/Utilities.swift::subBundleIdentifier
    # (and, for audio-capture, native/macos/audio-capture/Resources/Info.plist).
    declare -gA EXPECTED_BUNDLE_ID=(
        [calendar]="pl.speedwave.desktop.calendar"
        [reminders]="pl.speedwave.desktop.reminders"
        [mail]="pl.speedwave.desktop.mail"
        [notes]="pl.speedwave.desktop.notes"
        [audio-capture]="pl.speedwave.desktop.audio-capture"
    )
    declare -gA EXPECTED_USAGE_KEY=(
        [calendar]="NSCalendarsFullAccessUsageDescription"
        [reminders]="NSRemindersFullAccessUsageDescription"
        [mail]="NSAppleEventsUsageDescription"
        [notes]="NSAppleEventsUsageDescription"
        [audio-capture]="NSAudioCaptureUsageDescription"
    )
    SERVICES=(calendar reminders mail notes audio-capture)
}

# Returns the path to the binary for a service, picking universal first then arch-specific.
# Returns empty string if no built binary exists yet (test should skip).
resolve_binary() {
    local svc="$1"
    local pkg_dir="$REPO_ROOT/native/macos/$svc"
    local candidates=(
        "$pkg_dir/.build/apple/Products/Release/$svc-cli"
        "$pkg_dir/.build/release/$svc-cli"
    )
    for c in "${candidates[@]}"; do
        if [ -f "$c" ]; then
            echo "$c"
            return 0
        fi
    done
    # Fallback: any universal-apple-macosx slice or first arch-specific
    find "$pkg_dir/.build" -type f -name "$svc-cli" \
        \( -path "*universal*" -o -path "*release*" -o -path "*Release*" \) \
        ! -path "*.dSYM*" ! -path "*Intermediates*" 2>/dev/null | head -n 1
}

# Extract embedded plist as plutil-parseable file. Handles fat (universal) binaries
# by thinning to arm64 first (segedit only works on single-arch Mach-O).
extract_embedded_plist() {
    local bin="$1"
    local out="$2"
    # If fat, thin to arm64 first
    if file "$bin" | grep -q "Mach-O universal"; then
        local thin="${out}.arm64"
        lipo -thin arm64 "$bin" -output "$thin" 2>/dev/null || return 1
        segedit "$thin" -extract __TEXT __info_plist "$out" 2>/dev/null
        rm -f "$thin"
    else
        segedit "$bin" -extract __TEXT __info_plist "$out" 2>/dev/null
    fi
}

@test "every native CLI exists in build output (run make build-native-macos first)" {
    local svc bin missing=()
    for svc in "${SERVICES[@]}"; do
        bin="$(resolve_binary "$svc")"
        if [ -z "$bin" ] || [ ! -f "$bin" ]; then
            missing+=("$svc")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        skip "Built binaries missing for: ${missing[*]} — run 'make build-native-macos' first"
    fi
}

@test "every native CLI has __TEXT __info_plist section" {
    local svc bin
    for svc in "${SERVICES[@]}"; do
        bin="$(resolve_binary "$svc")"
        [ -n "$bin" ] || skip "$svc-cli not built"
        # otool -s prints "Contents of (__TEXT,__info_plist) section" + hex dump if present.
        # Empty section is ABSENT — must have at least one hex line beyond the header.
        local lines
        lines=$(otool -s __TEXT __info_plist "$bin" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$lines" -lt 3 ]; then
            echo "$svc-cli has no __TEXT __info_plist section (otool reported $lines lines)" >&2
            echo "  Likely cause: linkerSettings in $svc/Package.swift missing or stale .build cache" >&2
            return 1
        fi
    done
}

@test "embedded CFBundleIdentifier matches sub-identifier scheme" {
    local svc bin tmp expected actual
    tmp="$(mktemp "${TMPDIR:-/tmp}/sw-plist.XXXXXX")"
    for svc in "${SERVICES[@]}"; do
        bin="$(resolve_binary "$svc")"
        [ -n "$bin" ] || skip "$svc-cli not built"
        extract_embedded_plist "$bin" "$tmp" || {
            echo "Failed to extract embedded plist from $bin" >&2
            return 1
        }
        actual="$(plutil -extract CFBundleIdentifier raw "$tmp" 2>/dev/null)"
        expected="${EXPECTED_BUNDLE_ID[$svc]}"
        if [ "$actual" != "$expected" ]; then
            echo "$svc-cli embedded CFBundleIdentifier='$actual', expected '$expected'" >&2
            echo "  TCC will bind the permission to the wrong identifier — tccutil reset commands" >&2
            echo "  in docs/troubleshooting.md will not match." >&2
            rm -f "$tmp"
            return 1
        fi
    done
    rm -f "$tmp"
}

@test "embedded CFBundleExecutable matches binary basename" {
    local svc bin tmp actual expected
    tmp="$(mktemp "${TMPDIR:-/tmp}/sw-plist.XXXXXX")"
    for svc in "${SERVICES[@]}"; do
        bin="$(resolve_binary "$svc")"
        [ -n "$bin" ] || skip "$svc-cli not built"
        extract_embedded_plist "$bin" "$tmp" || return 1
        actual="$(plutil -extract CFBundleExecutable raw "$tmp" 2>/dev/null)"
        expected="$svc-cli"
        if [ "$actual" != "$expected" ]; then
            echo "$svc-cli embedded CFBundleExecutable='$actual', expected '$expected'" >&2
            rm -f "$tmp"
            return 1
        fi
    done
    rm -f "$tmp"
}

@test "embedded CFBundleShortVersionString matches tauri.conf.json version" {
    # SSOT drift guard: build-native-macos.sh stamps tauri.conf.json's version into each
    # CLI's Resources/Info.plist before swift build. If the stamp step is skipped or the
    # tauri.conf.json version changes without a rebuild, this fails.
    local tauri_version svc bin tmp actual
    if command -v jq >/dev/null 2>&1; then
        tauri_version="$(jq -r '.version' "$REPO_ROOT/desktop/src-tauri/tauri.conf.json")"
    else
        tauri_version="$(grep -E '"version"' "$REPO_ROOT/desktop/src-tauri/tauri.conf.json" | head -1 | sed -E 's/.*"version"\s*:\s*"([^"]+)".*/\1/')"
    fi
    [ -n "$tauri_version" ] || skip "Cannot read version from tauri.conf.json"
    tmp="$(mktemp "${TMPDIR:-/tmp}/sw-plist.XXXXXX")"
    for svc in "${SERVICES[@]}"; do
        bin="$(resolve_binary "$svc")"
        [ -n "$bin" ] || skip "$svc-cli not built"
        extract_embedded_plist "$bin" "$tmp" || return 1
        actual="$(plutil -extract CFBundleShortVersionString raw "$tmp" 2>/dev/null)"
        if [ "$actual" != "$tauri_version" ]; then
            echo "$svc-cli embedded CFBundleShortVersionString='$actual', expected '$tauri_version'" >&2
            echo "  Run 'make build-native-macos' to re-stamp from tauri.conf.json." >&2
            rm -f "$tmp"
            return 1
        fi
    done
    rm -f "$tmp"
}

@test "each CLI Info.plist has correct UsageDescription key" {
    # Source-of-truth Info.plist files (read directly, not from binary) must
    # carry the right TCC usage description for each service. The linker
    # embeds these into the binary, so the source file is authoritative.
    local svc plist key val
    for svc in "${SERVICES[@]}"; do
        plist="$REPO_ROOT/native/macos/$svc/Resources/Info.plist"
        [ -f "$plist" ] || {
            echo "Missing source Info.plist: $plist" >&2
            return 1
        }
        key="${EXPECTED_USAGE_KEY[$svc]}"
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
    # Without the source plist, the linker -sectcreate flag would point at a
    # nonexistent path and the build would fail with a cryptic ld error.
    local svc plist
    for svc in "${SERVICES[@]}"; do
        plist="$REPO_ROOT/native/macos/$svc/Resources/Info.plist"
        if [ ! -f "$plist" ]; then
            echo "Missing $plist — required by Package.swift linker -sectcreate flag" >&2
            return 1
        fi
    done
}

@test "Package.swift files declare Info.plist linker flags for every CLI" {
    # Drift guard: every CLI's Package.swift must carry the -sectcreate __TEXT
    # __info_plist flags pointing at Resources/Info.plist. If a future PR adds a
    # new native CLI without these flags, EventKit/AppleEvents calls will silently
    # reject on macOS 14+. This test catches that at PR review time.
    local svc pkg pattern
    for svc in "${SERVICES[@]}"; do
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

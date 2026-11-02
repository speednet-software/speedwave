#!/usr/bin/env bats

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
SERVICES="calendar reminders mail notes audio-capture"

setup() {
    if [ "$(uname)" != "Darwin" ]; then
        skip "macOS-only: requires segedit/lipo and macOS-native CLI binaries"
    fi
}

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

require_built_binaries() {
    local svc missing=""
    for svc in $SERVICES; do
        [ -n "$(resolve_binary "$svc")" ] || missing="$missing $svc"
    done
    [ -z "$missing" ] || skip "built binaries missing for:$missing — run make build-native-macos (scripts/build-native-macos.sh for universal ones)"
}

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

assert_plist_key() {
    local svc="$1" plist="$2" key="$3" expected="$4" actual
    actual="$(plutil -extract "$key" raw "$plist" 2>/dev/null)" || {
        echo "$svc-cli embedded plist carries no $key" >&2
        return 1
    }
    [ "$actual" = "$expected" ] || {
        echo "$svc-cli embedded $key='$actual', expected '$expected'" >&2
        return 1
    }
}

@test "every native CLI has __TEXT __info_plist section" {
    require_built_binaries
    local svc bin lines
    for svc in $SERVICES; do
        bin="$(resolve_binary "$svc")"
        lines=$(otool -s __TEXT __info_plist "$bin" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$lines" -lt 3 ]; then
            echo "$svc-cli has no __TEXT __info_plist section (otool reported $lines lines)" >&2
            echo "  Likely cause: linkerSettings in $svc/Package.swift missing or stale .build cache" >&2
            return 1
        fi
    done
}

@test "embedded plist carries the right identifier and executable" {
    require_built_binaries
    local svc bin tmp expected
    tmp="$BATS_TEST_TMPDIR/sw-plist"
    for svc in $SERVICES; do
        bin="$(resolve_binary "$svc")"
        extract_embedded_plist "$bin" "$tmp" || {
            echo "Failed to extract embedded plist from $bin" >&2
            return 1
        }
        expected="$(expected_bundle_id "$svc")" || return 1
        assert_plist_key "$svc" "$tmp" CFBundleIdentifier "$expected" || {
            echo "  TCC will bind the permission to the wrong identifier." >&2
            return 1
        }
        assert_plist_key "$svc" "$tmp" CFBundleExecutable "$svc-cli" || return 1
    done
}

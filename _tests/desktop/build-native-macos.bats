#!/usr/bin/env bats

SPW_ROOT="$BATS_TEST_DIRNAME/../.."
SPW_PACKAGES="reminders calendar mail notes audio-capture"

setup() {
    if [ "$(uname)" != "Darwin" ]; then
        skip "macOS-only: evaluates the Swift package manifests"
    fi
}

assert_package_list() {
    local pkg n=0
    for pkg in $SPW_PACKAGES; do n=$((n + 1)); done
    [ "$n" -eq 5 ] || {
        echo "SPW_PACKAGES expands to $n services, expected 5" >&2
        return 1
    }
}

package_fixture_root() {
    local root pkg
    root="$(cd "$BATS_TEST_TMPDIR" && pwd -P)/native/macos"
    for pkg in shared $SPW_PACKAGES; do
        mkdir -p "$root/$pkg"
        cp "$SPW_ROOT/native/macos/$pkg/Package.swift" "$root/$pkg/"
    done
    for pkg in $SPW_PACKAGES; do
        cp -R "$SPW_ROOT/native/macos/$pkg/Resources" "$root/$pkg/"
    done
    printf '%s\n' "$root"
}

linked_info_plist() {
    swift package --package-path "$1" --manifest-cache none dump-package | python3 -c '
import json, sys
def walk(node):
    if isinstance(node, list):
        if "__info_plist" in node:
            yield node[-1]
        for item in node:
            yield from walk(item)
    elif isinstance(node, dict):
        for item in node.values():
            yield from walk(item)
found = list(walk(json.load(sys.stdin)))
if len(found) != 1:
    sys.exit("expected one -sectcreate __info_plist flag set, found %d" % len(found))
print(found[0])
'
}

assert_links_source_plist() {
    local root="$1" pkg linked
    for pkg in $SPW_PACKAGES; do
        linked="$(linked_info_plist "$root/$pkg")" || return 1
        [ "$linked" = "$root/$pkg/Resources/Info.plist" ] || {
            echo "$pkg links $linked, expected Resources/Info.plist" >&2
            return 1
        }
        [ -f "$linked" ]
    done
}

@test "Package.swift embeds Resources/Info.plist by absolute path" {
    assert_package_list
    assert_links_source_plist "$(package_fixture_root)"
}

@test "Package.swift ignores a .build/Info.plist an older build left behind" {
    assert_package_list
    local root pkg
    root="$(package_fixture_root)"
    for pkg in $SPW_PACKAGES; do
        mkdir -p "$root/$pkg/.build"
        cp "$root/$pkg/Resources/Info.plist" "$root/$pkg/.build/Info.plist"
    done
    assert_links_source_plist "$root"
}

#!/usr/bin/env bats
# Verifies that .github/workflows/backmerge.yml derives its version-file lists
# (VERSION_EXCLUDES / AUTO_RESOLVE_FILES) from release-please-config.json
# `extra-files` at runtime, so they can never drift out of sync. Only files
# release-please bumps but does NOT list in extra-files (its own
# manifest/config/workflow, lockfiles, CHANGELOG) may be hardcoded inline.
#
# Before this derivation, both lists were ~30-entry hand-synced arrays that
# silently broke the backmerge on every new worker. See CLAUDE.md SSOT note.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
CONFIG="$REPO_ROOT/release-please-config.json"
BACKMERGE="$REPO_ROOT/.github/workflows/backmerge.yml"

# extra-files paths (plain strings and {path: ...} objects).
_extra_files() {
    python3 -c "
import json
with open('$CONFIG') as f:
    cfg = json.load(f)
for item in cfg['packages']['.']['extra-files']:
    if isinstance(item, str):
        print(item)
    elif isinstance(item, dict) and 'path' in item:
        print(item['path'])
"
}

# Paths hardcoded in the STATIC_VERSION_FILES bash array in the YAML.
# Use [[:space:]] (not \s) so BSD awk on macOS matches the closing paren line.
_static_version_files() {
    awk '
        /STATIC_VERSION_FILES=\(/ { capture=1; next }
        capture && /^[[:space:]]*\)/ { capture=0; next }
        capture { gsub(/^[ \t]+|[ \t]+$/, ""); if ($0) print }
    ' "$BACKMERGE"
}

@test "backmerge derives RP_EXTRA_FILES from release-please-config.json via jq" {
    # The whole point: the per-package list is read from the SSOT, not retyped.
    grep -q "release-please-config.json" "$BACKMERGE"
    grep -Eq 'mapfile -t RP_EXTRA_FILES' "$BACKMERGE"
    grep -Eq 'jq -r .*extra-files' "$BACKMERGE"
}

@test "both arrays are built from RP_EXTRA_FILES + STATIC_VERSION_FILES" {
    grep -Eq 'VERSION_EXCLUDES\+=\(":!\$f"\)' "$BACKMERGE"
    grep -Eq 'AUTO_RESOLVE_FILES=\("\$\{RP_EXTRA_FILES\[@\]\}" "\$\{STATIC_VERSION_FILES\[@\]\}"\)' "$BACKMERGE"
}

@test "no extra-file is hardcoded in STATIC_VERSION_FILES (would duplicate the SSOT)" {
    local dupes=()
    while IFS= read -r f; do
        if _static_version_files | grep -qxF "$f"; then
            dupes+=("$f")
        fi
    done < <(_extra_files)

    if [ "${#dupes[@]}" -gt 0 ]; then
        echo "extra-files entries duplicated in STATIC_VERSION_FILES (remove them — they are derived):"
        printf '  %s\n' "${dupes[@]}"
        return 1
    fi
}

@test "STATIC_VERSION_FILES holds exactly the release-please files absent from extra-files" {
    # These are bumped by release-please but never appear in extra-files, so
    # they must stay inline. Drift here = a missed conflict on backmerge.
    local expected=(
        .release-please-manifest.json
        release-please-config.json
        .github/workflows/release-please.yml
        CHANGELOG.md
        package-lock.json
        mcp-servers/package-lock.json
        Cargo.lock
        desktop/src-tauri/Cargo.lock
    )
    local actual
    actual="$(_static_version_files | sort)"
    local want
    want="$(printf '%s\n' "${expected[@]}" | sort)"
    [ "$actual" = "$want" ]
}

#!/usr/bin/env bats
# Verifies that release-please-config.json extra-files stays a subset of
# .github/workflows/backmerge.yml AUTO_RESOLVE_FILES and VERSION_EXCLUDES.
#
# Without this alignment, the automated backmerge main → dev hits add/add
# conflicts on every file release-please bumped that the auto-resolver
# doesn't know about. See CLAUDE.md SSOT-alignment note.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
CONFIG="$REPO_ROOT/release-please-config.json"
BACKMERGE="$REPO_ROOT/.github/workflows/backmerge.yml"

# Extract path strings from extra-files (both plain strings and {path: ...} objects)
_extra_files() {
    python3 -c "
import json, sys
with open('$CONFIG') as f:
    cfg = json.load(f)
for item in cfg['packages']['.']['extra-files']:
    if isinstance(item, str):
        print(item)
    elif isinstance(item, dict) and 'path' in item:
        print(item['path'])
"
}

# Extract paths from AUTO_RESOLVE_FILES bash array in the YAML
_auto_resolve_files() {
    awk '
        /AUTO_RESOLVE_FILES=\(/ { capture=1; next }
        capture && /^\s*\)/ { capture=0; next }
        capture { gsub(/^[ \t]+|[ \t]+$/, ""); if ($0) print }
    ' "$BACKMERGE"
}

# Extract excluded paths from VERSION_EXCLUDES (strip ':!' prefix and quotes)
_version_excludes() {
    awk '
        /VERSION_EXCLUDES=\(/ { capture=1; next }
        capture && /^\s*\)/ { capture=0; next }
        capture {
            gsub(/^[ \t]+|[ \t]+$/, "");
            # Each line may have one or more "':!path'" tokens
            n = split($0, tokens, /[ \t]+/);
            for (i = 1; i <= n; i++) {
                t = tokens[i];
                gsub(/^['\''"]:!/, "", t);
                gsub(/['\''"]$/, "", t);
                if (t) print t;
            }
        }
    ' "$BACKMERGE"
}

@test "every release-please extra-file is in backmerge AUTO_RESOLVE_FILES" {
    local missing=()
    while IFS= read -r f; do
        if ! _auto_resolve_files | grep -qxF "$f"; then
            missing+=("$f")
        fi
    done < <(_extra_files)

    if [ "${#missing[@]}" -gt 0 ]; then
        echo "Files in release-please extra-files but NOT in AUTO_RESOLVE_FILES:"
        printf '  %s\n' "${missing[@]}"
        echo ""
        echo "Add them to AUTO_RESOLVE_FILES in .github/workflows/backmerge.yml"
        echo "See CLAUDE.md SSOT-alignment section for the procedure."
        return 1
    fi
}

@test "every release-please extra-file is in backmerge VERSION_EXCLUDES" {
    local missing=()
    while IFS= read -r f; do
        if ! _version_excludes | grep -qxF "$f"; then
            missing+=("$f")
        fi
    done < <(_extra_files)

    if [ "${#missing[@]}" -gt 0 ]; then
        echo "Files in release-please extra-files but NOT in VERSION_EXCLUDES:"
        printf '  %s\n' "${missing[@]}"
        echo ""
        echo "Add them to VERSION_EXCLUDES in .github/workflows/backmerge.yml"
        echo "See CLAUDE.md SSOT-alignment section for the procedure."
        return 1
    fi
}

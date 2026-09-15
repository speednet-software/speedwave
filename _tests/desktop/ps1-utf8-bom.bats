#!/usr/bin/env bats

# Every tracked .ps1 must be UTF-8 with BOM: Windows PowerShell 5.1 reads a BOM-less .ps1 in the
# system ANSI code page, which garbles non-ASCII text (cross-platform rules).

REPO_ROOT="$BATS_TEST_DIRNAME/../.."

@test "every tracked .ps1 starts with a UTF-8 BOM" {
    local count=0 offenders="" file
    while IFS= read -r file; do
        count=$((count + 1))
        [ "$(od -An -tx1 -N3 "$REPO_ROOT/$file" | tr -d ' \n')" = "efbbbf" ] || offenders+="$file"$'\n'
    done < <(cd "$REPO_ROOT" && git ls-files '*.ps1')
    [ "$count" -ge 1 ]
    [ -z "$offenders" ] || {
        printf 'Not UTF-8 with BOM:\n%s' "$offenders" >&2
        false
    }
}

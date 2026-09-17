#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
TOKEN_RE="[^][:space:]\"'\`\$(){};|&<>=,:\\\\[]+"
NL=$'\n'

_surface_files() {
    local f
    for f in "$1/Makefile" "$1/scripts/e2e-vm.sh" \
        "$1"/.github/workflows/*.yml "$1"/.github/workflows/*.yaml \
        "$1"/.github/actions/*/action.yml "$1"/.github/actions/*/action.yaml; do
        [ -f "$f" ] || continue
        echo "$f"
    done
}

_tracked_suites() {
    git -C "$1" -c core.quotePath=false ls-files '*.bats'
}

_haystack() {
    local surfaces=() surface text rc=0
    while IFS= read -r surface; do surfaces+=("$surface"); done < <(_surface_files "$1")
    [ "${#surfaces[@]}" -gt 0 ] || return 2
    text="$(LC_ALL=C grep -hv '^[[:space:]]*#' "${surfaces[@]}")" || rc=$?
    [ "$rc" -le 1 ] || return 2
    printf '%s\n' "$text" | LC_ALL=C awk '
        sub(/\\$/, "") { joined = joined $0 " "; next }
        { print joined $0; joined = "" }
        END { if (joined != "") print joined }
    '
}

_unreferenced_suites() {
    local text refs suites path
    text="$(_haystack "$1")" || return 2
    refs="$(printf '%s\n' "$text" | LC_ALL=C grep -oE "$TOKEN_RE" | LC_ALL=C grep '\.bats$' |
        LC_ALL=C sed 's|.*/||' | LC_ALL=C sort -u)"
    suites="$(_tracked_suites "$1")" || return 2
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        case "$NL$refs$NL" in
            *"$NL${path##*/}$NL"*) ;;
            *) echo "$path" ;;
        esac
    done <<<"$suites"
}

_duplicate_basenames() {
    _tracked_suites "$1" | LC_ALL=C sed 's|.*/||' | LC_ALL=C sort | uniq -d
}

_nonliteral_suite_args() {
    local text dirs
    text="$(_haystack "$1")" || return 2
    dirs="$(_tracked_suites "$1" | LC_ALL=C sed 's|/[^/]*$||' | LC_ALL=C sort -u)"
    printf '%s\n' "$text" | LC_ALL=C grep -oE "$TOKEN_RE" | LC_ALL=C grep '\*.*\.bats$' || true
    printf '%s\n' "$text" | LC_ALL=C grep -E '(^|[^A-Za-z0-9._/-])bats([[:space:]]|$)' |
        LC_ALL=C grep -oE "$TOKEN_RE" | LC_ALL=C sed 's|/*$||' | DIRS="$dirs" LC_ALL=C awk '
            BEGIN { n = split(ENVIRON["DIRS"], dir, "\n") }
            {
                for (i = 1; i <= n; i++) {
                    tail = substr($0, length($0) - length(dir[i]))
                    if ($0 == dir[i] || tail == "/" dir[i]) { print; next }
                }
            }
        '
}

_plant_repo() {
    FIXTURE="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$FIXTURE"
    git -C "$FIXTURE" init -q
}

_plant_suite() {
    mkdir -p "$(dirname "$FIXTURE/$1")"
    printf '#!/usr/bin/env bats\n' >"$FIXTURE/$1"
    git -C "$FIXTURE" add -- "$1"
}

@test "guard is not vacuous: tracked suites and surfaces are both found" {
    run _tracked_suites "$REPO_ROOT"
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -ge 10 ]

    run _surface_files "$REPO_ROOT"
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -ge 3 ]
    printf '%s\n' "${lines[@]}" | grep -qxF "$REPO_ROOT/Makefile"
}

@test "the Makefile and scripts/e2e-vm.sh wiring surfaces exist" {
    for surface in Makefile scripts/e2e-vm.sh; do
        if [ ! -f "$REPO_ROOT/$surface" ]; then
            echo "Wiring surface $surface is missing — point _surface_files at its new path"
            return 1
        fi
    done
}

@test "every tracked bats suite basename is unique" {
    dupes="$(_duplicate_basenames "$REPO_ROOT")"
    if [ -n "$dupes" ]; then
        echo "Suite basenames shared by several files — the wiring match is by basename, rename one:"
        echo "$dupes" | sed 's/^/  /'
        return 1
    fi
}

@test "every committed bats suite is named by a Makefile target, workflow, action or e2e-vm.sh" {
    orphans="$(_unreferenced_suites "$REPO_ROOT")"
    if [ -n "$orphans" ]; then
        echo "Committed bats suites nothing ever runs — add each to a bats list in the Makefile:"
        echo "$orphans" | sed 's/^/  /'
        return 1
    fi
}

@test "no surface names bats suites by glob or by directory" {
    nonliteral="$(_nonliteral_suite_args "$REPO_ROOT")"
    if [ -n "$nonliteral" ]; then
        echo "bats suites named by glob or directory — name each suite file literally:"
        echo "$nonliteral" | sed 's/^/  /'
        return 1
    fi
}

@test "a suite named only in a comment, inside a longer token or after a non-ASCII byte is reported" {
    _plant_repo
    for suite in wired.bats café.bats commented.bats suffixed.bats report.bats; do
        _plant_suite "_tests/ci/$suite"
    done
    run _tracked_suites "$FIXTURE"
    [ "${#lines[@]}" -eq 5 ]
    printf 'test:\n\tbats _tests/ci/wired.bats \\\n\t  _tests/ci/café.bats\n# bats _tests/ci/commented.bats\n\techo _tests/ci/suffixed.bats.orig néreport.bats\n' \
        >"$FIXTURE/Makefile"

    for locale in C en_US.UTF-8; do
        LC_ALL="$locale" run _unreferenced_suites "$FIXTURE"
        [ "$status" -eq 0 ]
        [ "$output" = "_tests/ci/commented.bats${NL}_tests/ci/report.bats${NL}_tests/ci/suffixed.bats" ]
    done
}

@test "a bats invocation naming a suite directory or glob is reported, a non-bats directory mention is not" {
    _plant_repo
    _plant_suite _tests/ci/one.bats
    run _tracked_suites "$FIXTURE"
    [ "${#lines[@]}" -eq 1 ]
    printf 'a:\n\tbats --print-output-on-failure \\\n\t  _tests/ci/\nb:\n\tbats _tests/ci/*.bats\nc:\n\trsync -a _tests/ci/ host:/tmp/\n' \
        >"$FIXTURE/Makefile"

    run _nonliteral_suite_args "$FIXTURE"
    [ "$status" -eq 0 ]
    [ "$output" = "_tests/ci/*.bats${NL}_tests/ci" ]
}

@test "a basename shared by two suites is reported" {
    _plant_repo
    _plant_suite _tests/ci/dup.bats
    _plant_suite _tests/desktop/dup.bats
    _plant_suite _tests/ci/solo.bats
    run _tracked_suites "$FIXTURE"
    [ "${#lines[@]}" -eq 3 ]

    run _duplicate_basenames "$FIXTURE"
    [ "$status" -eq 0 ]
    [ "$output" = "dup.bats" ]
}

@test "an unreadable surface fails the scan instead of reading as no references" {
    _plant_repo
    _plant_suite _tests/ci/one.bats
    printf 'a:\n\tbats _tests/ci/one.bats\n' >"$FIXTURE/Makefile"
    chmod 000 "$FIXTURE/Makefile"
    if [ -r "$FIXTURE/Makefile" ]; then
        skip "running as root, a mode-000 file stays readable"
    fi

    run _unreferenced_suites "$FIXTURE"
    [ "$status" -eq 2 ]
    run _nonliteral_suite_args "$FIXTURE"
    [ "$status" -eq 2 ]
}

#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
WORKFLOW=".github/workflows/test.yml"
CI_STEP="Angular tests + coverage"

setup() {
    cd "$REPO_ROOT"
}

_ci_step_field() {
    awk -v key="$1: " -v step="- name: $CI_STEP" '
        { line = $0; sub(/[[:space:]]+$/, "", line); item = line; sub(/^[[:space:]]+/, "", item) }
        item == step { in_step = 1; next }
        in_step && (item ~ /^- [A-Za-z-]+:/ || line ~ /^  [A-Za-z_][A-Za-z0-9_-]*:$/) { exit }
        in_step && index(item, key) == 1 { value = substr(item, length(key) + 1); sub(/^[[:space:]]+/, "", value); print value }
    ' "$WORKFLOW"
}

@test "angular.json's test target loads vitest.config.ts through runnerConfig" {
    run jq -r '.projects[].architect.test.options.runnerConfig' desktop/src/angular.json
    [ "$status" -eq 0 ]
    [ "$output" = "vitest.config.ts" ] || {
        echo "desktop/src/angular.json test options.runnerConfig is '$output'; set it to vitest.config.ts."
        return 1
    }
    [ -f desktop/src/vitest.config.ts ]
}

@test "CI's Angular step runs exactly the ng test line of make coverage-angular" {
    run make --no-print-directory -n coverage-angular
    [ "$status" -eq 0 ]
    [ "$(grep -c 'ng test' <<<"$output")" = "1" ] || {
        echo "make -n coverage-angular must print exactly one ng test line:"
        echo "$output"
        return 1
    }
    recipe="$(grep 'ng test' <<<"$output")"
    [[ "$recipe" =~ ^cd\ ([^[:space:]]+)\ \&\&\ (.+)$ ]] || {
        echo "Expected 'cd <dir> && <command>', got: $recipe"
        return 1
    }
    make_dir="${BASH_REMATCH[1]}"
    make_cmd="${BASH_REMATCH[2]}"

    if grep -qiE 'runner-?config' <<<"$make_cmd"; then
        echo "make coverage-angular overrides angular.json's runnerConfig: $make_cmd"
        return 1
    fi

    run grep -cE '^[[:space:]]*- name: Angular tests \+ coverage[[:space:]]*$' "$WORKFLOW"
    [ "$output" = "1" ]
    ci_dir="$(_ci_step_field working-directory)"
    ci_cmd="$(_ci_step_field run)"
    if [ "$ci_dir" != "$make_dir" ] || [ "$ci_cmd" != "$make_cmd" ]; then
        echo "make coverage-angular runs:  (cd $make_dir) $make_cmd"
        echo "CI '$CI_STEP' runs: (cd $ci_dir) $ci_cmd"
        echo "Keep the step's working-directory and run identical to the Makefile recipe."
        return 1
    fi
}

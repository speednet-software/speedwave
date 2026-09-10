#!/usr/bin/env bats

# A `!`-prefixed pipeline is exempt from set -e (POSIX), so bats only honours such an
# assertion when it is the last executable line of the test — anywhere else it is dead.

REPO_ROOT="$BATS_TEST_DIRNAME/../.."

@test "no negated assertion sits above the last line of its test" {
    local offenders
    offenders="$(cd "$REPO_ROOT" && git ls-files '*.bats' | while read -r file; do
        awk -v f="$file" '
            /^@test/ { name = $0; n = 0; last = 0; delete body; next }
            name != "" && /^\}$/ {
                for (i = 1; i <= n; i++) {
                    if (body[i] ~ /^[[:space:]]*!/ && i < last) print f ": " name
                }
                name = ""
                next
            }
            name != "" {
                body[++n] = $0
                if ($0 !~ /^[[:space:]]*(#|$)/) last = n
            }
        ' "$file"
    done)"

    [ -z "$offenders" ] || {
        echo "Dead negated assertions (use a counted grep or run + [ \"\$status\" -ne 0 ]):" >&2
        printf '%s\n' "$offenders" >&2
        false
    }
}

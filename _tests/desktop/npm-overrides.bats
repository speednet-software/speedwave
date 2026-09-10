#!/usr/bin/env bats
# npm rewrites a dependent's declared range when an override applies, so a
# forced-but-incompatible version never shows up in `npm ls`. See alignments.md.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/check-npm-overrides.mjs"

# Writes a fixture repo: $1 = overrides JSON, $2 = lockfile packages JSON.
fixture() {
    FX="$(mktemp -d "${BATS_TEST_TMPDIR}/fx.XXXXXX")"
    printf '{"name":"fx","private":true,"overrides":%s}\n' "$1" > "$FX/package.json"
    printf '{"lockfileVersion":3,"packages":%s}\n' "$2" > "$FX/package-lock.json"
}

@test "the repository's own overrides satisfy the guard" {
    run node "$GUARD"
    [ "$status" -eq 0 ]
}

@test "an override forcing a version outside a dependent's range fails (the undici incident)" {
    fixture \
        '{"undici":"^7.24.0"}' \
        '{"":{"name":"fx"},"node_modules/jsdom":{"version":"30.0.1","dependencies":{"undici":"^8.9.0"}},"node_modules/undici":{"version":"7.29.0"}}'
    SPW_OVERRIDES_ALLOWLIST_JSON='{}' run node "$GUARD" "$FX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"not a subset"* ]]
    [[ "$output" == *"^8.9.0"* ]]
}

@test "an override widening a dependent's exact pin fails (the piscina incident)" {
    fixture \
        '{"piscina":"^5.2.0"}' \
        '{"":{"name":"fx"},"node_modules/@angular/build":{"version":"22.1.7","dependencies":{"piscina":"5.2.0"}},"node_modules/piscina":{"version":"5.2.0"}}'
    SPW_OVERRIDES_ALLOWLIST_JSON='{}' run node "$GUARD" "$FX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"not a subset"* ]]
}

@test "an override that only narrows a dependent's range passes" {
    fixture \
        '{"piscina":"~5.2.0"}' \
        '{"":{"name":"fx"},"node_modules/@angular/build":{"version":"22.1.7","dependencies":{"piscina":"^5.0.0"}},"node_modules/piscina":{"version":"5.2.0"}}'
    SPW_OVERRIDES_ALLOWLIST_JSON='{}' run node "$GUARD" "$FX"
    [ "$status" -eq 0 ]
}

@test "an override nothing depends on fails as dead config" {
    fixture \
        '{"ghost":"^1.0.0"}' \
        '{"":{"name":"fx"},"node_modules/other":{"version":"1.0.0"}}'
    SPW_OVERRIDES_ALLOWLIST_JSON='{}' run node "$GUARD" "$FX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"dead config"* ]]
}

@test "an allowlisted force still refused by a dependent passes" {
    fixture \
        '{"serialize-javascript":"^7.0.4"}' \
        '{"":{"name":"fx"},"node_modules/mocha":{"version":"10.0.0","dependencies":{"serialize-javascript":"^6.0.2"}},"node_modules/serialize-javascript":{"version":"7.0.5"}}'
    SPW_OVERRIDES_ALLOWLIST_JSON='{"package.json::serialize-javascript":"patched line"}' run node "$GUARD" "$FX"
    [ "$status" -eq 0 ]
}

@test "an allowlisted force every dependent already accepts fails as redundant" {
    fixture \
        '{"serialize-javascript":"^7.0.4"}' \
        '{"":{"name":"fx"},"node_modules/mocha":{"version":"10.0.0","dependencies":{"serialize-javascript":"^7.0.0"}},"node_modules/serialize-javascript":{"version":"7.0.5"}}'
    SPW_OVERRIDES_ALLOWLIST_JSON='{"package.json::serialize-javascript":"patched line"}' run node "$GUARD" "$FX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"redundant"* ]]
}

@test "an allowlist entry with no matching override fails as stale" {
    fixture \
        '{"piscina":"~5.2.0"}' \
        '{"":{"name":"fx"},"node_modules/@angular/build":{"version":"22.1.7","dependencies":{"piscina":"^5.0.0"}},"node_modules/piscina":{"version":"5.2.0"}}'
    SPW_OVERRIDES_ALLOWLIST_JSON='{"package.json::long-gone":"why"}' run node "$GUARD" "$FX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"stale entry"* ]]
}

@test "a nested override object fails rather than passing unanalyzed" {
    fixture \
        '{"undici":{".":"^7.24.0"}}' \
        '{"":{"name":"fx"},"node_modules/jsdom":{"version":"30.0.1","dependencies":{"undici":"^8.9.0"}},"node_modules/undici":{"version":"7.29.0"}}'
    SPW_OVERRIDES_ALLOWLIST_JSON='{}' run node "$GUARD" "$FX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"not analyzed"* ]]
}

@test "overrides with no lockfile to verify against fail" {
    FX="$(mktemp -d "${BATS_TEST_TMPDIR}/fx.XXXXXX")"
    printf '{"name":"fx","private":true,"overrides":{"undici":"^7.24.0"}}\n' > "$FX/package.json"
    SPW_OVERRIDES_ALLOWLIST_JSON='{}' run node "$GUARD" "$FX"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no readable package-lock.json"* ]]
}

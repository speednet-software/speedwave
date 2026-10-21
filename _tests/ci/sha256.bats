#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/sha256.sh"
ABC_SHA256=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad

setup() {
    printf 'abc' >"$BATS_TEST_TMPDIR/abc"
    SEALED="$BATS_TEST_TMPDIR/sealed"
    mkdir -p "$SEALED"
    ln -s "$(command -v awk)" "$SEALED/awk"
}

@test "prints the lowercase sha256 of a file" {
    run "$SCRIPT" "$BATS_TEST_TMPDIR/abc"
    [ "$status" -eq 0 ]
    [ "$output" = "$ABC_SHA256" ]
}

@test "handles a path with spaces and non-ASCII characters" {
    cp "$BATS_TEST_TMPDIR/abc" "$BATS_TEST_TMPDIR/zażółć plik"
    run "$SCRIPT" "$BATS_TEST_TMPDIR/zażółć plik"
    [ "$status" -eq 0 ]
    [ "$output" = "$ABC_SHA256" ]
}

@test "falls back to shasum and lowercases its output" {
    cat >"$SEALED/shasum" <<'EOT'
#!/bin/sh
[ "$1 $2" = "-a 256" ] || exit 9
echo "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD  $3"
EOT
    chmod +x "$SEALED/shasum"
    run env PATH="$SEALED" "$BASH" "$SCRIPT" "$BATS_TEST_TMPDIR/abc"
    [ "$status" -eq 0 ]
    [ "$output" = "$ABC_SHA256" ]
}

@test "fails when neither sha256sum nor shasum is on PATH" {
    run env PATH="$SEALED" "$BASH" "$SCRIPT" "$BATS_TEST_TMPDIR/abc"
    [ "$status" -ne 0 ]
    [[ "$output" == *"neither sha256sum nor shasum is on PATH"* ]]
}

@test "fails on a missing file" {
    run "$SCRIPT" "$BATS_TEST_TMPDIR/absent"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no such file: $BATS_TEST_TMPDIR/absent"* ]]
}

@test "requires exactly one argument" {
    run "$SCRIPT"
    [ "$status" -eq 2 ]
    run "$SCRIPT" a b
    [ "$status" -eq 2 ]
}

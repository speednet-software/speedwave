#!/usr/bin/env bats

REPO_ROOT="$BATS_TEST_DIRNAME/../.."

setup() {
    BIN="$(mktemp -d "${BATS_TEST_TMPDIR}/py.XXXXXX")"
}

teardown() {
    rm -rf "$BIN"
}

fake_python() {
    cat > "$BIN/$1" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-c" ]; then exit $2; fi
printf '%s\n' "\$*" > "$BIN/$1.args"
EOF
    chmod +x "$BIN/$1"
}

store_stub() {
    printf '#!/usr/bin/env bash\necho "Python was not found; run without arguments to install from the Microsoft Store" >&2\nexit 9009\n' > "$BIN/$1"
    chmod +x "$BIN/$1"
}

@test "guard passes with a real Python 3" {
    run make -C "$REPO_ROOT" guard-python PYTHON="$(command -v python3)"
    [ "$status" -eq 0 ]
    [[ "$output" != *"Python 3 not found"* ]]
}

@test "guard refuses a missing interpreter and names the install step" {
    run make -C "$REPO_ROOT" guard-python PYTHON="$BIN/no-such-python"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Python 3 not found (PYTHON=$BIN/no-such-python)"* ]]
    [[ "$output" == *"make setup-dev-windows"* ]]
}

@test "guard refuses a Microsoft Store stub that exits with an error" {
    store_stub python3
    run make -C "$REPO_ROOT" guard-python PYTHON="$BIN/python3"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Python 3 not found"* ]]
}

@test "guard refuses an interpreter older than Python 3" {
    fake_python python2 1
    run make -C "$REPO_ROOT" guard-python PYTHON="$BIN/python2"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Python 3 not found"* ]]
}

@test "prepare-pii-ner-model stops at the guard before running the converter" {
    run make -C "$REPO_ROOT" prepare-pii-ner-model PYTHON="$BIN/no-such-python"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Python 3 not found"* ]]
    [[ "$output" != *"fetch_and_convert.py --out"* ]]
}

@test "prepare-pii-ner-model runs the converter once the guard passes" {
    fake_python python3 0
    run make -C "$REPO_ROOT" prepare-pii-ner-model PYTHON="$BIN/python3"
    [ "$status" -eq 0 ]
    [ "$(cat "$BIN/python3.args")" = "crates/pii-ner/tools/fetch_and_convert.py --out desktop/src-tauri/pii-ner" ]
}

@test "autodetection skips a python3 stub and picks a working python" {
    store_stub python3
    fake_python python 0
    run env PATH="$BIN:$PATH" make -C "$REPO_ROOT" prepare-pii-ner-model
    [ "$status" -eq 0 ]
    [ -f "$BIN/python.args" ]
    [ ! -f "$BIN/python3.args" ]
}

@test "autodetection with no working interpreter falls back to python3 and the guard names it" {
    store_stub python3
    store_stub python
    run env PATH="$BIN:$PATH" make -C "$REPO_ROOT" guard-python
    [ "$status" -ne 0 ]
    [[ "$output" == *"Python 3 not found (PYTHON=python3)"* ]]
}

#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/ci-clean-cargo-target.sh"
HASH=0123456789abcdef

setup() {
    TARGET="$BATS_TEST_TMPDIR/st"
    STUBS="$BATS_TEST_TMPDIR/stubs"
    mkdir -p "$STUBS" "$BATS_TEST_TMPDIR/ws-a" "$BATS_TEST_TMPDIR/ws-b"

    cat >"$BATS_TEST_TMPDIR/ws-a.json" <<'EOT'
{"packages":[{"name":"speedwave-runtime","targets":[
  {"name":"speedwave_runtime","kind":["lib"]},
  {"name":"speedwave-cli","kind":["bin"]},
  {"name":"integration_it","kind":["test"]},
  {"name":"build-script-build","kind":["custom-build"]}]}]}
EOT
    cat >"$BATS_TEST_TMPDIR/ws-b.json" <<'EOT'
{"packages":[{"name":"speedwave-desktop","targets":[
  {"name":"speedwave_desktop_lib","kind":["lib","cdylib"]},
  {"name":"speedwave-desktop","kind":["bin"]}]}]}
EOT
    cat >"$STUBS/cargo" <<'EOT'
#!/usr/bin/env bash
[ "${STUB_CARGO_FAIL:-}" = 1 ] && exit 101
while [ "$#" -gt 0 ]; do
    [ "$1" = "--manifest-path" ] && manifest="$2"
    shift
done
cat "$(dirname "$manifest")/../$(basename "$(dirname "$manifest")").json"
EOT
    chmod +x "$STUBS/cargo"
    PATH="$STUBS:$PATH"
    MANIFEST_A="$BATS_TEST_TMPDIR/ws-a/Cargo.toml"
    MANIFEST_B="$BATS_TEST_TMPDIR/ws-b/Cargo.toml"

    build_profile "$TARGET/release"
    build_profile "$TARGET/wasm32-unknown-unknown/release"
    mkdir -p "$TARGET/.tauri/NSIS" "$TARGET/.tauri/WixTools314"
    touch "$TARGET/CACHEDIR.TAG" "$TARGET/.rustc_info.json" \
        "$TARGET/.tauri/NSIS/makensis.exe" "$TARGET/.tauri/WixTools314/candle.exe"
}

build_profile() {
    local p="$1"
    mkdir -p "$p/deps" "$p/.fingerprint" "$p/build" "$p/bundle/nsis" "$p/bundle/msi" "$p/examples" "$p/incremental/x"
    touch "$p/speedwave-desktop.exe" "$p/speedwave_desktop.pdb" "$p/speedwave-desktop.d" "$p/.cargo-lock"
    touch "$p/bundle/nsis/Speedwave_setup.exe" "$p/bundle/msi/Speedwave.msi" "$p/examples/e.exe"
    local f
    for f in libdepa-$HASH.rlib depa-$HASH.d libdepb-$HASH.rlib libdepb-$HASH.rmeta \
        libspeedwave_runtime-$HASH.rlib speedwave_runtime-$HASH.d speedwave_runtime.pdb \
        speedwave_cli-$HASH.exe speedwave_cli-$HASH.pdb integration_it-$HASH.exe \
        libspeedwave_desktop_lib-$HASH.rlib speedwave_desktop_lib.dll.lib speedwave_desktop-$HASH.exe \
        libspeedwave_runtime_extra-$HASH.rlib build_script_build-$HASH.exe; do
        touch "$p/deps/$f"
    done
    for f in depa-$HASH depb-$HASH speedwave-runtime-$HASH speedwave-desktop-$HASH speedwave-runtime-extra-$HASH; do
        mkdir -p "$p/.fingerprint/$f"
        touch "$p/.fingerprint/$f/lib-x"
    done
    for f in depa-$HASH speedwave-desktop-$HASH speedwave-runtime-$HASH; do
        mkdir -p "$p/build/$f"
        touch "$p/build/$f/output"
    done
}

run_clean() {
    run "$SCRIPT" "$TARGET" "$MANIFEST_A" "$MANIFEST_B"
}

@test "removes members' artifacts from deps, .fingerprint and build" {
    run_clean
    [ "$status" -eq 0 ]
    for p in release wasm32-unknown-unknown/release; do
        [ ! -e "$TARGET/$p/deps/libspeedwave_runtime-$HASH.rlib" ]
        [ ! -e "$TARGET/$p/deps/speedwave_runtime-$HASH.d" ]
        [ ! -e "$TARGET/$p/deps/speedwave_runtime.pdb" ]
        [ ! -e "$TARGET/$p/deps/speedwave_cli-$HASH.exe" ]
        [ ! -e "$TARGET/$p/deps/speedwave_cli-$HASH.pdb" ]
        [ ! -e "$TARGET/$p/deps/integration_it-$HASH.exe" ]
        [ ! -e "$TARGET/$p/deps/libspeedwave_desktop_lib-$HASH.rlib" ]
        [ ! -e "$TARGET/$p/deps/speedwave_desktop_lib.dll.lib" ]
        [ ! -e "$TARGET/$p/deps/speedwave_desktop-$HASH.exe" ]
        [ ! -e "$TARGET/$p/.fingerprint/speedwave-runtime-$HASH" ]
        [ ! -e "$TARGET/$p/.fingerprint/speedwave-desktop-$HASH" ]
        [ ! -e "$TARGET/$p/build/speedwave-desktop-$HASH" ]
        [ ! -e "$TARGET/$p/build/speedwave-runtime-$HASH" ]
    done
}

@test "keeps the dependencies of both workspaces sharing the directory" {
    run_clean
    [ "$status" -eq 0 ]
    for p in release wasm32-unknown-unknown/release; do
        [ -e "$TARGET/$p/deps/libdepa-$HASH.rlib" ]
        [ -e "$TARGET/$p/deps/depa-$HASH.d" ]
        [ -e "$TARGET/$p/deps/libdepb-$HASH.rlib" ]
        [ -e "$TARGET/$p/deps/libdepb-$HASH.rmeta" ]
        [ -e "$TARGET/$p/.fingerprint/depa-$HASH/lib-x" ]
        [ -e "$TARGET/$p/.fingerprint/depb-$HASH/lib-x" ]
        [ -e "$TARGET/$p/build/depa-$HASH/output" ]
    done
}

@test "keeps a dependency whose name only starts with a member name" {
    run_clean
    [ "$status" -eq 0 ]
    [ -e "$TARGET/release/deps/libspeedwave_runtime_extra-$HASH.rlib" ]
    [ -e "$TARGET/release/.fingerprint/speedwave-runtime-extra-$HASH/lib-x" ]
}

@test "keeps build scripts of dependencies" {
    run_clean
    [ "$status" -eq 0 ]
    [ -e "$TARGET/release/deps/build_script_build-$HASH.exe" ]
}

@test "removes the installers, binaries and other profile content" {
    run_clean
    [ "$status" -eq 0 ]
    for p in release wasm32-unknown-unknown/release; do
        [ ! -e "$TARGET/$p/bundle" ]
        [ ! -e "$TARGET/$p/examples" ]
        [ ! -e "$TARGET/$p/incremental" ]
        [ ! -e "$TARGET/$p/speedwave-desktop.exe" ]
        [ ! -e "$TARGET/$p/speedwave_desktop.pdb" ]
        [ ! -e "$TARGET/$p/speedwave-desktop.d" ]
        [ -d "$TARGET/$p/deps" ]
        [ -d "$TARGET/$p/.fingerprint" ]
        [ -d "$TARGET/$p/build" ]
    done
}

@test "keeps the Tauri tool directory and the cache marker" {
    run_clean
    [ "$status" -eq 0 ]
    [ -e "$TARGET/.tauri/NSIS/makensis.exe" ]
    [ -e "$TARGET/.tauri/WixTools314/candle.exe" ]
    [ -e "$TARGET/CACHEDIR.TAG" ]
    [ ! -e "$TARGET/.rustc_info.json" ]
}

@test "reports the sizes before and after" {
    head -c 3145728 /dev/zero >"$TARGET/release/bundle/nsis/Speedwave_setup.exe"
    run_clean
    [ "$status" -eq 0 ]
    [[ "$output" =~ "ci-clean-cargo-target: $TARGET went from 3 MiB to 0 MiB" ]]
}

@test "a second run changes nothing more" {
    run_clean
    local first
    first="$(cd "$TARGET" && find . | sort)"
    run_clean
    [ "$status" -eq 0 ]
    [ "$first" = "$(cd "$TARGET" && find . | sort)" ]
}

@test "a missing target directory warns and succeeds" {
    run "$SCRIPT" "$BATS_TEST_TMPDIR/absent" "$MANIFEST_A"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "::warning::" ]]
    [[ "$output" =~ "target directory $BATS_TEST_TMPDIR/absent does not exist" ]]
}

@test "a cargo metadata failure warns, succeeds and deletes nothing" {
    local before
    before="$(cd "$TARGET" && find . | sort)"
    STUB_CARGO_FAIL=1 run_clean
    [ "$status" -eq 0 ]
    [[ "$output" =~ "::warning::" ]]
    [[ "$output" =~ "cargo metadata failed" ]]
    [ "$before" = "$(cd "$TARGET" && find . | sort)" ]
}

@test "arguments are required" {
    run "$SCRIPT" "$TARGET"
    [ "$status" -eq 2 ]
}

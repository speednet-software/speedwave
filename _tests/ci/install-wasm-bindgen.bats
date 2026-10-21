#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/install-wasm-bindgen.sh"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    else
        shasum -a 256 "$1" | awk '{ print $1 }'
    fi
}

write_lockfile() {
    cat >"$LOCK" <<EOT
version = 4

[[package]]
name = "wasm-bindgen-shared"
version = "9.9.9"

[[package]]
name = "wasm-bindgen"
version = "$1"
source = "registry+https://github.com/rust-lang/crates.io-index"
EOT
}

publish_release() {
    local version="$1" target="$2" reported="$3" name pkg
    name="wasm-bindgen-$version-$target"
    pkg="$SERVED/pkg/$name"
    mkdir -p "$pkg" "$SERVED/$version"
    printf '#!/bin/sh\necho "wasm-bindgen %s"\n' "$reported" >"$pkg/wasm-bindgen"
    chmod +x "$pkg/wasm-bindgen"
    echo license >"$pkg/LICENSE-MIT"
    tar -czf "$SERVED/$version/$name.tar.gz" -C "$SERVED/pkg" "$name"
    printf '%s  gh-release/%s.tar.gz\n' "$(sha256_of "$SERVED/$version/$name.tar.gz")" "$name" >"$SERVED/$version/$name.tar.gz.sha256sum"
}

setup() {
    LOCK="$BATS_TEST_TMPDIR/Cargo.lock"
    SERVED="$BATS_TEST_TMPDIR/served"
    STUBS="$BATS_TEST_TMPDIR/stubs"
    DEST="$BATS_TEST_TMPDIR/dest"
    GITHUB_PATH_FILE="$BATS_TEST_TMPDIR/github-path"
    CURL_LOG="$BATS_TEST_TMPDIR/curl.log"
    mkdir -p "$SERVED" "$STUBS"
    : >"$GITHUB_PATH_FILE"
    : >"$CURL_LOG"
    cat >"$STUBS/curl" <<'EOT'
#!/usr/bin/env bash
out="" url=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        --retry) shift 2 ;;
        -*) shift ;;
        *) url="$1"; shift ;;
    esac
done
echo "$url" >>"$CURL_LOG"
src="$SERVED/${url#https://github.com/wasm-bindgen/wasm-bindgen/releases/download/}"
[ -f "$src" ] || exit 22
cp "$src" "$out"
EOT
    chmod +x "$STUBS/curl"
    write_uname Darwin arm64
    export LOCK SERVED CURL_LOG
}

write_uname() {
    cat >"$STUBS/uname" <<EOT
#!/usr/bin/env bash
case "\$1" in
    -s) echo $1 ;;
    -m) echo $2 ;;
esac
EOT
    chmod +x "$STUBS/uname"
}

install_wasm_bindgen() {
    PATH="$STUBS:$PATH" WASM_BINDGEN_LOCKFILE="$LOCK" GITHUB_PATH="$GITHUB_PATH_FILE" run "$SCRIPT" "$@"
}

@test "installs the wasm-bindgen release of the Cargo.lock version for Apple silicon" {
    write_lockfile 1.2.3
    publish_release 1.2.3 aarch64-apple-darwin 1.2.3
    publish_release 9.9.9 aarch64-apple-darwin 9.9.9

    install_wasm_bindgen "$DEST"
    [ "$status" -eq 0 ]
    [ "$output" = "$DEST" ]
    [ "$("$DEST/wasm-bindgen" --version)" = "wasm-bindgen 1.2.3" ]
    [ "$(cat "$GITHUB_PATH_FILE")" = "$DEST" ]
    [ "$(wc -l <"$CURL_LOG" | tr -d ' ')" -eq 2 ]
    grep -qx 'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/1.2.3/wasm-bindgen-1.2.3-aarch64-apple-darwin.tar.gz' "$CURL_LOG"
    grep -qx 'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/1.2.3/wasm-bindgen-1.2.3-aarch64-apple-darwin.tar.gz.sha256sum' "$CURL_LOG"
}

@test "installs the Intel macOS release on an x86_64 Mac" {
    write_uname Darwin x86_64
    write_lockfile 1.2.3
    publish_release 1.2.3 x86_64-apple-darwin 1.2.3

    install_wasm_bindgen "$DEST"
    [ "$status" -eq 0 ]
    [ "$("$DEST/wasm-bindgen" --version)" = "wasm-bindgen 1.2.3" ]
    grep -q 'wasm-bindgen-1.2.3-x86_64-apple-darwin.tar.gz$' "$CURL_LOG"
}

@test "installs into a default directory named after the version and leaves GITHUB_PATH alone when unset" {
    write_lockfile 1.2.3
    publish_release 1.2.3 aarch64-apple-darwin 1.2.3

    PATH="$STUBS:$PATH" WASM_BINDGEN_LOCKFILE="$LOCK" RUNNER_TEMP="$BATS_TEST_TMPDIR/runner" run env -u GITHUB_PATH "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = "$BATS_TEST_TMPDIR/runner/wasm-bindgen-1.2.3" ]
    [ -x "$output/wasm-bindgen" ]
    [ ! -s "$GITHUB_PATH_FILE" ]
}

@test "refuses an archive whose sha256 differs from the release checksum and installs nothing" {
    write_lockfile 1.2.3
    publish_release 1.2.3 aarch64-apple-darwin 1.2.3
    printf '%s  gh-release/wasm-bindgen-1.2.3-aarch64-apple-darwin.tar.gz\n' "$(printf 'x%.0s' $(seq 64))" \
        >"$SERVED/1.2.3/wasm-bindgen-1.2.3-aarch64-apple-darwin.tar.gz.sha256sum"

    install_wasm_bindgen "$DEST"
    [ "$status" -ne 0 ]
    [[ "$output" == *"sha256 mismatch"* ]]
    [ ! -e "$DEST/wasm-bindgen" ]
    [ ! -s "$GITHUB_PATH_FILE" ]
}

@test "refuses a binary that reports another version than Cargo.lock" {
    write_lockfile 1.2.3
    publish_release 1.2.3 aarch64-apple-darwin 1.2.4

    install_wasm_bindgen "$DEST"
    [ "$status" -ne 0 ]
    [[ "$output" == *"expected 'wasm-bindgen 1.2.3'"* ]]
    [ ! -s "$GITHUB_PATH_FILE" ]
}

@test "fails when the release has no asset for the locked version" {
    write_lockfile 1.2.3

    install_wasm_bindgen "$DEST"
    [ "$status" -ne 0 ]
    [ ! -e "$DEST/wasm-bindgen" ]
    [ ! -s "$GITHUB_PATH_FILE" ]
}

@test "fails when Cargo.lock has no wasm-bindgen package" {
    printf 'version = 4\n\n[[package]]\nname = "wasm-bindgen-shared"\nversion = "9.9.9"\n' >"$LOCK"

    install_wasm_bindgen "$DEST"
    [ "$status" -ne 0 ]
    [[ "$output" == *"wasm-bindgen is not in"* ]]
    [ ! -s "$CURL_LOG" ]
}

@test "fails on a host with no mapped prebuilt target before downloading anything" {
    write_uname Linux x86_64
    write_lockfile 1.2.3

    install_wasm_bindgen "$DEST"
    [ "$status" -ne 0 ]
    [[ "$output" == *"no prebuilt wasm-bindgen is mapped for Linux x86_64"* ]]
    [ ! -s "$CURL_LOG" ]
}

@test "reads the version from the repository Cargo.lock by default" {
    PATH="$STUBS:$PATH" run env -u WASM_BINDGEN_LOCKFILE -u GITHUB_PATH "$SCRIPT" "$DEST"
    [ "$status" -ne 0 ]
    local url version
    url="$(head -n 1 "$CURL_LOG")"
    [[ "$url" =~ /download/([0-9]+\.[0-9]+\.[0-9]+)/wasm-bindgen-([0-9.]+)-aarch64-apple-darwin\.tar\.gz$ ]]
    version="${BASH_REMATCH[1]}"
    [ "${BASH_REMATCH[2]}" = "$version" ]
    grep -A1 -x 'name = "wasm-bindgen"' "$BATS_TEST_DIRNAME/../../Cargo.lock" | grep -qx "version = \"$version\""
}

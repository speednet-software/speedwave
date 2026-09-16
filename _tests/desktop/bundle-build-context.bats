#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.sh"
BUILD_WASM="$BATS_TEST_DIRNAME/../../crates/pii-engine-wasm/build-wasm.sh"
REAL_MCP_SERVERS="$BATS_TEST_DIRNAME/../../mcp-servers"
REAL_CONTAINERS="$BATS_TEST_DIRNAME/../../containers"

rm_with_retry() {
    local target="$1"
    local attempt
    for attempt in 1 2 3 4 5; do
        rm -rf "$target" 2>/dev/null && return 0
        sleep 0.2
    done
    rm -rf "$target"
}

stage_tracked_copy() {
    local src="$1" dir="$2" f files=()
    git -C "$src" ls-files -z --cached -- . > "$dir.list"
    while IFS= read -r -d '' f; do
        if [ -e "$src/$f" ]; then files+=("$f"); fi
    done < "$dir.list"
    [ "${#files[@]}" -gt 0 ]
    printf '%s\0' "${files[@]}" > "$dir.list"
    tar -C "$src" -cf "$dir.tar" --null -T "$dir.list"
    mkdir -p "$dir"
    tar -xf "$dir.tar" -C "$dir"
    [ "$(find "$dir" \( -type f -o -type l \) | wc -l)" -eq "${#files[@]}" ]
}

assert_run_waits_for_lock() {
    local lock="$1" sentinel="$2" pid i rc=0 why=""
    shift 2
    mkdir -p "$lock" "$(dirname "$sentinel")"
    echo "$$" > "$lock/pid"
    touch "$sentinel"
    [ "$(cat "$lock/pid")" = "$$" ]
    [ -f "$sentinel" ]

    "$@" &
    pid=$!
    for i in 1 2 3 4 5 6 7 8 9 10; do
        [ -f "$sentinel" ] || why="started its body while $lock was held"
        [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ] || why="reclaimed or overwrote the held $lock"
        kill -0 "$pid" 2>/dev/null || why="exited instead of waiting for $lock"
        [ -z "$why" ] || break
        sleep 0.2
    done
    if [ -n "$why" ]; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        echo "$* $why"
        return 1
    fi

    rm -rf "$lock"
    wait "$pid" || rc=$?
    [ "$rc" -eq 0 ]
    [ ! -e "$sentinel" ]
    [ ! -d "$lock" ]
}

tree_fingerprint() {
    local d
    for d in "$@"; do
        (cd "$d" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 cksum)
    done
}

setup() {
    DEST="$(mktemp -d "${TMPDIR:-/tmp}/bundle-bats.XXXXXX")"
    export BUNDLE_DEST="$DEST"
    WASM_DIR="$DEST/wasm"
    export BUNDLE_WASM_PKG_DIR="$WASM_DIR/wasm-pkg"
    WASM_LOCK="$WASM_DIR/.wasm-build.lock"
}

teardown() {
    rm_with_retry "$DEST"
}

@test "bundle script exists and is executable" {
    [ -x "$SCRIPT" ]
}

@test "bundle script creates build-context/containers/ with its dotfiles and nested dirs" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/build-context/containers" ]
    [ -f "$DEST/build-context/containers/.dockerignore" ]
    [ -f "$DEST/build-context/containers/proxy/src/main.rs" ]
}

@test "bundle script copies Containerfile.claude" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$DEST/build-context/containers/Containerfile.claude" ]
}

@test "bundle script vendors crates/pii-engine into containers/crates for the proxy build context" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/build-context/containers/crates/pii-engine/src" ]
    [ -f "$DEST/build-context/containers/crates/pii-engine/Cargo.toml" ]
    [ ! -d "$DEST/build-context/containers/crates/pii-engine/target" ]
    [ -f "$DEST/build-context/containers/mcp-servers/policies/rules.yaml" ]
}

@test "every ImageDef hash input resolves inside the staged build-context" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    local build_rs="$BATS_TEST_DIRNAME/../../crates/speedwave-runtime/src/build.rs"
    local inputs
    inputs="$(awk '/^pub const IMAGES/,/^\];/' "$build_rs" \
        | awk '/hash_inputs: &\[/,/\]/' | grep -oE '"[^"]+"' | tr -d '"' | sort -u)"
    [ -n "$inputs" ]
    local missing=""
    local p
    while IFS= read -r p; do
        if [ ! -e "$DEST/build-context/$p" ] && [ ! -e "$DEST/build-context/containers/$p" ]; then
            missing="$missing $p"
        fi
    done <<< "$inputs"
    if [ -n "$missing" ]; then
        echo "hash inputs unresolvable in the staged build-context:$missing"
        return 1
    fi
    local -a input_paths=()
    while IFS= read -r p; do input_paths+=("$p"); done <<< "$inputs"
    local symlinks
    symlinks="$(cd "$BATS_TEST_DIRNAME/../.." && git ls-files -s -- "${input_paths[@]}" containers/claude-resources | awk '$1 == "120000"')"
    if [ -n "$symlinks" ]; then
        echo "symlinks committed under image hash inputs (the digest rejects them):"
        echo "$symlinks"
        return 1
    fi
}

@test "bundle script excludes host build outputs from containers/ at copy time (target, dist, node_modules)" {
    local copy="$DEST/containers-src"
    stage_tracked_copy "$REAL_CONTAINERS" "$copy"
    local marker="$copy/.bats-prune-check"
    mkdir -p "$marker/target" "$marker/dist" "$marker/node_modules"
    echo x > "$marker/target/blob"
    echo x > "$marker/dist/blob"
    echo x > "$marker/node_modules/blob"
    echo x > "$marker/keep.txt"
    [ "$(find "$marker" -type f | wc -l)" -eq 4 ]

    BUNDLE_CONTAINERS_DIR="$copy" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$DEST/build-context/containers/.bats-prune-check/keep.txt" ]
    [ ! -d "$DEST/build-context/containers/.bats-prune-check/target" ]
    [ ! -d "$DEST/build-context/containers/.bats-prune-check/dist" ]
    [ ! -d "$DEST/build-context/containers/.bats-prune-check/node_modules" ]
}

@test "bundle script never enumerates containers/proxy/target: an unreadable transient rustc deps file cannot break the copy" {
    local copy="$DEST/containers-src"
    stage_tracked_copy "$REAL_CONTAINERS" "$copy"
    local plant="$copy/proxy/target/debug/deps/rustcbats0PLANT"
    mkdir -p "$(dirname "$plant")"
    echo transient > "$plant"
    chmod 000 "$plant"
    [ "$(find "$copy/proxy/target" -type f | wc -l)" -eq 1 ]

    BUNDLE_CONTAINERS_DIR="$copy" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$DEST/build-context/containers/proxy/src/main.rs" ]
    [ ! -e "$DEST/build-context/containers/proxy/target" ]
}

@test "bundle script copy survives a tar writer still flushing after the extractor reached end-of-archive" {
    local stub_dir="$DEST/stub-bin" stub_log="$DEST/tar-stub.log" real_tar
    real_tar="$(command -v tar)"
    [ -x "$real_tar" ]
    mkdir -p "$stub_dir"
    cat >"$stub_dir/tar" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-cf" ]; then
    "$REAL_TAR" "$@" || exit $?
    echo intercepted >>"$TAR_STUB_LOG"
    for _ in 1 2 3 4 5 6; do
        sleep 0.5
        head -c 512 /dev/zero || exit 1
    done
    exit 0
fi
exec "$REAL_TAR" "$@"
EOF
    chmod +x "$stub_dir/tar"

    REAL_TAR="$real_tar" TAR_STUB_LOG="$stub_log" PATH="$stub_dir:$PATH" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$(wc -l <"$stub_log" | tr -d ' ')" -eq 2 ]
    [ -f "$DEST/build-context/containers/proxy/src/main.rs" ]
    [ -f "$DEST/build-context/containers/crates/pii-engine/Cargo.toml" ]
}

@test "bundle script creates mcp-servers with tsconfig.base.json" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$DEST/build-context/mcp-servers/tsconfig.base.json" ]
}

@test "bundle script creates all MCP service directories" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    for svc in shared policies hub slack sharepoint redmine gitlab; do
        [ -d "$DEST/build-context/mcp-servers/$svc" ]
        [ -f "$DEST/build-context/mcp-servers/$svc/package.json" ]
        [ -d "$DEST/build-context/mcp-servers/$svc/src" ]
    done
}

@test "bundle script copies policies templates" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/build-context/mcp-servers/policies/templates" ]
    [ -f "$DEST/build-context/mcp-servers/policies/templates/strict.yaml" ]
}

@test "bundle script builds and stages a real policies/wasm-pkg artifact" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/build-context/mcp-servers/policies/wasm-pkg" ]
    shopt -s nullglob
    local staged=("$DEST/build-context/mcp-servers/policies/wasm-pkg"/*_bg.wasm)
    shopt -u nullglob
    [ "${#staged[@]}" -gt 0 ]
    [ -s "${staged[0]}" ]
}

@test "bundle script rebuilds policies/wasm-pkg from source even when a stale artifact already exists" {
    mkdir -p "$BUNDLE_WASM_PKG_DIR"
    echo fake-wasm > "$BUNDLE_WASM_PKG_DIR/pii_engine_wasm_bg.wasm"
    [ "$(grep -rl fake-wasm "$BUNDLE_WASM_PKG_DIR" | wc -l)" -eq 1 ]

    run "$SCRIPT"
    [ "$status" -eq 0 ]

    local dest_dir="$DEST/build-context/mcp-servers/policies/wasm-pkg"
    shopt -s nullglob
    local built=("$BUNDLE_WASM_PKG_DIR"/*_bg.wasm) staged=("$dest_dir"/*_bg.wasm)
    shopt -u nullglob
    [ "${#built[@]}" -eq 1 ]
    [ "${#staged[@]}" -eq 1 ]
    [ -s "${staged[0]}" ]
    [ "$(grep -rl fake-wasm "$BUNDLE_WASM_PKG_DIR" "$dest_dir" | wc -l)" -eq 0 ]
}

@test "build-wasm.sh anchors a relative out dir to the caller's cwd, not the crate dir" {
    local stub_dir="$DEST/stub-bin" caller="$DEST/caller" rel
    mkdir -p "$stub_dir"
    cat >"$stub_dir/wasm-pack" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$WASM_PACK_ARGS"
EOF
    chmod +x "$stub_dir/wasm-pack"

    for rel in 'rel/wasm-pkg' 'rel\wasm-pkg'; do
        mkdir -p "$caller/rel/wasm-pkg"
        echo stale > "$caller/rel/wasm-pkg/stale_bg.wasm"
        [ -f "$caller/rel/wasm-pkg/stale_bg.wasm" ]

        WASM_PACK_ARGS="$DEST/wasm-pack-args" PATH="$stub_dir:$PATH" \
            run bash -c 'cd "$1" && bash "$2" "$3"' _ "$caller" "$BUILD_WASM" "$rel"
        [ "$status" -eq 0 ]
        [ ! -e "$caller/rel/wasm-pkg" ]
        [ "$(grep -A1 -x -e '--out-dir' "$DEST/wasm-pack-args" | tail -n 1)" = "$(cd "$caller" && pwd)/rel/wasm-pkg" ]
    done
}

@test "build-wasm.sh keeps the same absolute path forms as scripts/cargo-target-dir.sh" {
    local absolute='/* | [A-Za-z]:* | \\\\*)'
    [ "$(grep -cF -- "$absolute" "$BUILD_WASM")" -eq 1 ]
    [ "$(grep -cF -- "$absolute" "$BATS_TEST_DIRNAME/../../scripts/cargo-target-dir.sh")" -eq 1 ]
}

@test "build-wasm.sh --lock waits on the lock beside its out dir until it is released" {
    local stub_dir="$DEST/stub-bin" out="$DEST/npm-build/wasm-pkg"
    mkdir -p "$stub_dir"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$stub_dir/wasm-pack"
    chmod +x "$stub_dir/wasm-pack"

    assert_run_waits_for_lock "$DEST/npm-build/.wasm-build.lock" "$out/stale_bg.wasm" \
        env PATH="$stub_dir:$PATH" bash "$BUILD_WASM" --lock "$out"
}

@test "build-wasm.sh without --lock builds under a lock its caller already holds" {
    local stub_dir="$DEST/stub-bin" out="$DEST/bundle-build/wasm-pkg" lock="$DEST/bundle-build/.wasm-build.lock" pid i
    mkdir -p "$stub_dir" "$lock" "$out"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$stub_dir/wasm-pack"
    chmod +x "$stub_dir/wasm-pack"
    echo "$$" > "$lock/pid"
    echo stale > "$out/stale_bg.wasm"
    [ "$(cat "$lock/pid")" = "$$" ]
    [ -f "$out/stale_bg.wasm" ]

    env PATH="$stub_dir:$PATH" bash "$BUILD_WASM" "$out" &
    pid=$!
    for i in $(seq 50); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        echo "build-wasm.sh waited on the lock its caller holds"
        return 1
    fi
    wait "$pid"
    [ ! -e "$out/stale_bg.wasm" ]
    [ "$(cat "$lock/pid")" = "$$" ]
}

@test "bundle script fails hard when the wasm toolchain is unavailable" {
    local stub_dir
    stub_dir="$(mktemp -d)"
    trap 'rm -rf "$stub_dir"' RETURN
    cat >"$stub_dir/wasm-pack" <<'EOF'
#!/usr/bin/env bash
echo "stub wasm-pack: simulated failure" >&2
exit 1
EOF
    chmod +x "$stub_dir/wasm-pack"

    PATH="$stub_dir:$PATH" run "$SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"make setup-dev"* ]]
    [ ! -d "$DEST/build-context" ]
}

@test "bundle script does not include os service in build-context" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ ! -d "$DEST/build-context/mcp-servers/os" ]
}

@test "bundle script creates mcp-os/os/dist/ and mcp-os/shared/dist/" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/mcp-os/os/dist" ]
    [ -d "$DEST/mcp-os/shared/dist" ]
}

@test "bundle script installs express in mcp-os/shared/node_modules" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/mcp-os/shared/node_modules/express" ]
}

@test "bundle script strips devDependencies from the staged shared package.json" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    run grep -q '"devDependencies"' "$DEST/mcp-os/shared/package.json"
    [ "$status" -ne 0 ]
    run grep -q '"devDependencies"' "$DEST/oauth/shared/package.json"
    [ "$status" -ne 0 ]
}

@test "bundle script creates @speedwave/mcp-shared directory in mcp-os/os" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/mcp-os/os/node_modules/@speedwave/mcp-shared" ]
    [ ! -L "$DEST/mcp-os/os/node_modules/@speedwave/mcp-shared" ]
    [ -d "$DEST/mcp-os/os/node_modules/@speedwave/mcp-shared/dist" ]
}

@test "mcp-os bundle: full import chain resolves (spawn and check)" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    local script="$DEST/mcp-os/os/dist/index.js"
    local tmpout
    tmpout="$(mktemp)"
    PORT=0 MCP_OS_AUTH_TOKEN=test-token node "$script" > "$tmpout" 2>&1 &
    local pid=$!
    local i=0
    while [ $i -lt 50 ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" || true
            echo "mcp-os exited early. Output:"
            cat "$tmpout"
            rm -f "$tmpout"
            return 1
        fi
        if grep -q '"port"' "$tmpout" 2>/dev/null; then
            kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
            rm -f "$tmpout"
            return 0
        fi
        sleep 0.1
        i=$((i + 1))
    done
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
    echo "Timeout waiting for port. Output:"
    cat "$tmpout"
    rm -f "$tmpout"
    return 1
}

@test "bundle script copies hub Containerfile" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$DEST/build-context/mcp-servers/hub/Containerfile" ]
}

@test "bundle script is idempotent (running twice succeeds)" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/build-context/containers" ]
}

@test "bundle script removes stale files on re-run" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    touch "$DEST/build-context/STALE_FILE"
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ ! -f "$DEST/build-context/STALE_FILE" ]
}

@test "bundle script references only existing source files" {
    local repo_root="$BATS_TEST_DIRNAME/../.."
    local checked=0 src resolved
    while IFS= read -r src; do
        resolved="${src//\$REPO_ROOT/$repo_root}"
        resolved="${resolved//\$MCP_SERVERS_DIR/$repo_root/mcp-servers}"
        resolved="${resolved//\$CONTAINERS_DIR/$repo_root/containers}"
        [[ "$resolved" == *'$'* ]] && continue
        checked=$((checked + 1))
        [ -e "$resolved" ] || { echo "Source path does not exist: $src (resolved: $resolved)"; return 1; }
    done < <(grep -E '^\s*(cp|copy_tree) ' "$SCRIPT" | grep -oE '"\$(REPO_ROOT|MCP_SERVERS_DIR|CONTAINERS_DIR)(/[^"]+)?"' | tr -d '"' | sort -u)
    [ "$checked" -gt 0 ]
}

@test "mcp-os/shared standalone lockfile resolves without workspace context" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$DEST/mcp-os/shared/package-lock.json" ]
    local tmpdir
    tmpdir="$(mktemp -d)"
    trap 'rm -rf "$tmpdir"' RETURN
    cp "$DEST/mcp-os/shared/package.json" "$tmpdir/"
    cp "$DEST/mcp-os/shared/package-lock.json" "$tmpdir/"
    (cd "$tmpdir" && npm ci --omit=dev --ignore-scripts)
    [ "$(ls "$tmpdir/node_modules" | wc -l)" -gt 0 ]
}

@test "bundle script normalises shell scripts to LF in build-context" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    while IFS= read -r f; do
        if grep -q $'\r' "$f"; then
            echo "CRLF detected in $f"
            return 1
        fi
    done < <(find "$DEST/build-context/containers" -type f -name '*.sh')
}

@test "bundle script strips CR from a CRLF source script (defense-in-depth)" {
    local copy="$DEST/containers-src"
    stage_tracked_copy "$REAL_CONTAINERS" "$copy"
    printf '#!/bin/bash\r\necho hi\r\n' > "$copy/install-claude.sh"
    chmod 0755 "$copy/install-claude.sh"
    [ "$(grep -c $'\r' "$copy/install-claude.sh")" -eq 2 ]
    printf '#!/bin/bash\necho hi\n' > "$DEST/expected-lf.sh"

    BUNDLE_CONTAINERS_DIR="$copy" run "$SCRIPT"
    [ "$status" -eq 0 ]
    cmp "$DEST/expected-lf.sh" "$DEST/build-context/containers/install-claude.sh"
}

@test "bundle script preserves source script permissions" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]

    local src="$BATS_TEST_DIRNAME/../../containers/install-claude.sh"
    local dst="$DEST/build-context/containers/install-claude.sh"

    local src_perms
    local dst_perms
    src_perms=$(stat -c '%a' "$src" 2>/dev/null || stat -f '%A' "$src")
    dst_perms=$(stat -c '%a' "$dst" 2>/dev/null || stat -f '%A' "$dst")
    [ "$src_perms" = "$dst_perms" ]
}

@test "bundle script releases both locks on success" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ ! -d "$DEST/.bundle.lock" ]
    [ ! -d "$WASM_LOCK" ]
}

@test "bundle script reclaims a stale lock whose holder PID is dead" {
    mkdir -p "$DEST/.bundle.lock"
    echo "2147483647" > "$DEST/.bundle.lock/pid"
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/build-context/containers" ]
    [ ! -d "$DEST/.bundle.lock" ]
}

@test "lock held by a live holder blocks a second run until released" {
    assert_run_waits_for_lock "$DEST/.bundle.lock" "$DEST/build-context/held-sentinel" "$SCRIPT"
    [ -d "$DEST/build-context/containers" ]
}

@test "wasm-build lock beside BUNDLE_WASM_PKG_DIR blocks a run until released" {
    assert_run_waits_for_lock "$WASM_LOCK" "$DEST/build-context/held-sentinel" "$SCRIPT"
    [ -d "$DEST/build-context/containers" ]
}

@test "concurrent runs on the same DEST both finish with a valid package.json" {
    "$SCRIPT" &
    local p1=$!
    "$SCRIPT" &
    local p2=$!
    local r1=0 r2=0
    wait "$p1" || r1=$?
    wait "$p2" || r2=$?
    [ "$r1" -eq 0 ]
    [ "$r2" -eq 0 ]
    [ ! -d "$DEST/.bundle.lock" ]
    local pkg="$DEST/build-context/mcp-servers/shared/package.json"
    [ -s "$pkg" ]
    node -e "JSON.parse(require('fs').readFileSync('$pkg','utf8'))"
}

@test "bundle script fails fast when a source-tree knob points at a missing tree" {
    local stub_dir="$DEST/stub-bin" knob
    mkdir -p "$stub_dir"
    printf '#!/usr/bin/env bash\ntouch "%s/wasm-pack-ran"\nexit 1\n' "$DEST" > "$stub_dir/wasm-pack"
    chmod +x "$stub_dir/wasm-pack"

    for knob in BUNDLE_MCP_SERVERS_DIR BUNDLE_CONTAINERS_DIR; do
        PATH="$stub_dir:$PATH" run env "$knob=$DEST/no-such-tree" "$SCRIPT"
        [ "$status" -ne 0 ]
        [ "$(printf '%s' "$output" | grep -cF -- "$knob")" -eq 1 ]
        [ ! -e "$DEST/wasm-pack-ran" ]
        [ ! -d "$DEST/mcp-os" ]
        [ ! -d "$DEST/.bundle.lock" ]
        [ ! -d "$WASM_DIR" ]
    done
}

@test "bundle-build-context.ps1 checks LASTEXITCODE after every npm call" {
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    [ "$(grep -cE '^[[:space:]]*npm ' "$ps1")" -gt 0 ]
    run awk '/^[[:space:]]*npm / { call = $0; if ((getline following) <= 0 || following !~ /\$LASTEXITCODE -ne 0/) print call }' "$ps1"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "bundle-build-context.ps1 releases on every exit only the locks it acquired" {
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    [ "$(grep -c '^try {$' "$ps1")" -eq 1 ]
    [ "$(grep -c '^} finally {$' "$ps1")" -eq 1 ]
    run awk '
        /^try \{$/ { in_try = 1 }
        /^\} finally \{$/ { in_try = 0; in_finally = 1 }
        /^[[:space:]]*Acquire-Lock \$/ { if (in_try) inside++; else outside++ }
        /\$heldLocks\.Add\(\$dir\)/ { added = NR }
        /Out-File -FilePath "\$dir\\pid"/ { pid_write = NR }
        in_finally && /Remove-Item/ { removes = $0 }
        END {
            if (inside != 2 || outside != 0) print "Acquire-Lock calls inside the try: " inside ", outside: " outside
            if (!added || !pid_write || added > pid_write) print "a lock must be registered before its PID write"
            if (removes !~ /\$heldLocks/ || removes ~ /\$lockDir|\$wasmLockDir/) print "the finally must remove only $heldLocks: " removes
        }' "$ps1"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "bundle-build-context.ps1 derives the wasm lock dir for a bare out dir name, like dirname" {
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    run awk '
        index($0, "$wasmParentDir = Split-Path -Parent $wasmPkgDir") == 1 { split_at = NR }
        index($0, "if (-not $wasmParentDir) { $wasmParentDir = ") == 1 { fallback_at = NR; fallback = $0 }
        index($0, "$wasmLockDir = Join-Path $wasmParentDir") == 1 { join_at = NR }
        END { exit !(split_at && split_at < fallback_at && fallback_at < join_at && fallback ~ /= .\.. \}$/) }' "$ps1"
    [ "$status" -eq 0 ]
}

@test "bundle script --ci builds a clean scratch copy and leaves a concurrent run on the real tree intact" {
    local d ws workspaces=(os shared oauth) dist_dirs=()
    for ws in "${workspaces[@]}"; do dist_dirs+=("$REAL_MCP_SERVERS/$ws/dist"); done
    for d in "${dist_dirs[@]}"; do [ -d "$d" ]; done
    local hidden_lock="$REAL_MCP_SERVERS/node_modules/.package-lock.json"
    [ -f "$hidden_lock" ]
    local copy="$DEST/mcp-servers-src"
    stage_tracked_copy "$REAL_MCP_SERVERS" "$copy"
    [ -f "$copy/package-lock.json" ]
    [ ! -d "$copy/node_modules" ]
    for ws in "${workspaces[@]}"; do [ ! -d "$copy/$ws/dist" ]; done
    local before
    before="$(tree_fingerprint "${dist_dirs[@]}")"
    [ -n "$before" ]
    local marker="$DEST/started"
    touch "$marker"
    local plain_dest="$DEST/plain-dest"

    BUNDLE_MCP_SERVERS_DIR="$copy" "$SCRIPT" --ci &
    local p_ci=$!
    BUNDLE_DEST="$plain_dest" "$SCRIPT" &
    local p_plain=$!
    local r_ci=0 r_plain=0
    wait "$p_ci" || r_ci=$?
    wait "$p_plain" || r_plain=$?
    [ "$r_ci" -eq 0 ]
    [ "$r_plain" -eq 0 ]
    [ -z "$(find "${dist_dirs[@]}" -type f -newer "$marker")" ]
    [ "$(tree_fingerprint "${dist_dirs[@]}")" = "$before" ]
    [ -f "$hidden_lock" ]
    [ -z "$(find "$hidden_lock" -newer "$marker")" ]
    [ -f "$copy/node_modules/.package-lock.json" ]
    for ws in "${workspaces[@]}"; do [ -d "$copy/$ws/dist" ]; done
    [ -d "$DEST/mcp-os/os/dist" ]
    [ -d "$DEST/mcp-os/shared/dist" ]
    [ -f "$DEST/mcp-os/shared/package.json" ]
    [ -d "$DEST/mcp-os/shared/node_modules/express" ]
    [ -d "$DEST/mcp-os/os/node_modules/@speedwave/mcp-shared" ]
    [ ! -L "$DEST/mcp-os/os/node_modules/@speedwave/mcp-shared" ]
}

@test "every COPY source in bundled Containerfiles exists in the staged tree" {
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    ctx="$BUNDLE_DEST/build-context"
    [ -d "$ctx" ] || { echo "staged context missing: $ctx"; return 1; }
    found_any=""
    fail=""
    while IFS= read -r df; do
        case "$df" in
            */mcp-servers/*) root="$ctx/mcp-servers" ;;
            *) root="$ctx/containers" ;;
        esac
        while IFS= read -r src; do
            found_any=1
            matches=$(cd "$root" 2>/dev/null && compgen -G "$src" | head -1)
            [ -n "$matches" ] || fail="$fail\n$df: missing COPY source '$src'"
        done < <(grep -E '^(COPY|ADD) ' "$df" \
                   | grep -v -- '--from=' \
                   | sed -E 's/^(COPY|ADD) +//; s/ +[^ ]+$//' \
                   | tr ' ' '\n' \
                   | grep -v '^--' \
                   | sed 's/^\.\///' \
                   | grep -v '^$')
    done < <(find "$ctx" \( -name 'Dockerfile' -o -name 'Containerfile*' \) -type f)
    [ -n "$found_any" ] || { echo "vacuous: no COPY lines parsed"; return 1; }
    if [ -n "$fail" ]; then
        echo -e "COPY sources missing from staged bundle:$fail"
        return 1
    fi
}

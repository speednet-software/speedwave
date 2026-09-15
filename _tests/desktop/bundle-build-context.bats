#!/usr/bin/env bats
# Tests for scripts/bundle-build-context.sh (expected dir structure); bundle-build-context.ps1 mirrors
# this, exercised only in Windows E2E VMs. Prerequisite: `make build-mcp` for the os/shared/oauth dist dirs.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.sh"
BUILD_WASM="$BATS_TEST_DIRNAME/../../crates/pii-engine-wasm/build-wasm.sh"
REAL_MCP_SERVERS="$BATS_TEST_DIRNAME/../../mcp-servers"
REAL_CONTAINERS="$BATS_TEST_DIRNAME/../../containers"

# Per-test temp DEST (script honours $BUNDLE_DEST). Retry rm to survive EDR open fds.
rm_with_retry() {
    local target="$1"
    local attempt
    for attempt in 1 2 3 4 5; do
        rm -rf "$target" 2>/dev/null && return 0
        sleep 0.2
    done
    rm -rf "$target"
}

# stage_tracked_copy <src> <dir>: copies the tracked files under <src> (nothing untracked or gitignored, so
# no node_modules/dist/target) into <dir>, for fixtures and rebuilds off the real tree; asserts the exact count.
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

# assert_run_waits_for_lock <lock-dir> <sentinel> <command>...: holds <lock-dir> as this live bats process and asserts
# <command> neither wipes the planted <sentinel> (its first write past the lock) nor takes the lock until it is released.
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
        # Reap the command before failing, so it never writes into a DEST that teardown is removing.
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

# tree_fingerprint <dir>...: one cksum line per file in path order, so two snapshots compare as strings.
tree_fingerprint() {
    local d
    for d in "$@"; do
        (cd "$d" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 cksum)
    done
}

setup() {
    DEST="$(mktemp -d "${TMPDIR:-/tmp}/bundle-bats.XXXXXX")"
    export BUNDLE_DEST="$DEST"
    # The wasm build and its lock land under DEST too, so no test rewrites the real policies/wasm-pkg.
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

@test "bundle script creates build-context/containers/" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/build-context/containers" ]
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
    # policy.rs include_str!s this repo-root-relative; Containerfile.proxy COPYs it.
    [ -f "$DEST/build-context/containers/mcp-servers/policies/rules.yaml" ]
}

# The digest resolver (bundle.rs::resolve_hash_input) tries <root>/<input> then
# <root>/containers/<input>; an input resolving in neither aborts every image build in an installed app.
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
}

@test "bundle script prunes host build outputs from containers/ (target, dist, node_modules)" {
    # The dirty source tree is a scratch copy of containers/ under DEST, so teardown reaps it even on failure.
    local copy="$DEST/containers-src"
    stage_tracked_copy "$REAL_CONTAINERS" "$copy"
    local marker="$copy/.bats-prune-check"
    # Non-empty dirs pin the prune to a recursive delete.
    mkdir -p "$marker/target" "$marker/dist" "$marker/node_modules"
    echo x > "$marker/target/blob"
    echo x > "$marker/dist/blob"
    echo x > "$marker/node_modules/blob"
    echo x > "$marker/keep.txt"
    [ "$(find "$marker" -type f | wc -l)" -eq 4 ]

    BUNDLE_CONTAINERS_DIR="$copy" run "$SCRIPT"
    [ "$status" -eq 0 ]
    # Sibling content survives; the three build-output dirs do not.
    [ -f "$DEST/build-context/containers/.bats-prune-check/keep.txt" ]
    [ ! -d "$DEST/build-context/containers/.bats-prune-check/target" ]
    [ ! -d "$DEST/build-context/containers/.bats-prune-check/dist" ]
    [ ! -d "$DEST/build-context/containers/.bats-prune-check/node_modules" ]
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
    # No prebuilt/placeholder fallback: the script builds crates/pii-engine-wasm itself
    # (requires wasm-pack + the wasm32 target — `make setup-dev`) and hard-fails otherwise.
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
    # A stale artifact under an older crate name, planted in this test's own wasm out dir (BUNDLE_WASM_PKG_DIR).
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
    # bundle-build-context.ps1 passes a repo-relative out dir, possibly with backslashes. The stub wasm-pack
    # records its arguments, and the planted stale file shows which dir the pre-build wipe hit.
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
    # Both anchor a relative path to a base dir; one pattern list keeps drive and UNC paths absolute in both.
    local absolute='/* | [A-Za-z]:* | \\\\*)'
    [ "$(grep -cF -- "$absolute" "$BUILD_WASM")" -eq 1 ]
    [ "$(grep -cF -- "$absolute" "$BATS_TEST_DIRNAME/../../scripts/cargo-target-dir.sh")" -eq 1 ]
}

@test "build-wasm.sh --lock waits on the lock beside its out dir until it is released" {
    # npm's build:wasm passes --lock, so it serializes with any bundle run holding the same lock.
    local stub_dir="$DEST/stub-bin" out="$DEST/npm-build/wasm-pkg"
    mkdir -p "$stub_dir"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$stub_dir/wasm-pack"
    chmod +x "$stub_dir/wasm-pack"

    assert_run_waits_for_lock "$DEST/npm-build/.wasm-build.lock" "$out/stale_bg.wasm" \
        env PATH="$stub_dir:$PATH" bash "$BUILD_WASM" --lock "$out"
}

@test "build-wasm.sh without --lock builds under a lock its caller already holds" {
    # The bundle scripts hold .wasm-build.lock through their later copy and call build-wasm.sh plain:
    # that run must neither wait on the lock nor release it.
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
    # Stub wasm-pack as a always-failing binary and put it first on PATH; the script must
    # exit non-zero with a clear remediation hint, never fall back to a placeholder dir.
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
    # Failed imports exit 1; success prints {"port":N} and keeps running.
    local script="$DEST/mcp-os/os/dist/index.js"
    local tmpout
    tmpout="$(mktemp)"
    PORT=0 MCP_OS_AUTH_TOKEN=test-token node "$script" > "$tmpout" 2>&1 &
    local pid=$!
    # Wait up to 5s for either port announcement or process exit
    local i=0
    while [ $i -lt 50 ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            # Process exited — check if it was ERR_MODULE_NOT_FOUND
            wait "$pid" || true
            echo "mcp-os exited early. Output:"
            cat "$tmpout"
            rm -f "$tmpout"
            return 1
        fi
        if grep -q '"port"' "$tmpout" 2>/dev/null; then
            # Success — port announced, imports resolved
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
    # Create a stale file that should not survive a re-run
    touch "$DEST/build-context/STALE_FILE"
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ ! -f "$DEST/build-context/STALE_FILE" ]
}

@test "bundle script references only existing source files" {
    # Every literal cp source ($REPO_ROOT, $MCP_SERVERS_DIR or $CONTAINERS_DIR, without loop variables)
    # must exist in the checkout at the knobs' defaults; a typo there only surfaces as a failed bundle otherwise.
    local repo_root="$BATS_TEST_DIRNAME/../.."
    local checked=0 src resolved
    while IFS= read -r src; do
        resolved="${src//\$REPO_ROOT/$repo_root}"
        resolved="${resolved//\$MCP_SERVERS_DIR/$repo_root/mcp-servers}"
        resolved="${resolved//\$CONTAINERS_DIR/$repo_root/containers}"
        [[ "$resolved" == *'$'* ]] && continue
        checked=$((checked + 1))
        [ -e "$resolved" ] || { echo "Source path does not exist: $src (resolved: $resolved)"; return 1; }
    done < <(grep -E '^\s*cp ' "$SCRIPT" | grep -oE '"\$(REPO_ROOT|MCP_SERVERS_DIR|CONTAINERS_DIR)(/[^"]+)?"' | tr -d '"' | sort -u)
    [ "$checked" -gt 0 ]
}

@test "mcp-os/shared standalone lockfile resolves without workspace context" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    # Verify the two-step install produced a standalone lockfile
    [ -f "$DEST/mcp-os/shared/package-lock.json" ]
    # Verify the lockfile can be consumed standalone (npm ci in clean dir succeeds)
    local tmpdir
    tmpdir="$(mktemp -d)"
    trap 'rm -rf "$tmpdir"' RETURN
    cp "$DEST/mcp-os/shared/package.json" "$tmpdir/"
    cp "$DEST/mcp-os/shared/package-lock.json" "$tmpdir/"
    (cd "$tmpdir" && npm ci --omit=dev --ignore-scripts)
    # At least one production dependency must be installed
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
    # The CRLF source goes into a scratch copy of containers/: install-claude.bats executes the real script.
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

    # GNU stat (-c) first, BSD stat (-f) fallback: GNU `stat -f` means --file-system.
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
    # Simulate a run killed with SIGKILL (untrappable): a leftover lock dir
    # pointing at a PID that no longer exists must not deadlock the next run.
    mkdir -p "$DEST/.bundle.lock"
    # PID 2147483647 (INT_MAX) is not a live process on any supported platform.
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
    # Runs sharing one wasm out dir serialize on the lock next to it, wherever that dir lives.
    assert_run_waits_for_lock "$WASM_LOCK" "$DEST/build-context/held-sentinel" "$SCRIPT"
    [ -d "$DEST/build-context/containers" ]
}

@test "concurrent runs on the same DEST both finish with a valid package.json" {
    # Two runs on the same DEST must both finish with a non-corrupt package.json.
    "$SCRIPT" &
    local p1=$!
    "$SCRIPT" &
    local p2=$!
    # Reap both before asserting, so teardown never races a live writer.
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
    # A wasm-pack stub leaves a sentinel if the wasm build starts; the knob checks must come first.
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
    # Windows PowerShell 5.1 never turns a native non-zero exit into an error and no suite runs the
    # .ps1, so an unchecked npm failure would ship a broken host-worker bundle silently.
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    [ "$(grep -cE '^[[:space:]]*npm ' "$ps1")" -gt 0 ]
    run awk '/^[[:space:]]*npm / { call = $0; if ((getline following) <= 0 || following !~ /\$LASTEXITCODE -ne 0/) print call }' "$ps1"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "bundle-build-context.ps1 releases on every exit only the locks it acquired" {
    # Pins that both acquisitions sit inside the try, a lock is registered before its PID write can fail,
    # and the finally removes only registered locks, so a failed write never strands a pid-less lock.
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
    # Split-Path -Parent yields '' for a bare name and Join-Path rejects it; the .sh `dirname` gives `.`.
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    run awk '
        index($0, "$wasmParentDir = Split-Path -Parent $wasmPkgDir") == 1 { split_at = NR }
        index($0, "if (-not $wasmParentDir) { $wasmParentDir = ") == 1 { fallback_at = NR; fallback = $0 }
        index($0, "$wasmLockDir = Join-Path $wasmParentDir") == 1 { join_at = NR }
        END { exit !(split_at && split_at < fallback_at && fallback_at < join_at && fallback ~ /= .\.. \}$/) }' "$ps1"
    [ "$status" -eq 0 ]
}

@test "bundle script --ci builds a clean scratch copy and leaves a concurrent run on the real tree intact" {
    # The plain run stages the real dist dirs while --ci rebuilds the copy; the two share only the
    # wasm-build lock, so any --ci write into the real tree (npm ci, tsc) surfaces here.
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
    # Its own DEST (own .bundle.lock), reaped with $DEST by teardown.
    local plain_dest="$DEST/plain-dest"

    BUNDLE_MCP_SERVERS_DIR="$copy" "$SCRIPT" --ci &
    local p_ci=$!
    BUNDLE_DEST="$plain_dest" "$SCRIPT" &
    local p_plain=$!
    # Reap both before asserting, so teardown never races a live writer.
    local r_ci=0 r_plain=0
    wait "$p_ci" || r_ci=$?
    wait "$p_plain" || r_plain=$?
    [ "$r_ci" -eq 0 ]
    [ "$r_plain" -eq 0 ]
    # Real dist is untouched. Only an npm install or ci rewrites node_modules/.package-lock.json; tool caches
    # there (vitest's .vite-temp) leave it alone, so an unchanged file means the real tree was never reinstalled.
    [ -z "$(find "${dist_dirs[@]}" -type f -newer "$marker")" ]
    [ "$(tree_fingerprint "${dist_dirs[@]}")" = "$before" ]
    [ -f "$hidden_lock" ]
    [ -z "$(find "$hidden_lock" -newer "$marker")" ]
    # npm ci + the workspace builds landed in the copy, and the --ci bundle was staged from there.
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
    # The script honours only $BUNDLE_DEST (set by setup) — never argv.
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    ctx="$BUNDLE_DEST/build-context"
    [ -d "$ctx" ] || { echo "staged context missing: $ctx"; return 1; }
    found_any=""
    fail=""
    # Worker images build with context = mcp-servers/; claude with containers/.
    while IFS= read -r df; do
        case "$df" in
            */mcp-servers/*) root="$ctx/mcp-servers" ;;
            *) root="$ctx/containers" ;;
        esac
        while IFS= read -r src; do
            found_any=1
            # Glob sources (package*.json) must expand to >=1 staged file.
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

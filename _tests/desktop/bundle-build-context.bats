#!/usr/bin/env bats
# Tests for scripts/bundle-build-context.sh (expected dir structure); bundle-build-context.ps1 mirrors
# this, exercised only in Windows E2E VMs. Prerequisite: `make build-mcp` for the os/shared/oauth dist dirs.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.sh"
REAL_MCP_SERVERS="$BATS_TEST_DIRNAME/../../mcp-servers"

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

# stage_mcp_servers_copy <dir>: copies the tracked mcp-servers/ files (nothing untracked or gitignored,
# so no node_modules/dist) into <dir> for --ci runs off the real tree; a failed or empty plant aborts.
stage_mcp_servers_copy() {
    local dir="$1" f files=()
    git -C "$REAL_MCP_SERVERS" ls-files -z --cached -- . > "$dir.list"
    while IFS= read -r -d '' f; do
        if [ -e "$REAL_MCP_SERVERS/$f" ]; then files+=("$f"); fi
    done < "$dir.list"
    [ "${#files[@]}" -gt 0 ]
    printf '%s\0' "${files[@]}" > "$dir.list"
    tar -C "$REAL_MCP_SERVERS" -cf "$dir.tar" --null -T "$dir.list"
    mkdir -p "$dir"
    tar -xf "$dir.tar" -C "$dir"
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
}

teardown() {
    rm_with_retry "$DEST"
    # A test that plants fixtures in the real source tree records their root here.
    if [ -n "${PLANT:-}" ]; then rm_with_retry "$PLANT"; fi
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

@test "bundle script never copies host build outputs into the staged containers/, at any depth (target, dist, node_modules)" {
    # Each build-output dir holds an unreadable file, so a copy that enters one (even to prune it
    # afterwards) fails: a parallel cargo or tsc run rewrites these dirs mid-copy.
    PLANT="$BATS_TEST_DIRNAME/../../containers/.bats-build-outputs"
    local base out blob
    for base in "$PLANT" "$PLANT/nested/deeper"; do
        mkdir -p "$base/src"
        echo x > "$base/src/keep.txt"
        for out in target dist node_modules; do
            blob="$base/$out/sub/blob"
            mkdir -p "${blob%/*}"
            echo x > "$blob"
            chmod 000 "$blob"
            [ ! -r "$blob" ]
        done
    done
    [ "$(find "$PLANT" -type f -name blob | wc -l)" -eq 6 ]
    # Lookalike names and a plain file named dist are content: the exclusion is directory-gated.
    mkdir -p "$PLANT/distribution"
    echo x > "$PLANT/distribution/keep.txt"
    echo x > "$PLANT/nested/dist"

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    local staged="$DEST/build-context/containers/.bats-build-outputs"
    [ -f "$staged/src/keep.txt" ]
    [ -f "$staged/nested/deeper/src/keep.txt" ]
    [ -f "$staged/distribution/keep.txt" ]
    [ -f "$staged/nested/dist" ]
    [ -z "$(find "$DEST/build-context/containers" -type d \( -name target -o -name dist -o -name node_modules \))" ]
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
    local src="$BATS_TEST_DIRNAME/../../mcp-servers/policies/wasm-pkg"
    trap 'rm -rf "$src"' RETURN
    mkdir -p "$src"
    echo fake-wasm > "$src/pii_engine_wasm_bg.wasm"

    run "$SCRIPT"
    [ "$status" -eq 0 ]

    local dest_dir="$DEST/build-context/mcp-servers/policies/wasm-pkg"
    shopt -s nullglob
    local staged=("$dest_dir"/*_bg.wasm)
    shopt -u nullglob
    [ "${#staged[@]}" -gt 0 ]
    [ -s "${staged[0]}" ]
    ! grep -q "fake-wasm" "${staged[0]}"
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
    # Every literal cp or copy_source_tree source ($REPO_ROOT/… or $MCP_SERVERS_DIR/… without loop
    # variables) must exist in the checkout; a typo there only surfaces as a failed bundle otherwise.
    local repo_root="$BATS_TEST_DIRNAME/../.."
    local checked=0 src resolved
    while IFS= read -r src; do
        resolved="${src//\$REPO_ROOT/$repo_root}"
        resolved="${resolved//\$MCP_SERVERS_DIR/$repo_root/mcp-servers}"
        [[ "$resolved" == *'$'* ]] && continue
        checked=$((checked + 1))
        [ -e "$resolved" ] || { echo "Source path does not exist: $src (resolved: $resolved)"; return 1; }
    done < <(grep -E '^\s*(cp|copy_source_tree) ' "$SCRIPT" | grep -oE '"\$(REPO_ROOT|MCP_SERVERS_DIR)/[^"]+"' | tr -d '"' | sort -u)
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
    local src="$BATS_TEST_DIRNAME/../../containers/install-claude.sh"
    local backup
    backup="$(mktemp)"
    cp "$src" "$backup"
    local src_perms
    src_perms=$(stat -c '%a' "$src" 2>/dev/null || stat -f '%A' "$src")

    printf '#!/bin/bash\r\necho hi\r\n' > "$src"
    chmod 0755 "$src"

    run "$SCRIPT"
    local bundler_status=$status

    cp "$backup" "$src"
    chmod "$src_perms" "$src"
    rm -f "$backup"

    [ "$bundler_status" -eq 0 ]
    if grep -q $'\r' "$DEST/build-context/containers/install-claude.sh"; then
        echo "Bundler did not strip CR from destination"
        return 1
    fi
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

@test "bundle script releases the lock on success" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ ! -d "$DEST/.bundle.lock" ]
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
    # Hold the lock with our live PID; the script must block until release.
    mkdir -p "$DEST/.bundle.lock"
    echo "$$" > "$DEST/.bundle.lock/pid"   # $$ is bats — a live process

    "$SCRIPT" &
    local pid=$!
    # While we hold the lock the script must never start its body — poll repeatedly.
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
        [ ! -d "$DEST/build-context" ] || {
            echo "script started its body while the lock was held"
            return 1
        }
        kill -0 "$pid" 2>/dev/null || {
            echo "script exited instead of waiting for the lock"
            return 1
        }
        sleep 0.2
    done
    [ -f "$DEST/.bundle.lock/pid" ]                 # our lock untouched
    [ "$(cat "$DEST/.bundle.lock/pid")" = "$$" ]    # not reclaimed/overwritten

    rm -rf "$DEST/.bundle.lock"                      # release — script can proceed
    wait "$pid"; local rc=$?
    [ "$rc" -eq 0 ]
    [ -d "$DEST/build-context/containers" ]
    [ ! -d "$DEST/.bundle.lock" ]                    # script released its own lock
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

@test "bundle script fails fast when BUNDLE_MCP_SERVERS_DIR points at a missing tree" {
    # A wasm-pack stub leaves a sentinel if the wasm build starts; the knob check must come first.
    local stub_dir="$DEST/stub-bin"
    mkdir -p "$stub_dir"
    printf '#!/usr/bin/env bash\ntouch "%s/wasm-pack-ran"\nexit 1\n' "$DEST" > "$stub_dir/wasm-pack"
    chmod +x "$stub_dir/wasm-pack"

    PATH="$stub_dir:$PATH" BUNDLE_MCP_SERVERS_DIR="$DEST/no-such-mcp-servers" run "$SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"BUNDLE_MCP_SERVERS_DIR"* ]]
    [ ! -e "$DEST/wasm-pack-ran" ]
    [ ! -d "$DEST/mcp-os" ]
    [ ! -d "$DEST/.bundle.lock" ]
}

@test "bundle-build-context.ps1 starts with a UTF-8 BOM" {
    # Windows PowerShell reads a BOM-less .ps1 in the system locale (cross-platform rules).
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    [ "$(od -An -tx1 -N3 "$ps1" | tr -d ' \n')" = "efbbbf" ]
}

@test "bundle-build-context.ps1 checks LASTEXITCODE after every native call" {
    # PowerShell never fails on a native non-zero exit and no suite runs the .ps1, so a line led by
    # a lowercase command word that is not a keyword (npm, bash, ...) must be followed by the check.
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    run awk '
        pending != "" { if ($0 !~ /\$LASTEXITCODE -ne 0/) print "unchecked: " pending; pending = "" }
        $1 ~ /^[a-z][a-z0-9._-]*$/ && $1 !~ /^(if|elseif|else|foreach|for|while|do|until|switch|function|filter|param|begin|process|end|try|catch|finally|trap|return|exit|throw|break|continue)$/ {
            calls++
            pending = $0
        }
        END {
            if (pending != "") print "unchecked: " pending
            if (calls == 0) print "vacuous: no native calls parsed"
        }
    ' "$ps1"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "bundle script --ci builds a clean scratch copy and leaves a concurrent run on the real tree intact" {
    # The plain run stages the real dist dirs while --ci rebuilds the copy; the two share only the
    # wasm-build lock, so any --ci write into the real tree (npm ci, tsc) surfaces here.
    local d ws workspaces=(os shared oauth) dist_dirs=()
    for ws in "${workspaces[@]}"; do dist_dirs+=("$REAL_MCP_SERVERS/$ws/dist"); done
    for d in "${dist_dirs[@]}"; do [ -d "$d" ]; done
    [ -d "$REAL_MCP_SERVERS/node_modules" ]
    local copy="$DEST/mcp-servers-src"
    stage_mcp_servers_copy "$copy"
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
    # No real dist file was rewritten and dist content matches; npm ci recreates node_modules, so an
    # unchanged directory mtime proves it was never reinstalled (files inside it are not compared).
    [ -z "$(find "${dist_dirs[@]}" -type f -newer "$marker")" ]
    [ "$(tree_fingerprint "${dist_dirs[@]}")" = "$before" ]
    [ -z "$(find "$REAL_MCP_SERVERS/node_modules" -maxdepth 0 -newer "$marker")" ]
    # npm ci + the workspace builds landed in the copy, and the --ci bundle was staged from there.
    [ -d "$copy/node_modules" ]
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

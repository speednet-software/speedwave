#!/usr/bin/env bats
# Tests for scripts/bundle-build-context.sh
# Verifies that the script creates the expected directory structure.
#
# Note: bundle-build-context.ps1 (Windows equivalent) receives identical
# changes but is only exercised inside Windows E2E VMs (scripts/e2e-vm.sh).
#
# Prerequisite: `make build-mcp` must be run first so that mcp-servers/os/dist/
# and mcp-servers/shared/dist/ exist for dev-mode copying.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.sh"

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

setup() {
    DEST="$(mktemp -d "${TMPDIR:-/tmp}/bundle-bats.XXXXXX")"
    export BUNDLE_DEST="$DEST"
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

@test "bundle script prunes host build outputs from containers/ (target, dist, node_modules)" {
    # Plant a dirty source tree; the trap removes it even on assertion failure.
    local marker="$BATS_TEST_DIRNAME/../../containers/.bats-prune-check"
    trap 'rm_with_retry "$marker"' RETURN
    # Non-empty dirs pin the prune to a recursive delete.
    mkdir -p "$marker/target" "$marker/dist" "$marker/node_modules"
    echo x > "$marker/target/blob"
    echo x > "$marker/dist/blob"
    echo x > "$marker/node_modules/blob"
    echo x > "$marker/keep.txt"

    run "$SCRIPT"
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
    # Extract all cp source paths from the script and verify they exist.
    REPO_ROOT="$BATS_TEST_DIRNAME/../.."

    # Collect non-variable literal paths used as cp sources (skip $DEST targets)
    while IFS= read -r src; do
        # Resolve $REPO_ROOT prefix
        resolved="${src/\$REPO_ROOT/$REPO_ROOT}"
        resolved="${resolved/\"\$REPO_ROOT\"/$REPO_ROOT}"
        # Skip paths with unresolved variables (loop vars like $svc_src)
        [[ "$resolved" == *'$'* ]] && continue
        # Strip quotes
        resolved="${resolved//\"/}"
        [ -e "$resolved" ] || { echo "Source path does not exist: $src (resolved: $resolved)"; return 1; }
    done < <(grep -E '^\s+cp ' "$SCRIPT" | grep -v '\$DEST' | grep -oE '"?\$REPO_ROOT/[^"[:space:]]+"?' | sort -u)
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
    wait "$p1"; local r1=$?
    wait "$p2"; local r2=$?
    [ "$r1" -eq 0 ]
    [ "$r2" -eq 0 ]
    [ ! -d "$DEST/.bundle.lock" ]
    local pkg="$DEST/build-context/mcp-servers/shared/package.json"
    [ -s "$pkg" ]
    node -e "JSON.parse(require('fs').readFileSync('$pkg','utf8'))"
}

@test "bundle script --ci works without pre-built dist directories" {
    REPO_ROOT="$BATS_TEST_DIRNAME/../.."
    # Simulate a clean checkout by temporarily renaming dist directories
    local os_dist="$REPO_ROOT/mcp-servers/os/dist"
    local shared_dist="$REPO_ROOT/mcp-servers/shared/dist"
    local os_bak="${os_dist}.bats-bak"
    local shared_bak="${shared_dist}.bats-bak"

    # Back up existing dist dirs (if they exist)
    [ -d "$os_dist" ] && mv "$os_dist" "$os_bak"
    [ -d "$shared_dist" ] && mv "$shared_dist" "$shared_bak"

    # Run --ci mode (npm ci + npm run build should recreate dist/)
    run "$SCRIPT" --ci

    # Restore backups regardless of outcome
    [ -d "$os_bak" ] && { rm -rf "$os_dist"; mv "$os_bak" "$os_dist"; }
    [ -d "$shared_bak" ] && { rm -rf "$shared_dist"; mv "$shared_bak" "$shared_dist"; }

    [ "$status" -eq 0 ]
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

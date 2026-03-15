#!/usr/bin/env bats
# Tests for scripts/bundle-build-context.sh
# Verifies that the script creates the expected directory structure.
#
# Prerequisite: `make build-mcp` must be run first so that mcp-servers/os/dist/
# and mcp-servers/shared/dist/ exist for dev-mode copying.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.sh"
DEST="$BATS_TEST_DIRNAME/../../desktop/src-tauri"

setup() {
    rm -rf "$DEST/build-context"
    rm -rf "$DEST/mcp-os"
}

teardown() {
    rm -rf "$DEST/build-context"
    rm -rf "$DEST/mcp-os"
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

@test "bundle script creates mcp-servers with tsconfig.base.json" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -f "$DEST/build-context/mcp-servers/tsconfig.base.json" ]
}

@test "bundle script creates all MCP service directories" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    for svc in shared hub slack sharepoint redmine gitlab; do
        [ -d "$DEST/build-context/mcp-servers/$svc" ]
        [ -f "$DEST/build-context/mcp-servers/$svc/package.json" ]
        [ -d "$DEST/build-context/mcp-servers/$svc/src" ]
    done
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
    # Extract all cp/cp -r source paths from the script and verify they exist.
    # This catches bugs like referencing shared/package-lock.json when the
    # lockfile is at the workspace root.
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
}

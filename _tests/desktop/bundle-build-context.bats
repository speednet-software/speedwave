#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.sh"
REAL_MCP_SERVERS="$BATS_TEST_DIRNAME/../../mcp-servers"

rm_with_retry() {
    local target="$1"
    local attempt
    for attempt in 1 2 3 4 5; do
        rm -rf "$target" 2>/dev/null && return 0
        sleep 0.2
    done
    rm -rf "$target"
}

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
}

@test "bundle script never copies host build outputs into the staged containers/, at any depth (target, dist, node_modules)" {
    PLANT="$BATS_TEST_DIRNAME/../../containers/.bats-build-outputs"
    rm_with_retry "$PLANT"
    local base out blob
    for base in "$PLANT" "$PLANT/nested/deeper"; do
        mkdir -p "$base/src"
        echo x > "$base/src/keep.txt"
        for out in target dist node_modules; do
            blob="$base/$out/sub/blob"
            mkdir -p "${blob%/*}"
            echo x > "$blob"
            chmod -N "$blob" 2>/dev/null || true
            chmod 000 "$blob"
            [ ! -r "$blob" ]
        done
    done
    [ "$(find "$PLANT" -type f -name blob | wc -l)" -eq 6 ]
    mkdir -p "$PLANT/distribution" "$PLANT/links" "$DEST/cargo-cache"
    echo x > "$PLANT/distribution/keep.txt"
    echo x > "$PLANT/nested/dist"
    echo x > "$DEST/cargo-cache/blob"
    ln -s "$DEST/cargo-cache" "$PLANT/links/target"
    [ -L "$PLANT/links/target" ]

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    local staged="$DEST/build-context/containers/.bats-build-outputs"
    [ -f "$staged/src/keep.txt" ]
    [ -f "$staged/nested/deeper/src/keep.txt" ]
    [ -f "$staged/distribution/keep.txt" ]
    [ -f "$staged/nested/dist" ]
    [ -d "$staged/links" ]
    [ -z "$(find "$DEST/build-context/containers" \( -type d -o -type l \) \( -name target -o -name dist -o -name node_modules \))" ]
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
        [[ "$resolved" == *'$'* ]] && continue
        checked=$((checked + 1))
        [ -e "$resolved" ] || { echo "Source path does not exist: $src (resolved: $resolved)"; return 1; }
    done < <(grep -E '^\s*(cp|copy_source_tree) ' "$SCRIPT" | grep -oE '"\$(REPO_ROOT|MCP_SERVERS_DIR)/[^"]+"' | tr -d '"' | sort -u)
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
    mkdir -p "$DEST/.bundle.lock"
    echo "2147483647" > "$DEST/.bundle.lock/pid"
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ -d "$DEST/build-context/containers" ]
    [ ! -d "$DEST/.bundle.lock" ]
}

@test "lock held by a live holder blocks a second run until released" {
    mkdir -p "$DEST/.bundle.lock"
    echo "$$" > "$DEST/.bundle.lock/pid"

    "$SCRIPT" &
    local pid=$!
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
    [ -f "$DEST/.bundle.lock/pid" ]
    [ "$(cat "$DEST/.bundle.lock/pid")" = "$$" ]

    rm -rf "$DEST/.bundle.lock"
    wait "$pid"; local rc=$?
    [ "$rc" -eq 0 ]
    [ -d "$DEST/build-context/containers" ]
    [ ! -d "$DEST/.bundle.lock" ]
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

@test "bundle script fails fast when BUNDLE_MCP_SERVERS_DIR points at a missing tree" {
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
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    [ "$(od -An -tx1 -N3 "$ps1" | tr -d ' \n')" = "efbbbf" ]
}

@test "bundle-build-context.ps1 fails the run after every native call that exits non-zero" {
    local ps1="$BATS_TEST_DIRNAME/../../scripts/bundle-build-context.ps1"
    run awk '
        function command_word(line) {
            sub(/^[[:space:]]+/, "", line)
            sub(/^\$[A-Za-z0-9_:]+[[:space:]]*=[[:space:]]*/, "", line)
            sub(/^&[[:space:]]*/, "", line)
            split(line, parts, /[[:space:]]+/)
            return parts[1]
        }
        function fails_run(line) { return line ~ /(^|[^A-Za-z])(throw|exit)([^A-Za-z]|$)/ }
        function close_check(line) {
            depth += gsub(/\{/, "{", line) - gsub(/\}/, "}", line)
            if (depth > 0) return
            depth = 0
            if (!exits) print "check never fails the run: " check
        }
        depth > 0 {
            if (fails_run($0)) exits = 1
            close_check($0)
            next
        }
        pending != "" {
            call = pending
            pending = ""
            if ($0 !~ /\$LASTEXITCODE -ne 0/) {
                print "unchecked: " call
            } else {
                check = $0
                exits = fails_run($0)
                close_check($0)
                next
            }
        }
        {
            word = command_word($0)
            if (word ~ /^[A-Za-z][A-Za-z0-9._]*$/ && tolower(word) !~ /^(if|elseif|else|foreach|for|while|do|until|switch|function|filter|param|begin|process|end|try|catch|finally|trap|return|exit|throw|break|continue|class|enum|using|data|hidden|static|in)$/) {
                calls++
                if (word == "npm") npm++
                pending = $0
            }
        }
        END {
            if (pending != "") print "unchecked: " pending
            if (npm == 0) print "vacuous: no npm call parsed"
        }
    ' "$ps1"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "bundle script --ci builds a clean scratch copy and leaves a concurrent run on the real tree intact" {
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
    [ -z "$(find "$REAL_MCP_SERVERS/node_modules" -maxdepth 0 -newer "$marker")" ]
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

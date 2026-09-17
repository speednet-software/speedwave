#!/usr/bin/env bats

ENTRYPOINT="$BATS_TEST_DIRNAME/../../containers/entrypoint.sh"
DEFAULTS_RS="$BATS_TEST_DIRNAME/../../crates/speedwave-runtime/src/defaults.rs"

PINNED_VERSION="$(grep 'pub const CLAUDE_VERSION' "$DEFAULTS_RS" | sed 's/.*"\(.*\)".*/\1/')"
[[ -n "$PINNED_VERSION" ]] || { echo "ERROR: could not extract CLAUDE_VERSION from defaults.rs" >&2; exit 1; }

setup() {
    TEST_HOME="$(mktemp -d)"
    export HOME="$TEST_HOME"
    mkdir -p "$HOME/.claude"

    RESOURCES_DIR="$(mktemp -d)"
    export SPEEDWAVE_RESOURCES="$RESOURCES_DIR"

    export CLAUDE_VERSION="$PINNED_VERSION"

    REAL_JQ="$(command -v jq || true)"

    STUBS_DIR="$(mktemp -d)"
    export STUBS_DIR
    CLEAN_PATH="$STUBS_DIR:$(echo "$PATH" | tr ':' '\n' \
        | grep -v '\.local/bin' | grep -v 'homebrew' \
        | tr '\n' ':' | sed 's/:$//')"
    export PATH="$CLEAN_PATH"

    if [ -n "$REAL_JQ" ]; then
        printf '#!/bin/bash\nexec %q "$@"\n' "$REAL_JQ" > "$STUBS_DIR/jq"
        chmod +x "$STUBS_DIR/jq"
    fi

    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"

    cat > "$STUBS_DIR/timeout" << 'EOF'
#!/bin/bash
shift
exec "$@"
EOF
    chmod +x "$STUBS_DIR/timeout"

    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
echo "UNEXPECTED curl: $*" >&2
exit 1
EOF
    chmod +x "$STUBS_DIR/curl"

    export SPEEDWAVE_SKIP_HUB_WAIT=1

    export OS_AVAILABLE_SUBS="reminders,calendar,mail,notes"

    export CLAUDE_READY_MARKER="$TEST_HOME/claude-ready"
}

teardown() {
    rm -rf "$TEST_HOME" "$STUBS_DIR" "$RESOURCES_DIR"
}


@test "fails when CLAUDE_VERSION is not set" {
    unset CLAUDE_VERSION
    run bash "$ENTRYPOINT" true
    [ "$status" -ne 0 ]
    [[ "$output" == *"CLAUDE_VERSION"* ]]
}


@test "warns when installed claude version differs from pinned CLAUDE_VERSION" {
    cat > "$STUBS_DIR/claude" << 'EOF'
#!/bin/bash
echo "0.0.1 (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING: image has Claude Code 0.0.1"* ]]
    [[ "$output" == *"$PINNED_VERSION"* ]]
}

@test "no version-skew warning when installed version matches the pin" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" != *"WARNING: image has Claude Code"* ]]
}

@test "no version-skew warning when claude --version output is unparseable" {
    cat > "$STUBS_DIR/claude" << 'EOF'
#!/bin/bash
echo "garbage output"
EOF
    chmod +x "$STUBS_DIR/claude"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" != *"WARNING: image has Claude Code"* ]]
}


@test "CLAUDE_VERSION env var is forwarded to install-claude.sh" {
    rm -f "$STUBS_DIR/claude"

    local version_file
    version_file="$(mktemp)"

    local patched
    patched="$(mktemp)"
    sed "s|/usr/local/bin/install-claude.sh|${STUBS_DIR}/install-claude.sh|g" "$ENTRYPOINT" > "$patched"

    cat > "$STUBS_DIR/install-claude.sh" << EOF
#!/bin/bash
echo "\$1" > ${version_file}
# Make claude "appear" installed after this
mkdir -p "${STUBS_DIR}"
cat > "${STUBS_DIR}/claude" << INNER
#!/bin/bash
echo "${PINNED_VERSION} (Claude Code)"
INNER
chmod +x "${STUBS_DIR}/claude"
EOF
    chmod +x "$STUBS_DIR/install-claude.sh"

    CLAUDE_VERSION="$PINNED_VERSION" run bash "$patched" true 2>/dev/null || true

    [[ -s "$version_file" ]]
    grep -q "$PINNED_VERSION" "$version_file"
    rm -f "$version_file" "$patched"
}


@test "does not call curl when claude is already installed" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
}


@test "creates /tmp/claude-ready health marker" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -f "$CLAUDE_READY_MARKER" ]
}


@test "exits non-zero when HOME is not writable (mimics uid-mismatch EACCES)" {
    [ "$(id -u)" -ne 0 ] || skip "must run as non-root to enforce mode bits"

    chmod 0555 "$HOME"
    run bash "$ENTRYPOINT" true
    chmod 0755 "$HOME"

    [ "$status" -ne 0 ]
}


@test "executes the passed command" {
    run bash "$ENTRYPOINT" echo "hello-from-entrypoint"
    [ "$status" -eq 0 ]
    [[ "$output" == *"hello-from-entrypoint"* ]]
}

@test "passes arguments to the command" {
    run bash "$ENTRYPOINT" bash -c 'echo "arg=$1"' _ myarg
    [ "$status" -eq 0 ]
    [[ "$output" == *"arg=myarg"* ]]
}


@test "symlinks CLAUDE.md from resources" {
    echo "# Speedwave System Context" > "${SPEEDWAVE_RESOURCES}/CLAUDE.md"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "$HOME/.claude/CLAUDE.md" ]
    [ "$(readlink "$HOME/.claude/CLAUDE.md")" = "${SPEEDWAVE_RESOURCES}/CLAUDE.md" ]
    grep -q "Speedwave System Context" "$HOME/.claude/CLAUDE.md"
}

@test "skips CLAUDE.md symlink when not in resources" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "$HOME/.claude/CLAUDE.md" ]
}


@test "symlinks skills entries when present in resources" {
    mkdir -p "$RESOURCES_DIR/skills"
    touch "$RESOURCES_DIR/skills/my-skill.md"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -d "$HOME/.claude/skills" ]
    [ ! -L "$HOME/.claude/skills" ]
    [ -L "$HOME/.claude/skills/my-skill.md" ]
    [ "$(readlink "$HOME/.claude/skills/my-skill.md")" = "$RESOURCES_DIR/skills/my-skill.md" ]
}

@test "resource directory exists but is empty when source is absent" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -d "$HOME/.claude/skills" ]
    [ ! -L "$HOME/.claude/skills" ]
    [ -z "$(ls -A "$HOME/.claude/skills")" ]
}

@test "links the bundled core skills from the real resources tree" {
    real_resources="$BATS_TEST_DIRNAME/../../containers/claude-resources"
    export SPEEDWAVE_RESOURCES="$real_resources"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -d "$HOME/.claude/skills" ]
    [ ! -L "$HOME/.claude/skills" ]

    for skill in speedwave-sitemap speedwave-site-audit speedwave-product-showcase speedwave-wait-what; do
        [ -L "$HOME/.claude/skills/$skill" ]
        [ "$(readlink "$HOME/.claude/skills/$skill")" = "$real_resources/skills/$skill" ]
        [ -f "$HOME/.claude/skills/$skill/SKILL.md" ]
    done
}


@test "exports DISABLE_AUTOUPDATER=1" {
    run bash "$ENTRYPOINT" bash -c 'echo "AUTOUPDATER=$DISABLE_AUTOUPDATER"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"AUTOUPDATER=1"* ]]
}


@test "adds HOME/.local/bin to PATH" {
    run bash "$ENTRYPOINT" bash -c 'echo "PATH=$PATH"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"/.local/bin"* ]]
}

@test "claude in HOME/.local/bin is found without reinstalling" {
    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/claude" << EOF
#!/bin/bash
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$HOME/.local/bin/claude"
    rm -f "$STUBS_DIR/claude"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
}


@test "symlinks claude from /usr/local/bin to ~/.local/bin" {
    local fake_usr_local="$TEST_HOME/fake-usr-local-bin"
    mkdir -p "$fake_usr_local"
    cp "$STUBS_DIR/claude" "$fake_usr_local/claude"
    chmod +x "$fake_usr_local/claude"

    local patched
    patched="$(mktemp)"
    sed "s|/usr/local/bin/claude|${fake_usr_local}/claude|g" "$ENTRYPOINT" > "$patched"

    run bash "$patched" true
    [ "$status" -eq 0 ]
    [ -L "$HOME/.local/bin/claude" ]
    [ "$(readlink "$HOME/.local/bin/claude")" = "${fake_usr_local}/claude" ]

    rm -f "$patched"
}


@test "bashrc PATH export is added" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc"
}

@test "bashrc PATH export not duplicated" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]

    local count
    count="$(grep -c '\.local/bin' "$HOME/.bashrc")"
    [ "$count" -eq 1 ]
}


@test "commands entries are symlinked into a real dir" {
    mkdir -p "$RESOURCES_DIR/commands"
    touch "$RESOURCES_DIR/commands/my-command.md"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -d "$HOME/.claude/commands" ]
    [ ! -L "$HOME/.claude/commands" ]
    [ -L "$HOME/.claude/commands/my-command.md" ]
    [ "$(readlink "$HOME/.claude/commands/my-command.md")" = "$RESOURCES_DIR/commands/my-command.md" ]
}

@test "agents entries are symlinked into a real dir" {
    mkdir -p "$RESOURCES_DIR/agents"
    touch "$RESOURCES_DIR/agents/my-agent.md"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -d "$HOME/.claude/agents" ]
    [ ! -L "$HOME/.claude/agents" ]
    [ -L "$HOME/.claude/agents/my-agent.md" ]
    [ "$(readlink "$HOME/.claude/agents/my-agent.md")" = "$RESOURCES_DIR/agents/my-agent.md" ]
}

@test "hooks entries are symlinked into a real dir" {
    mkdir -p "$RESOURCES_DIR/hooks"
    touch "$RESOURCES_DIR/hooks/my-hook.sh"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -d "$HOME/.claude/hooks" ]
    [ ! -L "$HOME/.claude/hooks" ]
    [ -L "$HOME/.claude/hooks/my-hook.sh" ]
    [ "$(readlink "$HOME/.claude/hooks/my-hook.sh")" = "$RESOURCES_DIR/hooks/my-hook.sh" ]
}


@test "default command is a TERM-trappable keep-alive loop (not interactive shell)" {
    grep -q "while :; do sleep 86400 & wait" "$ENTRYPOINT"
    ! grep -q 'exec sleep infinity' "$ENTRYPOINT"
}


@test "mcp-config has only speedwave-hub when MCP_OS vars are unset" {
    unset MCP_OS_URL
    unset MCP_OS_AUTH_TOKEN
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -f "${TEST_HOME}/.claude/mcp-config.json" ]
    run cat "${TEST_HOME}/.claude/mcp-config.json"
    [[ "$output" == *"speedwave-hub"* ]]
    [[ "$output" != *"speedwave-os"* ]]
}

@test "mcp-config has only hub when MCP_OS_URL set but MCP_OS_AUTH_TOKEN unset" {
    export MCP_OS_URL="http://host.docker.internal:4007"
    unset MCP_OS_AUTH_TOKEN
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run cat "${TEST_HOME}/.claude/mcp-config.json"
    [[ "$output" == *"speedwave-hub"* ]]
    [[ "$output" != *"speedwave-os"* ]]
}


@test "symlinks output-styles/Speedwave.md file from resources" {
    mkdir -p "${SPEEDWAVE_RESOURCES}/output-styles"
    echo "# Test Style" > "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/output-styles/Speedwave.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/output-styles/Speedwave.md")" = "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md" ]
}

@test "preserves custom output styles alongside bundled Speedwave.md" {
    mkdir -p "${SPEEDWAVE_RESOURCES}/output-styles"
    echo "# Bundled" > "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md"
    mkdir -p "${TEST_HOME}/.claude/output-styles"
    echo "# My Custom Style" > "${TEST_HOME}/.claude/output-styles/MyStyle.md"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/output-styles/Speedwave.md" ]
    [ -f "${TEST_HOME}/.claude/output-styles/MyStyle.md" ]
    grep -q "My Custom Style" "${TEST_HOME}/.claude/output-styles/MyStyle.md"
}


@test "pre-accepts /workspace trust+project-onboarding but skips login onboarding when credentials are absent" {
    [ ! -e "${TEST_HOME}/.claude.json" ]
    [ ! -e "${TEST_HOME}/.claude/.credentials.json" ]
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -f "${TEST_HOME}/.claude.json" ]
    grep -q '"hasTrustDialogAccepted": true' "${TEST_HOME}/.claude.json"
    grep -q '"hasCompletedProjectOnboarding": true' "${TEST_HOME}/.claude.json"
    ! grep -q '"hasCompletedOnboarding"' "${TEST_HOME}/.claude.json"
}

@test "creates ~/.claude.json with onboarding AND trust when credentials exist" {
    printf '{"token":"x"}' > "${TEST_HOME}/.claude/.credentials.json"
    [ ! -e "${TEST_HOME}/.claude.json" ]
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -f "${TEST_HOME}/.claude.json" ]
    grep -q '"hasCompletedOnboarding": true' "${TEST_HOME}/.claude.json"
    grep -q '"hasTrustDialogAccepted": true' "${TEST_HOME}/.claude.json"
    grep -q '"hasCompletedProjectOnboarding": true' "${TEST_HOME}/.claude.json"
}

@test "pre-seeded ~/.claude.json is valid JSON in both credential states" {
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    python3 -c "import json,sys; json.load(open('${TEST_HOME}/.claude.json'))"
    printf '{"token":"x"}' > "${TEST_HOME}/.claude/.credentials.json"
    rm -f "${TEST_HOME}/.claude.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    python3 -c "import json,sys; json.load(open('${TEST_HOME}/.claude.json'))"
}

@test "preserves existing ~/.claude.json keys when no credentials (no merge)" {
    [ ! -e "${TEST_HOME}/.claude/.credentials.json" ]
    printf '{"my":"existing-state"}' > "${TEST_HOME}/.claude.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ "$(cat "${TEST_HOME}/.claude.json")" = '{"my":"existing-state"}' ]
}

@test "merges onboarding+trust into an existing ~/.claude.json when credentials exist" {
    printf '{"token":"x"}' > "${TEST_HOME}/.claude/.credentials.json"
    printf '{"oauthAccount":{"userID":"u1"}}' > "${TEST_HOME}/.claude.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    python3 -c "import json; json.load(open('${TEST_HOME}/.claude.json'))"
    grep -q '"hasCompletedOnboarding": true' "${TEST_HOME}/.claude.json"
    grep -q '"hasTrustDialogAccepted": true' "${TEST_HOME}/.claude.json"
    grep -q '"userID": "u1"' "${TEST_HOME}/.claude.json"
}

@test "merge is idempotent when onboarding fields already present" {
    printf '{"token":"x"}' > "${TEST_HOME}/.claude/.credentials.json"
    printf '{"hasCompletedOnboarding":true,"installMethod":"native","projects":{"/workspace":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' \
        > "${TEST_HOME}/.claude.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    python3 -c "import json; assert json.load(open('${TEST_HOME}/.claude.json'))['hasCompletedOnboarding'] is True"
}

@test "onboarding merge degrades gracefully on corrupt credentialed .claude.json" {
    printf '{"token":"x"}' > "${TEST_HOME}/.claude/.credentials.json"
    printf 'NOT_JSON' > "${TEST_HOME}/.claude.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ "$(cat "${TEST_HOME}/.claude.json")" = 'NOT_JSON' ]
    [ ! -e "${TEST_HOME}/.claude.json.tmp" ]
    [[ "$output" == *".claude.json unparseable — onboarding merge skipped"* ]]
}


@test "symlinks statusline.sh from resources" {
    echo '#!/bin/bash' > "${SPEEDWAVE_RESOURCES}/statusline.sh"
    echo 'echo "statusline"' >> "${SPEEDWAVE_RESOURCES}/statusline.sh"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/statusline.sh" ]
    [ "$(readlink "${TEST_HOME}/.claude/statusline.sh")" = "${SPEEDWAVE_RESOURCES}/statusline.sh" ]
}

@test "statusline.sh symlink is recreated on every start" {
    echo '#!/bin/bash' > "${SPEEDWAVE_RESOURCES}/statusline.sh"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/statusline.sh" ]
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/statusline.sh" ]
    [ "$(readlink "${TEST_HOME}/.claude/statusline.sh")" = "${SPEEDWAVE_RESOURCES}/statusline.sh" ]
}

@test "skips statusline symlink when not in resources" {
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/statusline.sh" ]
}


@test "seeds settings.json as a writable copy, not a symlink" {
    echo '{"statusLine":{"type":"command","command":"~/.claude/statusline.sh"}}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -f "${TEST_HOME}/.claude/settings.json" ]
    [ ! -L "${TEST_HOME}/.claude/settings.json" ]
    [ -w "${TEST_HOME}/.claude/settings.json" ]
    grep -q "statusLine" "${TEST_HOME}/.claude/settings.json"
}

@test "replaces a stale settings.json symlink with a writable copy" {
    echo '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    ln -s "${SPEEDWAVE_RESOURCES}/settings.json" "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ ! -L "${TEST_HOME}/.claude/settings.json" ]
    [ -f "${TEST_HOME}/.claude/settings.json" ]
}

@test "preserves a user's modified settings.json across restarts" {
    echo '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    echo '{"effortLevel":"low"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.effortLevel==='low'?0:1)"
    [ "$status" -eq 0 ]
}

@test "skips settings.json when not in resources" {
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/settings.json" ]
}

@test "merges new template keys into existing settings.json without overwriting user values" {
    printf '{"effortLevel":"high","newKey":42}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"effortLevel":"low"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.effortLevel==='low'?0:1)"
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.newKey===42?0:1)"
    [ "$status" -eq 0 ]
}

@test "merge degrades gracefully when node fails (corrupt settings.json)" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf 'NOT_JSON' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run cat "${TEST_HOME}/.claude/settings.json"
    [[ "$output" == "NOT_JSON" ]]
}

@test "merge leaves no stale .tmp file after successful settings.json merge" {
    printf '{"effortLevel":"high","newKey":1}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"effortLevel":"low"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/settings.json.tmp" ]
    run node -e "JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8'))"
    [ "$status" -eq 0 ]
}

@test "keeps a settings.json model that differs from ANTHROPIC_MODEL" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"effortLevel":"low","model":"claude-opus-4-8"}' > "${TEST_HOME}/.claude/settings.json"
    ANTHROPIC_MODEL="openrouter/z-ai/glm-5.2" run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model==='claude-opus-4-8'?0:1)"
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.effortLevel==='low'?0:1)"
    [ "$status" -eq 0 ]
}

@test "keeps a foreign settings.json model while ANTHROPIC_MODEL routes the session" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"model":"openrouter/z-ai/glm-5.2"}' > "${TEST_HOME}/.claude/settings.json"
    ANTHROPIC_MODEL="local/qwen3" run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model==='openrouter/z-ai/glm-5.2'?0:1)"
    [ "$status" -eq 0 ]
}

@test "keeps settings.json model when ANTHROPIC_MODEL is unset (account default)" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"model":"claude-opus-4-8"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model==='claude-opus-4-8'?0:1)"
    [ "$status" -eq 0 ]
}

@test "keeps settings.json model when it matches ANTHROPIC_MODEL" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"model":"claude-opus-4-8"}' > "${TEST_HOME}/.claude/settings.json"
    ANTHROPIC_MODEL="claude-opus-4-8" run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model==='claude-opus-4-8'?0:1)"
    [ "$status" -eq 0 ]
}

@test "drops a FOREIGN settings.json model when ANTHROPIC_MODEL is unset (CR#1)" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"model":"openrouter/z-ai/glm-5.2"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model===undefined?0:1)"
    [ "$status" -eq 0 ]
}

@test "drops a slash-free non-Claude settings.json model when ANTHROPIC_MODEL is unset" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"model":"llama3.3"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model===undefined?0:1)"
    [ "$status" -eq 0 ]
}

@test "keeps a Claude Code alias settings.json model when ANTHROPIC_MODEL is unset" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"model":"fable[1m]"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model==='fable[1m]'?0:1)"
    [ "$status" -eq 0 ]
}

@test "drops a non-alias settings.json model without a slash when ANTHROPIC_MODEL is unset" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    for model in mistral Sonnet opus1 ""; do
        printf '{"model":"%s"}' "${model}" > "${TEST_HOME}/.claude/settings.json"
        run bash "${ENTRYPOINT}" echo ok
        [ "$status" -eq 0 ]
        run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model===undefined?0:1)"
        [ "$status" -eq 0 ] || { echo "model kept: ${model}"; false; }
    done
}

@test "keeps every Claude Code model alias when ANTHROPIC_MODEL is unset" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    aliases="$(sed -n 's/.*claude-\.+|(\([a-z|]*\)).*/\1/p' "${ENTRYPOINT}" | tr '|' ' ')"
    [[ " ${aliases} " == *" default "* && " ${aliases} " == *" opusplan "* ]]
    for alias in ${aliases} "opusplan[1m]"; do
        printf '{"model":"%s"}' "$alias" > "${TEST_HOME}/.claude/settings.json"
        run bash "${ENTRYPOINT}" echo ok
        [ "$status" -eq 0 ]
        run node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(s.model==='${alias}'?0:1)"
        [ "$status" -eq 0 ] || { echo "alias dropped: ${alias}"; false; }
    done
}

@test "leaves settings.json byte-identical when the template merge changes nothing" {
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    printf '{"effortLevel":"low","model":"claude-opus-5"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run cat "${TEST_HOME}/.claude/settings.json"
    [ "$output" = '{"effortLevel":"low","model":"claude-opus-5"}' ]
}


@test "SPEEDWAVE_PLUGINS creates symlinks for all resource types" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    mkdir -p "${plugins_dir}/my-plugin/commands"
    mkdir -p "${plugins_dir}/my-plugin/agents"
    mkdir -p "${plugins_dir}/my-plugin/skills"
    mkdir -p "${plugins_dir}/my-plugin/hooks"
    echo "cmd content" > "${plugins_dir}/my-plugin/commands/do-thing.md"
    echo "agent content" > "${plugins_dir}/my-plugin/agents/helper.md"
    echo "skill content" > "${plugins_dir}/my-plugin/skills/analyze.md"
    echo "hook content" > "${plugins_dir}/my-plugin/hooks/pre-run.sh"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    [ -L "${TEST_HOME}/.claude/commands/do-thing.md" ]
    [ -L "${TEST_HOME}/.claude/agents/helper.md" ]
    [ -L "${TEST_HOME}/.claude/skills/analyze.md" ]
    [ -L "${TEST_HOME}/.claude/hooks/pre-run.sh" ]

    [ "$(readlink "${TEST_HOME}/.claude/commands/do-thing.md")" = "${plugins_dir}/my-plugin/commands/do-thing.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/agents/helper.md")" = "${plugins_dir}/my-plugin/agents/helper.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/skills/analyze.md")" = "${plugins_dir}/my-plugin/skills/analyze.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/hooks/pre-run.sh")" = "${plugins_dir}/my-plugin/hooks/pre-run.sh" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS symlinks skill directories (not just flat files)" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    mkdir -p "${plugins_dir}/my-plugin/skills/my-skill"
    echo "# My Skill" > "${plugins_dir}/my-plugin/skills/my-skill/SKILL.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    [ -L "${TEST_HOME}/.claude/skills/my-skill" ]
    [ -d "${TEST_HOME}/.claude/skills/my-skill" ]
    [ -f "${TEST_HOME}/.claude/skills/my-skill/SKILL.md" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS symlinks command subdirectories" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    mkdir -p "${plugins_dir}/my-plugin/commands/iteration"
    echo "# Create" > "${plugins_dir}/my-plugin/commands/iteration/create.md"
    echo "# List" > "${plugins_dir}/my-plugin/commands/iteration/list.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    [ -L "${TEST_HOME}/.claude/commands/iteration" ]
    [ -d "${TEST_HOME}/.claude/commands/iteration" ]
    [ -f "${TEST_HOME}/.claude/commands/iteration/create.md" ]
    [ -f "${TEST_HOME}/.claude/commands/iteration/list.md" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS handles multiple comma-separated plugins" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    mkdir -p "${plugins_dir}/alpha/commands"
    mkdir -p "${plugins_dir}/beta/skills"
    echo "alpha cmd" > "${plugins_dir}/alpha/commands/alpha-cmd.md"
    echo "beta skill" > "${plugins_dir}/beta/skills/beta-skill.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="alpha,beta" run bash "$patched" true
    [ "$status" -eq 0 ]

    [ -L "${TEST_HOME}/.claude/commands/alpha-cmd.md" ]
    [ -L "${TEST_HOME}/.claude/skills/beta-skill.md" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "empty SPEEDWAVE_PLUGINS is handled gracefully" {
    SPEEDWAVE_PLUGINS="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
}

@test "unset SPEEDWAVE_PLUGINS is handled gracefully" {
    unset SPEEDWAVE_PLUGINS
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
}

@test "SPEEDWAVE_PLUGINS rejects invalid slug with path traversal" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="../etc/passwd" run bash "$patched" true
    [ "$status" -eq 0 ]

    [[ "$output" == *"WARNING: Skipping invalid plugin slug: ../etc/passwd"* ]]

    [ ! -e "${TEST_HOME}/.claude/commands/../etc/passwd" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS rejects slug with uppercase" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="MyPlugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    [[ "$output" == *"WARNING: Skipping invalid plugin slug: MyPlugin"* ]]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS rejects slug starting with digit" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="1badslug" run bash "$patched" true
    [ "$status" -eq 0 ]

    [[ "$output" == *"WARNING: Skipping invalid plugin slug: 1badslug"* ]]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS rejects slug with special characters" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="my_plugin;rm -rf /" run bash "$patched" true
    [ "$status" -eq 0 ]

    [[ "$output" == *"WARNING: Skipping invalid plugin slug:"* ]]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS accepts valid slugs and rejects invalid in same list" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    mkdir -p "${plugins_dir}/good-plugin/commands"
    echo "cmd" > "${plugins_dir}/good-plugin/commands/cmd.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="good-plugin,../BAD,also-good" run bash "$patched" true
    [ "$status" -eq 0 ]

    [ -L "${TEST_HOME}/.claude/commands/cmd.md" ]

    [[ "$output" == *"WARNING: Skipping invalid plugin slug: ../BAD"* ]]

    rm -rf "$plugins_dir" "$patched"
}

@test "plugin resources coexist with core resources (no read-only conflict)" {
    mkdir -p "$RESOURCES_DIR/skills"
    mkdir -p "$RESOURCES_DIR/commands"
    echo "# Core Skill" > "$RESOURCES_DIR/skills/core-skill.md"
    echo "# Core Command" > "$RESOURCES_DIR/commands/core-command.md"

    local plugins_dir
    plugins_dir="$(mktemp -d)"
    mkdir -p "${plugins_dir}/example-plugin/skills"
    mkdir -p "${plugins_dir}/example-plugin/commands"
    echo "# Plugin Skill" > "${plugins_dir}/example-plugin/skills/example-plugin-skill.md"
    echo "# Plugin Command" > "${plugins_dir}/example-plugin/commands/example-plugin-cmd.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="example-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    [ -d "${TEST_HOME}/.claude/skills" ]
    [ ! -L "${TEST_HOME}/.claude/skills" ]
    [ -d "${TEST_HOME}/.claude/commands" ]
    [ ! -L "${TEST_HOME}/.claude/commands" ]

    [ -L "${TEST_HOME}/.claude/skills/core-skill.md" ]
    [ -L "${TEST_HOME}/.claude/skills/example-plugin-skill.md" ]
    [ -L "${TEST_HOME}/.claude/commands/core-command.md" ]
    [ -L "${TEST_HOME}/.claude/commands/example-plugin-cmd.md" ]

    grep -q "Core Skill" "${TEST_HOME}/.claude/skills/core-skill.md"
    grep -q "Plugin Skill" "${TEST_HOME}/.claude/skills/example-plugin-skill.md"
    grep -q "Core Command" "${TEST_HOME}/.claude/commands/core-command.md"
    grep -q "Plugin Command" "${TEST_HOME}/.claude/commands/example-plugin-cmd.md"

    rm -rf "$plugins_dir" "$patched"
}

@test "without plugins core resources are per-entry symlinks into a real dir" {
    mkdir -p "$RESOURCES_DIR/skills"
    mkdir -p "$RESOURCES_DIR/commands"
    echo "# Skill" > "$RESOURCES_DIR/skills/my-skill.md"
    echo "# Command" > "$RESOURCES_DIR/commands/my-command.md"

    unset SPEEDWAVE_PLUGINS
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]

    [ -d "${TEST_HOME}/.claude/skills" ]
    [ ! -L "${TEST_HOME}/.claude/skills" ]
    [ -L "${TEST_HOME}/.claude/skills/my-skill.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/skills/my-skill.md")" = "$RESOURCES_DIR/skills/my-skill.md" ]

    [ -d "${TEST_HOME}/.claude/commands" ]
    [ ! -L "${TEST_HOME}/.claude/commands" ]
    [ -L "${TEST_HOME}/.claude/commands/my-command.md" ]
}

@test "SPEEDWAVE_PLUGINS skips non-existent plugin directory" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="nonexistent-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    [ ! -e "${TEST_HOME}/.claude/commands/nonexistent-plugin" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS warns when plugin overwrites another plugin resource" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    mkdir -p "${plugins_dir}/alpha/commands"
    mkdir -p "${plugins_dir}/beta/commands"
    echo "alpha version" > "${plugins_dir}/alpha/commands/do-thing.md"
    echo "beta version" > "${plugins_dir}/beta/commands/do-thing.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="alpha,beta" run bash "$patched" true
    [ "$status" -eq 0 ]

    [[ "$output" == *"WARNING: plugin 'beta' overwrites commands/do-thing.md from another plugin"* ]]

    [ -L "${TEST_HOME}/.claude/commands/do-thing.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/commands/do-thing.md")" = "${plugins_dir}/beta/commands/do-thing.md" ]

    rm -rf "$plugins_dir" "$patched"
}


@test "plugin mode replaces stale whole-directory symlink left from no-plugins run" {
    mkdir -p "$RESOURCES_DIR/skills/code-review-basic"
    echo "# Core skill" > "$RESOURCES_DIR/skills/code-review-basic/SKILL.md"

    chmod 555 "$RESOURCES_DIR/skills"
    ln -sfn "$RESOURCES_DIR/skills" "$HOME/.claude/skills"

    local plugins_dir
    plugins_dir="$(mktemp -d)"
    mkdir -p "${plugins_dir}/my-plugin/skills/extra-skill"
    echo "# Plugin skill" > "${plugins_dir}/my-plugin/skills/extra-skill/SKILL.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true

    chmod 755 "$RESOURCES_DIR/skills"

    [ "$status" -eq 0 ]

    [ ! -L "$HOME/.claude/skills" ]
    [ -d "$HOME/.claude/skills" ]

    [ -L "$HOME/.claude/skills/code-review-basic" ]
    [ "$(readlink "$HOME/.claude/skills/code-review-basic")" = "$RESOURCES_DIR/skills/code-review-basic" ]
    [ -L "$HOME/.claude/skills/extra-skill" ]
    [ "$(readlink "$HOME/.claude/skills/extra-skill")" = "${plugins_dir}/my-plugin/skills/extra-skill" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "no-plugins mode preserves real directory of per-entry symlinks" {
    mkdir -p "$RESOURCES_DIR/skills/core-skill"
    echo "# Core" > "$RESOURCES_DIR/skills/core-skill/SKILL.md"

    mkdir -p "$HOME/.claude/skills"
    ln -sfn "/some/old/plugin/path/leftover" "$HOME/.claude/skills/leftover"

    unset SPEEDWAVE_PLUGINS
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]

    [ -d "$HOME/.claude/skills" ]
    [ ! -L "$HOME/.claude/skills" ]
    [ -L "$HOME/.claude/skills/core-skill" ]
    [ "$(readlink "$HOME/.claude/skills/core-skill")" = "$RESOURCES_DIR/skills/core-skill" ]
    [ -L "$HOME/.claude/skills/leftover" ]
    [ "$(readlink "$HOME/.claude/skills/leftover")" = "/some/old/plugin/path/leftover" ]
}



@test "SPEEDWAVE_SKIP_HUB_WAIT=1 bypasses the hub readiness probe" {
    export SPEEDWAVE_SKIP_HUB_WAIT=1
    SECONDS=0
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ "$SECONDS" -lt 5 ]
}

@test "without SPEEDWAVE_SKIP_HUB_WAIT, hub probe runs but tolerates failure" {
    unset SPEEDWAVE_SKIP_HUB_WAIT
    local patched
    patched="$(mktemp)"
    sed 's/local host="mcp-hub" port="${MCP_HUB_PORT}" attempts=30/local host="mcp-hub" port="${MCP_HUB_PORT}" attempts=2/' \
        "$ENTRYPOINT" > "$patched"
    run bash "$patched" true
    [ "$status" -eq 0 ]
    [ -f "$CLAUDE_READY_MARKER" ]
    [[ "$output" == *"did not respond"* ]]
    rm -f "$patched"
}



setup_integrations_fixture() {
    mkdir -p "$RESOURCES_DIR/skills/code-review-basic"
    echo "# Core" > "$RESOURCES_DIR/skills/code-review-basic/SKILL.md"
    mkdir -p "$RESOURCES_DIR/skills/integrations/office"
    echo "# Office" > "$RESOURCES_DIR/skills/integrations/office/SKILL.md"
    mkdir -p "$RESOURCES_DIR/skills/integrations/playwright"
    echo "# Playwright" > "$RESOURCES_DIR/skills/integrations/playwright/SKILL.md"
    mkdir -p "$RESOURCES_DIR/skills/integrations/context7"
    echo "# Context7" > "$RESOURCES_DIR/skills/integrations/context7/SKILL.md"
}

@test "core skill is symlinked regardless of ENABLED_SERVICES" {
    setup_integrations_fixture
    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
    [ ! -e "${TEST_HOME}/.claude/skills/integrations" ]
}

@test "ENABLED_SERVICES=office links integration skill" {
    setup_integrations_fixture
    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ "$(readlink "${TEST_HOME}/.claude/skills/office")" = "$RESOURCES_DIR/skills/integrations/office" ]
    [ ! -e "${TEST_HOME}/.claude/skills/playwright" ]
    [ ! -e "${TEST_HOME}/.claude/skills/context7" ]
}

@test "core and integration skills coexist" {
    setup_integrations_fixture
    ENABLED_SERVICES="office,playwright" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ -L "${TEST_HOME}/.claude/skills/playwright" ]
    [ ! -e "${TEST_HOME}/.claude/skills/context7" ]
}

@test "ENABLED_SERVICES tolerates whitespace around comma" {
    setup_integrations_fixture
    ENABLED_SERVICES=" office , playwright " run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ -L "${TEST_HOME}/.claude/skills/playwright" ]
}

@test "missing integrations/ directory is not an error" {
    mkdir -p "$RESOURCES_DIR/skills/code-review-basic"
    echo "# Core" > "$RESOURCES_DIR/skills/code-review-basic/SKILL.md"

    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
    [ ! -e "${TEST_HOME}/.claude/skills/office" ]
}

@test "gating works for all four resource types (skills/commands/agents/hooks)" {
    for rt in skills commands agents hooks; do
        mkdir -p "$RESOURCES_DIR/$rt/core-entry"
        echo "# Core $rt" > "$RESOURCES_DIR/$rt/core-entry/README.md"
        mkdir -p "$RESOURCES_DIR/$rt/integrations/office"
        echo "# Office $rt" > "$RESOURCES_DIR/$rt/integrations/office/README.md"
    done

    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    for rt in skills commands agents hooks; do
        [ -L "${TEST_HOME}/.claude/$rt/core-entry" ]
        [ "$(readlink "${TEST_HOME}/.claude/$rt/core-entry")" = "$RESOURCES_DIR/$rt/core-entry" ]
        [ -L "${TEST_HOME}/.claude/$rt/office" ]
        [ "$(readlink "${TEST_HOME}/.claude/$rt/office")" = "$RESOURCES_DIR/$rt/integrations/office" ]
    done

    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    for rt in skills commands agents hooks; do
        [ -L "${TEST_HOME}/.claude/$rt/core-entry" ]
        [ ! -e "${TEST_HOME}/.claude/$rt/office" ]
    done
}

@test "ENABLED_SERVICES=slack links and unlinks the slack skill (ADR-071)" {
    mkdir -p "$RESOURCES_DIR/skills/integrations/slack"
    echo "# Slack" > "$RESOURCES_DIR/skills/integrations/slack/SKILL.md"

    ENABLED_SERVICES="slack" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/slack" ]
    [ "$(readlink "${TEST_HOME}/.claude/skills/slack")" = "$RESOURCES_DIR/skills/integrations/slack" ]

    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/slack" ]
}

@test "toggle off removes previously-linked integration skill" {
    setup_integrations_fixture

    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ -f "${TEST_HOME}/.claude/.speedwave-managed-links" ]
    grep -q "skills/office$" "${TEST_HOME}/.claude/.speedwave-managed-links"

    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/office" ]
    run grep -q "skills/office$" "${TEST_HOME}/.claude/.speedwave-managed-links"
    [ "$status" -ne 0 ]
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
}

@test "swap: run 1 office, run 2 playwright — office gone, playwright present" {
    setup_integrations_fixture

    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]

    ENABLED_SERVICES="playwright" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/office" ]
    [ -L "${TEST_HOME}/.claude/skills/playwright" ]
}

@test "idempotency: two identical runs produce identical state file" {
    setup_integrations_fixture

    local snapshot
    snapshot="$(mktemp)"

    ENABLED_SERVICES="office,playwright" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    cp "${TEST_HOME}/.claude/.speedwave-managed-links" "${snapshot}"

    ENABLED_SERVICES="office,playwright" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    diff "${snapshot}" "${TEST_HOME}/.claude/.speedwave-managed-links"
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ -L "${TEST_HOME}/.claude/skills/playwright" ]

    rm -f "${snapshot}"
}

@test "reverse migration: pre-existing whole-dir symlink is replaced with real dir" {
    setup_integrations_fixture
    rm -rf "${TEST_HOME}/.claude/skills"
    ln -sfn "$RESOURCES_DIR/skills" "${TEST_HOME}/.claude/skills"
    [ -L "${TEST_HOME}/.claude/skills" ]

    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -d "${TEST_HOME}/.claude/skills" ]
    [ ! -L "${TEST_HOME}/.claude/skills" ]
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
}

@test "plugin and integration symlinks coexist in a single run" {
    setup_integrations_fixture

    local plugins_dir
    plugins_dir="$(mktemp -d)"
    mkdir -p "${plugins_dir}/foo/skills/foo-skill"
    echo "# Foo" > "${plugins_dir}/foo/skills/foo-skill/SKILL.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="foo" ENABLED_SERVICES="office" run bash "$patched" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ -L "${TEST_HOME}/.claude/skills/foo-skill" ]
    grep -q "skills/office$" "${TEST_HOME}/.claude/.speedwave-managed-links"
    grep -q "skills/foo-skill$" "${TEST_HOME}/.claude/.speedwave-managed-links"

    rm -rf "$plugins_dir" "$patched"
}

@test "plugin toggle off cleans up plugin link via state file" {
    mkdir -p "$RESOURCES_DIR/skills/core-skill"
    echo "# Core" > "$RESOURCES_DIR/skills/core-skill/SKILL.md"

    local plugins_dir
    plugins_dir="$(mktemp -d)"
    mkdir -p "${plugins_dir}/foo/skills/foo-skill"
    echo "# Foo" > "${plugins_dir}/foo/skills/foo-skill/SKILL.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="foo" run bash "$patched" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/foo-skill" ]

    unset SPEEDWAVE_PLUGINS
    run bash "$patched" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/foo-skill" ]
    [ -L "${TEST_HOME}/.claude/skills/core-skill" ]

    rm -rf "$plugins_dir" "$patched"
}

setup_os_subservice_fixture() {
    mkdir -p "$RESOURCES_DIR/skills/code-review-basic"
    echo "# Core" > "$RESOURCES_DIR/skills/code-review-basic/SKILL.md"
    for sub in reminders calendar mail notes; do
        mkdir -p "$RESOURCES_DIR/skills/integrations/$sub"
        echo "# $sub" > "$RESOURCES_DIR/skills/integrations/$sub/SKILL.md"
    done
}

@test "OS sub-service skills are gated jointly by ENABLED_SERVICES and DISABLED_OS_SERVICES" {
    setup_os_subservice_fixture

    ENABLED_SERVICES="os" DISABLED_OS_SERVICES="mail,notes" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/reminders" ]
    [ -L "${TEST_HOME}/.claude/skills/calendar" ]
    [ ! -e "${TEST_HOME}/.claude/skills/mail" ]
    [ ! -e "${TEST_HOME}/.claude/skills/notes" ]
}

@test "no OS sub-service skill is linked when os is not in ENABLED_SERVICES" {
    setup_os_subservice_fixture

    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/reminders" ]
    [ ! -e "${TEST_HOME}/.claude/skills/calendar" ]
    [ ! -e "${TEST_HOME}/.claude/skills/mail" ]
    [ ! -e "${TEST_HOME}/.claude/skills/notes" ]
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
}

@test "toggling a single OS sub-service off removes only that link" {
    setup_os_subservice_fixture

    ENABLED_SERVICES="os" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    for sub in reminders calendar mail notes; do
        [ -L "${TEST_HOME}/.claude/skills/$sub" ]
    done

    ENABLED_SERVICES="os" DISABLED_OS_SERVICES="mail" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/reminders" ]
    [ -L "${TEST_HOME}/.claude/skills/calendar" ]
    [ ! -e "${TEST_HOME}/.claude/skills/mail" ]
    [ -L "${TEST_HOME}/.claude/skills/notes" ]
}

@test "OS sub-services coexist with regular MCP integrations in ENABLED_SERVICES" {
    setup_os_subservice_fixture
    mkdir -p "$RESOURCES_DIR/skills/integrations/office"
    echo "# Office" > "$RESOURCES_DIR/skills/integrations/office/SKILL.md"

    ENABLED_SERVICES="office,os" DISABLED_OS_SERVICES="notes" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ -L "${TEST_HOME}/.claude/skills/reminders" ]
    [ -L "${TEST_HOME}/.claude/skills/calendar" ]
    [ -L "${TEST_HOME}/.claude/skills/mail" ]
    [ ! -e "${TEST_HOME}/.claude/skills/notes" ]
    [ ! -e "${TEST_HOME}/.claude/skills/os" ]
}


@test "SIGTERM during startup phase exits promptly via top trap" {
    unset SPEEDWAVE_SKIP_HUB_WAIT
    bash "$ENTRYPOINT" &
    pid=$!
    sleep 0.4
    [ ! -f "$CLAUDE_READY_MARKER" ] || skip "startup finished too fast to test the window"
    kill -TERM "$pid"
    for _ in $(seq 1 30); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    set +e
    wait "$pid"
    status=$?
    set -e
    [ "$status" -eq 0 ]
}

@test "keep-alive exits 0 on SIGTERM via trap" {
    bash "$ENTRYPOINT" &
    pid=$!
    for _ in $(seq 1 50); do
        [ -f "$CLAUDE_READY_MARKER" ] && break
        sleep 0.1
    done
    [ -f "$CLAUDE_READY_MARKER" ]
    kill -TERM "$pid"
    for _ in $(seq 1 30); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    set +e
    wait "$pid"
    status=$?
    set -e
    [ "$status" -eq 0 ]
}


_stub_claude_recording_plugin_installs() {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
echo "\$*" >> "$TEST_HOME/claude-calls.log"
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 1; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    echo "\$3" >> "$TEST_HOME/installed-plugins.log"
    exit 0
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
}

_plant_installed_plugins() {
    mkdir -p "$TEST_HOME/.claude/plugins"
    local ids entries="" id
    read -ra ids <<< "$1"
    for id in "${ids[@]}"; do
        [ -n "$entries" ] && entries+=","
        entries+="\"${id}\":[{\"scope\":\"user\",\"version\":\"1.0.0\",\"installedAt\":\"2026-03-17T23:13:39.280Z\",\"path\":\"/home/speedwave/.claude/plugins/cache/x/x\"}]"
    done
    printf '{"version":2,"plugins":{%s}}' "$entries" > "$TEST_HOME/.claude/plugins/installed_plugins.json"
    [ -f "$TEST_HOME/.claude/plugins/installed_plugins.json" ]
}

@test "installs each bundled plugin when no record exists" {
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design,feature-dev,example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"frontend-design@claude-plugins-official"* ]]
    [[ "$output" == *"feature-dev@claude-plugins-official"* ]]
    [[ "$output" == *"example-plugin@claude-plugins-official"* ]]
}

@test "does not install any plugin when the bundled-plugins env is unset" {
    _stub_claude_recording_plugin_installs
    unset SPEEDWAVE_BUNDLED_PLUGINS
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -f "$TEST_HOME/installed-plugins.log" ]
}

@test "a missing install record means nothing installed" {
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"frontend-design@claude-plugins-official"* ]]
}

@test "a malformed install record means nothing installed" {
    _stub_claude_recording_plugin_installs
    mkdir -p "$TEST_HOME/.claude/plugins"
    echo "not json" > "$TEST_HOME/.claude/plugins/installed_plugins.json"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"frontend-design@claude-plugins-official"* ]]
}

@test "a record whose entry is an empty array means not installed" {
    _stub_claude_recording_plugin_installs
    mkdir -p "$TEST_HOME/.claude/plugins"
    echo '{"version":2,"plugins":{"frontend-design@claude-plugins-official":[]}}' \
        > "$TEST_HOME/.claude/plugins/installed_plugins.json"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"frontend-design@claude-plugins-official"* ]]
}

@test "a pre-fix marker poisoned by the empty-list bug does not skip installs" {
    _stub_claude_recording_plugin_installs
    mkdir -p "$TEST_HOME/.claude"
    printf '%s\n' "frontend-design@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"frontend-design@claude-plugins-official"* ]]
    [ ! -f "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed" ]
}

@test "a failing plugin install is non-fatal and surfaces the error reason" {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
echo "\$*" >> "$TEST_HOME/claude-calls.log"
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 1; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    echo "network down" >&2
    exit 1
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design,feature-dev"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"failed to install bundled plugin"* ]]
    [[ "$output" == *"network down"* ]]
}

@test "skips an invalid bundled-plugin name and continues with the rest" {
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="Bad_Name,example-plugin"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"invalid bundled-plugin name: Bad_Name"* ]]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"example-plugin@"* ]]
    [[ "$output" != *"Bad_Name"* ]]
}

@test "skips all installs when the bundled-plugin marketplace is invalid" {
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="Bad/Marketplace"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"invalid bundled-plugin marketplace"* ]]
    [ ! -f "$TEST_HOME/installed-plugins.log" ]
}

@test "an invalid bundled-plugin marketplace runs no claude plugin command at all" {
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="Bad/Marketplace"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run grep -c '^plugin' "$TEST_HOME/claude-calls.log"
    [ "$output" = "0" ]
}

@test "a restart with every bundled plugin already recorded runs no claude plugin command at all" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design,feature-dev"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"frontend-design@claude-plugins-official"* ]]
    [[ "$output" == *"feature-dev@claude-plugins-official"* ]]

    rm -f "$TEST_HOME/claude-calls.log"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run grep -c '^plugin' "$TEST_HOME/claude-calls.log"
    [ "$output" = "0" ]
}

@test "missing jq warns and deterministically skips bundled-plugin install" {
    rm -f "$STUBS_DIR/jq"
    command -v jq &> /dev/null && skip "a non-stub jq is reachable on this test host"
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING: jq not found"* ]]
    [ ! -f "$TEST_HOME/installed-plugins.log" ]
}

@test "a newly added bundled plugin is still installed on the next start" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"

    SPEEDWAVE_BUNDLED_PLUGINS="frontend-design" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"frontend-design@claude-plugins-official"* ]]

    SPEEDWAVE_BUNDLED_PLUGINS="frontend-design,feature-dev" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" == *"feature-dev@claude-plugins-official"* ]]
}

@test "does not reinstall a plugin whose record entry is a non-empty array" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_recording_plugin_installs
    _plant_installed_plugins "frontend-design@claude-plugins-official"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design,feature-dev"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [[ "$output" != *"frontend-design@"* ]]
    [[ "$output" == *"feature-dev@claude-plugins-official"* ]]
}

_stub_claude_recording_all_plugin_calls() {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
echo "\$*" >> "$TEST_HOME/claude-calls.log"
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 1; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "marketplace" ] && [ "\$3" = "add" ]; then
    echo "marketplace-add \$4" >> "$TEST_HOME/plugin-calls.log"; exit 0
fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    echo "install \$3" >> "$TEST_HOME/plugin-calls.log"; exit 0
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
}

@test "bootstraps the official marketplace once, before the first bundled-plugin install" {
    _stub_claude_recording_all_plugin_calls
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design,example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/plugin-calls.log"
    [ "${lines[0]}" = "marketplace-add anthropics/claude-plugins-official" ]
    [ "${lines[1]}" = "install frontend-design@claude-plugins-official" ]
    [ "${lines[2]}" = "install example-plugin@claude-plugins-official" ]
    [ "${#lines[@]}" -eq 3 ]
}

@test "does not bootstrap a custom bundled-plugin marketplace" {
    _stub_claude_recording_all_plugin_calls
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="custom-mp"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/plugin-calls.log"
    [ "${lines[0]}" = "install example-plugin@custom-mp" ]
    [ "${#lines[@]}" -eq 1 ]
}

@test "skips the network add when the official marketplace is already registered on disk" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_recording_all_plugin_calls
    mkdir -p "$TEST_HOME/.claude/plugins"
    echo '{"claude-plugins-official":{"source":{"source":"github"}}}' \
        > "$TEST_HOME/.claude/plugins/known_marketplaces.json"
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/plugin-calls.log"
    [ "${lines[0]}" = "install example-plugin@claude-plugins-official" ]
    [ "${#lines[@]}" -eq 1 ]
}

@test "a null tombstone entry for the official marketplace does not skip the add" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_recording_all_plugin_calls
    mkdir -p "$TEST_HOME/.claude/plugins"
    echo '{"claude-plugins-official":null}' > "$TEST_HOME/.claude/plugins/known_marketplaces.json"
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/plugin-calls.log"
    [ "${lines[0]}" = "marketplace-add anthropics/claude-plugins-official" ]
    [ "${lines[1]}" = "install example-plugin@claude-plugins-official" ]
}

@test "bundled-plugin install carries at least a 120s timeout budget" {
    grep -qE 'timeout (1[2-9][0-9]|[2-9][0-9][0-9]) claude plugin install' "$ENTRYPOINT"
}

@test "a registry listing only other marketplaces does not skip the official add" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_recording_all_plugin_calls
    mkdir -p "$TEST_HOME/.claude/plugins"
    echo '{"some-other-mp":{}}' > "$TEST_HOME/.claude/plugins/known_marketplaces.json"
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/plugin-calls.log"
    [ "${lines[0]}" = "marketplace-add anthropics/claude-plugins-official" ]
    [ "${lines[1]}" = "install example-plugin@claude-plugins-official" ]
}

@test "skips marketplace bootstrap when every bundled plugin is already installed" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_recording_all_plugin_calls
    _plant_installed_plugins "example-plugin@claude-plugins-official"
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -f "$TEST_HOME/plugin-calls.log" ]
}

@test "a failed marketplace bootstrap is non-fatal, logged, and installs still run" {
    _stub_claude_recording_all_plugin_calls
    sed -i.bak 's|echo "marketplace-add .*|echo "network unreachable" >\&2; exit 1|' "$STUBS_DIR/claude"
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"failed to add plugin marketplace"* ]]
    [[ "$output" == *"network unreachable"* ]]
    run cat "$TEST_HOME/plugin-calls.log"
    [ "${lines[0]}" = "install example-plugin@claude-plugins-official" ]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"WARN CONFIG"* ]]
    [[ "$output" == *"marketplace add claude-plugins-official: network unreachable"* ]]
}


_stub_claude_retired_plugin() {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
echo "\$*" >> "$TEST_HOME/claude-calls.log"
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 1; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "uninstall" ]; then
    echo "\$3" >> "$TEST_HOME/uninstall.log"
    if [ -f "$TEST_HOME/uninstall-fail" ]; then cat "$TEST_HOME/uninstall-fail" >&2; exit 1; fi
    exit 0
fi
if [ "\$1" = "plugin" ] && [ "\$2" = "marketplace" ] && [ "\$3" = "add" ]; then
    echo "marketplace-add \$4" >> "$TEST_HOME/plugin-calls.log"; exit 0
fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    echo "\$3" >> "$TEST_HOME/installed-plugins.log"; exit 0
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
}

@test "a marker-recorded retired plugin is uninstalled once and its cache tree removed" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "superpowers@claude-plugins-official"
    mkdir -p "$TEST_HOME/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0"
    echo "# skill" > "$TEST_HOME/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/SKILL.md"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/uninstall.log"
    [ "${lines[0]}" = "superpowers@claude-plugins-official" ]
    [ "${#lines[@]}" -eq 1 ]
    [ -f "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2" ]
    run grep -qxF "superpowers@claude-plugins-official" \
        "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    [ "$status" -ne 0 ]
    [ ! -e "$TEST_HOME/.claude/plugins/cache/claude-plugins-official/superpowers" ]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"INFO OK"* ]]
    [[ "$output" == *"uninstalled retired plugin superpowers@claude-plugins-official"* ]]
}

@test "a plugin Speedwave never recorded installing is left alone" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin

    printf '%s\n' "frontend-design@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -f "$TEST_HOME/uninstall.log" ]

    rm -f "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -f "$TEST_HOME/uninstall.log" ]
}

@test "a failing retired-plugin uninstall is non-fatal and keeps the marker entry for a retry" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "superpowers@claude-plugins-official"
    printf '%s\n' "boom" > "$TEST_HOME/uninstall-fail"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"failed to uninstall retired plugin superpowers@claude-plugins-official"* ]]
    [[ "$output" == *"boom"* ]]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"WARN PLUGIN"* ]]
    [[ "$output" == *"uninstall superpowers@claude-plugins-official: boom"* ]]
    grep -qxF "superpowers@claude-plugins-official" \
        "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
}

@test "a well-formed record without the retired plugin drops the marker entry without calling uninstall" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    mkdir -p "$TEST_HOME/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0"
    mkdir -p "$TEST_HOME/.claude/plugins"
    echo '{"version":2,"plugins":{}}' > "$TEST_HOME/.claude/plugins/installed_plugins.json"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -f "$TEST_HOME/uninstall.log" ]
    [ ! -e "$TEST_HOME/.claude/plugins/cache/claude-plugins-official/superpowers" ]
    [ -f "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2" ]
    run grep -qxF "superpowers@claude-plugins-official" \
        "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    [ "$status" -ne 0 ]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"INFO SKIP"* ]]
    [[ "$output" == *"superpowers@claude-plugins-official not installed"* ]]

    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "frontend-design@claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -f "$TEST_HOME/uninstall.log" ]
    [ -f "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2" ]
    run grep -qxF "superpowers@claude-plugins-official" \
        "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    [ "$status" -ne 0 ]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"INFO SKIP"* ]]
    [[ "$output" == *"superpowers@claude-plugins-official not installed"* ]]
}

@test "a second start after a successful removal does not call uninstall again" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "superpowers@claude-plugins-official"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$TEST_HOME/uninstall.log")" -eq 1 ]
}

@test "an uninstall rejected as not installed is treated as already removed" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "superpowers@claude-plugins-official"
    printf '%s\n' 'Plugin "superpowers@claude-plugins-official" not found in installed plugins' \
        > "$TEST_HOME/uninstall-fail"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" != *"failed to uninstall retired plugin"* ]]
    [ -f "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2" ]
    run grep -qxF "superpowers@claude-plugins-official" \
        "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    [ "$status" -ne 0 ]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"INFO SKIP"* ]]
    [[ "$output" == *"superpowers@claude-plugins-official already removed"* ]]
}

@test "a missing or malformed install record is treated as unknown, so the retired uninstall still runs" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/uninstall.log"
    [ "${lines[0]}" = "superpowers@claude-plugins-official" ]
    [ "${#lines[@]}" -eq 1 ]

    rm -f "$TEST_HOME/uninstall.log"
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    mkdir -p "$TEST_HOME/.claude/plugins"
    echo "not json" > "$TEST_HOME/.claude/plugins/installed_plugins.json"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/uninstall.log"
    [ "${lines[0]}" = "superpowers@claude-plugins-official" ]
    [ "${#lines[@]}" -eq 1 ]
}

@test "removing the retired marker entry leaves the other bundled-plugin entries intact" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "frontend-design@claude-plugins-official" \
        "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "superpowers@claude-plugins-official"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    [ "${lines[0]}" = "frontend-design@claude-plugins-official" ]
    [ "${#lines[@]}" -eq 1 ]
    [ ! -f "$TEST_HOME/installed-plugins.log" ]
    [ "$(wc -l < "$TEST_HOME/uninstall.log")" -eq 1 ]
}

@test "missing jq warns and skips the retired-plugin removal, keeping the marker entry" {
    rm -f "$STUBS_DIR/jq"
    command -v jq &> /dev/null && skip "a non-stub jq is reachable on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING: jq not found"* ]]
    [[ "$output" == *"skipping removal of retired plugin superpowers@claude-plugins-official"* ]]
    [ ! -f "$TEST_HOME/uninstall.log" ]
    grep -qxF "superpowers@claude-plugins-official" \
        "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
}

@test "the retired-plugin uninstall carries a timeout budget" {
    grep -qE 'timeout ([6-9][0-9]|[1-9][0-9]{2,}) claude plugin uninstall' "$ENTRYPOINT"
}

@test "a failing retired-plugin uninstall keeps its marker line through a bundled-install rebuild" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "superpowers@claude-plugins-official"
    printf '%s\n' "boom" > "$TEST_HOME/uninstall-fail"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/installed-plugins.log"
    [ "${lines[0]}" = "frontend-design@claude-plugins-official" ]
    run cat "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    [ "${lines[0]}" = "frontend-design@claude-plugins-official" ]
    [ "${lines[1]}" = "superpowers@claude-plugins-official" ]
    [ "${#lines[@]}" -eq 2 ]
}

@test "a marker rewrite that cannot write its temp file warns and keeps the entry" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "superpowers@claude-plugins-official"
    mkdir -p "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2.tmp"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"could not rewrite the bundled-plugins marker"* ]]
    grep -qxF "superpowers@claude-plugins-official" \
        "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"WARN PLUGIN"* ]]
    [[ "$output" == *"marker rewrite failed"* ]]
}

@test "a bundled plugin found installed without a Speedwave record is marked found and counts as recorded" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    _plant_installed_plugins "frontend-design@claude-plugins-official"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -f "$TEST_HOME/installed-plugins.log" ]
    run cat "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    [ "${lines[0]}" = "frontend-design@claude-plugins-official#found" ]
    [ "${#lines[@]}" -eq 1 ]

    rm -f "$TEST_HOME/claude-calls.log"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run grep -c '^plugin' "$TEST_HOME/claude-calls.log"
    [ "$output" = "0" ]
}

@test "a retired plugin recorded as found is the user's install and is never uninstalled" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "superpowers@claude-plugins-official#found" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "superpowers@claude-plugins-official"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -f "$TEST_HOME/uninstall.log" ]
    grep -qxF "superpowers@claude-plugins-official#found" \
        "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
}

@test "a marker rebuild carries over Speedwave's own install records unchanged" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    printf '%s\n' "frontend-design@claude-plugins-official" \
        > "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    _plant_installed_plugins "frontend-design@claude-plugins-official"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design,feature-dev"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/.claude/.speedwave-bundled-plugins-installed.v2"
    [ "${lines[0]}" = "feature-dev@claude-plugins-official" ]
    [ "${lines[1]}" = "frontend-design@claude-plugins-official" ]
    [ "${#lines[@]}" -eq 2 ]
}

@test "plugin bookkeeping starts no Claude Code process" {
    [ -x "$STUBS_DIR/jq" ] || skip "jq not available on this test host"
    _stub_claude_retired_plugin
    _plant_installed_plugins "frontend-design@claude-plugins-official feature-dev@claude-plugins-official example-plugin@claude-plugins-official"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design,feature-dev,example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run grep -c '^plugin' "$TEST_HOME/claude-calls.log"
    [ "$output" = "0" ]
}


_make_hook_plugin() {
    local dir="$1" slug="$2"
    mkdir -p "${dir}/${slug}/hooks"
    echo "// hook" > "${dir}/${slug}/hooks/hook.mjs"
    cat > "${dir}/${slug}/hooks/hooks.json" << 'EOF'
{
  "UserPromptSubmit": [
    { "hooks": [ { "type": "command", "command": "node ${SPEEDWAVE_HOOK_DIR}/hook.mjs", "timeout": 10 } ] }
  ]
}
EOF
}

_patch_plugins_dir() {
    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|$1/|g" "$ENTRYPOINT" > "$patched"
    echo "$patched"
}

_settings_check() {
    node -e "const s=JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/settings.json','utf8')); process.exit(($1)?0:1)"
}

@test "plugin hooks.json registers a settings hook with SPEEDWAVE_HOOK_DIR substituted" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    run _settings_check "s.hooks.UserPromptSubmit[0].hooks[0].command==='node ${plugins_dir}/my-plugin/hooks/hook.mjs'"
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.UserPromptSubmit[0].hooks[0].timeout===10"
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/hooks/hooks.json" ]
    [ -L "${TEST_HOME}/.claude/hooks/hook.mjs" ]
    [ -f "${TEST_HOME}/.claude/.speedwave-managed-hooks" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "hooks from multiple plugins concatenate under the same event" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "alpha"
    _make_hook_plugin "$plugins_dir" "beta"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="alpha,beta" run bash "$patched" true
    [ "$status" -eq 0 ]

    run _settings_check "s.hooks.UserPromptSubmit.length===2"
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.UserPromptSubmit[0].hooks[0].command.includes('/alpha/hooks/') && s.hooks.UserPromptSubmit[1].hooks[0].command.includes('/beta/hooks/')"
    [ "$status" -eq 0 ]

    rm -rf "$plugins_dir" "$patched"
}

@test "plugin toggle-off removes injected hooks but preserves user-added hooks" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    node -e "
const fs=require('fs');
const p='${TEST_HOME}/.claude/settings.json';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
s.hooks.UserPromptSubmit.push({hooks:[{type:'command',command:'echo user-hook'}]});
s.hooks.SessionStart=[{hooks:[{type:'command',command:'echo user-session'}]}];
fs.writeFileSync(p,JSON.stringify(s,null,2));
"

    unset SPEEDWAVE_PLUGINS
    run bash "$patched" true
    [ "$status" -eq 0 ]

    run _settings_check "s.hooks.UserPromptSubmit.length===1 && s.hooks.UserPromptSubmit[0].hooks[0].command==='echo user-hook'"
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.SessionStart[0].hooks[0].command==='echo user-session'"
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/.speedwave-managed-hooks" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "a user-added hook structurally identical to a managed one survives toggle-off" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    node -e "
const fs=require('fs');
const p='${TEST_HOME}/.claude/settings.json';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
const copy = JSON.parse(JSON.stringify(s.hooks.UserPromptSubmit[0]));
delete copy._speedwaveHookId;
s.hooks.UserPromptSubmit.push(copy);
fs.writeFileSync(p,JSON.stringify(s,null,2));
"
    run _settings_check "s.hooks.UserPromptSubmit.length===2"
    [ "$status" -eq 0 ]

    unset SPEEDWAVE_PLUGINS
    run bash "$patched" true
    [ "$status" -eq 0 ]

    run _settings_check "s.hooks.UserPromptSubmit.length===1 && s.hooks.UserPromptSubmit[0]._speedwaveHookId===undefined"
    [ "$status" -eq 0 ]

    rm -rf "$plugins_dir" "$patched"
}

@test "toggle-off with no user hooks removes the hooks key entirely" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.UserPromptSubmit.length===1"
    [ "$status" -eq 0 ]

    unset SPEEDWAVE_PLUGINS
    run bash "$patched" true
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks===undefined"
    [ "$status" -eq 0 ]

    rm -rf "$plugins_dir" "$patched"
}

@test "malformed plugin hooks.json warns and does not block other plugins" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "good-plugin"
    mkdir -p "${plugins_dir}/bad-plugin/hooks"
    echo 'NOT_JSON' > "${plugins_dir}/bad-plugin/hooks/hooks.json"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="bad-plugin,good-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING: ignoring invalid hooks declaration"* ]]
    run _settings_check "s.hooks.UserPromptSubmit.length===1 && s.hooks.UserPromptSubmit[0].hooks[0].command.includes('/good-plugin/hooks/')"
    [ "$status" -eq 0 ]

    rm -rf "$plugins_dir" "$patched"
}

@test "hooks.json with invalid event name, hook shape, or empty command is rejected" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    mkdir -p "${plugins_dir}/evt-plugin/hooks" "${plugins_dir}/shape-plugin/hooks" "${plugins_dir}/empty-plugin/hooks"
    cat > "${plugins_dir}/evt-plugin/hooks/hooks.json" << 'EOF'
{ "userPromptSubmit": [ { "hooks": [ { "type": "command", "command": "echo x" } ] } ] }
EOF
    cat > "${plugins_dir}/shape-plugin/hooks/hooks.json" << 'EOF'
{ "UserPromptSubmit": [ { "hooks": [ { "command": "echo x" } ] } ] }
EOF
    cat > "${plugins_dir}/empty-plugin/hooks/hooks.json" << 'EOF'
{ "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "  " } ] } ] }
EOF
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="evt-plugin,shape-plugin,empty-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING: ignoring invalid hooks declaration"* ]]
    [ ! -e "${TEST_HOME}/.claude/settings.json" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "core bundle hooks.json registers unconditionally" {
    mkdir -p "$RESOURCES_DIR/hooks"
    echo "// core hook" > "$RESOURCES_DIR/hooks/core-hook.mjs"
    cat > "$RESOURCES_DIR/hooks/hooks.json" << 'EOF'
{ "SessionStart": [ { "hooks": [ { "type": "command", "command": "node ${SPEEDWAVE_HOOK_DIR}/core-hook.mjs" } ] } ] }
EOF

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.SessionStart[0].hooks[0].command==='node ${RESOURCES_DIR}/hooks/core-hook.mjs'"
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/hooks/hooks.json" ]
    [ -L "${TEST_HOME}/.claude/hooks/core-hook.mjs" ]
}

@test "integration hooks.json is gated by ENABLED_SERVICES and cleaned on toggle-off" {
    mkdir -p "$RESOURCES_DIR/hooks/integrations/office"
    cat > "$RESOURCES_DIR/hooks/integrations/office/hooks.json" << 'EOF'
{ "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node ${SPEEDWAVE_HOOK_DIR}/guard.mjs" } ] } ] }
EOF
    echo "// guard" > "$RESOURCES_DIR/hooks/integrations/office/guard.mjs"

    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.PreToolUse[0].matcher==='Bash' && s.hooks.PreToolUse[0].hooks[0].command==='node ${RESOURCES_DIR}/hooks/integrations/office/guard.mjs'"
    [ "$status" -eq 0 ]

    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks===undefined"
    [ "$status" -eq 0 ]
}

@test "OS sub-service hooks.json is gated jointly by os enablement and DISABLED_OS_SERVICES" {
    for sub in mail calendar; do
        mkdir -p "$RESOURCES_DIR/hooks/integrations/$sub"
        cat > "$RESOURCES_DIR/hooks/integrations/$sub/hooks.json" << EOF
{ "SessionStart": [ { "hooks": [ { "type": "command", "command": "echo $sub" } ] } ] }
EOF
    done

    ENABLED_SERVICES="os" DISABLED_OS_SERVICES="mail" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.SessionStart.length===1 && s.hooks.SessionStart[0].hooks[0].command==='echo calendar'"
    [ "$status" -eq 0 ]
}

@test "hook registration is idempotent across identical runs" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    printf '{"effortLevel":"high"}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    local snapshot
    snapshot="$(mktemp)"
    cp "${TEST_HOME}/.claude/settings.json" "$snapshot"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    diff "$snapshot" "${TEST_HOME}/.claude/settings.json"
    run _settings_check "s.hooks.UserPromptSubmit.length===1"
    [ "$status" -eq 0 ]
    run _settings_check "s.effortLevel==='high'"
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/settings.json.tmp" ]

    rm -rf "$plugins_dir" "$patched" "$snapshot"
}

@test "hook registration swap: plugin alpha replaced by beta between runs" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "alpha"
    _make_hook_plugin "$plugins_dir" "beta"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="alpha" run bash "$patched" true
    [ "$status" -eq 0 ]
    SPEEDWAVE_PLUGINS="beta" run bash "$patched" true
    [ "$status" -eq 0 ]

    run _settings_check "s.hooks.UserPromptSubmit.length===1 && s.hooks.UserPromptSubmit[0].hooks[0].command.includes('/beta/hooks/')"
    [ "$status" -eq 0 ]

    rm -rf "$plugins_dir" "$patched"
}

@test "corrupt settings.json skips hook registration and leaves the file untouched" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    printf 'NOT_JSON' > "${TEST_HOME}/.claude/settings.json"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"hook registration skipped"* ]]
    [ "$(cat "${TEST_HOME}/.claude/settings.json")" = 'NOT_JSON' ]
    [ ! -e "${TEST_HOME}/.claude/settings.json.tmp" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "non-object hooks key in settings.json skips registration and leaves the file untouched" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    printf '{"hooks":[]}' > "${TEST_HOME}/.claude/settings.json"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"hooks key is not an object — hook registration skipped"* ]]
    [ "$(cat "${TEST_HOME}/.claude/settings.json")" = '{"hooks":[]}' ]

    rm -rf "$plugins_dir" "$patched"
}

@test "non-array event value in settings hooks is skipped with a warning, other events register" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    printf '{"hooks":{"UserPromptSubmit":"oops"}}' > "${TEST_HOME}/.claude/settings.json"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"hooks.UserPromptSubmit is not an array"* ]]
    run _settings_check "s.hooks.UserPromptSubmit==='oops'"
    [ "$status" -eq 0 ]

    rm -rf "$plugins_dir" "$patched"
}

@test "hand-deleted injected hook is re-added on the next start while its source stays enabled" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    node -e "
const fs=require('fs');
const p='${TEST_HOME}/.claude/settings.json';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
delete s.hooks;
fs.writeFileSync(p,JSON.stringify(s,null,2));
"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.UserPromptSubmit.length===1"
    [ "$status" -eq 0 ]

    rm -rf "$plugins_dir" "$patched"
}

@test "a lost managed-hooks manifest does not duplicate injected hooks" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    rm -f "${TEST_HOME}/.claude/.speedwave-managed-hooks"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    run _settings_check "s.hooks.UserPromptSubmit.length===1"
    [ "$status" -eq 0 ]
    [ -f "${TEST_HOME}/.claude/.speedwave-managed-hooks" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "a corrupt managed-hooks manifest warns, does not duplicate, and is rewritten" {
    local plugins_dir patched
    plugins_dir="$(mktemp -d)"
    _make_hook_plugin "$plugins_dir" "my-plugin"
    patched="$(_patch_plugins_dir "$plugins_dir")"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    printf 'NOT_JSON' > "${TEST_HOME}/.claude/.speedwave-managed-hooks"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"managed-hooks state unparseable"* ]]
    run _settings_check "s.hooks.UserPromptSubmit.length===1"
    [ "$status" -eq 0 ]
    run node -e "JSON.parse(require('fs').readFileSync('${TEST_HOME}/.claude/.speedwave-managed-hooks','utf8'))"
    [ "$status" -eq 0 ]

    rm -rf "$plugins_dir" "$patched"
}


@test "startup log records a failed bundled-plugin install with reason and level" {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 0; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    echo "Failed to clone repository" >&2
    exit 1
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [[ "$output" == *"failed to install bundled plugin"* ]]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"ERROR FAIL"* ]]
    [[ "$output" == *"example-plugin@claude-plugins-official"* ]]
    [[ "$output" == *"Failed to clone repository"* ]]
    [[ "$output" == *"entrypoint done (1 failure"* ]]
}

@test "startup log lines carry a parseable timestamp and a known level" {
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run bash -c "grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[^ ]* (INFO|WARN|ERROR) ' '$TEST_HOME/.speedwave-entrypoint.log'"
    [ "$output" -ge 2 ]
}

@test "startup log is truncated on each start, not appended" {
    _stub_claude_recording_plugin_installs
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run bash -c "grep -c 'speedwave entrypoint' '$TEST_HOME/.speedwave-entrypoint.log'"
    [ "$output" -eq 1 ]
}

@test "a write failure mid-start never fails the container start" {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
chmod 400 "$TEST_HOME/.speedwave-entrypoint.log" 2>/dev/null || true
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then echo '[]'; exit 0; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then exit 0; fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
    export SPEEDWAVE_BUNDLED_PLUGINS="frontend-design"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    chmod 600 "$TEST_HOME/.speedwave-entrypoint.log" 2>/dev/null || true
}

@test "the startup log is refused when claude-home holds a symlink in its place" {
    _stub_claude_recording_plugin_installs
    mkdir -p "$TEST_HOME"
    ln -sf /etc/passwd "$TEST_HOME/.speedwave-entrypoint.log"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run bash -c "grep -o 'speedwave entrypoint' /etc/passwd 2>/dev/null | wc -l | tr -d ' '"
    [ "$output" -eq 0 ]
}


@test "startup log redacts Bearer ghp_, xoxe rotating and x-speedwave-proxy-auth secrets" {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 0; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    echo "auth failed: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn and xoxe.xoxp-FAKE-TOKEN-VALUE and x-speedwave-proxy-auth: synthetic-test-token-0000000000000000000000" >&2
    exit 1
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"[REDACTED]"* ]]
    [[ "$output" != *"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"* ]]
    [[ "$output" != *"xoxe."* ]]
    [[ "$output" != *"synthetic-test-token-0000000000000000000000"* ]]
    [[ "$output" == *"x-speedwave-proxy-auth: [REDACTED]"* ]]
}

@test "startup log redacts an Anthropic sk-ant- key and a GitHub fine-grained github_pat_ token" {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 0; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    echo "leaked sk-ant-api03-abcdef123456789-abcdef and github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" >&2
    exit 1
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
    export SPEEDWAVE_BUNDLED_PLUGINS="example-plugin"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="claude-plugins-official"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" == *"[REDACTED]"* ]]
    [[ "$output" != *"sk-ant-api03-abcdef123456789-abcdef"* ]]
    [[ "$output" != *"github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"* ]]
}

@test "startup log message at exactly the 500-char cap is kept in full" {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 0; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    printf 'A%.0s' {1..494} >&2
    printf 'Z' >&2
    exit 1
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
    export SPEEDWAVE_BUNDLED_PLUGINS="p"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="m"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run bash -c "grep -o 'p@m: A*Z' '$TEST_HOME/.speedwave-entrypoint.log'"
    [ "$status" -eq 0 ]
    [ "${#output}" -eq 500 ]
    [[ "$output" == *Z ]]
}

@test "startup log message over the 500-char cap is truncated, dropping the tail" {
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
if [ "\$1" = "plugin" ] && [ "\$2" = "list" ]; then exit 0; fi
if [ "\$1" = "plugin" ] && [ "\$2" = "install" ]; then
    printf 'A%.0s' {1..495} >&2
    printf 'Z' >&2
    exit 1
fi
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"
    export SPEEDWAVE_BUNDLED_PLUGINS="p"
    export SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="m"
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    run cat "$TEST_HOME/.speedwave-entrypoint.log"
    [[ "$output" != *"Z"* ]]
    run bash -c "grep -o 'p@m: A*' '$TEST_HOME/.speedwave-entrypoint.log'"
    [ "$status" -eq 0 ]
    [ "${#output}" -eq 500 ]
}

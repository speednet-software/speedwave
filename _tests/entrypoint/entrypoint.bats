#!/usr/bin/env bats
# Tests for containers/entrypoint.sh
# Runs on the host (macOS/Linux) — no container required.
# Stubs out 'curl' and 'claude' to avoid network calls.

ENTRYPOINT="$BATS_TEST_DIRNAME/../../containers/entrypoint.sh"

setup() {
    TEST_HOME="$(mktemp -d)"
    export HOME="$TEST_HOME"
    mkdir -p "$HOME/.claude"

    RESOURCES_DIR="$(mktemp -d)"
    export SPEEDWAVE_RESOURCES="$RESOURCES_DIR"

    # Stubs dir goes first in PATH; also strip real claude locations
    STUBS_DIR="$(mktemp -d)"
    export STUBS_DIR
    CLEAN_PATH="$STUBS_DIR:$(echo "$PATH" | tr ':' '\n' \
        | grep -v '\.local/bin' | grep -v 'homebrew' \
        | tr '\n' ':' | sed 's/:$//')"
    export PATH="$CLEAN_PATH"

    # Default stub: claude already installed — skip curl
    cat > "$STUBS_DIR/claude" << 'EOF'
#!/bin/bash
echo "2.1.45 (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"

    # Default curl stub — fail loudly if unexpectedly called
    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
echo "UNEXPECTED curl: $*" >&2
exit 1
EOF
    chmod +x "$STUBS_DIR/curl"
}

teardown() {
    rm -rf "$TEST_HOME" "$STUBS_DIR" "$RESOURCES_DIR"
}

# ---------------------------------------------------------------------------
# CLAUDE_VERSION — default and passthrough
# ---------------------------------------------------------------------------

@test "CLAUDE_VERSION defaults to 'latest' when env var is unset" {
    rm -f "$STUBS_DIR/claude"  # force install path

    local version_file
    version_file="$(mktemp)"

    # curl stub: entrypoint calls `curl -fsSL <url> -o <file>`, so parse -o to find output path
    # and write a tiny script that records $1 (the version) into version_file
    cat > "$STUBS_DIR/curl" << EOF
#!/bin/bash
OUT=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in -o) OUT="\$2"; shift 2;; *) shift;; esac
done
[ -n "\$OUT" ] && echo "echo \\\$1 > ${version_file}" > "\$OUT"
EOF
    chmod +x "$STUBS_DIR/curl"

    CLAUDE_VERSION="" run bash "$ENTRYPOINT" true 2>/dev/null || true

    [[ -s "$version_file" ]]
    grep -q "latest" "$version_file"
    rm -f "$version_file"
}

@test "CLAUDE_VERSION env var is forwarded to install.sh" {
    rm -f "$STUBS_DIR/claude"

    local version_file
    version_file="$(mktemp)"

    # curl stub: parse -o flag, write installer script to the output file
    cat > "$STUBS_DIR/curl" << EOF
#!/bin/bash
OUT=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in -o) OUT="\$2"; shift 2;; *) shift;; esac
done
[ -n "\$OUT" ] && echo "echo \\\$1 > ${version_file}" > "\$OUT"
EOF
    chmod +x "$STUBS_DIR/curl"

    CLAUDE_VERSION="stable" run bash "$ENTRYPOINT" true 2>/dev/null || true

    [[ -s "$version_file" ]]
    grep -q "stable" "$version_file"
    rm -f "$version_file"
}

# ---------------------------------------------------------------------------
# Skip download when claude is already installed
# ---------------------------------------------------------------------------

@test "does not call curl when claude is already installed" {
    # curl stub exits 1 — test fails if it is called
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Health check marker
# ---------------------------------------------------------------------------

@test "creates /tmp/claude-ready health marker" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -f /tmp/claude-ready ]
}

# ---------------------------------------------------------------------------
# Command passthrough
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# CLAUDE.md symlink from resources
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Resource symlinking via SPEEDWAVE_RESOURCES
# ---------------------------------------------------------------------------

@test "symlinks skills directory when present in resources" {
    mkdir -p "$RESOURCES_DIR/skills"
    touch "$RESOURCES_DIR/skills/my-skill.md"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "$HOME/.claude/skills" ]
    [ "$(readlink "$HOME/.claude/skills")" = "$RESOURCES_DIR/skills" ]
}

@test "does not create symlink when resource directory is absent" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "$HOME/.claude/skills" ]
}

# ---------------------------------------------------------------------------
# DISABLE_AUTOUPDATER
# ---------------------------------------------------------------------------

@test "exports DISABLE_AUTOUPDATER=1" {
    run bash "$ENTRYPOINT" bash -c 'echo "AUTOUPDATER=$DISABLE_AUTOUPDATER"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"AUTOUPDATER=1"* ]]
}

# ---------------------------------------------------------------------------
# PATH includes ~/.local/bin for Claude Code installed by install.sh
# ---------------------------------------------------------------------------

@test "adds HOME/.local/bin to PATH" {
    run bash "$ENTRYPOINT" bash -c 'echo "PATH=$PATH"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"/.local/bin"* ]]
}

@test "claude in HOME/.local/bin is found without reinstalling" {
    # Place a claude stub in the fake ~/.local/bin
    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/claude" << 'EOF'
#!/bin/bash
echo "2.1.45 (Claude Code)"
EOF
    chmod +x "$HOME/.local/bin/claude"
    # Remove stub from STUBS_DIR so only the ~/.local/bin one exists
    rm -f "$STUBS_DIR/claude"

    # curl stub still exits 1 — install must NOT be triggered
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Symlink claude from /usr/local/bin to ~/.local/bin
# ---------------------------------------------------------------------------

@test "symlinks claude from /usr/local/bin to ~/.local/bin" {
    # Create a fake /usr/local/bin/claude via stubs dir already in PATH.
    # The entrypoint checks /usr/local/bin/claude specifically, so we need
    # to place a file there. Instead we use the stubs dir as a stand-in:
    # override the check by making the stub look like /usr/local/bin/claude.
    # Since we can't write to /usr/local/bin in tests, we verify the symlink
    # logic by placing claude in STUBS_DIR (which is in PATH) and checking
    # that entrypoint creates ~/.local/bin/claude when /usr/local/bin/claude exists.

    # Create a temporary "fake /usr/local/bin" to satisfy the -x check
    local fake_usr_local="$TEST_HOME/fake-usr-local-bin"
    mkdir -p "$fake_usr_local"
    cp "$STUBS_DIR/claude" "$fake_usr_local/claude"
    chmod +x "$fake_usr_local/claude"

    # Patch entrypoint to use our fake path instead of /usr/local/bin
    local patched
    patched="$(mktemp)"
    sed "s|/usr/local/bin/claude|${fake_usr_local}/claude|g" "$ENTRYPOINT" > "$patched"

    run bash "$patched" true
    [ "$status" -eq 0 ]
    [ -L "$HOME/.local/bin/claude" ]
    [ "$(readlink "$HOME/.local/bin/claude")" = "${fake_usr_local}/claude" ]

    rm -f "$patched"
}

# ---------------------------------------------------------------------------
# bashrc PATH export
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Resource symlinks: commands, agents, hooks
# ---------------------------------------------------------------------------

@test "commands resource symlink created" {
    mkdir -p "$RESOURCES_DIR/commands"
    touch "$RESOURCES_DIR/commands/my-command.md"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "$HOME/.claude/commands" ]
    [ "$(readlink "$HOME/.claude/commands")" = "$RESOURCES_DIR/commands" ]
}

@test "agents resource symlink created" {
    mkdir -p "$RESOURCES_DIR/agents"
    touch "$RESOURCES_DIR/agents/my-agent.md"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "$HOME/.claude/agents" ]
    [ "$(readlink "$HOME/.claude/agents")" = "$RESOURCES_DIR/agents" ]
}

@test "hooks resource symlink created" {
    mkdir -p "$RESOURCES_DIR/hooks"
    touch "$RESOURCES_DIR/hooks/my-hook.sh"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "$HOME/.claude/hooks" ]
    [ "$(readlink "$HOME/.claude/hooks")" = "$RESOURCES_DIR/hooks" ]
}

# ---------------------------------------------------------------------------
# Default command keeps container alive (sleep infinity)
# ---------------------------------------------------------------------------

@test "default command is sleep infinity (not interactive shell)" {
    # Verify that entrypoint execs 'sleep infinity' when no args given.
    # We can't run it on macOS (sleep infinity is Linux-only), so we
    # check the script source directly.
    grep -q 'exec sleep infinity' "$ENTRYPOINT"
}

# ---------------------------------------------------------------------------
# MCP config: mcp-os is routed through hub, not directly from entrypoint
# ---------------------------------------------------------------------------

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
    export MCP_OS_URL="http://192.168.5.2:4007"
    unset MCP_OS_AUTH_TOKEN
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    run cat "${TEST_HOME}/.claude/mcp-config.json"
    [[ "$output" == *"speedwave-hub"* ]]
    [[ "$output" != *"speedwave-os"* ]]
}

# ---------------------------------------------------------------------------
# Output styles: Speedwave.md symlink from resources
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Statusline: symlink from resources
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# settings.json: symlink from resources
# ---------------------------------------------------------------------------

@test "symlinks settings.json from resources" {
    echo '{"statusLine":{"type":"command","command":"~/.claude/statusline.sh"}}' > "${SPEEDWAVE_RESOURCES}/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/settings.json" ]
    [ "$(readlink "${TEST_HOME}/.claude/settings.json")" = "${SPEEDWAVE_RESOURCES}/settings.json" ]
    grep -q "statusLine" "${TEST_HOME}/.claude/settings.json"
}

@test "skips settings.json symlink when not in resources" {
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/settings.json" ]
}

# ---------------------------------------------------------------------------
# SPEEDWAVE_PLUGINS: symlink plugin resources
# ---------------------------------------------------------------------------

@test "SPEEDWAVE_PLUGINS creates symlinks for all resource types" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    # Create a plugin with all four resource types
    mkdir -p "${plugins_dir}/my-plugin/commands"
    mkdir -p "${plugins_dir}/my-plugin/agents"
    mkdir -p "${plugins_dir}/my-plugin/skills"
    mkdir -p "${plugins_dir}/my-plugin/hooks"
    echo "cmd content" > "${plugins_dir}/my-plugin/commands/do-thing.md"
    echo "agent content" > "${plugins_dir}/my-plugin/agents/helper.md"
    echo "skill content" > "${plugins_dir}/my-plugin/skills/analyze.md"
    echo "hook content" > "${plugins_dir}/my-plugin/hooks/pre-run.sh"

    # Patch entrypoint to use our temp plugins dir instead of /speedwave/plugins
    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    # Verify symlinks for each resource type
    [ -L "${TEST_HOME}/.claude/commands/do-thing.md" ]
    [ -L "${TEST_HOME}/.claude/agents/helper.md" ]
    [ -L "${TEST_HOME}/.claude/skills/analyze.md" ]
    [ -L "${TEST_HOME}/.claude/hooks/pre-run.sh" ]

    # Verify symlink targets
    [ "$(readlink "${TEST_HOME}/.claude/commands/do-thing.md")" = "${plugins_dir}/my-plugin/commands/do-thing.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/agents/helper.md")" = "${plugins_dir}/my-plugin/agents/helper.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/skills/analyze.md")" = "${plugins_dir}/my-plugin/skills/analyze.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/hooks/pre-run.sh")" = "${plugins_dir}/my-plugin/hooks/pre-run.sh" ]

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

    # Verify warning was printed
    [[ "$output" == *"WARNING: Skipping invalid plugin slug: ../etc/passwd"* ]]

    # No symlinks should be created
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

    # Verify warning was printed
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

    # Create a valid plugin
    mkdir -p "${plugins_dir}/good-plugin/commands"
    echo "cmd" > "${plugins_dir}/good-plugin/commands/cmd.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="good-plugin,../BAD,also-good" run bash "$patched" true
    [ "$status" -eq 0 ]

    # Valid plugin should be symlinked
    [ -L "${TEST_HOME}/.claude/commands/cmd.md" ]

    # Invalid slug should have produced a warning
    [[ "$output" == *"WARNING: Skipping invalid plugin slug: ../BAD"* ]]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS skips non-existent plugin directory" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    # Do NOT create the plugin directory — it should be silently skipped
    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="nonexistent-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    # No symlinks should be created for the missing plugin
    [ ! -e "${TEST_HOME}/.claude/commands/nonexistent-plugin" ]

    rm -rf "$plugins_dir" "$patched"
}

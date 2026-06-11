#!/usr/bin/env bats
# Tests for containers/entrypoint.sh
# Runs on the host (macOS) — no container required.
# Stubs out 'curl' and 'claude' to avoid network calls.

ENTRYPOINT="$BATS_TEST_DIRNAME/../../containers/entrypoint.sh"
DEFAULTS_RS="$BATS_TEST_DIRNAME/../../crates/speedwave-runtime/src/defaults.rs"

# Extract pinned version from defaults.rs (SSOT) — avoids hardcoding "2.1.76" in tests.
PINNED_VERSION="$(grep 'pub const CLAUDE_VERSION' "$DEFAULTS_RS" | sed 's/.*"\(.*\)".*/\1/')"
[[ -n "$PINNED_VERSION" ]] || { echo "ERROR: could not extract CLAUDE_VERSION from defaults.rs" >&2; exit 1; }

setup() {
    TEST_HOME="$(mktemp -d)"
    export HOME="$TEST_HOME"
    mkdir -p "$HOME/.claude"

    RESOURCES_DIR="$(mktemp -d)"
    export SPEEDWAVE_RESOURCES="$RESOURCES_DIR"

    # CLAUDE_VERSION is required — set a default for tests that don't care about it
    export CLAUDE_VERSION="$PINNED_VERSION"

    # Stubs dir goes first in PATH; also strip real claude locations
    STUBS_DIR="$(mktemp -d)"
    export STUBS_DIR
    CLEAN_PATH="$STUBS_DIR:$(echo "$PATH" | tr ':' '\n' \
        | grep -v '\.local/bin' | grep -v 'homebrew' \
        | tr '\n' ':' | sed 's/:$//')"
    export PATH="$CLEAN_PATH"

    # Default stub: claude already installed — skip install
    cat > "$STUBS_DIR/claude" << EOF
#!/bin/bash
echo "${PINNED_VERSION} (Claude Code)"
EOF
    chmod +x "$STUBS_DIR/claude"

    # Default curl stub — fail loudly if unexpectedly called
    cat > "$STUBS_DIR/curl" << 'EOF'
#!/bin/bash
echo "UNEXPECTED curl: $*" >&2
exit 1
EOF
    chmod +x "$STUBS_DIR/curl"

    # Tests run outside the compose network, so there is no mcp-hub to wait
    # for. The startup gate is opt-in via this env var so tests stay fast.
    export SPEEDWAVE_SKIP_HUB_WAIT=1

    # OS_AVAILABLE_SUBS is normally injected by compose.rs from TOGGLEABLE_OS_SERVICES.
    export OS_AVAILABLE_SUBS="reminders,calendar,mail,notes"

    # Per-test health marker under TEST_HOME so parallel runs (bats --jobs)
    # and concurrent worktrees never collide on a shared /tmp path.
    # Cleaned up by teardown's rm -rf "$TEST_HOME".
    export CLAUDE_READY_MARKER="$TEST_HOME/claude-ready"
}

teardown() {
    rm -rf "$TEST_HOME" "$STUBS_DIR" "$RESOURCES_DIR"
}

# ---------------------------------------------------------------------------
# CLAUDE_VERSION — required (no default)
# ---------------------------------------------------------------------------

@test "fails when CLAUDE_VERSION is not set" {
    unset CLAUDE_VERSION
    run bash "$ENTRYPOINT" true
    [ "$status" -ne 0 ]
    [[ "$output" == *"CLAUDE_VERSION"* ]]
}

# ---------------------------------------------------------------------------
# Version skew between baked binary and pinned CLAUDE_VERSION
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# CLAUDE_VERSION env var forwarded to install-claude.sh
# ---------------------------------------------------------------------------

@test "CLAUDE_VERSION env var is forwarded to install-claude.sh" {
    rm -f "$STUBS_DIR/claude"  # force install path

    # Create a fake install-claude.sh that records the version
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
    [ -f "$CLAUDE_READY_MARKER" ]
}

# ---------------------------------------------------------------------------
# set -e kills the entrypoint when HOME is not writable (the Windows bug)
#
# On Windows the CLAUDE_HOME 9p mount defaulted to uid 0 while the container
# runs as uid 1000; with metadata enforcing ownership, the entrypoint's first
# write to ${HOME} hit EACCES and `set -euo pipefail` exited non-zero BEFORE
# `exec sleep infinity`, so the container went Exited ("cannot exec in a
# stopped state"). The host-side fix is uid=1000 in the wsl.conf automount
# options; this test pins the invariant that a non-writable HOME is fatal, so
# the entrypoint can never silently "succeed" into a half-set-up home.
# ---------------------------------------------------------------------------

@test "exits non-zero when HOME is not writable (mimics uid-mismatch EACCES)" {
    # root ignores DAC mode bits, so this assertion is only meaningful as a
    # non-root user (the real container is uid 1000, never root).
    [ "$(id -u)" -ne 0 ] || skip "must run as non-root to enforce mode bits"

    chmod 0555 "$HOME"  # readable+executable, NOT writable by the owner
    run bash "$ENTRYPOINT" true
    chmod 0755 "$HOME"  # restore so teardown's rm -rf works

    [ "$status" -ne 0 ]
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

@test "symlinks skills entries when present in resources" {
    mkdir -p "$RESOURCES_DIR/skills"
    touch "$RESOURCES_DIR/skills/my-skill.md"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    # skills is a real directory of per-entry symlinks (not a whole-directory
    # symlink) so per-integration entries can be gated on/off without disturbing
    # the core entries that share the directory.
    [ -d "$HOME/.claude/skills" ]
    [ ! -L "$HOME/.claude/skills" ]
    [ -L "$HOME/.claude/skills/my-skill.md" ]
    [ "$(readlink "$HOME/.claude/skills/my-skill.md")" = "$RESOURCES_DIR/skills/my-skill.md" ]
}

@test "resource directory exists but is empty when source is absent" {
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    # The entrypoint always creates the four resource dirs (so plugin and
    # integration links can be added per-entry); if the source mount has no
    # skills/ then the directory just stays empty.
    [ -d "$HOME/.claude/skills" ]
    [ ! -L "$HOME/.claude/skills" ]
    [ -z "$(ls -A "$HOME/.claude/skills")" ]
}

@test "links the bundled core web-authoring skills from the real resources tree" {
    # Point at the real claude-resources tree (not a synthetic fixture) so this
    # test verifies the actual top-level core skills ship as symlinks. These are
    # unconditionally linked (no integration gating, no ENABLED_SERVICES).
    real_resources="$BATS_TEST_DIRNAME/../../containers/claude-resources"
    export SPEEDWAVE_RESOURCES="$real_resources"

    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -d "$HOME/.claude/skills" ]
    [ ! -L "$HOME/.claude/skills" ]

    for skill in speedwave-sitemap speedwave-site-audit speedwave-product-showcase; do
        [ -L "$HOME/.claude/skills/$skill" ]
        [ "$(readlink "$HOME/.claude/skills/$skill")" = "$real_resources/skills/$skill" ]
        [ -f "$HOME/.claude/skills/$skill/SKILL.md" ]
    done
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
    cat > "$HOME/.local/bin/claude" << EOF
#!/bin/bash
echo "${PINNED_VERSION} (Claude Code)"
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
    export MCP_OS_URL="http://host.docker.internal:4007"
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
# ~/.claude.json pre-seed: always pre-accepts the /workspace trust dialog;
# onboarding only when logged in (ADR-052). Trust is keyed by working_dir and
# is separate from --dangerously-skip-permissions, so it must be set even with
# no credentials, while onboarding stays incomplete so `claude` shows OAuth.
# ---------------------------------------------------------------------------

@test "pre-accepts /workspace trust but skips onboarding when credentials are absent" {
    [ ! -e "${TEST_HOME}/.claude.json" ]
    [ ! -e "${TEST_HOME}/.claude/.credentials.json" ]
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -f "${TEST_HOME}/.claude.json" ]
    grep -q '"hasTrustDialogAccepted": true' "${TEST_HOME}/.claude.json"
    # No credentials → onboarding NOT completed → claude still shows the login prompt.
    ! grep -q '"hasCompletedOnboarding"' "${TEST_HOME}/.claude.json"
}

@test "creates ~/.claude.json with onboarding AND trust when credentials exist" {
    # Simulate a logged-in user: credentials present, no .claude.json yet.
    printf '{"token":"x"}' > "${TEST_HOME}/.claude/.credentials.json"
    [ ! -e "${TEST_HOME}/.claude.json" ]
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ -f "${TEST_HOME}/.claude.json" ]
    grep -q '"hasCompletedOnboarding": true' "${TEST_HOME}/.claude.json"
    grep -q '"hasTrustDialogAccepted": true' "${TEST_HOME}/.claude.json"
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

@test "does not overwrite an existing ~/.claude.json (even with credentials)" {
    printf '{"token":"x"}' > "${TEST_HOME}/.claude/.credentials.json"
    printf '{"my":"existing-state"}' > "${TEST_HOME}/.claude.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    [ "$(cat "${TEST_HOME}/.claude.json")" = '{"my":"existing-state"}' ]
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
# settings.json: WRITABLE copy (NOT a symlink) — Claude Code writes it via
# /effort and /model; the resources mount is read-only so a symlink → EROFS.
# ---------------------------------------------------------------------------

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
    # Older builds linked settings.json into the read-only resources mount.
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
    # Simulate /effort low writing the user's choice into the copy.
    echo '{"effortLevel":"low"}' > "${TEST_HOME}/.claude/settings.json"
    run bash "${ENTRYPOINT}" echo ok
    [ "$status" -eq 0 ]
    grep -q '"effortLevel":"low"' "${TEST_HOME}/.claude/settings.json"
}

@test "skips settings.json when not in resources" {
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

@test "SPEEDWAVE_PLUGINS symlinks skill directories (not just flat files)" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    # Create a plugin with a skill directory containing SKILL.md
    mkdir -p "${plugins_dir}/my-plugin/skills/my-skill"
    echo "# My Skill" > "${plugins_dir}/my-plugin/skills/my-skill/SKILL.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    # Verify the skill directory is symlinked (not just files)
    [ -L "${TEST_HOME}/.claude/skills/my-skill" ]
    [ -d "${TEST_HOME}/.claude/skills/my-skill" ]
    [ -f "${TEST_HOME}/.claude/skills/my-skill/SKILL.md" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "SPEEDWAVE_PLUGINS symlinks command subdirectories" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    # Create a plugin with a command subdirectory
    mkdir -p "${plugins_dir}/my-plugin/commands/iteration"
    echo "# Create" > "${plugins_dir}/my-plugin/commands/iteration/create.md"
    echo "# List" > "${plugins_dir}/my-plugin/commands/iteration/list.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="my-plugin" run bash "$patched" true
    [ "$status" -eq 0 ]

    # Verify the command subdirectory is symlinked
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

@test "plugin resources coexist with core resources (no read-only conflict)" {
    # Setup core resources
    mkdir -p "$RESOURCES_DIR/skills"
    mkdir -p "$RESOURCES_DIR/commands"
    echo "# Core Skill" > "$RESOURCES_DIR/skills/core-skill.md"
    echo "# Core Command" > "$RESOURCES_DIR/commands/core-command.md"

    # Setup plugin resources
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

    # Resource dirs must be real directories (not symlinks to RO mount)
    [ -d "${TEST_HOME}/.claude/skills" ]
    [ ! -L "${TEST_HOME}/.claude/skills" ]
    [ -d "${TEST_HOME}/.claude/commands" ]
    [ ! -L "${TEST_HOME}/.claude/commands" ]

    # Both core and plugin entries accessible
    [ -L "${TEST_HOME}/.claude/skills/core-skill.md" ]
    [ -L "${TEST_HOME}/.claude/skills/example-plugin-skill.md" ]
    [ -L "${TEST_HOME}/.claude/commands/core-command.md" ]
    [ -L "${TEST_HOME}/.claude/commands/example-plugin-cmd.md" ]

    # Content is correct
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

    # No SPEEDWAVE_PLUGINS set — dirs are always real dirs of per-entry symlinks
    # (not whole-dir symlinks). This lets the integrations/ gate work and lets
    # the entrypoint cleans up stale links on toggle-off.
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

@test "SPEEDWAVE_PLUGINS warns when plugin overwrites another plugin resource" {
    local plugins_dir
    plugins_dir="$(mktemp -d)"

    # Two plugins both ship commands/do-thing.md
    mkdir -p "${plugins_dir}/alpha/commands"
    mkdir -p "${plugins_dir}/beta/commands"
    echo "alpha version" > "${plugins_dir}/alpha/commands/do-thing.md"
    echo "beta version" > "${plugins_dir}/beta/commands/do-thing.md"

    local patched
    patched="$(mktemp)"
    sed "s|/speedwave/plugins/|${plugins_dir}/|g" "$ENTRYPOINT" > "$patched"

    SPEEDWAVE_PLUGINS="alpha,beta" run bash "$patched" true
    [ "$status" -eq 0 ]

    # Warning about collision should appear on stderr (captured in output by bats)
    [[ "$output" == *"WARNING: plugin 'beta' overwrites commands/do-thing.md from another plugin"* ]]

    # Second plugin wins (last-wins semantics)
    [ -L "${TEST_HOME}/.claude/commands/do-thing.md" ]
    [ "$(readlink "${TEST_HOME}/.claude/commands/do-thing.md")" = "${plugins_dir}/beta/commands/do-thing.md" ]

    rm -rf "$plugins_dir" "$patched"
}

# ---------------------------------------------------------------------------
# Migration: ~/.claude/<resource_type> mode flips between runs.
# claude-home is a persistent volume, so a stale layout from a previous
# start can poison the current one if the entrypoint doesn't normalize it.
# ---------------------------------------------------------------------------

@test "plugin mode replaces stale whole-directory symlink left from no-plugins run" {
    # Reproduce the scenario from the bug: project was started without plugins
    # (skills became a symlink to read-only resources), then a plugin was
    # installed and the project restarted. Without normalization the per-entry
    # ln below would resolve through the symlink and try to write into the
    # read-only resources mount, killing the container with `set -e`.
    mkdir -p "$RESOURCES_DIR/skills/code-review-basic"
    echo "# Core skill" > "$RESOURCES_DIR/skills/code-review-basic/SKILL.md"

    # Simulate the stale symlink left by an earlier no-plugins run, pointing
    # at a read-only directory (chmod 555 is sufficient on the host).
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

    # Restore writability so teardown can clean up the tempdir
    chmod 755 "$RESOURCES_DIR/skills"

    [ "$status" -eq 0 ]

    # ~/.claude/skills must now be a real directory, not a symlink
    [ ! -L "$HOME/.claude/skills" ]
    [ -d "$HOME/.claude/skills" ]

    # Both core and plugin entries are present as per-entry symlinks
    [ -L "$HOME/.claude/skills/code-review-basic" ]
    [ "$(readlink "$HOME/.claude/skills/code-review-basic")" = "$RESOURCES_DIR/skills/code-review-basic" ]
    [ -L "$HOME/.claude/skills/extra-skill" ]
    [ "$(readlink "$HOME/.claude/skills/extra-skill")" = "${plugins_dir}/my-plugin/skills/extra-skill" ]

    rm -rf "$plugins_dir" "$patched"
}

@test "no-plugins mode preserves real directory of per-entry symlinks" {
    # The directory layout is always a real dir of per-entry symlinks (whether
    # or not plugins are loaded), so subsequent no-plugin runs must leave the
    # directory intact and continue to expose core entries.
    mkdir -p "$RESOURCES_DIR/skills/core-skill"
    echo "# Core" > "$RESOURCES_DIR/skills/core-skill/SKILL.md"

    # Simulate a previous plugin run leaving a stale plugin link behind: it must
    # NOT be tracked in the state file (we did not create it), so the entrypoint
    # should leave it alone — only links it owns get cleaned up.
    mkdir -p "$HOME/.claude/skills"
    ln -sfn "/some/old/plugin/path/leftover" "$HOME/.claude/skills/leftover"

    unset SPEEDWAVE_PLUGINS
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]

    [ -d "$HOME/.claude/skills" ]
    [ ! -L "$HOME/.claude/skills" ]
    [ -L "$HOME/.claude/skills/core-skill" ]
    [ "$(readlink "$HOME/.claude/skills/core-skill")" = "$RESOURCES_DIR/skills/core-skill" ]
    # The pre-existing leftover link was not created by entrypoint, so it must
    # not be tracked in the state file and must survive the run untouched.
    [ -L "$HOME/.claude/skills/leftover" ]
    [ "$(readlink "$HOME/.claude/skills/leftover")" = "/some/old/plugin/path/leftover" ]
}


# ---------------------------------------------------------------------------
# MCP hub wait — startup race claude↔hub fix
# ---------------------------------------------------------------------------

@test "SPEEDWAVE_SKIP_HUB_WAIT=1 bypasses the hub readiness probe" {
    # Default in setup() — confirms no waiting when explicitly skipped.
    export SPEEDWAVE_SKIP_HUB_WAIT=1
    SECONDS=0
    run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    # Should be ~instant, never near the 30s timeout.
    [ "$SECONDS" -lt 5 ]
}

@test "without SPEEDWAVE_SKIP_HUB_WAIT, hub probe runs but tolerates failure" {
    # mcp-hub host does not resolve in test environment; probe must fail
    # within bounded time and entrypoint must still succeed. Patch the
    # attempts count down from 30 to 2 so the test is fast.
    unset SPEEDWAVE_SKIP_HUB_WAIT
    local patched
    patched="$(mktemp)"
    sed 's/local host="mcp-hub" port="${MCP_HUB_PORT}" attempts=30/local host="mcp-hub" port="${MCP_HUB_PORT}" attempts=2/' \
        "$ENTRYPOINT" > "$patched"
    run bash "$patched" true
    [ "$status" -eq 0 ]
    [ -f "$CLAUDE_READY_MARKER" ]
    # Stderr should carry the warning so operators see the degraded mode.
    [[ "$output" == *"did not respond"* ]]
    rm -f "$patched"
}


# ---------------------------------------------------------------------------
# Per-integration gating of claude-resources via ENABLED_SERVICES
# ---------------------------------------------------------------------------

setup_integrations_fixture() {
    # Core skill (always-on) + three integration-bound skills.
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
    # `integrations` itself must never be linked as if it were a skill.
    [ ! -e "${TEST_HOME}/.claude/skills/integrations" ]
}

@test "ENABLED_SERVICES=office links integration skill" {
    setup_integrations_fixture
    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ "$(readlink "${TEST_HOME}/.claude/skills/office")" = "$RESOURCES_DIR/skills/integrations/office" ]
    # The other two integration skills must NOT appear.
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
    # Only core entries; no integrations bucket.
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

    # Toggle off — all four must lose their office link.
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

    # Toggle off — the link must disappear (managed-links cleanup).
    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/slack" ]
}

# Regression guard for the toggle-off path: ~/.claude is persistent across
# container restarts, so a once-linked integration skill must disappear when
# the user toggles the integration off. Without state-file cleanup the link
# would linger and Claude would call tools whose worker is no longer running.
@test "toggle off removes previously-linked integration skill" {
    setup_integrations_fixture

    # Run 1 — Office enabled.
    ENABLED_SERVICES="office" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ -f "${TEST_HOME}/.claude/.speedwave-managed-links" ]
    grep -q "skills/office$" "${TEST_HOME}/.claude/.speedwave-managed-links"

    # Run 2 — Office disabled. The link MUST be gone.
    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/office" ]
    ! grep -q "skills/office$" "${TEST_HOME}/.claude/.speedwave-managed-links"
    # Core entries survive the toggle.
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
    # Simulate an older install where skills was a whole-dir symlink.
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
    # Core stays.
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
    # Integration symlinked because ENABLED_SERVICES includes it.
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    # Plugin symlinked because SPEEDWAVE_PLUGINS includes it.
    [ -L "${TEST_HOME}/.claude/skills/foo-skill" ]
    # The state file owns all three so the next toggle cleans them up.
    grep -q "skills/office$" "${TEST_HOME}/.claude/.speedwave-managed-links"
    grep -q "skills/foo-skill$" "${TEST_HOME}/.claude/.speedwave-managed-links"

    rm -rf "$plugins_dir" "$patched"
}

@test "plugin toggle off cleans up plugin link via state file" {
    # Core skill so the run has something stable to compare.
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

    # Plugin disabled on next run — link must be gone.
    unset SPEEDWAVE_PLUGINS
    run bash "$patched" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/foo-skill" ]
    [ -L "${TEST_HOME}/.claude/skills/core-skill" ]

    rm -rf "$plugins_dir" "$patched"
}

setup_os_subservice_fixture() {
    # Core skill + integrations/ with each OS sub-service.
    mkdir -p "$RESOURCES_DIR/skills/code-review-basic"
    echo "# Core" > "$RESOURCES_DIR/skills/code-review-basic/SKILL.md"
    for sub in reminders calendar mail notes; do
        mkdir -p "$RESOURCES_DIR/skills/integrations/$sub"
        echo "# $sub" > "$RESOURCES_DIR/skills/integrations/$sub/SKILL.md"
    done
}

@test "OS sub-service skills are gated jointly by ENABLED_SERVICES and DISABLED_OS_SERVICES" {
    setup_os_subservice_fixture

    # os enabled with mail and notes disabled — only reminders + calendar link.
    ENABLED_SERVICES="os" DISABLED_OS_SERVICES="mail,notes" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/reminders" ]
    [ -L "${TEST_HOME}/.claude/skills/calendar" ]
    [ ! -e "${TEST_HOME}/.claude/skills/mail" ]
    [ ! -e "${TEST_HOME}/.claude/skills/notes" ]
}

@test "no OS sub-service skill is linked when os is not in ENABLED_SERVICES" {
    setup_os_subservice_fixture

    # `os` absent — even with DISABLED_OS_SERVICES empty, none of the sub-services link.
    ENABLED_SERVICES="" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ ! -e "${TEST_HOME}/.claude/skills/reminders" ]
    [ ! -e "${TEST_HOME}/.claude/skills/calendar" ]
    [ ! -e "${TEST_HOME}/.claude/skills/mail" ]
    [ ! -e "${TEST_HOME}/.claude/skills/notes" ]
    # Core entries still linked.
    [ -L "${TEST_HOME}/.claude/skills/code-review-basic" ]
}

@test "toggling a single OS sub-service off removes only that link" {
    setup_os_subservice_fixture

    # Run 1: everything enabled.
    ENABLED_SERVICES="os" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    for sub in reminders calendar mail notes; do
        [ -L "${TEST_HOME}/.claude/skills/$sub" ]
    done

    # Run 2: mail disabled — its symlink must go, the others must stay.
    ENABLED_SERVICES="os" DISABLED_OS_SERVICES="mail" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/reminders" ]
    [ -L "${TEST_HOME}/.claude/skills/calendar" ]
    [ ! -e "${TEST_HOME}/.claude/skills/mail" ]
    [ -L "${TEST_HOME}/.claude/skills/notes" ]
}

@test "OS sub-services coexist with regular MCP integrations in ENABLED_SERVICES" {
    setup_os_subservice_fixture
    # Also add an MCP-integration-bound skill.
    mkdir -p "$RESOURCES_DIR/skills/integrations/office"
    echo "# Office" > "$RESOURCES_DIR/skills/integrations/office/SKILL.md"

    ENABLED_SERVICES="office,os" DISABLED_OS_SERVICES="notes" run bash "$ENTRYPOINT" true
    [ "$status" -eq 0 ]
    [ -L "${TEST_HOME}/.claude/skills/office" ]
    [ -L "${TEST_HOME}/.claude/skills/reminders" ]
    [ -L "${TEST_HOME}/.claude/skills/calendar" ]
    [ -L "${TEST_HOME}/.claude/skills/mail" ]
    [ ! -e "${TEST_HOME}/.claude/skills/notes" ]
    # `os` itself must NOT be linked as a skill — only its sub-services exist as skills.
    [ ! -e "${TEST_HOME}/.claude/skills/os" ]
}

# ---------------------------------------------------------------------------
# Keep-alive PID1 must exit 0 on SIGTERM (trap), not die killed (143) —
# in the container PID1 would otherwise ignore TERM and eat the 10s timeout.
# ---------------------------------------------------------------------------

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

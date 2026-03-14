#!/bin/bash
set -euo pipefail

# Disable auto-updater unconditionally — Speedwave pins Claude Code versions
export DISABLE_AUTOUPDATER=1

# Ensure full color support for Claude Code TUI
export TERM="${TERM:-xterm-256color}"

# Claude Code binary is baked into the image at /usr/local/bin/claude.
# Fallback: if missing (e.g. custom image), install at runtime.
export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"

CLAUDE_VERSION="${CLAUDE_VERSION:?CLAUDE_VERSION env var is required}"

# Resources mount point — overridable for testing
SPEEDWAVE_RESOURCES="${SPEEDWAVE_RESOURCES:-/speedwave/resources}"

if ! command -v claude &> /dev/null; then
    echo "Claude Code not found — installing via install-claude.sh (${CLAUDE_VERSION})..."
    /usr/local/bin/install-claude.sh "${CLAUDE_VERSION}"
fi

# Ensure ~/.local/bin is in PATH for interactive shells (nerdctl exec runs bash).
# Claude Code checks if ~/.local/bin/claude is in PATH and warns if not.
# The real binary is baked into /usr/local/bin in the image layer (fast ext4).
# The symlink at ~/.local/bin/claude points to it on the VirtioFS volume.
if [ -x /usr/local/bin/claude ]; then
    mkdir -p "${HOME}/.local/bin"
    ln -sf /usr/local/bin/claude "${HOME}/.local/bin/claude"
fi

# Ensure .bashrc exports PATH so nerdctl exec sessions see ~/.local/bin
if ! grep -q '\.local/bin' "${HOME}/.bashrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${HOME}/.bashrc"
fi

# Ensure ~/.claude exists before symlinking anything
mkdir -p "${HOME}/.claude"

# Symlink core resource directories (skills, commands, agents, hooks) from read-only mount
for resource_type in skills commands agents hooks; do
    if [ -d "${SPEEDWAVE_RESOURCES}/${resource_type}" ]; then
        ln -sfn "${SPEEDWAVE_RESOURCES}/${resource_type}" "${HOME}/.claude/${resource_type}"
    fi
done

# Symlink individual resource files from read-only mount.
# These auto-update when Speedwave ships new versions — no stale copies.
# Teams override via project-level .claude/ (ADR-022 scope precedence).
for resource_file in statusline.sh settings.json CLAUDE.md; do
    if [ -f "${SPEEDWAVE_RESOURCES}/${resource_file}" ]; then
        ln -sf "${SPEEDWAVE_RESOURCES}/${resource_file}" "${HOME}/.claude/${resource_file}"
    fi
done

# output-styles: symlink individual file (not directory) to preserve user's custom styles
if [ -f "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md" ]; then
    mkdir -p "${HOME}/.claude/output-styles"
    ln -sf "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md" "${HOME}/.claude/output-styles/Speedwave.md"
fi

# Symlink plugin resources if any plugins are configured
if [ -n "${SPEEDWAVE_PLUGINS:-}" ]; then
    for plugin in ${SPEEDWAVE_PLUGINS//,/ }; do
        # Validate slug: lowercase alphanumeric + hyphens, 1-64 chars, starts with letter
        if ! echo "${plugin}" | grep -qE '^[a-z][a-z0-9-]{0,63}$'; then
            echo "WARNING: Skipping invalid plugin slug: ${plugin}" >&2
            continue
        fi
        plugin_path="/speedwave/plugins/${plugin}"
        if [ -d "${plugin_path}" ]; then
            for resource_type in commands agents skills hooks; do
                if [ -d "${plugin_path}/${resource_type}" ]; then
                    mkdir -p "${HOME}/.claude/${resource_type}"
                    for entry in "${plugin_path}/${resource_type}"/*; do
                        [ -e "${entry}" ] && ln -sfn "${entry}" "${HOME}/.claude/${resource_type}/$(basename "${entry}")"
                    done
                fi
            done
        fi
    done
fi

# Generate MCP config for Claude Code — tells it where the MCP hub lives.
# MCP_HUB_PORT is injected by compose.template.yml; default matches PORT_BASE.
MCP_HUB_PORT="${MCP_HUB_PORT:-4000}"

# Claude sees ONLY the hub — all services (including mcp-os) are behind it.
cat > "${HOME}/.claude/mcp-config.json" << EOF
{
  "mcpServers": {
    "speedwave-hub": {
      "type": "http",
      "url": "http://mcp-hub:${MCP_HUB_PORT}"
    }
  }
}
EOF

# Health check marker
touch /tmp/claude-ready

# Execute the passed command (or keep container alive waiting for exec)
if [ $# -gt 0 ]; then
    exec "$@"
else
    exec sleep infinity
fi

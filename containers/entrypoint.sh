#!/bin/bash
set -euo pipefail

# Disable auto-updater unconditionally — Speedwave pins Claude Code versions
export DISABLE_AUTOUPDATER=1

# Ensure full color support for Claude Code TUI
export TERM="${TERM:-xterm-256color}"

# Claude Code binary is baked into the image at /usr/local/bin/claude.
# Fallback: if missing (e.g. custom image), install at runtime.
export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"

CLAUDE_VERSION="${CLAUDE_VERSION:-latest}"

# Resources mount point — overridable for testing
SPEEDWAVE_RESOURCES="${SPEEDWAVE_RESOURCES:-/speedwave/resources}"

if ! command -v claude &> /dev/null; then
    echo "Installing Claude Code (${CLAUDE_VERSION})..."
    INSTALLER=$(mktemp)
    curl -fsSL https://claude.ai/install.sh -o "$INSTALLER"
    # SHA256 verification — update hash when CLAUDE_VERSION changes
    EXPECTED_SHA256="${CLAUDE_INSTALLER_SHA256:-}"
    if [ -n "$EXPECTED_SHA256" ]; then
        ACTUAL_SHA256=$(sha256sum "$INSTALLER" | cut -d' ' -f1)
        if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
            echo "FATAL: install.sh SHA256 mismatch!" >&2
            echo "  expected: $EXPECTED_SHA256" >&2
            echo "  actual:   $ACTUAL_SHA256" >&2
            rm -f "$INSTALLER"
            exit 1
        fi
        echo "SHA256 verified: $ACTUAL_SHA256"
    else
        echo "WARNING: CLAUDE_INSTALLER_SHA256 not set — skipping verification"
    fi
    bash "$INSTALLER" "${CLAUDE_VERSION}"
    rm -f "$INSTALLER"
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

# Symlink addon resources if any addons are configured
if [ -n "${SPEEDWAVE_ADDONS:-}" ]; then
    for addon in ${SPEEDWAVE_ADDONS//,/ }; do
        addon_path="/speedwave/addons/${addon}"
        if [ -d "${addon_path}" ]; then
            for resource_type in commands agents skills; do
                if [ -d "${addon_path}/${resource_type}" ]; then
                    mkdir -p "${HOME}/.claude/${resource_type}"
                    for file in "${addon_path}/${resource_type}"/*; do
                        [ -f "${file}" ] && ln -sf "${file}" "${HOME}/.claude/${resource_type}/$(basename "${file}")"
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

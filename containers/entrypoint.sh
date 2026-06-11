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
else
    # Surface image/env version skew (stale image after an interrupted update).
    # Not auto-repaired: launchers exec the absolute /usr/local/bin/claude on
    # the read-only image layer, so only an image rebuild can fix it.
    installed_version="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
    if [ -n "$installed_version" ] && [ "$installed_version" != "$CLAUDE_VERSION" ]; then
        echo "WARNING: image has Claude Code ${installed_version} but the pinned version is ${CLAUDE_VERSION} — run 'speedwave update' to rebuild the image" >&2
    fi
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

# Symlink claude-resources per-entry into real dirs. Core entries always-on;
# integrations/<svc>/ gated by ENABLED_SERVICES. Links the script owns are
# tracked in ~/.claude/.speedwave-managed-links so toggle-off cleans them up.
# See ADR-022 for the design rationale.

# Reverse migration: an older run may have left whole-directory symlinks.
for resource_type in skills commands agents hooks; do
    target="${HOME}/.claude/${resource_type}"
    if [ -L "${target}" ]; then
        rm -f "${target}"
    fi
    mkdir -p "${target}"
done

# Drop links managed by the previous run BEFORE creating the new set.
state_file="${HOME}/.claude/.speedwave-managed-links"
if [ -f "${state_file}" ]; then
    while IFS= read -r link; do
        [ -L "${link}" ] && rm -f "${link}"
    done < "${state_file}"
fi

new_state="$(mktemp)"
trap 'rm -f "${new_state}"' EXIT

# Comma-split ENABLED_SERVICES into a Bash array, trimming whitespace per entry.
# Source is compose.rs (Rust SSOT TOGGLEABLE_MCP_SERVICES), not user input.
ENABLED_SVCS=()
OS_ENABLED=false
if [ -n "${ENABLED_SERVICES:-}" ]; then
    IFS=',' read -ra _raw_svcs <<< "${ENABLED_SERVICES}"
    for _svc in "${_raw_svcs[@]}"; do
        _svc="${_svc//[[:space:]]/}"
        [ -z "${_svc}" ] && continue
        if [ "${_svc}" = "os" ]; then
            OS_ENABLED=true
        fi
        ENABLED_SVCS+=("${_svc}")
    done
fi

# OS sub-services linked when `os` in ENABLED_SERVICES AND name not in DISABLED_OS_SERVICES.
# OS_AVAILABLE_SUBS and DISABLED_OS_SERVICES are injected by compose.rs from TOGGLEABLE_OS_SERVICES.
DISABLED_OS_SVCS=()
if [ -n "${DISABLED_OS_SERVICES:-}" ]; then
    IFS=',' read -ra _raw_dis <<< "${DISABLED_OS_SERVICES}"
    for _d in "${_raw_dis[@]}"; do
        _d="${_d//[[:space:]]/}"
        [ -n "${_d}" ] && DISABLED_OS_SVCS+=("${_d}")
    done
fi

OS_AVAILABLE=()
if [ -n "${OS_AVAILABLE_SUBS:-}" ]; then
    IFS=',' read -ra _raw_av <<< "${OS_AVAILABLE_SUBS}"
    for _a in "${_raw_av[@]}"; do
        _a="${_a//[[:space:]]/}"
        [ -n "${_a}" ] && OS_AVAILABLE+=("${_a}")
    done
fi

OS_ENABLED_SUBS=()
if [ "${OS_ENABLED}" = true ] && [ "${#OS_AVAILABLE[@]}" -gt 0 ]; then
    for sub in "${OS_AVAILABLE[@]}"; do
        disabled=false
        if [ "${#DISABLED_OS_SVCS[@]}" -gt 0 ]; then
            for d in "${DISABLED_OS_SVCS[@]}"; do
                [ "${d}" = "${sub}" ] && { disabled=true; break; }
            done
        fi
        [ "${disabled}" = false ] && OS_ENABLED_SUBS+=("${sub}")
    done
fi

for resource_type in skills commands agents hooks; do
    src_dir="${SPEEDWAVE_RESOURCES}/${resource_type}"
    [ -d "${src_dir}" ] || continue

    # Core entries — always-on. Skip the `integrations/` bucket which is gated below.
    for entry in "${src_dir}"/*; do
        [ -e "${entry}" ] || continue
        name="$(basename "${entry}")"
        [ "${name}" = "integrations" ] && continue
        link="${HOME}/.claude/${resource_type}/${name}"
        ln -sfn "${entry}" "${link}"
        echo "${link}" >> "${new_state}"
    done

    # Integration-bound entries — only symlinked when their config_key is in ENABLED_SERVICES.
    # `os` itself never has its own integration skill: only its sub-services (reminders,
    # calendar, mail, notes), so we filter it out here and handle the sub-services below.
    integrations_dir="${src_dir}/integrations"
    if [ -d "${integrations_dir}" ] && [ "${#ENABLED_SVCS[@]}" -gt 0 ]; then
        for svc in "${ENABLED_SVCS[@]}"; do
            [ "${svc}" = "os" ] && continue
            src="${integrations_dir}/${svc}"
            [ -d "${src}" ] || continue
            link="${HOME}/.claude/${resource_type}/${svc}"
            ln -sfn "${src}" "${link}"
            echo "${link}" >> "${new_state}"
        done
    fi

    # OS sub-services: linked only when `os` is enabled AND the sub-service is not disabled.
    if [ -d "${integrations_dir}" ] && [ "${#OS_ENABLED_SUBS[@]}" -gt 0 ]; then
        for sub in "${OS_ENABLED_SUBS[@]}"; do
            src="${integrations_dir}/${sub}"
            [ -d "${src}" ] || continue
            link="${HOME}/.claude/${resource_type}/${sub}"
            ln -sfn "${src}" "${link}"
            echo "${link}" >> "${new_state}"
        done
    fi
done

# Symlink read-only resource files (auto-update on new Speedwave versions).
# Teams override via project-level .claude/ (ADR-022 scope precedence).
for resource_file in statusline.sh CLAUDE.md; do
    if [ -f "${SPEEDWAVE_RESOURCES}/${resource_file}" ]; then
        ln -sf "${SPEEDWAVE_RESOURCES}/${resource_file}" "${HOME}/.claude/${resource_file}"
    fi
done

# settings.json must be a WRITABLE copy, not a symlink: Claude Code writes it
# (`/effort`, `/model` persist the choice) and the resources mount is read-only
# (EROFS otherwise). Replace a stale symlink (older builds linked it), then seed
# only when absent so a user's persisted choice survives across restarts.
if [ -L "${HOME}/.claude/settings.json" ]; then
    rm -f "${HOME}/.claude/settings.json"
fi
if [ -f "${SPEEDWAVE_RESOURCES}/settings.json" ] && [ ! -e "${HOME}/.claude/settings.json" ]; then
    cp "${SPEEDWAVE_RESOURCES}/settings.json" "${HOME}/.claude/settings.json"
fi

# output-styles: symlink individual file (not directory) to preserve user's custom styles
if [ -f "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md" ]; then
    mkdir -p "${HOME}/.claude/output-styles"
    ln -sf "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md" "${HOME}/.claude/output-styles/Speedwave.md"
fi

# Symlink plugin resources — same managed-link tracking as core/integration entries
# so toggling a plugin off cleans up its links on the next restart.
if [ -n "${SPEEDWAVE_PLUGINS:-}" ]; then
    for plugin in ${SPEEDWAVE_PLUGINS//,/ }; do
        if ! echo "${plugin}" | grep -qE '^[a-z][a-z0-9-]{0,63}$'; then
            echo "WARNING: Skipping invalid plugin slug: ${plugin}" >&2
            continue
        fi
        plugin_path="/speedwave/plugins/${plugin}"
        [ -d "${plugin_path}" ] || continue
        for resource_type in skills commands agents hooks; do
            [ -d "${plugin_path}/${resource_type}" ] || continue
            for entry in "${plugin_path}/${resource_type}"/*; do
                [ -e "${entry}" ] || continue
                target="${HOME}/.claude/${resource_type}/$(basename "${entry}")"
                if [ -L "${target}" ] && [ "$(readlink "${target}")" != "${entry}" ]; then
                    echo "WARNING: plugin '${plugin}' overwrites ${resource_type}/$(basename "${entry}") from another plugin" >&2
                fi
                ln -sfn "${entry}" "${target}"
                echo "${target}" >> "${new_state}"
            done
        done
    done
fi

# Atomically replace the state file. Sorted+deduplicated so successive idempotent runs
# produce byte-identical state files. On sort failure keep the previous state_file untouched
# (the EXIT trap cleans up new_state).
if sort -u "${new_state}" -o "${new_state}"; then
    mv "${new_state}" "${state_file}"
else
    echo "ERROR: failed to sort managed-links; previous state_file preserved" >&2
    exit 1
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

# Pre-seed .claude.json: always pre-accept the /workspace trust dialog (keyed by
# working_dir, separate from --dangerously-skip-permissions); set onboarding only
# when logged in, else leave it incomplete so `claude` shows the OAuth flow.
creds_valid() {
    local f="${HOME}/.claude/.credentials.json"
    # Non-empty and ends with `}` (a complete JSON object, not a truncated write).
    [ -s "$f" ] && [ "$(tr -d '[:space:]' < "$f" | tail -c 1)" = "}" ]
}
if [ ! -f "${HOME}/.claude.json" ]; then
    if creds_valid; then
        onboarding='"hasCompletedOnboarding": true,
  "installMethod": "native",'
    else
        onboarding=''
    fi
    cat > "${HOME}/.claude.json" << EOF
{
  ${onboarding}
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
EOF
fi


# Wait for MCP hub to accept connections before Claude starts. Without this,
# the first claude session hits `ConnectionRefused` on http://mcp-hub:4000
# during compose-up race (claude container ready before hub), and runs with
# zero tools — listFiles, search_tools, sharepoint.* all unavailable until
# user opens a fresh chat. Hub typically responds within a second; bail
# after ~30s so a broken hub doesn't lock the container forever.
# Set `SPEEDWAVE_SKIP_HUB_WAIT=1` in tests or single-container runs.
if [ -z "${SPEEDWAVE_SKIP_HUB_WAIT:-}" ]; then
    wait_for_hub() {
        local host="mcp-hub" port="${MCP_HUB_PORT}" attempts=30
        while [ "${attempts}" -gt 0 ]; do
            if (echo > "/dev/tcp/${host}/${port}") 2>/dev/null; then
                return 0
            fi
            attempts=$((attempts - 1))
            sleep 1
        done
        echo "WARNING: MCP hub at ${host}:${port} did not respond within 30s — Claude will start without tools." >&2
        return 1
    }
    wait_for_hub || true
fi

# Health check marker
touch "${CLAUDE_READY_MARKER:-/tmp/claude-ready}"

# Execute the passed command (or keep container alive waiting for exec)
if [ $# -gt 0 ]; then
    exec "$@"
else
    exec sleep infinity
fi

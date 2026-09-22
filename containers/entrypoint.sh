#!/bin/bash
set -euo pipefail

trap 'exit 0' TERM INT

_DIAG_LOG="${HOME}/.speedwave-entrypoint.log"
_DIAG_FAILURES=0
if [ -L "${_DIAG_LOG}" ] || { [ -e "${_DIAG_LOG}" ] && [ ! -f "${_DIAG_LOG}" ]; }; then
    _DIAG_LOG=""
elif ! : > "${_DIAG_LOG}" 2>/dev/null; then
    _DIAG_LOG=""
else
    chmod 600 "${_DIAG_LOG}" 2>/dev/null || true
    echo "=== speedwave entrypoint $(date -Iseconds 2>/dev/null || date) ===" >> "${_DIAG_LOG}" 2>/dev/null || _DIAG_LOG=""
fi

_diag_redact() {
    printf '%s' "$*" | tr '\n' ' ' \
        | sed -E \
            -e 's/(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|xoxe[.-][A-Za-z0-9.-]{8,}|xox[a-z]-[A-Za-z0-9-]{8,}|github_pat_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer +[A-Za-z0-9._-]{8,})/[REDACTED]/g' \
            -e 's/(x-speedwave-proxy-auth:[[:space:]]+)[^[:space:]]+/\1[REDACTED]/g' \
        | cut -c1-500
}

_diag() {
    local level="$1" tag="$2"; shift 2
    local msg; msg="$(_diag_redact "$*")"
    [ "${tag}" = "FAIL" ] && _DIAG_FAILURES=$((_DIAG_FAILURES + 1))
    if [ -n "${_DIAG_LOG}" ]; then
        echo "$(date -Iseconds 2>/dev/null || date) ${level} ${tag} ${msg}" >> "${_DIAG_LOG}" 2>/dev/null || _DIAG_LOG=""
    fi
    return 0
}

_diag_footer() {
    [ -n "${_DIAG_LOG}" ] || return 0
    echo "=== entrypoint done (${_DIAG_FAILURES} failure(s)) ===" >> "${_DIAG_LOG}" 2>/dev/null || true
    return 0
}

read -r -d '' JS_WRITE_ATOMIC << 'EOF' || true
const writeAtomic = (p, data) => {
  const fd = fs.openSync(p + ".tmp", "w");
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(p + ".tmp", p);
};
EOF

export DISABLE_AUTOUPDATER=1

export TERM="${TERM:-xterm-256color}"

export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"

CLAUDE_VERSION="${CLAUDE_VERSION:?CLAUDE_VERSION env var is required}"

SPEEDWAVE_RESOURCES="${SPEEDWAVE_RESOURCES:-/speedwave/resources}"

if ! command -v claude &> /dev/null; then
    echo "Claude Code not found — installing via install-claude.sh (${CLAUDE_VERSION})..."
    /usr/local/bin/install-claude.sh "${CLAUDE_VERSION}"
else
    installed_version="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
    if [ -n "$installed_version" ] && [ "$installed_version" != "$CLAUDE_VERSION" ]; then
        echo "WARNING: image has Claude Code ${installed_version} but the pinned version is ${CLAUDE_VERSION} — run 'speedwave update' to rebuild the image" >&2
        _diag WARN SKEW "image ${installed_version}, pinned ${CLAUDE_VERSION}"
    fi
    _diag INFO CLAUDE "version ${installed_version} (pinned ${CLAUDE_VERSION})"
fi

if [ -x /usr/local/bin/claude ]; then
    mkdir -p "${HOME}/.local/bin"
    ln -sf /usr/local/bin/claude "${HOME}/.local/bin/claude"
fi

if ! grep -q '\.local/bin' "${HOME}/.bashrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${HOME}/.bashrc"
fi

mkdir -p "${HOME}/.claude"


for resource_type in skills commands agents hooks; do
    target="${HOME}/.claude/${resource_type}"
    if [ -L "${target}" ]; then
        rm -f "${target}"
    fi
    mkdir -p "${target}"
done

state_file="${HOME}/.claude/.speedwave-managed-links"
if [ -f "${state_file}" ]; then
    while IFS= read -r link; do
        [ -L "${link}" ] && rm -f "${link}"
    done < "${state_file}"
fi

new_state="$(mktemp)"
trap 'rm -f "${new_state}"' EXIT

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

hook_decl_dirs=()

for resource_type in skills commands agents hooks; do
    src_dir="${SPEEDWAVE_RESOURCES}/${resource_type}"
    [ -d "${src_dir}" ] || continue

    if [ "${resource_type}" = "hooks" ] && [ -f "${src_dir}/hooks.json" ]; then
        hook_decl_dirs+=("${src_dir}")
    fi
    for entry in "${src_dir}"/*; do
        [ -e "${entry}" ] || continue
        name="$(basename "${entry}")"
        [ "${name}" = "integrations" ] && continue
        [ "${resource_type}" = "hooks" ] && [ "${name}" = "hooks.json" ] && continue
        link="${HOME}/.claude/${resource_type}/${name}"
        ln -sfn "${entry}" "${link}"
        echo "${link}" >> "${new_state}"
    done

    integrations_dir="${src_dir}/integrations"
    if [ -d "${integrations_dir}" ] && [ "${#ENABLED_SVCS[@]}" -gt 0 ]; then
        for svc in "${ENABLED_SVCS[@]}"; do
            [ "${svc}" = "os" ] && continue
            src="${integrations_dir}/${svc}"
            [ -d "${src}" ] || continue
            if [ "${resource_type}" = "hooks" ] && [ -f "${src}/hooks.json" ]; then
                hook_decl_dirs+=("${src}")
            fi
            link="${HOME}/.claude/${resource_type}/${svc}"
            ln -sfn "${src}" "${link}"
            echo "${link}" >> "${new_state}"
        done
    fi

    if [ -d "${integrations_dir}" ] && [ "${#OS_ENABLED_SUBS[@]}" -gt 0 ]; then
        for sub in "${OS_ENABLED_SUBS[@]}"; do
            src="${integrations_dir}/${sub}"
            [ -d "${src}" ] || continue
            if [ "${resource_type}" = "hooks" ] && [ -f "${src}/hooks.json" ]; then
                hook_decl_dirs+=("${src}")
            fi
            link="${HOME}/.claude/${resource_type}/${sub}"
            ln -sfn "${src}" "${link}"
            echo "${link}" >> "${new_state}"
        done
    fi
done

for resource_file in statusline.sh CLAUDE.md; do
    if [ -f "${SPEEDWAVE_RESOURCES}/${resource_file}" ]; then
        ln -sf "${SPEEDWAVE_RESOURCES}/${resource_file}" "${HOME}/.claude/${resource_file}"
    fi
done

if [ -L "${HOME}/.claude/settings.json" ]; then
    rm -f "${HOME}/.claude/settings.json"
fi
if [ -f "${SPEEDWAVE_RESOURCES}/settings.json" ]; then
    _tmpl="${SPEEDWAVE_RESOURCES}/settings.json"
    _dest="${HOME}/.claude/settings.json"
    if [ ! -e "${_dest}" ]; then
        cp "${_tmpl}" "${_dest}"
    else
        node -e "
const fs = require('fs');
${JS_WRITE_ATOMIC}
const tmpl = JSON.parse(fs.readFileSync('${_tmpl}', 'utf8'));
const cur  = JSON.parse(fs.readFileSync('${_dest}', 'utf8'));
const merged = Object.assign({}, tmpl, cur);
let changed = cur === null || typeof cur !== 'object' || Array.isArray(cur)
  || Object.keys(tmpl).some((k) => !Object.prototype.hasOwnProperty.call(cur, k));
const foreign = typeof merged.model === 'string' && !/^(claude-.+|(default|best|fable|sonnet|opus|haiku|opusplan)(\[1m\])?)\$/.test(merged.model);
if (!process.env.ANTHROPIC_MODEL && foreign) {
  console.error('entrypoint: dropping foreign settings.json model ' + merged.model);
  delete merged.model;
  changed = true;
}
if (changed) {
  writeAtomic('${_dest}', JSON.stringify(merged, null, 2) + '\n');
}
" || echo 'entrypoint: settings.json merge skipped' >&2
    fi
    unset _tmpl _dest
fi

if [ -f "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md" ]; then
    mkdir -p "${HOME}/.claude/output-styles"
    ln -sf "${SPEEDWAVE_RESOURCES}/output-styles/Speedwave.md" "${HOME}/.claude/output-styles/Speedwave.md"
fi

_bundled_marker="${HOME}/.claude/.speedwave-bundled-plugins-installed.v2"
rm -f "${HOME}/.claude/.speedwave-bundled-plugins-installed"

_plugin_installed() {
    jq -r --arg id "$1" \
        'if (.plugins | type) == "object" then (.plugins[$id] | type == "array" and length > 0) else empty end' \
        "${HOME}/.claude/plugins/installed_plugins.json" 2>/dev/null || true
}

_retired="superpowers@claude-plugins-official"
_retired_keep=""
if [ -f "${_bundled_marker}" ] && grep -qxF "${_retired}" "${_bundled_marker}"; then
    if ! command -v jq &> /dev/null; then
        echo "WARNING: jq not found — skipping removal of retired plugin ${_retired}" >&2
        _diag WARN CONFIG "jq not found — retired plugin removal skipped"
        _retired_keep="${_retired}"
    else
        _present="$(_plugin_installed "${_retired}")"
        _gone=0
        if [ "${_present}" = "false" ]; then
            rm -rf "${HOME}/.claude/plugins/cache/${_retired#*@}/${_retired%@*}"
            _gone=1
            _diag INFO SKIP "${_retired} not installed; dropping its marker entry"
        elif _err="$(timeout 60 claude plugin uninstall "${_retired}" 2>&1 >/dev/null)"; then
            rm -rf "${HOME}/.claude/plugins/cache/${_retired#*@}/${_retired%@*}"
            _gone=1
            _diag INFO OK "uninstalled retired plugin ${_retired}"
        elif [[ "${_err}" == *"not found in installed plugins"* ]]; then
            _gone=1
            _diag INFO SKIP "${_retired} already removed; dropping its marker entry"
        else
            echo "WARNING: failed to uninstall retired plugin ${_retired}: ${_err} (continuing)" >&2
            _diag WARN PLUGIN "uninstall ${_retired}: ${_err}"
            _retired_keep="${_retired}"
        fi
        if [ "${_gone}" -eq 1 ]; then
            _rc=0
            grep -vxF "${_retired}" "${_bundled_marker}" > "${_bundled_marker}.tmp" || _rc=$?
            if [ "${_rc}" -gt 1 ] || [ ! -f "${_bundled_marker}.tmp" ] || ! mv "${_bundled_marker}.tmp" "${_bundled_marker}"; then
                rm -f "${_bundled_marker}.tmp" 2>/dev/null || true
                echo "WARNING: could not rewrite the bundled-plugins marker for ${_retired} (continuing)" >&2
                _diag WARN PLUGIN "marker rewrite failed for ${_retired}"
                _retired_keep="${_retired}"
            fi
        fi
        unset _present _gone _err _rc
    fi
fi
unset _retired

if [ -n "${SPEEDWAVE_BUNDLED_PLUGINS:-}" ]; then
    _mp="${SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE:-claude-plugins-official}"
    if ! echo "${_mp}" | grep -qE '^[a-z][a-z0-9-]{0,63}$'; then
        echo "WARNING: invalid bundled-plugin marketplace, skipping install: ${_mp}" >&2
        _diag WARN CONFIG "invalid bundled-plugin marketplace: ${_mp}"
        SPEEDWAVE_BUNDLED_PLUGINS=""
    fi
    _all_recorded=1
    if [ -n "${SPEEDWAVE_BUNDLED_PLUGINS}" ] && [ -f "${_bundled_marker}" ]; then
        for _plugin in ${SPEEDWAVE_BUNDLED_PLUGINS//,/ }; do
            echo "${_plugin}" | grep -qE '^[a-z][a-z0-9-]{0,63}$' || continue
            grep -qxE "^${_plugin}@${_mp}(#found)?$" "${_bundled_marker}" || { _all_recorded=0; break; }
        done
    else
        _all_recorded=0
    fi
    if [ -n "${SPEEDWAVE_BUNDLED_PLUGINS}" ] && [ "${_all_recorded}" -eq 0 ] && ! command -v jq &> /dev/null; then
        echo "WARNING: jq not found — skipping bundled-plugin install (cannot verify what is already installed)" >&2
        _diag WARN CONFIG "jq not found — bundled-plugin install skipped"
        SPEEDWAVE_BUNDLED_PLUGINS=""
    fi
    if [ -n "${SPEEDWAVE_BUNDLED_PLUGINS}" ] && [ "${_all_recorded}" -eq 1 ]; then
        _diag INFO SKIP "all bundled plugins already recorded"
    fi
    if [ -n "${SPEEDWAVE_BUNDLED_PLUGINS}" ] && [ "${_all_recorded}" -eq 0 ]; then
        _new_marker="$(mktemp)"
        if [ -n "${_retired_keep}" ]; then
            echo "${_retired_keep}" >> "${_new_marker}"
        fi
        _mp_add_attempted=""
        for _plugin in ${SPEEDWAVE_BUNDLED_PLUGINS//,/ }; do
            if ! echo "${_plugin}" | grep -qE '^[a-z][a-z0-9-]{0,63}$'; then
                echo "WARNING: skipping invalid bundled-plugin name: ${_plugin}" >&2
                _diag WARN CONFIG "invalid bundled-plugin name: ${_plugin}"
                continue
            fi
            _match="$(_plugin_installed "${_plugin}@${_mp}")"
            if [ "${_match}" = "true" ]; then
                if grep -qxF "${_plugin}@${_mp}" "${_bundled_marker}" 2>/dev/null; then
                    echo "${_plugin}@${_mp}" >> "${_new_marker}"
                else
                    echo "${_plugin}@${_mp}#found" >> "${_new_marker}"
                fi
                _diag INFO SKIP "${_plugin}@${_mp} (already installed)"
                continue
            fi
            if [ "${_mp}" = "claude-plugins-official" ] && [ -z "${_mp_add_attempted}" ] \
                && ! jq -e --arg mp "${_mp}" '.[$mp] | type == "object"' "${HOME}/.claude/plugins/known_marketplaces.json" >/dev/null 2>&1; then
                _mp_add_attempted=1
                if ! _err="$(timeout 150 claude plugin marketplace add "anthropics/${_mp}" 2>&1 >/dev/null)"; then
                    echo "WARNING: failed to add plugin marketplace ${_mp}: ${_err} (continuing)" >&2
                    _diag WARN CONFIG "marketplace add ${_mp}: ${_err}"
                fi
            fi
            if _err="$(timeout 120 claude plugin install "${_plugin}@${_mp}" 2>&1 >/dev/null)"; then
                echo "${_plugin}@${_mp}" >> "${_new_marker}"
                _diag INFO OK "${_plugin}@${_mp}"
            else
                echo "WARNING: failed to install bundled plugin ${_plugin}@${_mp}: ${_err} (continuing)" >&2
                _diag ERROR FAIL "${_plugin}@${_mp}: ${_err}"
            fi
        done
        if [ -s "${_new_marker}" ]; then
            sort -u "${_new_marker}" -o "${_new_marker}" && mv "${_new_marker}" "${_bundled_marker}"
        else
            rm -f "${_new_marker}"
        fi
    fi
    unset _mp _plugin _err _all_recorded _new_marker _match _mp_add_attempted
fi
unset _bundled_marker _retired_keep

if [ -n "${SPEEDWAVE_PLUGINS:-}" ]; then
    for plugin in ${SPEEDWAVE_PLUGINS//,/ }; do
        if ! echo "${plugin}" | grep -qE '^[a-z][a-z0-9-]{0,63}$'; then
            echo "WARNING: Skipping invalid plugin slug: ${plugin}" >&2
            continue
        fi
        plugin_path="/speedwave/plugins/${plugin}"
        [ -d "${plugin_path}" ] || continue
        if [ -f "${plugin_path}/hooks/hooks.json" ]; then
            hook_decl_dirs+=("${plugin_path}/hooks")
        fi
        for resource_type in skills commands agents hooks; do
            [ -d "${plugin_path}/${resource_type}" ] || continue
            for entry in "${plugin_path}/${resource_type}"/*; do
                [ -e "${entry}" ] || continue
                [ "${resource_type}" = "hooks" ] && [ "$(basename "${entry}")" = "hooks.json" ] && continue
                target="${HOME}/.claude/${resource_type}/$(basename "${entry}")"
                if [ -L "${target}" ] && [ "$(readlink "${target}")" != "${entry}" ]; then
                    echo "WARNING: plugin '${plugin}' overwrites ${resource_type}/$(basename "${entry}") from another plugin" >&2
                    _diag WARN PLUGIN "resource collision: ${plugin}"
                fi
                ln -sfn "${entry}" "${target}"
                echo "${target}" >> "${new_state}"
            done
        done
    done
fi

if sort -u "${new_state}" -o "${new_state}"; then
    mv "${new_state}" "${state_file}"
else
    echo "ERROR: failed to sort managed-links; previous state_file preserved" >&2
    exit 1
fi

_managed_hooks="${HOME}/.claude/.speedwave-managed-hooks"
if [ "${#hook_decl_dirs[@]}" -gt 0 ] || [ -f "${_managed_hooks}" ]; then
    _decl_dirs=""
    if [ "${#hook_decl_dirs[@]}" -gt 0 ]; then
        _decl_dirs="$(printf '%s\n' "${hook_decl_dirs[@]}")"
    fi
    SPW_HOOK_DECL_DIRS="${_decl_dirs}" \
    SPW_SETTINGS_FILE="${HOME}/.claude/settings.json" \
    SPW_MANAGED_HOOKS_FILE="${_managed_hooks}" \
    node -e '
const fs = require("fs");
'"${JS_WRITE_ATOMIC}"'
const settingsPath = process.env.SPW_SETTINGS_FILE;
const statePath = process.env.SPW_MANAGED_HOOKS_FILE;
const declDirs = (process.env.SPW_HOOK_DECL_DIRS || "").split("\n").filter(Boolean);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const stable = (v) => JSON.stringify(v, (k, val) =>
  isObj(val) ? Object.keys(val).sort().reduce((o, key) => ((o[key] = val[key]), o), {}) : val);
const validDecl = (decl) => isObj(decl) && Object.entries(decl).every(([event, groups]) =>
  /^[A-Z][A-Za-z]{2,63}$/.test(event) && Array.isArray(groups) && groups.every((g) =>
    isObj(g) && Array.isArray(g.hooks) && g.hooks.every((h) =>
      isObj(h) && h.type === "command" && typeof h.command === "string" && h.command.trim() !== "")));

let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
  catch (e) { console.error("entrypoint: settings.json unparseable — hook registration skipped: " + e.message); process.exit(0); }
}
if (!isObj(settings) || (settings.hooks !== undefined && !isObj(settings.hooks))) {
  console.error("entrypoint: settings.json hooks key is not an object — hook registration skipped");
  process.exit(0);
}
const before = stable(settings);
const hooks = settings.hooks || {};
settings.hooks = hooks;

let prev = {};
if (fs.existsSync(statePath)) {
  try { const p = JSON.parse(fs.readFileSync(statePath, "utf8")); if (isObj(p)) prev = p; }
  catch (e) { console.error("WARNING: managed-hooks state unparseable (" + e.message + ") — hooks of disabled sources may stay registered until re-enabled and disabled again"); }
}

for (const [event, groups] of Object.entries(prev)) {
  if (!Array.isArray(hooks[event]) || !Array.isArray(groups)) continue;
  for (const g of groups) {
    if (!isObj(g) || typeof g._speedwaveHookId !== "string") continue;
    const i = hooks[event].findIndex((c) => isObj(c) && c._speedwaveHookId === g._speedwaveHookId);
    if (i !== -1) hooks[event].splice(i, 1);
  }
  if (hooks[event].length === 0) delete hooks[event];
}

const managed = {};
for (const dir of declDirs) {
  const file = dir + "/hooks.json";
  let decl;
  try { decl = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { console.error("WARNING: ignoring invalid hooks declaration " + file + ": " + e.message); continue; }
  if (!validDecl(decl)) { console.error("WARNING: ignoring invalid hooks declaration " + file); continue; }
  for (const [event, groups] of Object.entries(decl)) {
    groups.forEach((g, idx) => {
      for (const h of g.hooks) h.command = h.command.split("${SPEEDWAVE_HOOK_DIR}").join(dir);
      g._speedwaveHookId = dir + "#" + event + "#" + idx;
      (managed[event] = managed[event] || []).push(g);
    });
  }
}
for (const [event, groups] of Object.entries(managed)) {
  if (hooks[event] === undefined) hooks[event] = [];
  else if (!Array.isArray(hooks[event])) {
    console.error("WARNING: settings.json hooks." + event + " is not an array — skipping its managed hooks");
    continue;
  }
  for (const g of groups) {
    if (!hooks[event].some((c) => isObj(c) && c._speedwaveHookId === g._speedwaveHookId)) hooks[event].push(g);
  }
}
if (Object.keys(hooks).length === 0) delete settings.hooks;

if (stable(settings) !== before) {
  writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
if (Object.keys(managed).length > 0) {
  if (stable(managed) !== stable(prev)) writeAtomic(statePath, JSON.stringify(managed, null, 2) + "\n");
} else if (fs.existsSync(statePath)) {
  fs.unlinkSync(statePath);
}
' || echo 'entrypoint: hook registration failed — continuing without managed hooks' >&2
    unset _decl_dirs
fi
unset _managed_hooks

MCP_HUB_PORT="${MCP_HUB_PORT:-4000}"

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

creds_valid() {
    local f="${HOME}/.claude/.credentials.json"
    [ -s "$f" ] && [ "$(tr -d '[:space:]' < "$f" | tail -c 1)" = "}" ]
}
if [ ! -f "${HOME}/.claude.json" ]; then
    cat > "${HOME}/.claude.json" << 'EOF'
{
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
EOF
fi
if creds_valid; then
    node -e "
const fs = require('fs');
${JS_WRITE_ATOMIC}
const p = '${HOME}/.claude.json';
let j;
try { j = JSON.parse(fs.readFileSync(p, 'utf8')); }
catch { console.error('entrypoint: .claude.json unparseable — onboarding merge skipped'); process.exit(0); }
let changed = false;
if (j.hasCompletedOnboarding !== true) { j.hasCompletedOnboarding = true; changed = true; }
if (j.installMethod == null) { j.installMethod = 'native'; changed = true; }
j.projects = j.projects || {};
const ws = j.projects['/workspace'] || {};
if (ws.hasTrustDialogAccepted !== true) { ws.hasTrustDialogAccepted = true; changed = true; }
if (ws.hasCompletedProjectOnboarding !== true) { ws.hasCompletedProjectOnboarding = true; changed = true; }
j.projects['/workspace'] = ws;
if (changed) {
  writeAtomic(p, JSON.stringify(j, null, 2) + '\n');
}
" || echo 'entrypoint: .claude.json onboarding merge skipped' >&2
fi


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
        _diag WARN HUB "hub did not respond within 30s"
        return 1
    }
    wait_for_hub || true
fi

touch "${CLAUDE_READY_MARKER:-/tmp/claude-ready}"

if [ $# -gt 0 ]; then
    _diag_footer
    exec "$@"
else
    _diag_footer
    trap 'kill "$!" 2>/dev/null; exit 0' TERM INT
    while :; do sleep 86400 & wait $!; done
fi

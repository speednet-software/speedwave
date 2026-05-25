# ADR-022: Bundled .claude Resources and Project-Level Coexistence

> **Status:** Accepted
> **Context:** Documenting how Speedwave-bundled Claude Code resources coexist with team-committed `.claude/` directories

---

## Context

Speedwave bundles Claude Code resources — skills, commands, agents, and hooks — that extend Claude's capabilities inside the container (e.g., code review workflows, Speedwave-specific slash commands). These resources are shipped as files in the Speedwave application and mounted read-only into the Claude container at `/speedwave/resources/`.

Independently, development teams commit their own `.claude/` directory into their project repository (e.g., project-specific agents, custom commands, CLAUDE.md instructions). This directory is mounted into the container as `/workspace/.claude/` via the project volume.

The question: **how do Speedwave-bundled resources coexist with team-committed project-level resources without conflicts?**

## Decision

Speedwave places bundled resources at the **user level** (`/home/speedwave/.claude/`) via symlinks. Team resources remain at the **project level** (`/workspace/.claude/`). Container isolation ensures these two scopes never collide with the host system.

### Mechanism

`entrypoint.sh` places all bundled resources at user-level via symlinks. Top-level files use a single `ln -sf` each; the four resource-type directories (`skills/`, `commands/`, `agents/`, `hooks/`) are real directories of per-entry symlinks, with integration-bound entries gated by `ENABLED_SERVICES` and tracked in a state file:[^1]

```bash
# Cleanup links the previous run owned (toggle-off semantics).
state_file="${HOME}/.claude/.speedwave-managed-links"
if [ -f "${state_file}" ]; then
    while IFS= read -r link; do
        [ -L "${link}" ] && rm -f "${link}"
    done < "${state_file}"
fi

new_state="$(mktemp)"
trap 'rm -f "${new_state}"' EXIT

for resource_type in skills commands agents hooks; do
    src_dir="${SPEEDWAVE_RESOURCES}/${resource_type}"
    [ -d "${src_dir}" ] || continue

    # Core entries — always-on (skip the integrations/ bucket).
    for entry in "${src_dir}"/*; do
        [ -e "${entry}" ] || continue
        name="$(basename "${entry}")"
        [ "${name}" = "integrations" ] && continue
        link="${HOME}/.claude/${resource_type}/${name}"
        ln -sfn "${entry}" "${link}"
        echo "${link}" >> "${new_state}"
    done

    # Integration-bound entries — only linked when in ENABLED_SERVICES.
    integrations_dir="${src_dir}/integrations"
    if [ -d "${integrations_dir}" ] && [ -n "${ENABLED_SERVICES:-}" ]; then
        IFS=',' read -ra services <<< "${ENABLED_SERVICES}"
        for svc in "${services[@]}"; do
            svc="${svc//[[:space:]]/}"
            [ -z "${svc}" ] && continue
            [ "${svc}" = "os" ] && continue  # OS sub-services handled below.
            src="${integrations_dir}/${svc}"
            [ -d "${src}" ] || continue
            link="${HOME}/.claude/${resource_type}/${svc}"
            ln -sfn "${src}" "${link}"
            echo "${link}" >> "${new_state}"
        done
    fi

    # OS sub-services (reminders, calendar, mail, notes) are gated jointly: `os` must be in
    # ENABLED_SERVICES AND the sub-service must NOT appear in DISABLED_OS_SERVICES. The available
    # sub-service list is injected as OS_AVAILABLE_SUBS from TOGGLEABLE_OS_SERVICES (the Rust SSOT).
done

# Plugin entries are layered on top using the same per-entry mechanism and
# tracked in the same state file (so plugin toggle-off cleans up too).
# Individual top-level files (statusline.sh, settings.json, CLAUDE.md, output-styles/Speedwave.md)
# use plain `ln -sf` — they are not tracked in the state file because they never go away.
sort -u "${new_state}" -o "${new_state}"
mv "${new_state}" "${state_file}"
```

The only exception is `mcp-config.json`, which is **generated inline** by `entrypoint.sh` on every start because it depends on the runtime `MCP_HUB_PORT` variable. See [Bundled Resources](../architecture/bundled-resources.md) for the complete resource catalog.

This produces the following filesystem layout inside the container:

```
/home/speedwave/.claude/           ← user-level (Speedwave-controlled)
├── output-styles/
│   └── Speedwave.md → /speedwave/resources/output-styles/Speedwave.md
├── statusline.sh    → /speedwave/resources/statusline.sh
├── settings.json    → /speedwave/resources/settings.json
├── CLAUDE.md        → /speedwave/resources/CLAUDE.md
├── .speedwave-managed-links       ← state file: links the entrypoint owns
├── skills/                        ← real dir of per-entry symlinks
│   ├── code-review-basic    → /speedwave/resources/skills/code-review-basic                ← core, always linked
│   ├── code-review-…        → …
│   └── office               → /speedwave/resources/skills/integrations/office              ← gated by ENABLED_SERVICES
├── commands/                      ← real dir of per-entry symlinks (same gating model)
├── agents/                        ← real dir of per-entry symlinks (same gating model)
├── hooks/                         ← real dir of per-entry symlinks (same gating model)
├── mcp-config.json                ← generated by entrypoint.sh
└── ide/                           ← read-only mount (IDE Bridge lock files)

/workspace/.claude/                ← project-level (team-committed, from git)
├── agents/
├── commands/
├── settings.json
└── CLAUDE.md
```

### How Claude Code Resolves Scopes

Claude Code uses a scope hierarchy where project-level settings take precedence over user-level settings:[^2]

| Scope   | Container path             | Source                       | Priority |
| ------- | -------------------------- | ---------------------------- | -------- |
| Project | `/workspace/.claude/`      | Team's git repository        | Higher   |
| User    | `/home/speedwave/.claude/` | Speedwave bundle (symlinked) | Lower    |

Key behaviors:

- **Agents**: Project agents (`.claude/agents/`) override user agents (`~/.claude/agents/`) when names collide. Both sets are available when names differ.[^3]
- **Commands**: Same merge logic — project commands override user commands of the same name.[^4]
- **Skills**: Skill descriptions from both scopes are loaded into context. The character budget scales dynamically at 2% of the context window.[^5]
- **Hooks**: Array settings (including hooks) merge across scopes — both user-level and project-level hooks fire.[^2]
- **CLAUDE.md**: Both `~/.claude/CLAUDE.md` (user) and `/workspace/.claude/CLAUDE.md` or `/workspace/CLAUDE.md` (project) are loaded. Project instructions are additive to user instructions.[^2]
- **settings.json**: Project settings override user settings for the same keys. Array-valued settings (like `permissions.allow`) merge across scopes.[^2] Note: the user-level `settings.json` is a symlink to the read-only mount, so Claude Code cannot persist changes there. Teams that need custom settings should commit `.claude/settings.json` at the project level.

This means teams can:

1. Use Speedwave-bundled resources out of the box (user-level defaults)
2. Override specific resources by committing same-named files to `.claude/` in their repo
3. Add project-specific resources that complement the Speedwave bundle

### Plugin Resources

Plugins use the same per-entry symlink mechanism as core/integration resources — every plugin entry is symlinked individually into `~/.claude/<type>/` and recorded in the managed-links state file:[^1]

```bash
for entry in "${plugin_path}/${resource_type}"/*; do
    [ -e "${entry}" ] || continue
    target="${HOME}/.claude/${resource_type}/$(basename "${entry}")"
    ln -sfn "${entry}" "${target}"
    echo "${target}" >> "${new_state}"
done
```

This lets core, integration-gated, and plugin resources coexist within the same user-level directory. The state-file tracking means disabling a plugin on the next run removes its links — the same toggle-off semantics that apply to integrations. Plugin resources support all four resource types: `commands`, `agents`, `skills`, and `hooks`. Plugins run inside the container (sandboxed with `cap_drop: ALL`, `no-new-privileges`, `read_only`), so plugin hooks have the same trust boundary as plugin skills and commands.

### Container Isolation

The entire mechanism runs inside an OCI container with security hardening (ADR-009): `read_only` filesystem, `cap_drop: ALL`, `no-new-privileges`. The volume mounts are:[^6]

```yaml
volumes:
  - ${CLAUDE_HOME}:/home/speedwave:rw # persistent home (user-level)
  - ${PROJECT_DIR}:/workspace # project directory (project-level)
  - ${RESOURCES_DIR}:/speedwave/resources:ro # bundled resources (read-only)
  - ${IDE_LOCK_DIR}:/home/speedwave/.claude/ide:ro # IDE Bridge lock files (read-only)
```

Container isolation guarantees:

- Speedwave's user-level resources never touch the host's `~/.claude/`
- Team's project-level `.claude/` is mounted from the project directory, unchanged
- The read-only mount prevents the container from modifying bundled resources

## Rationale

### Why user-level (`~/.claude/`) for bundled resources?

- **Speedwave controls the scope**: user-level is managed by Speedwave, not by the team's repo
- **Teams can override**: project-level takes precedence, so teams can replace any Speedwave resource by committing a same-named file
- **No git pollution**: bundled resources never appear in the team's working tree or `git status`

### Why symlinks instead of copies?

- **Zero duplication**: symlinks point to the read-only mount — no disk space wasted on copies
- **Instant updates**: when Speedwave ships new resources (via image rebuild), symlinks automatically resolve to the new content without re-copying
- **Atomic**: `ln -sfn` is atomic — no partial state during container startup

### Why not write to `/workspace/.claude/`?

Writing Speedwave resources into the project directory would:

- Pollute `git status` with untracked files
- Risk merge conflicts with team-committed `.claude/` files
- Violate the principle that Speedwave does not modify the user's repository

### Why container isolation matters here?

On a bare host, user-level `~/.claude/` would be the developer's personal Claude Code config. Inside the container, `~/.claude/` is an isolated directory (`/home/speedwave/.claude/`) that Speedwave controls entirely. This eliminates any risk of Speedwave's bundled resources interfering with the developer's host-level Claude Code installation.

## Rejected Alternatives

### 1. Managed-level settings (`/etc/claude-code/` or `/Library/Application Support/ClaudeCode/`)

Claude Code supports a managed scope with the highest priority — it cannot be overridden by project or user settings.[^2] Using this scope for Speedwave resources would prevent teams from overriding bundled agents/commands, which contradicts the goal of team customization. Managed scope is designed for enterprise IT policies, not application defaults.

### 2. Writing bundled resources to `/workspace/.claude/`

This would place Speedwave resources at the project level, making them appear in `git status` as untracked files. Teams would need `.gitignore` entries for Speedwave-specific files, and there would be no clean separation between "what Speedwave provides" and "what the team commits."

### 3. Copying files instead of symlinking

Copying from `/speedwave/resources/` to `~/.claude/` would work but wastes disk space and requires explicit re-copy logic when resources change. Symlinks are simpler, atomic, and always reflect the current state of the read-only mount.

### 4. Bind-mounting individual resource directories

Instead of symlinking, we could add separate volume mounts for each resource type:

```yaml
volumes:
  - ${RESOURCES_DIR}/skills:/home/speedwave/.claude/skills:ro
  - ${RESOURCES_DIR}/agents:/home/speedwave/.claude/agents:ro
```

This would work but makes `compose.template.yml` more verbose and harder to extend. Adding a new resource type would require both a compose change and an entrypoint change. The current approach requires only an entrypoint change (the `for` loop automatically picks up new directories).

---

[^1]: [`containers/entrypoint.sh` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/containers/entrypoint.sh)

[^2]: [Claude Code Settings — Scopes and Precedence](https://code.claude.com/docs/en/settings)

[^3]: [Claude Code Subagents — Choose the subagent scope](https://code.claude.com/docs/en/sub-agents)

[^4]: [Claude Code Slash Commands](https://code.claude.com/docs/en/slash-commands)

[^5]: [Claude Code Skills — Extend Claude with skills](https://code.claude.com/docs/en/skills)

[^6]: [`containers/compose.template.yml` — Speedwave repository](https://github.com/speednet-software/speedwave/blob/main/containers/compose.template.yml)

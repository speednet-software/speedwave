# ADR-022: Bundled .claude Resources and Project-Level Coexistence

> **Status:** Accepted
> **Context:** How Speedwave-bundled Claude Code resources coexist with a team's committed `.claude/` directory

---

## Context

Speedwave ships its own Claude Code resources — skills, a status line, an output style, a `CLAUDE.md`, and a `settings.json` — mounted read-only into the container at `/speedwave/resources/`. (`commands`, `agents`, and `hooks` are resource buckets the wiring supports but the bundle does not currently fill; they come from plugins or a team's own `.claude/`. Note that for `hooks`, symlinking files is not enough — Claude Code executes only hooks registered under a settings `hooks` key, which the entrypoint generates from `hooks/hooks.json` declarations; see [ADR-078](ADR-078-claude-hook-registration.md).)

Teams independently commit their own `.claude/` directory to their repo (project-specific agents, commands, instructions). It arrives in the container as `/workspace/.claude/`.

The question: how do the two coexist without conflicts, and without Speedwave touching the developer's host machine?

## Decision

Speedwave places its resources at the **user scope** (`~/.claude/`); the team's resources stay at the **project scope** (`/workspace/.claude/`). Claude Code resolves project over user, so a team overrides a Speedwave resource by committing a same-named file (array-valued settings like `hooks` and `permissions.allow` merge rather than replace — see Settings scopes below). `entrypoint.sh` wires up the user scope on every container start; the mechanics live there, not in this ADR.[^1]

Resources are linked, not copied — each one is a symlink into the read-only mount, so it auto-updates when Speedwave ships a new version and wastes no disk space. Integration-bound resources (e.g. an Office skill) are linked only when their integration is enabled; the entrypoint tracks every link it owns so toggling an integration off removes it cleanly.

Two resources are not symlinks:

- **`mcp-config.json`** is generated on each start, because it embeds the runtime MCP hub port.
- **`settings.json`** is a writable copy, seeded from the bundle only when absent. Claude Code persists to it at runtime — `/effort` and `/model` save the user's choice there — and a symlink into the read-only mount made those writes fail with `EROFS`. Seeding only-when-absent means a user's choice survives restarts; a stale symlink from an older build is replaced on the next start.

Everything runs inside the hardened container (read-only root, `cap_drop: ALL`, `no-new-privileges`; see [ADR-009]). The user scope is the container's `~/.claude/` — never the developer's real one.

## Settings scopes

Claude Code has five settings scopes, highest precedence first:[^2]

1. **Managed** — `/etc/claude-code/managed-settings.json`, cannot be overridden by anything
2. **CLI flags**
3. **Local** — `.claude/settings.local.json`
4. **Project** — `.claude/settings.json` (team, via git)
5. **User** — `~/.claude/settings.json` (Speedwave bundle)

Speedwave uses only **User** (its defaults) and leaves **Project** to teams. Because User is the lowest scope, a team's project-level value overrides Speedwave's for scalar/object keys. Array-valued keys (`permissions.allow`, `hooks`) are the exception — they merge across scopes rather than override, so both Speedwave's and the team's entries apply. That merge concerns the `hooks` **settings key**, not hook files: content symlinked into `~/.claude/hooks/` never runs by itself. Speedwave-managed hook entries are written into the user-scope `settings.json` by the entrypoint per [ADR-078](ADR-078-claude-hook-registration.md).

## Rationale

- **User scope keeps control with Speedwave, not the repo** — Speedwave owns its defaults, the team overrides at project scope, and nothing pollutes the team's working tree or `git status`.
- **Symlinks over copies** for read-only resources — zero duplication, instant updates on image rebuild, atomic at startup.
- **A copy for `settings.json`** — the one resource Claude Code writes at runtime, so it has to be writable; the symlink would break `/effort` and `/model`.

## Rejected alternatives

- **Managed scope for Speedwave's resources** — highest precedence means teams could not override them, which defeats the point. Managed is for enterprise IT policy, not application defaults.
- **Writing into `/workspace/.claude/`** — would surface Speedwave files in the team's `git status` and risk merge conflicts.
- **Copying everything instead of symlinking** — wastes disk and needs re-copy logic on every update. Only `settings.json` needs to be a copy (because it is written at runtime); the rest stay symlinks.

## See also

- [Bundled Resources](../architecture/bundled-resources.md) — the reference for this design: full resource catalog (source path, target, mechanism, overridable?), the container filesystem layout, and the volume mounts with their read-only / read-write access levels.
- [ADR-009](ADR-009-per-project-isolation-preserved.md) — container hardening and per-project isolation.
- [ADR-015](ADR-015-plugin-system.md) — how plugin-provided resources layer onto the same user scope.

---

[^1]: [`containers/entrypoint.sh`](https://github.com/speednet-software/speedwave/blob/main/containers/entrypoint.sh) — the implementation; see also [Bundled Resources](../architecture/bundled-resources.md) for the full catalog and filesystem layout.

[^2]: [Claude Code Settings — Scopes and Precedence](https://code.claude.com/docs/en/settings)

[ADR-009]: ADR-009-per-project-isolation-preserved.md

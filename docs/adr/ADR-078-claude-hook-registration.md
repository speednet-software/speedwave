# ADR-078: Claude Code Hook Registration via settings.json

**Status:** Accepted

**Date:** 2026-07-06

## Context

Claude Code auto-discovers `skills/`, `commands/`, and `agents/` from `~/.claude/`, but hooks work differently: a hook runs only when it is registered under the `hooks` key of a settings file (user, project, local, or managed scope) or shipped by a native Claude Code plugin as `hooks/hooks.json` next to a `.claude-plugin/plugin.json` manifest.[^1][^2] There is no auto-discovery of a `~/.claude/hooks/` directory.

Speedwave's resource wiring treated `hooks` as a fourth directory-discovered resource type: `entrypoint.sh` symlinked `claude-resources/hooks/` entries from the bundle, from enabled integrations, and from enabled plugins into `~/.claude/hooks/` — and stopped there. No code path ever wrote a `hooks` key into `~/.claude/settings.json`, and the bundled settings template has no such key. Consequences:

- Every hook shipped by a plugin or integration was dead — Claude Code never executed it.
- The `shared` plugin ships a working `UserPromptSubmit` hook (`expand-shortcuts.ts`) whose README instructs users to register it **manually** in `/workspace/.claude/settings.json`.
- [ADR-022] and [ADR-015] documented the symlink bucket as if it were sufficient; [ADR-051] described plugin `claude-resources/hooks/` as "executed on every Claude tool call" — a threat that in fact did not exist because nothing executed them.

## Decision

On every container start, after the resource symlink phase, `entrypoint.sh` **generates the `hooks` key in `~/.claude/settings.json`** from declarative `hooks.json` files shipped by enabled sources. Symlinking a script into `~/.claude/hooks/` remains a convenience for inspection; registration is what makes a hook run.

### Declaration format

A source that wants hooks ships `hooks/hooks.json` — an object in Claude Code's native hooks-settings shape (event name → array of `{matcher?, hooks: [{type: "command", command, timeout?}]}`), the same structure native Claude Code plugins use in their `hooks/hooks.json`.[^2] Recognized locations, gated by the same filters as resource symlinks:

| Source               | Container path                                                    | Gate                                                                                             |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Core bundle          | `/speedwave/resources/hooks/hooks.json`                           | always                                                                                           |
| Built-in integration | `/speedwave/resources/hooks/integrations/<config_key>/hooks.json` | `<config_key>` in `ENABLED_SERVICES` (OS sub-services gated jointly with `DISABLED_OS_SERVICES`) |
| Plugin               | `/speedwave/plugins/<slug>/hooks/hooks.json`                      | slug in `SPEEDWAVE_PLUGINS`                                                                      |

Because Speedwave does not load plugins through Claude Code's native plugin loader, `${CLAUDE_PLUGIN_ROOT}` is never set.[^2] Commands instead use the Speedwave placeholder **`${SPEEDWAVE_HOOK_DIR}`**, which the entrypoint replaces with the absolute in-container path of the directory containing that `hooks.json` (e.g. `/speedwave/plugins/shared/hooks`). Scripts therefore resolve to their read-only source mount, sidestepping symlink-resolution surprises, and sibling files (`shortcuts.json` etc.) resolve naturally via `import.meta.url`. The claude image is `node:24`, which executes type-stripped TypeScript directly, so `node ${SPEEDWAVE_HOOK_DIR}/hook.ts` needs no extra runtime.[^3]

`hooks.json` itself is a registration manifest, not a script — the entrypoint excludes it from the per-entry `~/.claude/hooks/` symlink pass (this also prevents spurious cross-plugin collision warnings on the shared name). One caveat: integration resources are symlinked as whole directories, so an integration's `hooks.json` remains visible at `~/.claude/hooks/<config_key>/hooks.json`; it is inert there — registration always reads declarations from the source mount.

### Merge semantics and toggle-off tracking

`~/.claude/settings.json` is a writable copy that survives restarts ([ADR-022]), so naive injection would leave dead hooks behind when a plugin is disabled. The entrypoint mirrors the `.speedwave-managed-links` pattern with a side-manifest `~/.claude/.speedwave-managed-hooks` recording exactly the entries Speedwave injected. Each start:

1. Remove the previously injected entries from `settings.json` (matched structurally, key-order-insensitive) — hooks added by the user or team are untouched.
2. Collect `hooks.json` from currently enabled sources, validate shape, substitute `${SPEEDWAVE_HOOK_DIR}`, and **concatenate** per event (matching Claude Code's own cross-scope merge behavior for hooks[^1]), skipping any entry structurally identical to one already present for that event.
3. Write `settings.json`, then the manifest, atomically (`.tmp` + fsync + rename); delete the manifest when nothing is managed.

The identity dedupe in step 2 makes the two-file write crash-safe without ordering tricks: if a crash lands between the `settings.json` write and the manifest write (or the manifest is lost or corrupted), the next start re-injects nothing that is already registered and re-records it in a fresh manifest — an injected hook can never end up registered twice. Writing settings first (rather than manifest-first) matters for the toggle-change case: a stale manifest then still names the previous generation's entries, so they are removed on the next start instead of being orphaned.

A malformed `hooks.json` is skipped with a warning and never blocks the container start or other sources' hooks. An unparseable `settings.json` (or one whose `hooks` key is not an object) skips registration entirely and leaves the file untouched; a single event key holding a non-array is skipped with a warning while other events still register. No sentinel is added inside hook objects — Claude Code owns that schema. If a user hand-deletes an injected hook while its source stays enabled, the next start re-adds it; the supported way to remove a hook is disabling its plugin/integration.

### Validation

The entrypoint validates each declaration before injection: top-level object; event names matching `^[A-Z][A-Za-z]{2,63}$` (shape-checked, not pinned to a hardcoded event list — the valid vocabulary belongs to the pinned Claude Code version, not to Speedwave); each group an object with a `hooks` array; each hook `{type: "command", command: <string>}`. Other fields (`matcher`, `timeout`, future Claude Code additions) pass through untouched. A declaration failing validation is rejected whole.

## Security analysis

Hooks are arbitrary commands executed inside the claude container on Claude Code lifecycle events. Before this ADR that surface was documented ([ADR-051]) but not real; now it is real **by design**, so the mitigations must be stated:

- **Trust is anchored in the existing Ed25519 signature.** A plugin's `hooks.json` and hook scripts live in the signed tree; every read of the tree goes through `verify_plugin_signature_cached` ([ADR-051]), so a tampered declaration or script fails verification before the container ever mounts it. Core/integration declarations ship inside the Speedwave bundle itself. The signature covers the files, not runtime behavior: a signed command may still fetch and execute remote content at event time, so enabling a plugin is a trust decision about its author, not just about file integrity.
- **Enablement is the consent gate — against honest sources.** A hook registers only while its plugin/integration is enabled for the project — the same explicit, per-project toggle that already gates the source's tools and skills. Disabling removes the registration on the next start. This revocation binds sources that stop being mounted; it is not a defense against code already running inside the container: `~/.claude/settings.json` and the tracking manifest live in the writable claude-home volume, so in-container code (Claude itself, an enabled hook) could add hook entries directly — the same trust level as any in-container code. Structural-identity dedupe prevents duplicate registration even when the manifest is corrupted or deleted.
- **The execution context is the hardened claude container** — token-free, `cap_drop: ALL`, `no-new-privileges`, read-only root ([ADR-009]). A hook cannot reach service credentials. It **can** read `/workspace` and use the container's network like any other in-container code (Claude itself included), so a malicious _signed and enabled_ hook could exfiltrate workspace content — the trust decision sits at plugin signing and enablement, not at the hook mechanism.
- No new mount, port, or privilege is introduced; the mechanism only writes JSON into a file Claude Code already reads.

Surfacing registered hooks per plugin in the Desktop UI (informed consent at enable time) is deliberately left as follow-up work; today the signed tree plus the enable toggle carry the trust decision.

## Rejected alternatives

- **Native Claude Code plugin loader** (`.claude-plugin/plugin.json` + marketplace/`--plugin-dir`): registers hooks (and all other resources) through Claude Code itself and provides `${CLAUDE_PLUGIN_ROOT}`,[^2] but replaces Speedwave's entire resource model (user-scope symlinks, per-integration gating, managed-link cleanup). Worth revisiting if plugin distribution moves to a marketplace model; disproportionate today.
- **Registering hooks in `/workspace/.claude/settings.json`** (the manual workaround the `shared` README prescribed): pollutes the team's git tree ([ADR-022] rejected this for all bundled resources) and cannot follow per-project enable/disable.
- **Hardcoding first-party hooks in the bundled settings template**: validates nothing for plugins, and template keys merge only when absent from the on-disk copy, so updates would not propagate.

## Consequences

- Positive: plugin/integration/bundle hooks actually run; toggling a source off cleanly unregisters its hooks; user- and team-added hooks are never touched. The `shared` plugin can drop its manual-registration instruction once it ships a `hooks.json` and is re-signed — users who had followed the old README must remove the manual entry from `/workspace/.claude/settings.json`, or the hook fires twice per prompt (project- and user-scope hook arrays merge).
- Negative: a genuinely new execution surface (see Security analysis); one more generated state file (`.speedwave-managed-hooks`).
- Downgrade: an app downgrade runs an entrypoint that knows nothing about `.speedwave-managed-hooks`, so already-injected entries stay registered and are no longer managed — a subsequently disabled plugin keeps its hook entry while its `/speedwave/plugins/<slug>` mount disappears (the command then fails at event time). Cleanup is manual (`~/.claude/settings.json`) or by re-upgrading.
- A corrupted tracking manifest degrades, not breaks: still-enabled sources re-register (dedupe prevents duplicates) and are re-tracked; entries of sources disabled while the manifest was corrupt linger until removed manually or re-managed by an enable/disable cycle.
- Docs updated in this change: [ADR-022], [ADR-051], [ADR-015] carry update notes; `docs/architecture/bundled-resources.md`, `docs/architecture/security.md`, and `docs/guides/integrations.md` describe the real mechanism; the plugin contract (`.claude/rules/plugins.md`) names `hooks/hooks.json` and the placeholder.

## Footnotes

[^1]: Claude Code documentation, "Hooks reference" — hooks are configured in settings files (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy settings); hook arrays from multiple scopes merge. <https://code.claude.com/docs/en/hooks>

[^2]: Claude Code documentation, "Plugins" — native plugins register hooks via `hooks/hooks.json` with a `.claude-plugin/plugin.json` manifest and reference files via `${CLAUDE_PLUGIN_ROOT}`. <https://code.claude.com/docs/en/plugins>

[^3]: Node.js documentation, "Type stripping" — Node.js 24 runs TypeScript files with erasable types directly. <https://nodejs.org/docs/latest-v24.x/api/typescript.html>

[ADR-009]: ADR-009-per-project-isolation-preserved.md
[ADR-015]: ADR-015-plugin-system.md
[ADR-022]: ADR-022-bundled-claude-resources-and-project-coexistence.md
[ADR-051]: ADR-051-plugin-signature-runtime-verification.md

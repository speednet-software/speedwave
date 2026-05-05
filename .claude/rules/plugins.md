---
paths:
  - 'crates/speedwave-runtime/src/plugin.rs'
  - 'crates/speedwave-runtime/src/compose.rs'
  - 'crates/speedwave-runtime/src/signing.rs'
  - 'crates/speedwave-runtime/src/consts.rs'
  - 'desktop/src-tauri/src/plugin_cmd.rs'
  - 'desktop/src/src/app/models/plugin.ts'
---

# Plugin System Rules

Plugins live in a **separate repository** (`speedwave-plugins`, sibling to this repo). Anything in this repo that the plugin contract depends on is a public API — treat it that way.

## Where the contract is defined

CLAUDE.md has the full contract surface table (manifest schema, signature, blocklist, compose injection, env-var convention, mount paths, settings schema, Tauri commands, frontend models). Read it before changing any of those files. Do not duplicate the table here — it goes stale.

## Breaking-change rule

Before changing **any** contract element from CLAUDE.md's "Plugins" table:

1. Search the `speedwave-plugins` sibling repository for usage. If a plugin reads the field/calls the command/relies on the env var — it's load-bearing.
2. If breaking: coordinate the change. Either land a backward-compat shim in this repo first, or ship the plugin update first. Never break the contract in a single commit.
3. Manifest schema changes (`PluginManifest` in `plugin.rs`) require a `validate_manifest()` test for the new field's edge cases (missing, empty, malformed, oversize) **before** plugins start producing it.

If you cannot verify a change is safe — ask the user.

## Container constraints (non-negotiable)

Plugin containers inherit Speedwave's hardening (`cap_drop: ALL`, `no-new-privileges`, `read_only`, resource limits — see `.claude/rules/security.md`). When extending compose injection in `apply_plugins()` / `generate_plugin_service()`:

- Token mounts stay `:ro` unless the plugin's manifest opts in via `token_mount: rw` and there is an ADR justifying it (precedent: SharePoint OAuth refresh, ADR-009).
- Workspace mount is `/workspace:rw` — that is the only writable cross-boundary surface. Do not introduce a second one.
- The hub→worker channel is `WORKER_<SLUG_UPPER>_URL` — uppercase, underscore-separated. Discovery and naming both depend on this; do not introduce a parallel mechanism.

## Slug + service ID

- Slug regex `^[a-z][a-z0-9-]{0,63}$` is enforced by `validate_manifest()`. Mirror it in any new validation path; do not write a second regex.
- Built-in service IDs (`BUILT_IN_SERVICE_IDS` in `consts.rs`) are reserved — plugins cannot use them. When adding a new built-in service, also add it to the blocklist.

## Settings UI (Desktop)

Frontend `PluginStatusEntry` (`desktop/src/src/app/models/plugin.ts`) must match Tauri command return types in `plugin_cmd.rs`. If you add a field on one side and not the other, the type system won't catch it — the JSON deserialiser silently drops it. Update both in the same commit and add a frontend test that asserts the shape.

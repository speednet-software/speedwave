# ADR-081: Deliver plugin `settings_schema` values to workers via `/tokens/_settings.json`

**Status:** Accepted

**Date:** 2026-07-15

## Context

A plugin manifest may declare a `settings_schema` (JSON Schema Draft-7[^1]) describing non-secret configuration knobs — an API scope, a cache TTL, a default page size, an enum mode, a boolean toggle. Desktop already validated a saved payload against that schema (`plugin_cmd.rs::plugin_save_settings`), stored it per project in `user_config.plugin_settings`, and read it back into the settings form (`plugin_load_settings`).

The values never reached the worker container, though. Only two channels existed:

- **`/tokens`** — one file per `auth_fields` entry, written by `plugin_cmd.rs::save_plugin_credentials`.
- **env** — the static `extra_env` map from the manifest, injected by `plugin::generate_plugin_service`.

So `settings_schema` was a UI-only feature: a worker could not read the values a user configured. Plugins worked around it by smuggling ordinary config into `auth_fields`, where the credentials form supports only `text`/`password`/`textarea` — no enum, boolean, or number input — and every value is treated as a write-only secret. That conflates config with secrets and gives users a worse form for plain settings.

## Decision

The validated settings JSON is materialised to the worker as a file `/tokens/_settings.json`, alongside the `auth_fields` credential files, in the plugin's existing per-project token directory. There is no new mount and no new env channel.

- **Filename SSOT:** `consts::PLUGIN_SETTINGS_FILE` (`_settings.json`), mirrored in `mcp-servers/shared/src/security.ts` and pinned by the Rust cross-read test `plugin_settings_file_matches_mcp_shared_ts`.
- **Writer:** `plugin::write_settings_file` (runtime crate) writes `<data_dir>/tokens/<project>/<service_id>/_settings.json` owner-only (0o600, fsync-before-rename via `fs_perms`). Desktop's `plugin_save_settings` calls it after the schema validation and the config write succeed.
- **Reader:** `mcp-shared`'s `loadPluginSettings()` reads `<TOKENS_DIR>/_settings.json` and returns the parsed object, or `{}` when the file is absent (a plugin with no saved settings). A malformed (non-JSON) file is a hard error, matching the `loadToken` contract.
- **Reserved name:** `_settings.json` is rejected as an `auth_fields` key by `validate_manifest`, so a credential file can never collide with the settings file in the shared directory.

### Update timing

The file is (re)written on every save and **persists on disk** next to the credential files — exactly the lifecycle `auth_fields` files already follow. This gives two delivery points without any render-time plumbing:

- **At container start:** the token directory is bind-mounted `:ro`, so whatever settings file is on disk is present in the worker at start.
- **On settings change:** the host overwrites the file. Because the mount is a bind mount, the container sees the new bytes immediately[^2] — a worker that calls `loadPluginSettings()` per request observes the change **without a restart**. A worker that reads settings once at startup applies changes on its next start.

Materialising the file lazily on save (rather than regenerating it inside `render_compose`) keeps the mechanism symmetric with `auth_fields` and avoids threading `plugin_settings` through every `render_compose` caller. Migrating already-saved settings of installed plugins (writing the file for settings saved before this change) is out of scope: the file appears on the next save.

## Security analysis

- **Secrets stay in `auth_fields`.** `_settings.json` carries only non-secret config; a value with secret semantics belongs in an `auth_fields` file. This is a documented contract, not a machine-enforced one — the settings form has no `is_secret` concept, and the schema author is responsible for not putting secrets in settings.
- **No new attack surface.** The file lives inside the token directory that is already mounted `:ro` per the plugin volume profile enforced by `compose::SecurityCheck` (`VolumeCheckRules`). Adding a file inside an approved mount changes no mount spec, so the render-time security gate is unaffected. The worker cannot write it (`:ro`), and a compromised worker still sees only its own project/service directory.
- **Owner-only host perms.** The file is written 0o600 in a 0o700 directory tree, consistent with credential files.
- **Bounded size.** The payload is capped at `consts::PLUGIN_SETTINGS_MAX_BYTES` (64 KiB) at save time, the same cap that bounds the inline `user_config` copy.

## Consequences

- Plugins can read enum/boolean/number/string settings in the worker and change behavior without reinstalling the ZIP.
- The credentials form is freed to be secrets-only; `settings_schema` becomes the sanctioned home for configuration.
- One more file lives in the token directory; `remove_plugin`'s whole-directory wipe already removes it. `delete_plugin_credentials` intentionally leaves it (deleting credentials is not deleting configuration); a re-save overwrites it.

[^1]: JSON Schema Draft-7 core specification. https://json-schema.org/draft-07/json-schema-core.html

[^2]: OCI/`runc` bind mounts expose the host path directly into the container, so host-side writes are visible without a remount. https://github.com/opencontainers/runtime-spec/blob/main/config.md#mounts

# ADR-015: Plugin System

> **Status:** Accepted
> **Context:** Speedwave needs an extension mechanism that adds MCP integrations and Claude resources without weakening the per-project token isolation and container hardening of the built-in workers.

## Decision

Speedwave uses an open-core model: an MIT-licensed core plus signed plugins distributed as Ed25519-signed[^1] ZIP packages (only Speednet creates and signs them). Plugins are installed globally, enabled per project, and discovered dynamically by the MCP Hub at runtime. A plugin ZIP is source code (a `Containerfile` plus sources), not a pre-built image — Speedwave builds a local OCI image from the verified, signed source at install time, the same way built-in workers are built. The earlier unsigned-addon system (`addon.json`, `compose.addon.yml` fragment merge) is fully replaced.

There are two plugin types: an **MCP service plugin** has a `service_id` and a required `Containerfile`, and ships a containerized worker plus optional claude-resources; a **resource-only plugin** has neither and ships only skills/commands/agents/hooks.

## Why

- Supply-chain integrity: an Ed25519 signature is verified at install **and on every load** (compose render, image build, resource mount, UI listing, startup audit) — it is a runtime invariant, not just an install gate (ADR-051).
- Per-project control: the same global install can be enabled for one project and disabled for another, each with its own credential set.
- Hardening parity: generated plugin services match the exact shape of built-in workers — `cap_drop: ALL`, `no-new-privileges`, `read_only`, `tmpfs /tmp:noexec,nosuid`, isolated per-project network, CPU/memory caps, read-only `/tokens` mount.
- Zero hub trust: the hub holds no tokens; it discovers plugin tools purely from `ENABLED_SERVICES`.

## How it works

- **Manifest (`plugin.json`):** required `name`, `slug` (kebab-case, `^[a-z][a-z0-9-]{0,63}$`), `version`, `description`. MCP plugins also set `service_id` (must equal `slug`). Optional fields include `instructions` (Markdown, ≤ 16 KiB), `resources`, `token_mount` (read-only only), `auth_fields`, `settings_schema`, `speedwave_compat`, `extra_env`, `mem_limit` (≤ 16 GiB), `cpu_limit` (≤ 4), and `requires_integrations`. The `port` field is **deprecated and ignored** — see "single worker port" below.
- **Slug drives all paths/keys:** install dir `~/.speedwave/plugins/<slug>/`, config key `integrations.plugins.<slug>.enabled`, compose service `mcp-<slug>`, hub env `WORKER_<SLUG_UPPER>_URL` (hyphens → underscores), tokens `~/.speedwave/tokens/<project>/<slug>/`, and the `SPEEDWAVE_PLUGINS` list passed to the claude container.
- **Single worker port:** every worker (built-in and plugin) listens on `consts::PORT_WORKER` (3000). Each container has its own network namespace, so port reuse is safe and DNS disambiguates (ADR-038). The generated compose always sets `PORT=3000`; a manifest that still declares a different `port` is logged and the value discarded.
- **Mutable state outside the signed tree:** per-plugin mutable files (e.g. the `image_pending` build marker, the persisted host-bridge `bridge-token` — ADR-074) live under `~/.speedwave/plugin-state/<slug>/`, never inside `plugins/<slug>/`, so writing them never changes the content digest (ADR-051). Legacy in-tree markers are migrated on first load.
- **Install-time validation:** slug format; no collision with `consts::BUILT_IN_SERVICE_IDS` or a built-in compose service name; `slug == service_id`; `Containerfile` present for MCP plugins; `token_mount: read_write` rejected (the `:rw` mount is reserved for built-ins per ADR-009); no duplicate `service_id`; reserved/dangerous `extra_env` keys rejected via `consts::RESERVED_ENV_KEYS`; bounded resource limits; `settings_schema` must be a JSON object ≤ 64 KiB; Zip-Slip protection on extraction[^4]. The collision/env/mount/limit checks re-run at compose-render time.
- **auth_fields validation:** an optional per-field regex constraint, enforced anchored full-match in both the Desktop `<input pattern>` and host-side at save. The pattern is length-capped (`consts::PLUGIN_AUTH_FIELD_PATTERN_MAX_LEN`, 512) and must compile under the Rust `regex` crate (RE2 subset — no backreferences/look-around)[^2]. This is intentionally stricter than the ECMA-262 flavour allowed in `settings_schema`[^3] (ADR-015 rationale: credentials are single strict values, settings are structured payloads).
- **Sandbox:** a plugin manages only its own tokens; it cannot write into core-integration token directories (`provision_credentials` was removed for violating this). `requires_integrations` declares dependencies the user must configure; the Desktop dashboard shows their status with a link to the Integrations tab.
- **Hub discovery:** `service-list.ts` parses `ENABLED_SERVICES` (no imports from other hub modules); the registry sets `SERVICE_NAMES` dynamically and calls `tools/list` on each worker. Plugin services flow through the same unified discovery path as built-in workers, with no plugin-specific tool-policy override: a tool whose `_meta` omits `deferLoading` defaults to `deferLoading: true` (the hub-side default in `tool-discovery.ts`); a worker can opt a tool in by supplying `deferLoading: false` in its `_meta`.
- **Container resources:** `containers/entrypoint.sh` iterates `SPEEDWAVE_PLUGINS`, revalidates each slug, and symlinks each plugin's `commands`/`agents`/`skills`/`hooks` entry individually (never whole directories) into `~/.claude/` so user resources are never overwritten. Hooks additionally require registration: a plugin ships `claude-resources/hooks/hooks.json`, which the entrypoint merges into the settings `hooks` key with `${SPEEDWAVE_HOOK_DIR}` path substitution — symlinked hook files alone never execute ([ADR-078](ADR-078-claude-hook-registration.md)).
- **CLI / Desktop:** CLI exposes `plugin install|list|remove|enable|disable`. Desktop adds a file-picker install, status cards, per-project enable toggle, an auto-generated credentials form from `auth_fields`, per-project settings, and a restart banner.

## Service ID constants (current values — verify against `consts.rs`)

- `consts::BUILT_IN_SERVICES` (compose names, for SecurityCheck): `claude`, `mcp-hub`, `mcp-slack`, `mcp-sharepoint`, `mcp-redmine`, `mcp-gitlab`, `mcp-github`, `mcp-atlassian`, `mcp-office`, `mcp-playwright`, `mcp-context7`.
- `consts::BUILT_IN_SERVICE_IDS` (logical IDs, for plugin collision check): `slack`, `sharepoint`, `redmine`, `gitlab`, `github`, `atlassian`, `office`, `playwright`, `context7`, `os`, `oauth`, `ide`. (`oauth` and `ide` have no compose service — they are host-side workers/bridges reserved purely so a plugin slug cannot shadow them; ADR-060, ADR-063.)
- A guard test verifies no overlap between the two lists.

## Where it lives in code

- Manifest, install/remove/list, image build, service generation, token I/O — `crates/speedwave-runtime/src/plugin.rs`
- Ed25519 verification (embedded public key, debug-only `SPEEDWAVE_ALLOW_UNSIGNED` bypass compiled out of release builds) — `crates/speedwave-runtime/src/signing.rs`
- `apply_plugins()`, `generate_plugin_service()`, `WORKER_*_URL` injection, plugin SecurityChecks — `crates/speedwave-runtime/src/compose.rs`
- Service-ID constants and reserved env keys — `crates/speedwave-runtime/src/consts.rs`
- Per-project enable state and `plugin_settings` — `crates/speedwave-runtime/src/config.rs`
- CLI subcommands — `crates/speedwave-cli/src/main.rs`
- Container resource symlinking — `containers/entrypoint.sh`
- Hub discovery — `mcp-servers/hub/src/service-list.ts`, `tool-discovery.ts`, `tool-registry.ts`, `http-bridge.ts`, `auth-tokens.ts`
- Tauri commands (10) — `desktop/src-tauri/src/plugin_cmd.rs`
- Frontend models and forms — `desktop/src/src/app/models/plugin.ts`, `desktop/src/src/app/plugins/`

## Rejected alternatives

- **Third-party plugin signing:** rejected — only Speednet-signed plugins are accepted, so community contributions go through Speednet. This is the supply-chain trade-off for the runtime-signature invariant.
- **Compose fragment merge (the old addon system):** rejected — fragments could not be validated or hardened consistently; plugin services are now generated programmatically with the same shape as built-in workers.
- **`read_write` token mount for plugins:** rejected — the `:rw` mount is reserved for built-in OAuth refresh (ADR-009). A plugin that must persist data writes to the `:rw` `/workspace` mount instead.
- **One unified regex flavour for both `auth_fields` and `settings_schema`:** rejected — the two surfaces have different lifecycles and storage (per-field token files vs. one JSON settings blob), so they keep RE2-subset and ECMA-262 respectively.

## References

- [ADR-009](ADR-009-per-project-isolation-preserved.md) — per-project isolation and the reserved `:rw` token mount
- [ADR-038](ADR-038-single-internal-worker-port.md) — single internal worker port (3000)
- [ADR-051](ADR-051-plugin-signature-runtime-verification.md) — plugin signature as a runtime invariant
- [ADR-060](ADR-060-host-side-oauth-refresh-worker.md), [ADR-063](ADR-063-host-bridge-generic.md) — host-side workers/bridges reserved in `BUILT_IN_SERVICE_IDS`

[^1]: RFC 8032, Edwards-Curve Digital Signature Algorithm (EdDSA), specifies Ed25519: https://datatracker.ietf.org/doc/html/rfc8032

[^2]: The Rust `regex` crate's syntax and matching engine correspond to RE2 and exclude backreferences and arbitrary lookaround: https://docs.rs/regex/latest/regex/index.html

[^3]: JSON Schema's `pattern` keyword draws its regular-expression syntax from ECMA-262 (JavaScript): https://json-schema.org/understanding-json-schema/reference/regular_expressions

[^4]: Zip Slip is a directory-traversal vulnerability class in archive extraction, publicly disclosed by Snyk: https://security.snyk.io/research/zip-slip-vulnerability

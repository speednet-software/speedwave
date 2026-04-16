# ADR-015: Plugin System

## Decision

Speedwave uses an open-core model: MIT-licensed core with proprietary plugins distributed as Ed25519-signed ZIP packages via portal.speednet.pl. Only Speednet creates and signs plugins. Plugins are installed globally, enabled per-project, and discovered dynamically by the MCP Hub at runtime.

## Rationale

| Layer                                                                                   | License     | Distribution                    |
| --------------------------------------------------------------------------------------- | ----------- | ------------------------------- |
| Speedwave core (hub, slack, gitlab, redmine, sharepoint, mcp-os, runtime, CLI, Desktop) | MIT         | Public GitHub                   |
| Plugins (Presale CRM, etc.)                                                             | Proprietary | portal.speednet.pl (signed ZIP) |

This model is identical to GitLab CE/EE[^1] and Metabase[^2] — MIT core for maximum adoption, proprietary extensions for monetization.

The previous addon system (unsigned ZIPs, compose fragment merge, no per-project control) is fully replaced. The `addon.rs` module, `addon.json` manifest format, and `compose.addon.yml` fragment approach no longer exist.

---

## Plugin Types

| Type                     | Has `service_id`? | Has `Containerfile`? | What it provides                                     |
| ------------------------ | ----------------- | -------------------- | ---------------------------------------------------- |
| **MCP service plugin**   | Yes               | Yes (required)       | Containerized MCP worker + optional claude-resources |
| **Resource-only plugin** | No                | No                   | Skills, commands, agents, hooks only                 |

---

## Plugin ZIP Structure

A plugin ZIP is **source code, not a pre-built image**. It contains a `Containerfile` (OCI build specification[^10]) and application sources. At install time, Speedwave builds a local OCI image from these sources using `nerdctl build` — the same mechanism used for built-in MCP workers. The resulting container runs under `nerdctl compose` as part of the project's compose stack. No pre-built tarballs, no image registry pulls — the image is built locally from verified, signed source.

```
presale-1.2.0/
├── plugin.json              # PluginManifest (REQUIRED)
├── Containerfile            # OCI build specification (REQUIRED for MCP plugins)
├── src/                     # Application source code
├── package.json
├── package-lock.json        # REQUIRED alongside package.json
├── claude-resources/        # Optional
│   ├── skills/              # .md workflow definitions
│   ├── commands/            # Claude commands (e.g. /presale)
│   ├── agents/              # Specialized agents
│   └── hooks/               # Hook scripts
├── SIGNATURE                # Ed25519 detached signature (REQUIRED)
└── LICENSE
```

---

## Plugin Manifest (`plugin.json`)

### Example — MCP service plugin

```json
{
  "name": "Presale CRM",
  "slug": "presale",
  "service_id": "presale",
  "version": "1.2.0",
  "description": "CRM integration for pre-sales workflow automation",
  "port": 4010,
  "image_tag": null,
  "resources": ["skills", "commands", "agents"],
  "token_mount": { "mode": "read_only" },
  "auth_fields": [
    {
      "key": "api_key",
      "label": "API Key",
      "field_type": "password",
      "placeholder": "Enter your CRM API key",
      "is_secret": true
    },
    {
      "key": "workspace_url",
      "label": "Workspace URL",
      "field_type": "text",
      "placeholder": "https://your-company.crm.example.com",
      "is_secret": false
    }
  ],
  "settings_schema": null,
  "speedwave_compat": ">=2.0.0",
  "extra_env": null,
  "mem_limit": "128m"
}
```

### Example — Resource-only plugin

```json
{
  "name": "Custom Commands",
  "slug": "my-commands",
  "version": "0.1.0",
  "description": "Additional Claude commands for internal workflows",
  "resources": ["commands", "skills"]
}
```

### Field Reference

| Field                   | Type     | Required | Description                                                                           |
| ----------------------- | -------- | -------- | ------------------------------------------------------------------------------------- |
| `name`                  | string   | Yes      | Human-readable display name                                                           |
| `slug`                  | string   | Yes      | Unique identifier, `^[a-z][a-z0-9-]{0,63}$`                                           |
| `service_id`            | string?  | MCP only | Must equal `slug` when present                                                        |
| `version`               | string   | Yes      | Semantic version                                                                      |
| `description`           | string   | Yes      | Short description                                                                     |
| `port`                  | u16?     | MCP only | Container listening port                                                              |
| `image_tag`             | string?  | No       | Custom image tag (default: `version`)                                                 |
| `resources`             | string[] | No       | Subset of `["skills", "commands", "agents", "hooks"]`                                 |
| `token_mount`           | object   | No       | `{"mode": "read_only"}` (default) or `{"mode": "read_write", "justification": "..."}` |
| `auth_fields`           | object[] | No       | Credential field definitions for the Desktop UI                                       |
| `settings_schema`       | JSON?    | No       | JSON Schema for per-project plugin settings                                           |
| `speedwave_compat`      | string?  | No       | Required Speedwave version range                                                      |
| `extra_env`             | map?     | No       | Additional environment variables for the container                                    |
| `mem_limit`             | string?  | No       | Container memory limit (default: `128m`)                                              |
| `requires_integrations` | string[] | No       | Core integrations the plugin depends on (e.g. `["sharepoint"]`)                       |

### auth_fields entry

| Field         | Type   | Description                                                |
| ------------- | ------ | ---------------------------------------------------------- |
| `key`         | string | File name under `tokens/<project>/<slug>/`                 |
| `label`       | string | Label shown in Desktop UI                                  |
| `field_type`  | string | `"password"` or `"text"`                                   |
| `placeholder` | string | Placeholder text in the input field                        |
| `is_secret`   | bool   | If `true`, stored as a token file with `0o600` permissions |

---

## Identification: `slug` and `service_id`

Every plugin has a **slug** — a unique kebab-case identifier validated against `^[a-z][a-z0-9-]{0,63}$`.

MCP plugins additionally have a **service_id**. For MCP plugins, `slug == service_id` is enforced at install time.

The slug determines all paths and keys:

| Context           | Pattern                                 | Example                                 |
| ----------------- | --------------------------------------- | --------------------------------------- |
| Install directory | `~/.speedwave/plugins/<slug>/`          | `~/.speedwave/plugins/presale/`         |
| Config key        | `integrations.plugins.<slug>.enabled`   | `integrations.plugins.presale.enabled`  |
| Compose service   | `mcp-<slug>`                            | `mcp-presale`                           |
| Hub env           | `WORKER_{SLUG_UPPER}_URL`               | `WORKER_PRESALE_URL`                    |
| ENABLED_SERVICES  | `...,<slug>`                            | `...,presale`                           |
| Tokens            | `~/.speedwave/tokens/<project>/<slug>/` | `~/.speedwave/tokens/acme/presale/`     |
| Claude env        | `SPEEDWAVE_PLUGINS=<slug>,<slug>`       | `SPEEDWAVE_PLUGINS=presale,my-commands` |

---

## Disk Layout

```
~/.speedwave/
├── plugins/
│   ├── presale/                         # MCP plugin (keyed by slug)
│   │   ├── plugin.json
│   │   ├── Containerfile
│   │   ├── src/
│   │   ├── claude-resources/
│   │   ├── SIGNATURE
│   │   └── .image_pending               # deferred build marker (temporary)
│   └── my-commands/                     # Resource-only plugin
│       ├── plugin.json
│       ├── claude-resources/
│       └── SIGNATURE
├── tokens/
│   └── acme/
│       └── presale/                     # per-project credentials
│           ├── api_key                  # 0o600 permissions
│           └── workspace_url
└── config.json
    ├── projects[].integrations.plugins.presale.enabled = true
    └── projects[].plugin_settings.presale = { ... }
```

---

## Signature Verification

Every plugin ZIP must contain a `SIGNATURE` file — an Ed25519 detached signature created by Speednet's private key. The public key is embedded at compile time in `signing.rs`.

Verification runs at install time before any other processing:

1. Read `SIGNATURE` (base64-encoded, 64 bytes decoded)
2. Compute SHA-256 digest of all files except `SIGNATURE` (sorted by name for determinism)
3. Verify Ed25519 signature against the embedded Speednet public key[^3]
4. Reject if missing, tampered, or invalid

In debug builds only (`#[cfg(debug_assertions)]`), the `SPEEDWAVE_ALLOW_UNSIGNED` env var skips verification for development. No CLI flag exists — prevents accidental use in production.[^4]

---

## Install-Time Validation

Beyond signature verification:

1. **Slug format** — must match `^[a-z][a-z0-9-]{0,63}$`
2. **No built-in collision** — slug must not be in `BUILT_IN_SERVICE_IDS` (`slack`, `sharepoint`, `redmine`, `gitlab`, `os`)
3. **Slug == service_id** — enforced when `service_id` is present
4. **Containerfile required** — if `service_id` present, Containerfile must exist
5. **ReadWrite justification** — if token mount is `read_write`, `justification` must be non-empty
6. **No duplicate service_id** — no other installed plugin may have the same `service_id`
7. **Zip Slip protection** — all extracted paths validated to stay within the target directory[^5]

---

## Per-Project Enable/Disable

Plugins are installed globally but enabled per-project. Default state: **disabled**.

Enable/disable state follows the 3-layer config merge:

```
defaults (disabled) → repo .speedwave.json → user ~/.speedwave/config.json
```

Config structure:

```json
{
  "projects": [
    {
      "name": "acme",
      "integrations": {
        "plugins": {
          "presale": { "enabled": true }
        }
      },
      "plugin_settings": {
        "presale": { "workspace": "acme-corp" }
      }
    }
  ]
}
```

`set_plugin_enabled()` is separate from `set_service()` — a typo like `"gitlb"` is rejected because it doesn't match any installed plugin manifest.

---

## Compose Integration

Plugin services are generated programmatically by `apply_plugins()` in `compose.rs`. This follows the `apply_llm_config()` pattern — fully-resolved YAML via `format!()` inserted into `doc["services"]`. No compose fragment merge.

### Generated service (MCP plugin)

```yaml
mcp-presale:
  image: speedwave-mcp-presale:1.2.0
  container_name: speedwave_acme_mcp_presale
  read_only: true
  user: '1000:1000'
  cap_drop:
    - ALL
  security_opt:
    - no-new-privileges:true
  tmpfs:
    - /tmp:noexec,nosuid,size=512m
  volumes:
    - /home/user/.speedwave/tokens/acme/presale:/tokens:ro
    - /path/to/project:/workspace:rw
  environment:
    - PORT=4010
  networks:
    - speedwave_acme_network
  labels:
    speedwave.plugin-service: 'true'
  deploy:
    resources:
      limits:
        cpus: '2.0'
        memory: 128m
```

### Environment injection

For each enabled MCP plugin, `apply_plugins()` injects:

- `WORKER_{SID}_URL` into mcp-hub (e.g., `WORKER_PRESALE_URL=http://mcp-presale:4010`)
- Service ID into hub's `ENABLED_SERVICES` via `apply_integrations_filter()`
- `SPEEDWAVE_PLUGINS=presale,my-commands` into the claude container (all enabled plugin slugs)

### Image build

Plugin images are built lazily:

1. `install_plugin()` creates `.image_pending` marker in the plugin directory
2. If `ContainerRuntime` is available at install time, builds immediately
3. Otherwise, `render_compose()` calls `ensure_plugin_images(runtime, enabled_ids)` before compose generation — this builds pending installs (`.image_pending` marker) AND rebuilds any images missing from the container engine (e.g., after VM reset), scoped to plugins enabled for the current project
4. Build uses `prepare_build_context()` + `build_image()`, handling Lima/WSL path translation[^6]

---

## Security Model

### Inherited container hardening

All OWASP protections[^7] apply to plugin containers (same as built-in workers):

- `cap_drop: ALL`
- `no-new-privileges`
- `read_only` filesystem
- `tmpfs: /tmp:noexec,nosuid`
- Isolated network per project (ADR-009)
- Resource limits (CPU + memory)
- Per-service token isolation

### Plugin-specific SecurityChecks

Four additional checks in `SecurityCheck::run()`, targeting services labeled `speedwave.plugin-service: "true"`:

| Check                           | Rejects                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `check_plugin_no_privileged`    | `privileged: true`                                        |
| `check_plugin_no_host_network`  | `network_mode: host`                                      |
| `check_plugin_no_extra_volumes` | Any volume beyond the single `/tokens` mount              |
| `check_plugin_token_mount_mode` | Compose mount mode that doesn't match the signed manifest |

The token mount mode check is the critical integrity guarantee: the signed manifest declares `:ro` or `:rw`, and the SecurityCheck verifies the generated compose matches. A plugin cannot escalate from read-only to read-write without Speednet re-signing the manifest.

`SecurityCheck::run()` receives `&[PluginManifest]` from the caller — manifests are loaded once during compose generation and passed through. The security gate is mandatory before any `compose_up`.

### Token mount modes

Default: **read-only** (`:ro`). A plugin requiring write access (e.g., OAuth token refresh) must declare `read_write` with a non-empty justification — same exception model as SharePoint (ADR-009)[^8]:

```json
{ "token_mount": { "mode": "read_write", "justification": "OAuth token refresh" } }
```

### Service ID constants

| Constant               | Values                                                                          | Purpose                        |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `BUILT_IN_SERVICES`    | `claude`, `mcp-hub`, `mcp-slack`, `mcp-sharepoint`, `mcp-redmine`, `mcp-gitlab` | SecurityCheck (compose names)  |
| `BUILT_IN_SERVICE_IDS` | `slack`, `sharepoint`, `redmine`, `gitlab`, `os`                                | Plugin install collision check |

Guard test verifies no overlap between the two.

---

## Plugin Sandbox

Plugins operate within a strict sandbox — they cannot modify application settings or credentials of core integrations. This is analogous to browser extensions, which cannot alter browser settings.

**Principles:**

- A plugin manages only its own tokens at `~/.speedwave/tokens/<project>/<slug>/`
- `requires_integrations` declares dependencies on core integrations — the user must configure them in the Integrations tab
- The Desktop UI shows required integration status on the plugin dashboard with a link to the Integrations tab
- `provision_credentials` was removed — it violated the sandbox principle by allowing plugins to write into core integration token directories

---

## Hub Discovery

The MCP Hub discovers plugin tools dynamically via `service-list.ts` — a module with zero imports from other hub modules (reads only `process.env.ENABLED_SERVICES`).

### Import graph (no cycles)

```
service-list.ts    ← reads process.env only
    ↑                    ↑
hub-tool-policy.ts   tool-registry.ts
    ↑                    ↑
tool-discovery.ts    http-bridge.ts
                         ↑
                     auth-tokens.ts
```

### Flow

1. `service-list.ts` parses `ENABLED_SERVICES`, separates built-in from plugin service IDs
2. `tool-registry.ts` sets `SERVICE_NAMES` dynamically during `initializeRegistry()` (includes plugins)
3. Registry calls `tools/list` on each worker (including plugin workers)
4. `tool-discovery.ts`: for plugin services (`isPluginService()`), accepts ALL worker tools — no policy-gating
5. `hub-tool-policy.ts`: `getPluginToolPolicy()` returns a default policy (`deferLoading: false`) for all plugin tools
6. `http-bridge.ts`, `auth-tokens.ts` iterate `getAllServiceNames()` dynamically

---

## Credential Lifecycle

Credentials are stored as individual files at `~/.speedwave/tokens/<project>/<slug>/<key>` with `0o600` permissions.

| Function                                               | Purpose                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `configure_plugin_tokens(project, service_id, tokens)` | Write credential files                                                   |
| `get_plugin_token_status(project, manifest)`           | Returns `Configured`, `NotConfigured { missing }`, or `NoTokensRequired` |

Desktop UI auto-generates a credential form from `auth_fields` in the manifest. The form shows field labels, types (text/password), and placeholders. Saving credentials triggers a restart prompt.

---

## Claude Container Integration

`entrypoint.sh` symlinks plugin resources into Claude's `~/.claude/` directory:

```bash
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
```

Shell-level slug validation provides defense-in-depth. Individual file symlinks (not directory symlinks) prevent overwriting user's custom resources.

---

## CLI Interface

```bash
speedwave plugin install <path.zip>                  # Extract, verify, install
speedwave plugin list                                 # List with status
speedwave plugin remove <slug>                        # Uninstall
speedwave plugin enable <slug> --project <name>       # Enable per-project
speedwave plugin disable <slug> --project <name>      # Disable per-project
```

## Desktop Interface

| Feature            | Description                                                                  |
| ------------------ | ---------------------------------------------------------------------------- |
| Install            | File picker for ZIP upload                                                   |
| List               | Cards showing name, version, configured/not-configured badge                 |
| Enable/disable     | Toggle switch per plugin (requires configuration first)                      |
| Credentials        | Auto-generated form from `auth_fields`                                       |
| Settings           | Per-project plugin settings (save/load)                                      |
| Uninstall          | Removes plugin directory                                                     |
| Restart            | Banner prompts for container restart after changes                           |
| Integration status | Shows required integration status on dashboard with link to Integrations tab |

Tauri commands: `get_plugins`, `install_plugin`, `remove_plugin`, `set_plugin_enabled`, `save_plugin_credentials`, `delete_plugin_credentials`, `plugin_save_settings`, `plugin_load_settings`.

---

## Implementation Files

| File                                      | Change                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `crates/speedwave-runtime/src/plugin.rs`  | New — manifest, install, remove, list, build, generate service, tokens            |
| `crates/speedwave-runtime/src/signing.rs` | New — Ed25519 verification, dev-only signing                                      |
| `crates/speedwave-runtime/src/compose.rs` | `render_compose()` +runtime param, `apply_plugins()`, 4 SecurityChecks            |
| `crates/speedwave-runtime/src/config.rs`  | `plugins` field, `set_plugin_enabled()`, `is_plugin_enabled()`, `plugin_settings` |
| `crates/speedwave-runtime/src/consts.rs`  | `BUILT_IN_SERVICE_IDS` constant                                                   |
| `crates/speedwave-runtime/src/lib.rs`     | `pub mod plugin; pub mod signing;` (replaces `pub mod addon;`)                    |
| `crates/speedwave-runtime/Cargo.toml`     | +zip, ed25519-dalek, sha2, base64                                                 |
| `crates/speedwave-cli/src/main.rs`        | Plugin subcommands (install/list/remove/enable/disable)                           |
| `containers/entrypoint.sh`                | `SPEEDWAVE_PLUGINS` block (replaces `SPEEDWAVE_ADDONS`)                           |
| `mcp-servers/hub/src/service-list.ts`     | New — dynamic service list from env                                               |
| `mcp-servers/hub/src/hub-tool-policy.ts`  | `getPluginToolPolicy()`                                                           |
| `mcp-servers/hub/src/tool-discovery.ts`   | Plugin service branch (accept all tools)                                          |
| `mcp-servers/hub/src/tool-registry.ts`    | Dynamic `SERVICE_NAMES`                                                           |
| `mcp-servers/hub/src/http-bridge.ts`      | Dynamic `AllBridges`                                                              |
| `mcp-servers/hub/src/auth-tokens.ts`      | Iterate all services dynamically                                                  |
| `desktop/src-tauri/src/plugin_cmd.rs`     | New — 8 Tauri commands                                                            |

---

## Consequences

**Positive:**

- Supply-chain security via Ed25519 signatures — only Speednet-signed plugins accepted
- Per-project control with independent credential sets
- Hub discovers plugin tools automatically — no manual configuration
- Generated services match the exact shape of built-in workers (full hardening)
- Standard credential lifecycle with Desktop UI forms

**Negative:**

- No third-party plugin creation — community contributions require Speednet
- New dependencies (zip, ed25519-dalek, sha2, base64) increase compile time
- Breaking change from addons — existing addon installs require re-install as plugins

---

[^1]: [GitLab CE vs EE — open-core model](https://about.gitlab.com/install/ce-or-ee/)

[^2]: [Metabase open-source vs commercial](https://www.metabase.com/docs/latest/paid-features/overview)

[^3]: [Ed25519 — Edwards-curve Digital Signature Algorithm (RFC 8032)](https://datatracker.ietf.org/doc/html/rfc8032)

[^4]: [Rust conditional compilation — cfg(debug_assertions)](https://doc.rust-lang.org/reference/conditional-compilation.html#debug_assertions)

[^5]: [Zip Slip vulnerability — Snyk research](https://security.snyk.io/research/zip-slip-vulnerability)

[^6]: [Lima — Linux virtual machines on macOS](https://github.com/lima-vm/lima)

[^7]: [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)

[^8]: [Microsoft identity platform — OAuth 2.0 token refresh](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token)

[^10]: [OCI Image Format Specification — Containerfile](https://github.com/containers/common/blob/main/docs/Containerfile.5.md)

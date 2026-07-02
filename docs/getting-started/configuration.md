# Configuration

Speedwave uses a three-level config merge: defaults -> repo `.speedwave.json` -> user `~/.speedwave/config.json` (highest priority).

## Config File: `~/.speedwave/config.json`

The user-level config file stores project definitions, the active project, and IDE selection:

```json
{
  "projects": [
    {
      "name": "acme-corp",
      "dir": "/Users/user/projects/acme-corp",
      "claude": {
        "env": {
          "ANTHROPIC_MODEL": "claude-opus-4-7",
          "CUSTOM_VAR": "value"
        },
        "llm": {
          "provider": "anthropic",
          "model": null,
          "base_url": null,
          "context_tokens": null
        }
      },
      "integrations": {
        "slack": { "enabled": true },
        "sharepoint": { "enabled": false },
        "redmine": { "enabled": false },
        "gitlab": { "enabled": true },
        "github": { "enabled": false },
        "atlassian": { "enabled": false },
        "office": { "enabled": false },
        "playwright": { "enabled": false },
        "context7": { "enabled": false },
        "os": {
          "reminders": { "enabled": true },
          "calendar": { "enabled": true },
          "mail": { "enabled": false },
          "notes": { "enabled": false }
        }
      }
    }
  ],
  "active_project": "acme-corp",
  "selected_ide": null,
  "ui": { "beta_enabled": false }
}
```

#### `claude.llm` schema v3 (ADR-073)

The example above shows the legacy flat `llm` shape, which is still read and auto-migrated. Since [ADR-073](../adr/ADR-073-embedded-per-project-speedwave-proxy.md) the Settings UI writes a provider **list** with an `active` selection and `schema_version: 3` (v3 adds provenance quarantine — a foreign model under an Anthropic entry is cleared on migration). A typical block (with the equivalent flat fields the app also writes for one-release downgrade) looks like:

```json
"llm": {
  "schema_version": 3,
  "providers": [
    { "id": "anthropic", "kind": "anthropic_oauth", "model": null },
    {
      "id": "local",
      "kind": "local",
      "base_url": "http://host.docker.internal:11434",
      "model": "qwen3",
      "has_api_key": false
    },
    { "id": "openrouter", "kind": "open_router", "has_api_key": true }
  ],
  "active": { "provider_id": "local", "model": "qwen3" },
  "proxy_enabled": true,
  "provider": "local",
  "model": "qwen3",
  "base_url": "http://host.docker.internal:11434",
  "context_tokens": null
}
```

Key VALUES never appear here — only the `has_api_key` presence flag; the secret lives at `~/.speedwave/tokens/<project>/llm/<provider_id>_api_key`. The `active` block is the routing source of truth; the trailing flat fields are the auto-written downgrade mirror.

### `ui.beta_enabled`

Optional, top-level, user-only (a checked-in `.speedwave.json` cannot set it). When `true`, the Desktop app reveals hidden / work-in-progress UI surfaces and shows a small `BETA` badge in the corner. Default is off. Toggle it from the tray-icon menu → **Beta features** (the item appears once initial setup is complete), or edit this field directly. This is a UI surface gate only — it is **not** a security control and does not unlock any privileged capability. See [ADR-058](../adr/ADR-058-beta-features-toggle.md).

## Per-Project: `.speedwave.json`

A `.speedwave.json` file in the project repository root provides repo-level defaults. These are overridden by the user-level config:

- `claude.env` — environment variables passed to Claude Code inside the container
- `claude.llm` — LLM provider configuration. Since [ADR-073](../adr/ADR-073-embedded-per-project-speedwave-proxy.md) the schema is a provider **list** (`providers[]` with `id`, `kind`, optional `base_url`, `has_api_key`) plus an `active` selection (`provider_id` + `model`) and `schema_version: 3`; provider kinds are `anthropic_oauth`, `anthropic_api_key`, `local`, `open_router`. The legacy flat fields (`provider`, `model`, `base_url`, `context_tokens`) are still read (auto-migrated on resolve) and still written for one release (downgrade story). `proxy_enabled: false` is the temporary kill-switch restoring pre-proxy direct injection (removal in N+2). See [ADR-041](../adr/ADR-041-local-llm-model-discovery.md) for model discovery. **`provider` / `base_url` / `providers` / `active` / `proxy_enabled` are not merged from the repo file**: only the user config may set them; the repo may suggest `model` only.
- `integrations` — enable/disable individual integrations per project.

### `claude.llm.context_tokens`

Optional. When set, this is the persisted context window (in tokens) the chat footer uses to render the `used / max` ratio before any stream-level value lands. Settings populates it automatically from the SSOT (Anthropic — `defaults::ANTHROPIC_MODELS`) or from the live discovery probe (local providers). Clearing it (`null`) lets the chat footer fall back through `live stream → SSOT lookup → previous in-memory value → 200_000`. Zero is rejected at save time to prevent a divide-by-zero in the percentage bar.

### Model discovery (local providers)

When the selected provider is local (`local`, or legacy `ollama` / `lmstudio` / `llamacpp`), the Settings → LLM Provider panel probes the server for the list of available models when you click **Discover models**. Discovery is button-driven only: the panel never probes automatically, not on open, not on provider switch, and not when a `base_url` is configured. A successful probe surfaces both the model ids and per-model context windows where the server advertises them:

- **Local providers (`local`, plus legacy `ollama` / `lmstudio` / `llamacpp`)** — a single unified `discover_local` path: one `GET /v1/models` request returns the id list, and the per-model context window is read **inline** from each entry's metadata, trying `meta.n_ctx_train` (llama.cpp / vLLM / Unsloth shape) first, then falling back to `max_context_length` (LM Studio 0.4.1+ shape). The legacy provider names route through this same path for two release cycles; the obsolete Ollama `GET /api/tags` listing is no longer used.
- **Ollama context fallback** — for entries that expose no inline context window, a single `POST /api/show` **sanity** call is made on the first such entry: a `200` response means the server implements `/api/show`, so the remaining missing entries are fanned out (bounded concurrency) to read their context windows; a `404`/error means the server does not implement it and the remaining entries stay `undefined`. This bounds the worst-case call count for unknown servers instead of issuing one request per model unconditionally.
- **Anthropic Messages probe** — alongside the model list, a `POST /v1/messages` 1-token sanity probe runs to detect whether the local server speaks the Anthropic Messages endpoint.
- **Anthropic** — not probed; the catalog comes from the backend SSOT (`speedwave_runtime::defaults::ANTHROPIC_MODELS`, surfaced via the `list_anthropic_models` Tauri command).
- The probe returns `Vec<DiscoveredModel>` (`{ id, context_tokens? }`); a missing context window stays `undefined` and the chat fallback chain takes over rather than guessing.
- The model field is a dropdown, shown only after a successful **Discover models** run or when a model was already saved earlier; there is no free-text model input, and **Save** stays disabled until a model is picked.
- A failed probe renders an inline error under the button instead: authentication failed (check the API key), the server is reachable but returned an HTTP error or an unexpected non-JSON response, or the server is not reachable at the configured URL.
- Clicking **Discover models** again re-probes on demand (useful after pulling a new model).
- The same URL validator runs on Save, rejecting `http://169.254.169.254`, `file://`, `http://user:pass@…`, URLs with query strings/fragments, etc. See [ADR-041](../adr/ADR-041-local-llm-model-discovery.md) for the full SSRF policy.

## Environment Variables

Environment variables defined in `claude.env` are passed directly to Claude Code inside the container:

- `ANTHROPIC_MODEL` — set a specific Claude model. Two paths populate it:
  1. `claude.env.ANTHROPIC_MODEL` (highest precedence; matches v1 behaviour and works for any provider).
  2. `claude.llm.model` for the `anthropic` provider — the runtime injects it as `ANTHROPIC_MODEL` at compose-render time.
     Empty/whitespace falls through to Claude Code's built-in default.
     > **Repo override caveat:** `ANTHROPIC_MODEL` is the one Anthropic env key a checked-in repo `.speedwave.json` may set (the deny-list strips `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`CUSTOM_HEADERS`). A cloned repo can therefore pin a more expensive model and bill it against your key. Review a repo's `claude.env` before opening it, or set the model in user config (`~/.speedwave/config.json`), which always wins.
- Custom variables can be used by MCP servers or Claude Code configuration
- Variables are injected at container start via the compose template

## `SPEEDWAVE_DATA_DIR` — Data Directory Override

The `SPEEDWAVE_DATA_DIR` environment variable overrides the default `~/.speedwave/` data directory. Everything Speedwave stores — config, Lima VM, compose files, tokens, plugins, MCP OS worker files — lives under this directory.

| Setting          | Value                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| **Default**      | `~/.speedwave/`                                                                                      |
| **`make dev`**   | `~/.speedwave-dev/`                                                                                  |
| **Requirements** | Must be an absolute path. Basename must match `^[a-z][a-z0-9-]{0,63}$` after stripping leading dots. |

The Makefile sets `SPEEDWAVE_DATA_DIR=$(HOME)/.speedwave-dev` by default, so all dev targets (`make dev`, `make test`, `make build`, etc.) use a separate data directory automatically. This means developers can run `make dev` alongside an installed production Speedwave app without conflicts.

### What is isolated

Each `SPEEDWAVE_DATA_DIR` value creates a fully independent Speedwave instance:

- **Lima VM** — VM name derived from basename (`.speedwave-dev` -> `speedwave-dev`)
- **Compose projects** — project prefix derived from the same basename
- **Data files** — config, logs, setup markers, cached downloads
- **Tokens** — per-project service credentials (`<data_dir>/tokens/<project>/`)
- **Claude home** — per-project Claude Code credentials, sessions, and
  onboarding state (`<data_dir>/claude-home/<project>/`). Logging in to Claude
  in one instance does **not** authenticate the other.
- **Plugins** — installed plugins (`<data_dir>/plugins/<slug>/`)
- **MCP OS worker** — PID file, auth token, port file, log file

### Example: production and dev side by side

```bash
# Terminal 1 — production app (uses default ~/.speedwave/)
open /Applications/Speedwave.app

# Terminal 2 — dev build (uses ~/.speedwave-dev/ via Makefile)
make dev
```

Both instances have their own Lima VM, containers, and data. They do not interfere with each other.

### Custom data directory

To use a custom directory (e.g. for CI or testing):

```bash
export SPEEDWAVE_DATA_DIR=/opt/speedwave-ci
make test
```

The variable is resolved once per process and cannot change at runtime.

## See Also

- [ADR-011: User Configuration Passed to Claude Code](../adr/ADR-011-user-configuration-passed-to-claude-code.md)
- [ADR-031: SPEEDWAVE_DATA_DIR Environment Variable for Instance Isolation](../adr/ADR-031-data-dir-env-var-for-instance-isolation.md)

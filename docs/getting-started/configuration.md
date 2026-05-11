# Configuration

Speedwave uses a three-level config merge: defaults -> repo `.speedwave.json` -> user `~/.speedwave/config.json` (highest priority).

## Config File: `~/.speedwave/config.json`

The user-level config file stores project definitions, the active project, IDE selection, and log level:

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
        "os": {
          "reminders": { "enabled": true },
          "calendar": { "enabled": true },
          "mail": { "enabled": false },
          "notes": { "enabled": false }
        },
        "hostExec": {
          "enabled": false,
          "commands": [
            {
              "name": "gradle_test",
              "exec": "./gradlew",
              "args": ["test"],
              "confirm": "ask"
            }
          ]
        }
      }
    }
  ],
  "active_project": "acme-corp",
  "selected_ide": null,
  "log_level": null
}
```

## Per-Project: `.speedwave.json`

A `.speedwave.json` file in the project repository root provides repo-level defaults. These are overridden by the user-level config:

- `claude.env` — environment variables passed to Claude Code inside the container
- `claude.llm` — LLM provider (`anthropic`, `ollama`, `lmstudio`, `llamacpp`), model name, optional base URL, and optional `context_tokens`. See [ADR-040](../adr/ADR-040-remove-litellm-direct-provider-injection.md) for provider details and [ADR-041](../adr/ADR-041-local-llm-model-discovery.md) for model auto-discovery. **`provider` / `base_url` are not merged from the repo file** — only the user config may set them.
- `integrations` — enable/disable individual integrations per project. **`integrations.hostExec` is the exception: it is ignored in the repo file** — a Host Exec command whitelist is user-config-only (see [`integrations.hostExec`](#integrationshostexec--host-exec-whitelist) below and [ADR-054](../adr/ADR-054-host-exec-worker.md)).

### `claude.llm.context_tokens`

Optional. When set, this is the persisted context window (in tokens) the chat footer uses to render the `used / max` ratio before any stream-level value lands. Settings populates it automatically from the SSOT (Anthropic — `defaults::ANTHROPIC_MODELS`) or from the live discovery probe (local providers). Clearing it (`null`) lets the chat footer fall back through `live stream → SSOT lookup → previous in-memory value → 200_000`. Zero is rejected at save time to prevent a divide-by-zero in the percentage bar.

### Model auto-discovery (local providers)

When the selected provider is local (`ollama`, `lmstudio`, `llamacpp`) and a `base_url` is configured (or the provider default is reachable), the Settings → LLM Provider panel probes the server for the list of available models and surfaces both the ids and per-model context windows where the server advertises them:

- **Ollama** — `GET /api/tags` for the id list, then a parallel fan-out of `POST /api/show` per model to read `model_info.<arch>.context_length`. Models without a recognised arch key fall back to the first numeric `*.context_length` field.
- **LM Studio** — `GET /api/v0/models` (the extended listing) which carries `max_context_length` per entry. The OpenAI-compat `/v1/models` fallback was removed; users on builds that pre-date the extended API will see an empty list.
- **llama.cpp** — `GET /v1/models` reads `meta.n_ctx_train` per entry (the runtime `--ctx-size` flag may constrain it lower; we report the trained value as the best-available approximation).
- **Anthropic** — not probed; the catalog comes from the backend SSOT (`speedwave_runtime::defaults::ANTHROPIC_MODELS`, surfaced via the `list_anthropic_models` Tauri command).
- The probe returns `Vec<DiscoveredModel>` (`{ id, context_tokens? }`); a missing context window stays `undefined` and the chat fallback chain takes over rather than guessing.
- If the server is offline or returns an unexpected response, the UI gracefully falls back to a free-text input so you can pre-configure the app before starting your server.
- A Refresh button re-probes on demand (useful after pulling a new model).
- The same URL validator runs on Save, rejecting `http://169.254.169.254`, `file://`, `http://user:pass@…`, URLs with query strings/fragments, etc. See [ADR-041](../adr/ADR-041-local-llm-model-discovery.md) for the full SSRF policy.

### `integrations.hostExec` — Host Exec whitelist

`integrations.hostExec` configures **Host Exec** (`host_exec`) for the project — the per-project host-side worker that runs a user-defined whitelist of project-toolchain commands on the host machine. It is **user-config-only**: a `hostExec` block in the repo `.speedwave.json` is **ignored** (an executable command whitelist is a security-class field, like `claude.llm.provider`/`base_url`; see [ADR-054](../adr/ADR-054-host-exec-worker.md)). Edit it via **Service integrations → Host Exec** in the Desktop app — enabling it pops a blocking danger modal — or by hand in `~/.speedwave/config.json`.

| Field      | Type | Meaning |
| ---------- | ---- | ------- |
| `enabled`  | `boolean` | Whether Host Exec is on for this project. Default `false`. With `false`, or with an empty `commands`, Claude can run nothing. |
| `commands` | array of recipe objects | The whitelist. Default `[]`. |

Each recipe object:

| Field      | Type | Meaning |
| ---------- | ---- | ------- |
| `name`     | `string` | `^[a-z][a-z0-9_]{0,63}$` (snake_case), unique. Claude calls it as `host_exec.<camelCase(name)>()`. |
| `exec`     | `string` | The executable. Relative (`./gradlew`, `npm`, `docker`) resolves against the project dir or PATH; absolute is allowed (flagged in the UI). Rejected: shell/eval launchers (`bash`, `sh`, `eval`, `xargs`, …); `..`, NUL, `=`, newlines. |
| `args`     | array of strings | Fixed arguments — literals plus `{name}` parameter tokens (each substitution = one argv element). A literal sub-command is fine (`["run", "build"]`); a bare `{param}` element after a meta-tool (`npm`, `make`, `node`, …) is rejected. |
| `cwdSub`   | `string` (optional) | Subdirectory to run in (monorepos) — relative, no `..`, no symlink escape. |
| `params`   | array (optional) | `{ name, pattern, maxLen? }` — `name` snake_case unique; `pattern` a regex the supplied value must fully match; `maxLen` ≤ 65536. |
| `env`      | object (optional) | Literal env vars for the recipe. Reserved names (`PATH`, `LD_*`, `NODE_OPTIONS`, …) rejected. **Don't put secrets here** — use a repo `.env`; the snapshot is `0600` and the host log redacts these values, but a `.env` is still the right place. |
| `confirm`  | `"ask"` \| `"session"` \| `"always"` | When the per-call confirmation prompt shows. Default `"ask"`. `"always"` is rejected for recipes that look state-changing (DB clients; `docker compose up/down/exec/rm/prune`; migration tools). |

The runtime serialises these objects camelCase (`cwdSub`, `maxLen`) in both `~/.speedwave/config.json` and the worker snapshot (`~/.speedwave/host-exec/<project>/config.json`). Invalid recipes are rejected by `host_exec::validate_host_exec_config` on save (the Desktop command surfaces a readable error). See [Integrations → Host Exec](../guides/integrations.md#host-exec) for the full guide and [Security Model → Host Exec](../architecture/security.md#host-exec--deliberate-scoped-weakening) for the threat analysis.

## Environment Variables

Environment variables defined in `claude.env` are passed directly to Claude Code inside the container:

- `ANTHROPIC_MODEL` — set a specific Claude model. Two paths populate it:
  1. `claude.env.ANTHROPIC_MODEL` (highest precedence; matches v1 behaviour and works for any provider).
  2. `claude.llm.model` for the `anthropic` provider — the runtime injects it as `ANTHROPIC_MODEL` at compose-render time.
     Empty/whitespace falls through to Claude Code's built-in default.
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
- [ADR-054: Host Exec — Host-Side Per-Project Toolchain Worker](../adr/ADR-054-host-exec-worker.md)
- [Integrations → Host Exec](../guides/integrations.md#host-exec)

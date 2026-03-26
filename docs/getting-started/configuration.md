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
          "ANTHROPIC_MODEL": "claude-opus-4-6",
          "CUSTOM_VAR": "value"
        },
        "llm": {
          "provider": "anthropic",
          "model": "claude-sonnet-4-6",
          "base_url": null,
          "api_key_env": null
        }
      },
      "integrations": {
        "slack": { "enabled": true },
        "sharepoint": { "enabled": false },
        "redmine": { "enabled": false },
        "gitlab": { "enabled": true },
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
  "log_level": null
}
```

## Per-Project: `.speedwave.json`

A `.speedwave.json` file in the project repository root provides repo-level defaults. These are overridden by the user-level config:

- `claude.env` — environment variables passed to Claude Code inside the container
- `claude.llm` — LLM provider, model, base URL, and API key env var name
- `integrations` — enable/disable individual integrations per project

## Environment Variables

Environment variables defined in `claude.env` are passed directly to Claude Code inside the container:

- `ANTHROPIC_MODEL` — set a specific Claude model (not set by default — Claude Code uses its own model selection)
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

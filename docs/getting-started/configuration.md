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

- `ANTHROPIC_MODEL` — override the default Claude model
- Custom variables can be used by MCP servers or Claude Code configuration
- Variables are injected at container start via the compose template

## See Also

- [ADR-011: User Configuration Passed to Claude Code](../adr/ADR-011-user-configuration-passed-to-claude-code.md)

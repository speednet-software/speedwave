# Integrations

Speedwave connects Claude Code with external services through MCP (Model Context Protocol) servers.

## Available Integrations

| Integration | Service        | Container                            | Token Path                                  |
| ----------- | -------------- | ------------------------------------ | ------------------------------------------- |
| Slack       | Messaging      | `speedwave_<project>_mcp_slack`      | `~/.speedwave/tokens/<project>/slack/`      |
| SharePoint  | Documents      | `speedwave_<project>_mcp_sharepoint` | `~/.speedwave/tokens/<project>/sharepoint/` |
| GitLab      | Code hosting   | `speedwave_<project>_mcp_gitlab`     | `~/.speedwave/tokens/<project>/gitlab/`     |
| Redmine     | Issue tracking | `speedwave_<project>_mcp_redmine`    | `~/.speedwave/tokens/<project>/redmine/`    |
| OS          | Host services  | mcp-os (host process)                | N/A (runs on host)                          |

OS sub-integrations (Reminders, Calendar, Mail, Notes) run via mcp-os on the host — they access native APIs directly (EventKit on macOS, CalDAV/zbus on Linux, WinRT/MAPI on Windows).

## MCP Hub Architecture

The MCP Hub (`speedwave_<project>_mcp_hub`, port 4000) is the **only** MCP server Claude sees:

- **`search_tools`** — discovers available tools across all enabled integrations, including OS tools
- **`execute_code`** — routes tool execution requests to the appropriate worker (e.g., `os.listReminders()`, `os.createEvent()`)
- **HTTP bridge** — communicates with mcp-os on the host via `WORKER_OS_URL`

The Hub has **zero tokens** — it acts as a router. Each worker container mounts only its own service credentials.

## Adding New Integrations

Speedwave supports extending integrations via the plugin system:

- `speedwave plugin install <path.zip>` verifies the Ed25519 signature and extracts the plugin to `~/.speedwave/plugins/<slug>/`
- Each plugin contains a `plugin.json` manifest, an optional MCP service (`src/`, `Containerfile`), and optional claude-resources (`skills/`, `commands/`)
- `compose.rs` generates plugin service containers via `apply_plugins()`
- Plugin services get injected `WORKER_<PLUGIN>_URL` in the hub environment

See [ADR-015](../adr/ADR-015-plugin-system.md) for the plugin system design.

Plugins that declare `requires_integrations` (e.g. `["sharepoint"]`) display the required integration status on the plugin dashboard. The Desktop UI indicates whether required integrations are configured, linking to the Integrations tab when they are not.

## See Also

- [ADR-010: mcp-os as Host Process Per Platform](../adr/ADR-010-mcp-os-as-host-process-per-platform.md)
- [ADR-013: mcp-os as Host Process — Implementation Details](../adr/ADR-013-mcp-os-as-host-process-implementation.md)
- [ADR-015: Plugin System](../adr/ADR-015-plugin-system.md)

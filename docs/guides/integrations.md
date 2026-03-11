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

Speedwave supports extending integrations via the addon system:

- `speedwave addon install <path.zip>` extracts the addon to `~/.speedwave/addons/<name>/`
- Each addon contains an `addon.json` manifest and optional `compose.addon.yml`
- `compose.rs` merges addon compose fragments into the main compose document
- Addon services get injected `WORKER_<ADDON>_URL` in the hub environment

See [ADR-015](../adr/ADR-015-addon-system-open-core-model.md) for the full open-core model design.

## See Also

- [ADR-010: mcp-os as Host Process Per Platform](../adr/ADR-010-mcp-os-as-host-process-per-platform.md)
- [ADR-013: mcp-os as Host Process — Implementation Details](../adr/ADR-013-mcp-os-as-host-process-implementation.md)
- [ADR-015: Addon System — Open-Core Model](../adr/ADR-015-addon-system-open-core-model.md)

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

#### macOS Permission Check

When you enable an OS integration on macOS, Speedwave checks and requests the required system permission before enabling the integration:

- **Reminders / Calendar** — triggers the macOS Privacy & Security permission dialog (TCC). The system asks whether Speedwave is allowed to access your Reminders or Calendar data.
- **Notes / Mail** — triggers the macOS Automation permission dialog. The system asks whether Speedwave is allowed to control the Notes or Mail application.

If you deny the permission, the toggle reverts and an error message explains how to grant access. To grant permission after denial, go to **System Settings > Privacy & Security > [Reminders | Calendars | Automation]**, find Speedwave in the list, and enable it.

The Reminders integration supports tags stored as `[#tag]` markers in the notes field. Use `tags: ["idea", "work"]` in `createReminder` to assign tags; `listReminders` and `getReminder` extract tags from notes and return them separately in the `tags` field. Apple's EventKit API does not expose a dedicated tags property, so tags are persisted in notes using the `[#tag]` convention.

### Credential Requirements

Each MCP integration requires specific credentials to function. Fields marked as optional do not block the "Configured" status — the integration works without them.

| Integration | Required Fields                                                 | Optional Fields                                      |
| ----------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Slack       | `bot_token`, `user_token`                                       | —                                                    |
| SharePoint  | `client_id`, `tenant_id`, `site_id`, `base_path` + OAuth tokens | —                                                    |
| GitLab      | `token`, `host_url`                                             | —                                                    |
| Redmine     | `api_key`, `host_url`                                           | `project_id` (scope operations to a default project) |

### Redmine Configuration Wizard

The Desktop app provides an auto-configuration wizard for Redmine:

1. **Enter credentials** — provide `host_url` and `api_key`, then click Validate. The Desktop app verifies the credentials against the Redmine API (`GET /users/current.json`).
2. **Select project and mappings** — on success, the wizard fetches available projects, statuses, trackers, priorities, and activities from the Redmine API. Select a project from the dropdown (or "All projects" to work with all projects), then confirm ID mappings for each category. Mappings are auto-matched by comparing English names (e.g., a Redmine status named "In Progress" auto-matches the `status_in_progress` mapping key). Non-English Redmine instances require manual selection from the dropdowns.
3. **Save** — credentials and mappings are saved. Restart containers to apply.

The wizard shows up to 100 projects. For Redmine instances with more projects, find the project slug in the Redmine web UI (visible in the project URL) and set `project_id` directly in `~/.speedwave/tokens/<project>/redmine/config.json`.

Existing configurations with `project_name` in `config.json` continue to work — the MCP server reads it if present and auto-fetches it from the API when absent. Manual `config.json` editing remains supported for power users.

**Troubleshooting:** Corporate environments with custom certificate authorities or HTTP proxies may see TLS or connection errors during credential validation. This is a known limitation shared with SharePoint OAuth — the Desktop app uses bundled CA roots (`rustls-tls`), not the OS certificate store, and does not auto-detect system proxy settings.

## MCP Hub Architecture

The MCP Hub (`speedwave_<project>_mcp_hub`, port 4000) is the **only** MCP server Claude sees:

- **`search_tools`** — discovers available tools across all enabled integrations, including OS tools
- **`execute_code`** — routes tool execution requests to the appropriate worker (e.g., `os.listReminders()`, `os.createEvent()`)
- **HTTP bridge** — communicates with mcp-os on the host via `WORKER_OS_URL`

The Hub has **zero tokens** — it acts as a router. Each worker container mounts only its own service credentials.

## Workspace Mount

MCP service containers (both built-in SharePoint and plugins) mount the project directory as `/workspace:rw`:

```
{project_dir}:/workspace:rw
```

This allows MCP workers and Claude to share files through identical paths — `/workspace/...` is valid for both. No path translation needed and no separate context directory is required.

The path validator blocks access to sensitive paths within the workspace: `.git/`, `.env`, and `.speedwave/`. These entries are enforced by a denylist in `path-validator.ts`, ensuring that MCP workers cannot read or write protected files even though the full project directory is mounted.

## Adding New Integrations

Speedwave supports extending integrations via the plugin system:

- `speedwave plugin install <path.zip>` verifies the Ed25519 signature and extracts the plugin to `~/.speedwave/plugins/<slug>/`
- Each plugin contains a `plugin.json` manifest, an optional MCP service (`src/`, `Containerfile`), and optional claude-resources (`skills/`, `commands/`)
- `compose.rs` generates plugin service containers via `apply_plugins()`
- Plugin services get injected `WORKER_<PLUGIN>_URL` in the hub environment

See [ADR-015](../adr/ADR-015-plugin-system.md) for the plugin system design.

When a bundle update triggers image rebuilds, container restart operations (including plugin containers) automatically wait for builds to complete before proceeding.

Plugins that declare `requires_integrations` (e.g. `["sharepoint"]`) display the required integration status on the plugin dashboard. The Desktop UI indicates whether required integrations are configured, linking to the Integrations tab when they are not.

## See Also

- [ADR-010: mcp-os as Host Process Per Platform](../adr/ADR-010-mcp-os-as-host-process-per-platform.md)
- [ADR-013: mcp-os as Host Process — Implementation Details](../adr/ADR-013-mcp-os-as-host-process-implementation.md)
- [ADR-015: Plugin System](../adr/ADR-015-plugin-system.md)

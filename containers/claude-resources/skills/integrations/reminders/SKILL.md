---
name: reminders
description: Use the OS reminders integration to query and manage native macOS Reminders.app — listing reminder lists, fetching reminders by list or due date, creating new reminders, updating, completing, or deleting them. Use even when you think you know the answer — Reminders state is dynamic; only the live API reflects current items, due dates, and completion status. Do not use for: non-macOS systems, other reminder/task apps (Todoist, TickTick, etc.), or anything outside the user's local Reminders.app.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

Reminders access goes through MCP Hub. All reminder methods are on the injected `os` global — there is no separate `reminders` global. Use `search_tools` to discover the live schema, then `execute_code` to call `os.*` methods.

## Workflow

1. `search_tools({ query: "reminders", detail_level: "names_only", service: "os" })` — discover available tool names.
2. `search_tools({ query: "<toolName>", detail_level: "full_schema", service: "os" })` — get exact parameter schema before first use.
3. `execute_code` — call via `os.<toolName>(params)` using parameter names from the schema.

Always run steps 1–2 before guessing a tool name or parameter. The live schema is the source of truth.

## Key methods

- `os.listReminderLists()` — list all reminder lists (no params).
- `os.listReminders({ list_id?, limit?, show_completed? })` — list reminders, incomplete by default.
- `os.getReminder({ id })` — fetch a single reminder by ID.
- `os.createReminder({ name, list_id?, due_date?, priority?, notes?, tags? })` — create a reminder.
- `os.completeReminder({ id })` — mark a reminder as completed.

## Pitfalls

- **All methods are on `os.*`, not `reminders.*`** — there is no separate reminders global.
- **List names are case-sensitive.** Call `os.listReminderLists()` first if the user refers to a list by name; pass the resolved `id` to other calls.
- **`list_id` accepts the list's ID string** returned by `listReminderLists`, not a display name.
- **`show_completed` defaults to `false`** — completed reminders are excluded unless explicitly requested.
- **`priority` encoding:** 0 = none, 1 = high, 5 = medium, 9 = low.
- **Tags are stored in the notes field** as `[#tag]` markers (EventKit has no native tag property). `listReminders` and `getReminder` extract them into a separate `tags` array; pass `tags: ["work"]` to `createReminder` — do not embed `[#tag]` manually.
- **Due dates must be ISO 8601** (e.g. `"2025-06-01T10:00:00Z"`). Relative phrases ("tomorrow") must be resolved to an absolute timestamp before passing.
- **No recurrence-rule (RRULE) support** in the current API. If the user asks to create a repeating reminder, inform them this is not supported and offer to create a one-time reminder instead.
- **iCloud-synced lists work** because the system sync layer handles it — the API sees all lists the device has, regardless of backend.
- **macOS TCC permission is pre-validated by Speedwave Settings.** If this integration is enabled, assume access is granted; do not ask the user to check permissions.

## Confirmation rule

Per `CLAUDE.md`: `createReminder` and `completeReminder` are write operations and require explicit user confirmation before execution. `listReminderLists`, `listReminders`, and `getReminder` are read-only and need no confirmation.

## When NOT to use

- Non-macOS host environments.
- Third-party task managers (Todoist, Things, TickTick, Asana, Notion tasks, etc.).
- Generic task-management advice not tied to the user's local Reminders.app data.

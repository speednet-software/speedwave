---
name: calendar
description: Use the OS calendar integration to query and manage native macOS Calendar.app — listing calendars, fetching events by date range, creating/updating/deleting events, and checking availability. Use even when you think you know the answer — calendar state is dynamic; only the live API reflects current events, RSVP status, and shared-calendar updates. Do not use for: non-macOS systems, third-party calendar services (Google Calendar API directly, Outlook web, etc.) — those go through their own integrations if configured.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

Calendar access goes through the Speedwave MCP Hub. Claude does not see calendar tools directly — use `search_tools` to discover them and `execute_code` with the injected `os` global to invoke. macOS TCC permission is pre-validated at integration enable time; if the calendar reports access denied, direct the user to System Settings → Privacy & Security → Calendars.

## Workflow

1. `search_tools({ query: "calendar", detail_level: "names_only", service: "os" })` — confirm which tools are available.
2. `search_tools({ query: "<toolName>", detail_level: "full_schema", service: "os" })` — get the exact parameter schema.
3. `execute_code` — call the tool using exact parameter names from the schema.

Always run steps 1–2 before guessing a tool name or parameter shape.

## Pitfalls

- **`os.*`, not `calendar.*`.** All methods live on the `os` global: `os.listCalendars`, `os.listEvents`, `os.getEvent`, `os.createEvent`, `os.updateEvent`, `os.deleteEvent`.
- **Calendar source.** macOS Calendar.app aggregates accounts configured in System Settings → Internet Accounts. iCloud, Google, and Exchange accounts each appear as separate calendars if the user has them set up; this integration sees all of them together.
- **Discover before filtering.** Calendar names are case-sensitive. Call `os.listCalendars()` first to get exact `id` and `name` values — do not guess display names.
- **`calendar_id` accepts ID or name.** The CLI resolves by ID first, then falls back to a name match. Prefer the `id` from `listCalendars` to avoid ambiguity.
- **Date/time format.** All timestamps are ISO 8601. Timed events include a time component; all-day events use a date-only string. Dates without a timezone offset are interpreted in the system timezone. `listEvents` defaults to now → +7 days when no range is given; always pass an explicit range for non-trivial queries.
- **Recurring events.** The CLI operates on a single occurrence (`span: .thisEvent`). Modifying one occurrence does not alter the rest of the series. There is no API to modify the full recurrence series through this integration.
- **No free/busy API.** Availability checking requires listing events in the target range and inspecting the results manually — there is no dedicated free/busy or availability endpoint.
- **Confirmation rule.** Per `claude-resources/CLAUDE.md`, `createEvent`, `updateEvent`, and `deleteEvent` require explicit user confirmation before execution. Read operations (`listCalendars`, `listEvents`, `getEvent`) never require confirmation.

## When NOT to use

- Scheduling theory or general time-management advice — answer directly without calling the API.
- Web-based calendars not synced to macOS Calendar.app (e.g. a Google Calendar account the user has not added to Internet Accounts).
- Non-macOS systems — this integration is macOS-only.

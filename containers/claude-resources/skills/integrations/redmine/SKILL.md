---
name: redmine
description: Use Redmine integration to query and manage Redmine projects, issues, time entries, journals, comments, relations, and user mappings. Use whenever the user asks about Redmine, for example finding or creating issues, listing assigned tickets, logging time, commenting, transitioning status, linking issues, or looking up project members. Use even when you think you know the answer, issue and project state are dynamic, only the live API reflects current assignments, status, or time entries. Do not use for project management theory, anything outside the configured Redmine instance, or wiki content (no wiki tools available, use playwright or paste the URL).
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# Redmine

Redmine access goes through MCP Hub via `search_tools` + `execute_code` and the injected `redmine` global. `host_url`, `api_key`, and `project_id` are pre-configured at the worker (`/tokens/config.json`), never pass them as arguments, never ask the user for them. `project_id` may be `null` if not set; cross-project queries still work without it.

## Workflow

1. `search_tools({ query: "redmine <keyword>", detail_level: "names_only", service: "redmine" })`: discover available tools.
2. `search_tools({ query: "<exact-tool-name>", detail_level: "full_schema", service: "redmine" })`: get parameter shape before first use.
3. `execute_code`: invoke `await redmine.<toolName>({ ... })` using the exact parameter names from the schema.

## Pitfalls

- **No wiki tools.** The worker does not expose wiki pages. If the user asks for wiki content, say so and offer to fetch the URL via the `playwright` skill (if enabled) or ask the user to paste the content.
- **Time entries are NOT scoped by the API key.** `listTimeEntries` with no `user_id` returns every user's entries. For "my hours"/"my time entries", first resolve the current user via `getCurrentUser()` (or `resolveUser({identifier: 'me'})`) and pass that id, or the literal `'me'`, as `user_id`. Never assume the API key implicitly filters results.
- **Identity-dependent queries need explicit resolution.** "My issues", "assigned to me", "my hours" all require resolving the caller first: pass `'me'` directly to `assigned_to` (issues) or `user_id` (time entries), or call `getCurrentUser()`/`resolveUser({identifier: 'me'})` when you need the numeric ID for a write. Never assume any endpoint implicitly filters to the caller.
- **Issue relation directions matter.** `precedes`/`follows` and `blocks`/`blocked` are opposites; picking the wrong direction is a common mistake. Confirm direction with the user before creating a relation.
- **Status transitions go through `status_id`.** Discover allowed values via the mappings/config tool before setting a status; do not guess numeric IDs.
- **Custom field IDs are project-specific.** Resolve custom field names to IDs via the mappings tool before including them in a write call.
- **Write/delete require explicit user confirmation** per `claude-resources/CLAUDE.md`. This covers creating or updating issues, posting or editing comments, logging or correcting time entries, creating or removing relations, and closing or deleting anything.
- **Verify after updates.** Redmine silently ignores some field changes on closed issues: check the returned values match what was requested and report any discrepancy.

## When NOT to use

Redmine is project-bound. If the user mentions a project other than the one configured as the default `project_id`, ask whether to query that project explicitly (pass `project_id` in the call) or switch context entirely before proceeding.

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
- **Identity-dependent queries need explicit resolution; nothing is scoped by the API key.** "My issues", "assigned to me", "my hours", "my time entries" all require resolving the caller: pass the literal `'me'` directly to `assigned_to` (issues) or `user_id` (time entries) for reads, or call `getCurrentUser()`/`resolveUser({identifier: 'me'})` first when you need the numeric ID for a write. `listTimeEntries` with no `user_id` returns every user's entries: never assume any endpoint implicitly filters to the caller.
- **Issue relation directions matter.** `precedes`/`follows` and `blocks`/`blocked` are opposites; picking the wrong direction is a common mistake. Confirm direction with the user before creating a relation.
- **Status transitions go through `status_id`.** Discover allowed values via the mappings/config tool before setting a status; do not guess numeric IDs.
- **Target versions (a milestone or a planning week) go through `fixed_version_id`.** Resolve a version name to its ID with `listVersions` and pick one whose `status` is `open` (only those can be assigned), then pass it to `createIssue`/`updateIssue` or filter `listIssueIds` by it. `fixed_version_id: null` clears it. Redmine omits `fixed_version` from an issue that has none.
- **`listIssueIds` returns open issues unless told otherwise.** Counting every issue in a version, or every subtask, needs `status: "*"`.
- **Bad arguments are rejected, not ignored.** An undeclared parameter, a missing required one, a name given together with its `_id` twin (e.g. `status` and `status_id`), or a numeric ID that is not a positive integer fails with an error naming it, and nothing reaches Redmine: fix the call and retry instead of treating it as done. Always call tools with an object of named parameters, e.g. `resolveUser({ identifier: 'me' })`.
- **Attachments are files in `/workspace`.** `addAttachment({ issue_id, file_paths, notes })` and `createIssue({ file_paths })` take paths under `/workspace` (copy a file from `/tmp` or the home directory there first); `downloadAttachment({ issue_id, attachment_id })` saves to `/workspace/.speedwave/redmine/` and returns the path, so open that file to look at an image or log. Get `attachment_id` from `getIssueFull({ issue_id, include: ["attachments"] })`; an id that belongs to another issue is rejected. The Redmine server's size limit applies and a refusal attaches nothing.
- **Custom fields, dates, progress and privacy are writable.** `createIssue` and `updateIssue` take `start_date`, `due_date`, `done_ratio`, `is_private` and `custom_fields: [{ id, value }]` (an array value for a multiple field, `value: null` to clear one); `createIssue` also takes `watcher_user_ids`, `updateIssue` also `private_notes`. `getIssueFull` returns custom fields as `{ id, name, value, multiple }`. `listIssueIds` filters by `start_date`, `due_date`, `done_ratio`, `is_private`, `watcher_id` (Redmine filter expressions such as `"<=2026-11-30"`) and `cf: { "<field id>": "<expression>" }`.
- **Empty values.** An omitted field stays unchanged. `null` clears a field whose schema type allows `null`; on any other field it is an error, and `''` is always an error. Nothing is sent to Redmine in either case.
- **Write/delete require explicit user confirmation** per `claude-resources/CLAUDE.md`. This covers creating or updating issues, posting or editing comments, attaching or deleting attachments, logging or correcting time entries, creating or removing relations, and closing or deleting anything.
- **Verify after updates.** Redmine silently ignores some field changes (on closed issues, or a tracker the user may not set): `createIssue` and `updateIssue` return the whole issue as Redmine holds it plus `ignored_fields`, the sent fields Redmine did not apply (with a `message`); report any listed field to the user. `notes` and `private_notes` are not verified.

## When NOT to use

Redmine is project-bound. If the user mentions a project other than the one configured as the default `project_id`, ask whether to query that project explicitly (pass `project_id` in the call) or switch context entirely before proceeding.

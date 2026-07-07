---
name: atlassian
description: Use Atlassian integration to query and manage Jira Cloud and Confluence Cloud, Jira issues, comments, worklogs and time tracking, transitions, assignments, agile boards/sprints, and Confluence pages, spaces, labels, attachments. Use whenever the user asks about Jira tickets/issues/sprints, logging work or time on a Jira issue, or Confluence pages/spaces, searching with JQL/CQL, getting or creating issues, transitioning workflows, finding or updating pages, etc. Use even when you think you know the answer, issue and page state are dynamic, only the live API reflects current assignments, transitions, comments, or page revisions. Do not use for self-hosted Jira/Confluence Server or Data Center (Cloud only), generic project management theory, or anything outside the configured Atlassian site.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# Atlassian (Jira Cloud + Confluence Cloud)

Atlassian access (Jira and Confluence) goes through the MCP Hub via `search_tools` and `execute_code` using the injected `atlassian` global. `site_url`, `email`, and `api_token` are pre-configured on the worker: never pass them, never ask the user. An optional allowlist (`jira_project_keys`, `confluence_space_keys`) may also be pre-configured, restricting which projects/spaces are visible and writable.

## Workflow

1. `search_tools({ query: "jira issue" | "confluence page" | task keyword, detail_level: "names_only", service: "atlassian" })`: discover available tools. Filtering by product keyword (e.g. `"jira"` vs `"confluence"`) narrows results.
2. `search_tools` with `detail_level: "full_schema"` for the specific tool: confirm exact parameter names before calling.
3. `execute_code` with dot-notation: `await atlassian.toolName({ param: value })`.

## Pitfalls

**Allowlists may silently filter results to empty.** If a search returns 0 hits for something the user expects to exist, mention the project/space key may not be in the allowlist; do not claim the issue or page doesn't exist. Allowlists filter after the API call, so pagination cursors (`next_page_token`/`is_last`) reflect the unfiltered upstream page: a page that looks "last" may still be hiding excluded items, and vice versa.

**Self-scoping reads.** Speedwave authenticates as one shared Atlassian account per project, not a per-human login. For "my"/"assigned to me"/"my hours" questions, use `assignee = currentUser()` directly in JQL (`searchIssues`), or resolve `getMyself().account_id` and compare it against the assignee/author/reporter/worklog-author field in results. Never assume all data belongs to "the user" without checking.

**JQL is not CQL.** Jira uses JQL (`searchIssues`); Confluence uses CQL (`searchPages`). The field names, functions, and operators differ: never mix them. Example JQL: `assignee = currentUser() AND statusCategory != Done`. Example CQL: `space = DEV AND type = page AND text ~ "runbook"`.

**ADF vs storage format.** Jira Cloud content (issue description, comments) is ADF (Atlassian Document Format, a JSON tree). Confluence content is "storage" format (XHTML-like). Use `bodyText` for plain-text input to either product and let the worker convert; only pass `bodyAdf` or `bodyStorage` when you have the native format. Never feed ADF to a Confluence tool or storage XHTML to a Jira tool.

**User references use `accountId`.** `assignIssue`, `createIssue`, and similar tools take an opaque Cloud account ID (e.g. `5b10ac8d82e05b22cc7d4ef5`), not a username or email. Resolve the current user with `getMyself`. This worker has no user-search tool: for someone else, reuse an assignee/reporter `account_id` already present in a prior `getIssue`/`searchIssues` result, or ask the user for it. Do not guess.

**Transitions need a `transitionId`.** Call the transitions endpoint first to map a status name (e.g. "Done", "In Progress") to the valid numeric ID for that issue's current workflow before calling transition.

**Logging work uses `addWorklog`, and is attributed to the shared account.** `addWorklog` records time against an issue as the single shared Atlassian account this project authenticates as, not a per-human identity. When both Atlassian and Redmine are enabled, pick the worker by which system actually owns the issue: a Jira issue key (e.g. `PROJ-123`) means Atlassian's `addWorklog`, a Redmine issue ID means Redmine's time-entry tools.

**`updatePage` requires the current version number.** Fetch the page first, increment the version, then push. If the API returns a conflict, re-read and retry. Do not blindly retry with a stale version.

**Pagination differs by product.** Jira uses `startAt`/`maxResults` (or an opaque `nextPageToken` on some tools); Confluence uses cursor-based pagination. Read the full schema each time; do not assume offsets work the same across tools.

**Write/delete confirmation.** Per the container CLAUDE.md rule, never execute any create, update, transition, assign, or delete operation without explicit user confirmation in the current turn.

---
name: sharepoint
description: Use SharePoint integration to read, write, and manage files, document libraries, lists, list items, columns, and pages on the configured Microsoft 365 site. Use whenever the user asks about SharePoint — listing or searching files in a document library, uploading or downloading, creating or updating lists and items, adding columns, creating or publishing pages, or adding web parts. Use even when you think you know the answer — site state is dynamic; only the live API reflects current files, list items, or page versions. Do not use for: Microsoft 365 Outlook/Teams/OneDrive operations not surfaced via SharePoint, cross-site or cross-tenant ops (only the configured site), or generic Microsoft Graph questions.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# SharePoint (Microsoft 365)

SharePoint access goes through MCP Hub via `search_tools` (discovery) and `execute_code` (invocation) using the injected `sharepoint` global — called as `await sharepoint.<toolName>({ … })`. The `site_id`, OAuth refresh token, and tenant credentials are pre-configured at the worker; never pass them and never ask the user which site to use — the site is bound by omission (ADR-060).

## Workflow

1. `search_tools({ query: "sharepoint <keyword>", detail_level: "names_only", service: "sharepoint" })` — list candidate tools.
2. `search_tools({ query: "<chosen tool>", detail_level: "full_schema", service: "sharepoint" })` — get exact parameter names, required fields, and enums.
3. `execute_code` — call `await sharepoint.<toolName>({ … })` using only parameters from the schema.

## SharePoint-specific pitfalls

- **`site_id` is policy-by-omission.** No tool accepts a site parameter — the worker reads it from `/tokens/site_id`. If the user asks "which site?", explain it is pre-configured by the administrator.
- **File paths.** Parameters named `local_path` or `localPath` must point inside `/workspace`. Downloads and uploads both land there.
- **ETag CAS on uploads only.** `uploadFile` supports `expectedEtag` (If-Match) and `createOnly` (If-None-Match: \*) — fetch the current state via `listFileIds`/`getFileFull` first when overwrite safety matters. `updatePage` has NO ETag or conditional-update support: concurrent edits to the same page can silently clobber each other, and there is no way to detect this from the tool.
- **User-scoped queries ("my items", "items assigned to me").** Call `getCurrentUser` first to resolve the caller's email/id, then filter `listItems` against a list-specific author/assignee column (inspect `getList`'s column schema first — column names vary per list). `listItems`/`getItem` do not expose creator/modifier metadata by default, only user-defined list fields.
- **`updatePage` replaces the full canvas layout.** Graph does not support partial PATCH of sections. Re-fetch the page, edit the layout object, then push the entire `canvasLayout` back.
- **Image web parts require the file to be in SharePoint first.** External image URLs are dropped by SharePoint's picker. Upload the image with the upload file tool, then reference the resulting SharePoint path.
- **OData filter syntax in list-item queries.** String literals use single quotes, e.g. `fields/Status eq 'Open'` — not SQL double quotes.
- **Section and column indices are 0-based** and capped per the page layout (typically 20 sections, 10 columns). Exceeding the cap returns a 400 error.
- **Lists vs. libraries.** `listLists` returns both document libraries and custom lists (Graph does not separate them at this endpoint). Users often confuse them — clarify before writing.
- **Write/delete confirmation.** Any tool that creates, updates, deletes, uploads, or publishes requires explicit user confirmation before invocation, per the global rule in `claude-resources/CLAUDE.md`. Destructive deletions warrant a second confirmation.

## When NOT to use this skill

This skill operates exclusively on the single SharePoint site pre-configured for the project. Cross-site, cross-tenant, and multi-site operations are outside scope — inform the user and stop.

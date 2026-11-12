# ADR-109: Jira attachments in the Atlassian worker: list, download and delete, with a read-write workspace mount

> **Status:** Accepted
> **Date:** 2026-11-12
> **Context:** SPEED-998. The Atlassian worker moved files in one direction only, from `/workspace` to Jira. An agent could not see or fetch an attachment of an issue, and `deleteAttachment` failed whenever a Jira project allowlist was configured.

## Context

- `getIssue` returned no attachments: `ISSUE_FIELDS` did not request them and `mapIssue` (`mcp-servers/atlassian/src/domains/jira-issues.ts`) had no field for them.
- The only attachment tools were `addAttachment`, which reads a file through `readWorkspaceFile` (`mcp-servers/shared/src/workspace-file.ts`), and `deleteAttachment({ attachment_id })`.
- `/workspace` was mounted `:ro` in the `mcp-atlassian` service, enforced by the `ATLASSIAN_WORKSPACE_MOUNT_MODE` rule (`crates/speedwave-runtime/src/compose/security_check.rs`). A worker that only reads the workspace needs nothing more.
- An attachment ID alone does not name a project, so a call that takes only the ID cannot be checked against the project allowlist. `deleteAttachment` failed closed in that case.
- The Slack and SharePoint workers already mount `/workspace:rw` and write downloads to `/workspace/.speedwave/<service>/` (ADR-071 point 9, ADR-060).
- The endpoint for attachment content is `GET /rest/api/3/attachment/content/{id}`; by default it answers with a redirect to a media host, and the Atlassian reference documents a `redirect` query parameter[^1]. The reference does not say that `redirect=false` returns the bytes from the Jira host; that is the one unconfirmed point of this decision.

## Decision

1. **`mcp-atlassian` mounts `${PROJECT_DIR}:/workspace:rw`.** `ATLASSIAN_WORKSPACE_MOUNT_MODE` requires `:rw`, and a `:ro` mount is reported as a violation. The worker joins the sanctioned workspace-worker profile of Slack and SharePoint: `/tokens:ro`, `/workspace:rw`, nothing else. The accepted cost is the same as for those workers: a compromised or prompt-injected Atlassian worker can write anywhere under the project directory, not only under `.speedwave/jira/`.
2. **`getIssue` returns `attachments`.** Each entry has the attachment id, file name, size, MIME type, author and creation time; the array is empty when the issue has none. `searchIssues` is unchanged.
3. **New tool `downloadAttachment({ issue, attachment_id })`.** The issue is checked against the project allowlist, and `attachment_id` must be one of that issue's attachments (read from the issue), otherwise the tool returns an error that points to `getIssue` and sends no request to `/attachment/...`. The content is requested with `?redirect=false` from the Jira host only; the client keeps `maxRedirects: 0` and its `*.atlassian.net` origin check, so no second host is contacted. The body is streamed to `/workspace/.speedwave/jira/<attachment_id>-<name>`, where the name is reduced to a separator-free basename without leading dots (the Slack rule, copied; a shared module is SPEED-999). A repeated download overwrites the same file. The result holds the path, size and MIME type, never the bytes. The tool carries `speedwave.pl/timeout-class: long`.
4. **`deleteAttachment({ issue, attachment_id })`.** `issue` is required, checked against the allowlist, and the attachment must belong to it. The block on deleting while an allowlist is configured is removed.
5. **Read-only mode (ADR-108 decision 2).** `downloadAttachment` uses `WORKSPACE_WRITE_ANNOTATIONS`, because it changes nothing outside `/workspace`, so it works in read-only mode. `addAttachment` and `deleteAttachment` keep their classification and stay blocked. The Atlassian classification test lists `downloadAttachment`.
6. **No feature flag.**

## Consequences

- If `?redirect=false` does not return the file bytes from the Jira host, the download fails with an error that says the worker does not follow redirects, and the decision on handling the media-host redirect returns to the owner of SPEED-998. This is checked on a live instance before release.
- `addAttachment` is unchanged: one file per call, read fully into memory, capped at `ATLASSIAN_MAX_ATTACHMENT_BYTES`.
- Attachments embedded in comments or descriptions as ADF media without an entry in the issue's attachment list are not covered.
- The download code is a third copy of the Slack pattern (SPEED-982 has the second); SPEED-999 moves it into `mcp-servers/shared`.

## References

[^1]: Atlassian, Jira Cloud platform REST API v3, Issue attachments, "Get attachment content": https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/

# ADR-110: Redmine attachments through the workspace mount

> **Status:** Accepted
> **Date:** 2026-11-12
> **Context:** SPEED-982 (SPEED-246, downloading attachment content, closed as a duplicate). The Redmine integration could not attach a file, fetch an attachment or delete one; a person did it by hand in the browser. Atlassian, Slack and SharePoint already move files.

## Context

- `mcp-redmine` mounted only `/tokens:ro` (`containers/compose.template.yml`), so the worker could not see the files Claude sees. `/workspace` is the only place shared by the claude container and a worker: the `execute_code` sandbox in the hub has no disk, and a tool result returns to the model as JSON.
- The Redmine client (`mcp-servers/redmine/src/client.ts`) sent and received JSON only.
- `security_check.rs::VolumeCheckRules` had rule sets for SharePoint, Slack and Atlassian but none for Redmine (ADR-060, ADR-071 point 9).
- Redmine's REST API attaches a file in two steps: a `POST /uploads.json?filename=...` with `Content-Type: application/octet-stream` returns a token, and the token goes into the `uploads` array of an issue request. A file over the server limit is answered with 422.[^1] An attachment is read from the `content_url` of its record and deleted with `DELETE /attachments/:id.json`.[^2]

## Decision

1. **`mcp-redmine` mounts `${PROJECT_DIR}:/workspace:rw`.** The profile is the one Slack and SharePoint carry (ADR-071 point 9, ADR-060): `/tokens:ro`, `/workspace:rw`, nothing else. Write access is needed because `downloadAttachment` saves files. A new mount surface is not created; `/workspace` is the surface the project already shares.
2. **`VolumeCheckRules::REDMINE` validates it.** `security_check.rs` gets the `Redmine*` rules (long-form volume, token path, workspace path, workspace mode `:rw`, no extra volumes, missing `/tokens`, missing `/workspace`), wired through `check_builtin_workspace_worker_volumes` like Slack. A compose that drops the mount or changes its mode or path hard-fails at start.
3. **Bytes never pass through the hub.** Upload streams the file to `/uploads.json` with a `Content-Length` from `stat`; download streams `content_url` into a `.part` file that is renamed when complete and removed on failure. Worker memory (128 MiB, `resources.rs::STANDARD_WORKER_RESOURCES`) does not grow with the file. Sending the bytes through MCP was rejected: base64 in JSON, the whole file in worker and hub memory, and no place to write on the caller's side.
4. **Paths are confined before the first Redmine call.** `addAttachment` and `createIssue` resolve every entry of `file_paths` (1 to 10) with mcp-shared's `resolveWorkspaceFile`, so `../`, an absolute path elsewhere and a symlink leaving `/workspace` are rejected and no file is sent. A download is written to `/workspace/.speedwave/redmine/<attachment_id>-<name>`, with the name reduced to a separator-free basename without leading dots, as in Slack's `downloadFile`.
5. **Project scope.** `issue_id` goes through `showIssue`, which enforces the configured project. `downloadAttachment` and `deleteAttachment` read the issue with its attachments and act only on an `attachment_id` found there; any other id is a teaching error that points to `getIssueFull` with `include: ["attachments"]`, and no `/attachments/<id>` request is made. The download URL is built from `host_url`, the attachment id and its name, never taken from `content_url`, so the API key is not sent to a host the record names.
6. **One history entry.** `addAttachment` uploads every file, then sends one `PUT /issues/:id.json` with the `uploads` array and the optional `notes`.
7. **Size and time.** The worker has no size limit of its own; the Redmine server's limit applies, and a 422 or 413 on upload becomes an error that carries the server message and says nothing was attached. The tools carry `speedwave.pl/timeout-class: long`, as does `createIssue`, which can now upload.
8. **Read-only mode (ADR-108 decision 2).** `downloadAttachment` writes only into `/workspace` and uses `WORKSPACE_WRITE_ANNOTATIONS`, so it works in read-only mode. `addAttachment` and `createIssue` change Redmine and are blocked. `deleteAttachment` is destructive and blocked. `mcp-servers/redmine/src/tools/metadata.test.ts` classifies each tool.
9. **No list tool.** `getIssueFull` with `include: ["attachments"]` returns the attachment ids, and the tool descriptions name it as their source.

## Consequences

- A prompt-injected agent that can call `addAttachment` can attach any file under `/workspace` to a Redmine issue; the same exposure already exists for Slack `uploadFile` and Atlassian `addAttachment`. The confinement in decision 4 keeps `/tokens` and everything outside the project out of reach.
- The `mcp-redmine` container is `read_only` with `tmpfs /tmp`; its only writable path is the project mount.
- Existing rendered composes and snapshots lack the mount. The update path re-renders compose from the template, and `choose_rollback_compose` forward-fixes a snapshot that fails the new `REDMINE_MISSING_WORKSPACE_MOUNT` rule.

## Out of scope

- Bulk download of all attachments of an issue.
- Editing attachment metadata (`PATCH /attachments/:id`).
- One mount table for all services.

[^1]: <https://www.redmine.org/projects/redmine/wiki/Rest_api#Attaching-files>

[^2]: <https://www.redmine.org/projects/redmine/wiki/Rest_Attachments>

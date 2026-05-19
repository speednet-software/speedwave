# MCP Atlassian Worker

Isolated Jira & Confluence (Atlassian Cloud) MCP server with per-service token isolation for Speedwave.

## Architecture

- **Port**: 3000 (internal container network — `PORT` env, see ADR-038)
- **Transport**: Streamable HTTP (MCP spec, via `@speedwave/mcp-shared`)
- **Token Source**: `/tokens/{site_url,email,api_token}` required, `/tokens/{jira_project_keys,confluence_space_keys}` optional (read-only mount)
- **Auth**: `MCP_ATLASSIAN_AUTH_TOKEN` (Bearer token enforced on every request)
- **Atlassian auth**: Basic — `Authorization: Basic base64(email:api_token)` ([API token](https://id.atlassian.com/manage-profile/security/api-tokens))
- **Client**: thin `axios` HTTP client (no external Atlassian SDK — see `docs/guides/integrations.md` for the rationale)
- **APIs**: Jira Cloud REST v3 + Agile 1.0; Confluence Cloud REST v2 (spaces, pages, comments, label reads, attachments) + v1 (CQL search and bulk label-add — no v2 equivalent for those)
- **Scope**: Atlassian Cloud only (`*.atlassian.net`; no Data Center/Server)

## Security Model

**Blast Radius Containment**:

- ONLY has access to Atlassian tokens
- No access to Slack, SharePoint, Redmine, GitLab, or GitHub tokens
- Compromise of this worker only exposes Atlassian (further narrowed by the optional project/space allowlists)

**Defense Layers**:

- Bearer-token auth on every request, origin validation, per-session rate limiting, input validation (via `@speedwave/mcp-shared`)
- Error sanitization — the `Authorization` header, the base64 `email:token` blob and raw API tokens are never echoed in responses or logs
- Per-request retry policy: only GET / idempotent calls retry transient `5xx`; write operations retry only on `429` (respecting `Retry-After`), never on `5xx`, to avoid duplicating side effects
- Optional scope allowlists: when `jira_project_keys` / `confluence_space_keys` are set, operations outside those projects/spaces are rejected
- Non-root user in container, read-only token mount, `cap_drop: ALL`, `no-new-privileges`, read-only filesystem

## Tools (33 total)

| Domain                 | Count | Tools                                                                                            |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| Jira — issues          | 8     | searchIssues (JQL), getIssue, createIssue, updateIssue, getTransitions, transitionIssue, assignIssue, getMyself |
| Jira — comments         | 3     | addComment, getComments, addWorklog                                                              |
| Jira — projects         | 3     | listProjects, getProject, listIssueTypes                                                         |
| Jira — Agile            | 6     | listBoards, getBoard, getBoardConfiguration, listSprints, getSprint, moveIssuesToSprint          |
| Confluence — spaces     | 2     | listSpaces, getSpace                                                                             |
| Confluence — pages      | 6     | searchPages (CQL), getPage, getPageByTitle, createPage, updatePage, getPageChildren              |
| Confluence — content    | 5     | addPageComment, getPageComments, addPageLabels, getPageLabels, listAttachments                  |

Jira write payloads (`description`, comment bodies) accept plain `bodyText` (converted to a minimal Atlassian Document Format document) or a raw `bodyAdf` object. Confluence page bodies accept `bodyText` or raw `bodyStorage` (storage representation); `updatePage` fetches the current version automatically.

## File Structure

```
src/
  index.ts                  # bootstrap: createMCPServer, auth-token enforcement, client init
  auth.ts                   # /tokens credential loading + site_url validation
  client.ts                 # AtlassianClient — axios + per-request retry; static formatError()
  adf.ts                    # ADF + Confluence-storage helpers (textToAdf, resolveBodyPayload, …)
  scope.ts                  # project/space allowlist enforcement (assert*/filterByAllowlist, ScopeError)
  url.ts                    # deriveBrowseUrl helper
  types.ts                  # hand-written DTOs
  domains/                  # one module per resource (factory + normalisers) + normalizers.ts (shared)
  tools/                    # one module per resource (Tool definitions + handlers) + validation.ts
```

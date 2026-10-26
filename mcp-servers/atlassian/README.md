# MCP Atlassian Worker

Isolated Jira & Confluence (Atlassian Cloud) MCP server with per-service token isolation for Speedwave.

## Architecture

- **Port**: 3000 (internal container network — `PORT` env, see ADR-038)
- **Transport**: Streamable HTTP (MCP spec, via `@speedwave/mcp-shared`)
- **Token Source**: `/tokens/{site_url,email,api_token}` required, `/tokens/{jira_project_keys,confluence_space_keys}` optional (read-only mount)
- **Auth**: `MCP_ATLASSIAN_AUTH_TOKEN` (Bearer token enforced on every request)
- **Atlassian auth**: Basic — `Authorization: Basic base64(email:api_token)` ([API token](https://id.atlassian.com/manage-profile/security/api-tokens))
- **Client**: thin `axios` HTTP client (no external Atlassian SDK)
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

## Tools (40 total)

| Domain              | Count | Tools                                                                                                                                                                                                  |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Jira: issues        | 14    | searchIssues (JQL), getIssue, createIssue, updateIssue, deleteIssue, linkIssues, unlinkIssues, listLinkTypes, getTransitions, transitionIssue, assignIssue, getMyself, addAttachment, deleteAttachment |
| Jira: comments      | 3     | addComment, getComments, addWorklog                                                                                                                                                                    |
| Jira: projects      | 4     | listProjects, getProject, listIssueTypes, listComponents                                                                                                                                               |
| Jira: Agile         | 6     | listBoards, getBoard, getBoardConfiguration, listSprints, getSprint, moveIssuesToSprint                                                                                                                |
| Confluence: spaces  | 2     | listSpaces, getSpace                                                                                                                                                                                   |
| Confluence: pages   | 6     | searchPages (CQL), getPage, getPageByTitle, createPage, updatePage, getPageChildren                                                                                                                    |
| Confluence: content | 5     | addPageComment, getPageComments, addPageLabels, getPageLabels, listAttachments                                                                                                                         |

Jira tools take and return snake_case names (`max_results`, `transition_id`, `account_id`). Every Jira tool is wrapped in `withDeclaredParams`: an undeclared parameter or a missing required one is rejected with a teaching error before any request is sent. Confluence tools keep camelCase and are not under the guard yet (SPEED-870).

- Issues and projects are identified by one string, a key or a numeric ID (`issue: "PROJ-123"`).
- Jira text is Markdown in both directions: `description`, comment `body` and worklog `comment` are converted to ADF on write, and descriptions and comments come back as Markdown. ADF nodes with no Markdown form come back as `[adf:<type>]` markers. Content Markdown cannot express goes through the escape hatch `description_adf`, `body_adf` or `comment_adf` (send one or the other, not both). `searchIssues` returns no `description`; use `getIssue`.
- `createIssue` and `updateIssue` accept `parent` (key or ID; `null` detaches on update), `components` (names from `listComponents`; on update the list replaces the current one and `[]` clears it), `assignee` (account ID, `"me"` or `null`) and, on update, `type`. A Jira 400 on these becomes an error that names the next tool to call.
- `linkIssues({ issue, relation, target })` reads the relation from the side of `issue` (`PROJ-1 blocks PROJ-2`); valid relation texts come from `listLinkTypes`. `unlinkIssues` takes the `links[].id` returned by `getIssue` or `searchIssues`.
- `listIssueTypes` takes either `project` (types available there) or `issue` (types that issue can change to).
- `deleteIssue` is irreversible and fails while the issue has sub-tasks.
- The project allowlist covers the issue a call names, `parent`, and both ends of a link.

Confluence page bodies accept `bodyText` or raw `bodyStorage` (storage representation); `updatePage` fetches the current version automatically.

## File Structure

```
src/
  index.ts                  # bootstrap: createMCPServer, auth-token enforcement, client init
  auth.ts                   # /tokens credential loading + site_url validation
  client.ts                 # AtlassianClient — axios + per-request retry; static formatError()
  adf.ts                    # Markdown <-> ADF converter (markdownToAdf, adfToMarkdown) + Confluence-storage helpers
  scope.ts                  # project/space allowlist enforcement (assert*/filterByAllowlist, ScopeError)
  url.ts                    # deriveBrowseUrl helper
  types.ts                  # hand-written DTOs
  domains/                  # one module per resource (factory + normalisers) + normalizers.ts (shared)
  tools/                    # one module per resource (Tool definitions + handlers) + validation.ts
```

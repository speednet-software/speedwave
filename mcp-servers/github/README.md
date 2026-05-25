# MCP GitHub Worker

Isolated GitHub MCP server with per-service token isolation for Speedwave.

## Architecture

- **Port**: 3000 (internal Docker network — `PORT` env, see ADR-038)
- **Transport**: Streamable HTTP (MCP spec, via `@speedwave/mcp-shared`)
- **Token Source**: `/tokens/token` (read-only mount)
- **Auth**: `MCP_GITHUB_AUTH_TOKEN` (Bearer token enforced on every request)
- **Client Library**: `@octokit/rest` (composed with `@octokit/plugin-throttling` + `@octokit/plugin-retry`)
- **Scope**: github.com only in v1 (no GHES support yet — `baseUrl` is reserved for the future)

## Security Model

**Blast Radius Containment**:

- ONLY has access to GitHub tokens
- No access to Slack, SharePoint, Redmine, or other service tokens
- Compromise of this worker only exposes GitHub

**Defense Layers** (provided by `@speedwave/mcp-shared`):

- Bearer-token auth on every request
- Origin validation
- Rate limiting (per session)
- Input validation (tool name, session ID)
- Error sanitization (no internal path leaks; tokens never echoed in responses)
- Non-root user in container, read-only token mount

## Tools (45 total)

| Domain             | Count | Tools                                                                                                                     |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| Repos              | 3     | list repos / search repos, get repo, search code                                                                          |
| Pull Requests      | 7     | list, get, create, merge, update, get diff, get files                                                                     |
| PR Review          | 6     | list commits, list reviews, create review, list comments, create comment, create review (line) comment                    |
| Branches           | 5     | list, get, create, delete, compare                                                                                        |
| Commits            | 4     | list, list branch commits, search, get diff                                                                               |
| Repository content | 3     | get tree, get file contents, create/update file                                                                           |
| Actions            | 7     | list runs, get run, get run logs (URL), rerun, trigger (`workflow_dispatch`), list run artifacts, download artifact (URL) |
| Issues             | 5     | list, get, create, update, close                                                                                          |
| Labels             | 2     | list, create                                                                                                              |
| Releases           | 3     | create tag, delete tag, create release                                                                                    |

Workflow-run logs and artifacts are returned as short-lived download URLs (GitHub serves them as ZIP archives) — the worker does not download or unpack them.

## File Structure

```
github/
├── Dockerfile              # Multi-stage build, Node 24 Alpine, port 3000
├── package.json            # @octokit/rest + plugin-throttling + plugin-retry, @speedwave/mcp-shared
├── tsconfig.json           # extends ../tsconfig.base.json
├── vitest.config.ts        # coverage thresholds (lines 100 / functions 100 / branches 90 / statements 100)
└── src/
    ├── index.ts            # MCP server bootstrap (auth, tool registration, health check)
    ├── client.ts           # GitHubClient class — @octokit/rest wrapper + initializeGitHubClient()
    ├── types.ts            # GitHub API type definitions
    └── tools/              # Tool definitions with handlers (per domain) + validation.ts
```

## Token Configuration

### Token File (`/tokens/token`)

The worker reads a single line containing a GitHub access token. The Speedwave Desktop UI populates this file via the GitHub OAuth App device flow — user clicks **Sign in with GitHub**, enters the user code on `github.com/login/device`, and the token is written automatically. Manual PAT entry remains as an advanced fallback (e.g. for headless setups).

Token formats accepted by the worker (interchangeable — `loadToken()` does not inspect the prefix):

```
gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx    # OAuth App user token (Speedwave device flow)
github_pat_xxxxxxxxxxxxxxxxxxxx              # fine-grained PAT (advanced)
ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx    # classic PAT (advanced)
```

OAuth scopes requested by the Speedwave OAuth App: `repo read:user` (covers private/public repo R/W, issues, pulls, releases, Actions, and `GET /user` for the connection test).

The worker uses github.com (`https://api.github.com`) by default. GitHub Enterprise Server is not supported in v1.

## Build & Run

### Build

```bash
cd <repo>/mcp-servers
docker build -f github/Dockerfile -t speedwave/mcp-github:latest .
```

### Health Check

```bash
curl http://localhost:3000/health
# → { "status": "ok" }
```

## References

- **GitHub REST API**: https://docs.github.com/en/rest
- **@octokit/rest**: https://github.com/octokit/rest.js
- **MCP Spec**: https://modelcontextprotocol.io/
- **Speedwave Architecture**: `docs/architecture/README.md`

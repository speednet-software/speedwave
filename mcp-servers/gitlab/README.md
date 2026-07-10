# MCP GitLab Worker

Isolated GitLab MCP server with per-service token isolation for Speedwave.

## Architecture

- **Port**: 3000 (internal Docker network, via `PORT` env)
- **Transport**: Streamable HTTP (MCP spec, via `@speedwave/mcp-shared`)
- **Token Source**: `/tokens/token` (read-only mount)
- **Auth**: `MCP_GITLAB_AUTH_TOKEN` (Bearer token enforced on every request)
- **Host URL**: `/tokens/host_url` (read-only mount) if present, else the `GITLAB_URL` env var, else `https://gitlab.com`
- **Client Library**: `@gitbeaker/rest` (`^43.8.0`)

## Security Model

**Blast Radius Containment**:

- ONLY has access to GitLab tokens
- No access to Slack, SharePoint, Redmine, or other service tokens
- Compromise of this worker only exposes GitLab

**Defense Layers** (provided by `@speedwave/mcp-shared`):

- Bearer-token auth on every request
- Origin validation
- Rate limiting (per session)
- Input validation (tool name, session ID)
- Error sanitization (no internal path leaks; tokens never echoed in responses)
- Non-root user in container, read-only token mount

## Tools

The exact tool count is pinned by `src/tools/metadata.test.ts`; all tool names are camelCase.

| Domain        | Count | Tools                                                                                      |
| ------------- | ----- | ------------------------------------------------------------------------------------------- |
| Project       | 3     | listProjectIds, getProjectFull, searchCode                                                  |
| User          | 1     | getCurrentUser (resolves the token owner's identity for "me"/"my" filters)                  |
| Merge Request | 7     | listMrIds, getMrFull, createMergeRequest, approveMergeRequest, mergeMergeRequest, updateMergeRequest, getMrChanges |
| MR Notes      | 4     | listMrCommits, listMrPipelines, listMrNotes, createMrNote                                   |
| Discussion    | 2     | listMrDiscussions, createMrDiscussion                                                       |
| Branch        | 5     | listBranches, getBranch, createBranch, deleteBranch, compareBranches                        |
| Commit        | 4     | listBranchCommits, listCommits, searchCommits, getCommitDiff                                |
| Pipeline      | 5     | listPipelineIds, getPipelineFull, getJobLog, retryPipeline, triggerPipeline                  |
| Repository    | 3     | getTree, getFile, getBlame                                                                  |
| Artifact      | 3     | listArtifacts, downloadArtifact, deleteArtifacts                                            |
| Issue         | 5     | listIssues, getIssue, createIssue, updateIssue, closeIssue                                  |
| Label         | 2     | listLabels, createLabel                                                                     |
| Release       | 4     | listTags, createTag, deleteTag, createRelease                                               |

`downloadArtifact` and `getJobLog` return job log text (this client cannot fetch a raw CI artifact zip, only the job log/trace), each capped to the last N lines.

## File Structure

```
gitlab/
├── Dockerfile              # Multi-stage build, Node 24 Alpine, port 3000
├── package.json            # @gitbeaker/rest, @speedwave/mcp-shared
├── tsconfig.json           # extends ../tsconfig.base.json
├── vitest.config.ts        # coverage thresholds (lines 100 / functions 100 / branches 90 / statements 100)
└── src/
    ├── index.ts            # MCP server bootstrap (auth, tool registration, health check)
    ├── client.ts           # GitLabClient class: @gitbeaker/rest wrapper + initializeGitLabClient()
    ├── tool-names.ts        # SSOT for tool names referenced by client teaching messages and other tools' _meta
    ├── identity-scopes.ts   # SSOT for the assigned_to_me/created_by_me/all scope filter
    └── tools/               # Tool definitions with handlers (per domain) + validation.ts + test-helpers.ts
```

## Token Configuration

### Token File (`/tokens/token`)

The worker reads a single line containing a GitLab Personal Access Token (PAT). Recommended scopes: `api` (or `read_repository`/`write_repository` for a narrower grant).

### Host URL (`/tokens/host_url`)

Optional single-line file containing the GitLab instance URL (e.g. `https://gitlab.example.com`). Falls back to the `GITLAB_URL` environment variable, then `https://gitlab.com`.

## Build & Run

### Build

```bash
cd <repo>/mcp-servers
docker build -f gitlab/Dockerfile -t speedwave/mcp-gitlab:latest .
```

### Health Check

```bash
curl http://localhost:3000/health
# → { "status": "ok" }
```

## References

- **GitLab API**: https://docs.gitlab.com/ee/api/
- **@gitbeaker/rest**: https://github.com/jdalrymple/gitbeaker
- **MCP Spec**: https://modelcontextprotocol.io/
- **Speedwave Architecture**: `docs/architecture/README.md`

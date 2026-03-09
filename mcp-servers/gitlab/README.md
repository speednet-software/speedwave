# MCP GitLab Worker

Isolated GitLab MCP server with per-service token isolation for Speedwave.

## Architecture

- **Port**: 3004 (internal Docker network)
- **Transport**: Streamable HTTP (MCP spec 2025-03-26)
- **Token Source**: `/tokens/token` (RO mount)
- **Host URL**: `/project/project.json` (gitlab.url field)
- **Client Library**: @gitbeaker/rest v41.0.0

## Security Model

**Blast Radius Containment**:

- ONLY has access to GitLab tokens
- No access to Slack, SharePoint, Redmine, or other service tokens
- Compromise of this worker only exposes GitLab credentials

**Defense Layers**:

- Origin validation (CVE-SPEED-001 fix)
- Rate limiting (100 req/min per session)
- Input validation (tool name, session ID)
- Error sanitization (no internal path leaks)
- Non-root user in container
- Read-only token mounts

## Tools (18 Total)

### Projects (3 tools)

- `list_projects` - List GitLab projects with search/filters
- `show_project` - Get project details
- `search_code` - Search code across projects

### Merge Requests (7 tools)

- `list_merge_requests` - List MRs with filters
- `show_merge_request` - Get MR details
- `create_merge_request` - Create new MR
- `approve_merge_request` - Approve MR
- `merge_merge_request` - Merge MR (with squash/auto-merge options)
- `update_merge_request` - Update MR (title/description/labels/state)
- `get_mr_changes` - Get MR diff/changes

### Commits (2 tools)

- `list_branch_commits` - List commits on branch
- `get_commit_diff` - Get commit diff

### Pipelines (4 tools)

- `list_pipelines` - List pipelines with status/ref filters
- `show_pipeline` - Get pipeline details + jobs
- `get_job_log` - Get job log output (with tail support)
- `retry_pipeline` - Retry failed pipeline

### Tags & Releases (2 tools)

- `create_tag` - Create Git tag
- `create_release` - Create release from tag

## File Structure

```
gitlab/
├── Dockerfile (57 lines)           # Multi-stage build, Node 24 Alpine
├── package.json (27 lines)         # @gitbeaker/rest, express, cors
├── tsconfig.json (20 lines)        # ES2022, NodeNext modules
└── src/
    ├── index.ts (725 lines)        # Express server, 18 tool definitions
    ├── client.ts (496 lines)       # GitLabClient class, @gitbeaker/rest wrapper
    └── mcp/                         # Shared MCP infrastructure
        ├── index.ts (9 lines)      # Re-exports
        ├── types.ts (152 lines)    # MCP protocol types
        ├── jsonrpc.ts (190 lines)  # JSON-RPC 2.0 handler
        ├── security.ts (173 lines) # Origin validation, rate limiting
        ├── session.ts (85 lines)   # Session management
        └── sse.ts (93 lines)       # Server-Sent Events streaming

Total: 1,923 lines of TypeScript
```

## Usage

### Build

```bash
cd /workspace/core/runtime/speedwave/mcp-servers
docker build -f gitlab/Dockerfile -t speedwave/mcp-gitlab:latest .
```

### Run (Standalone)

```bash
docker run -d \
  --name mcp-gitlab \
  -p 3004:3004 \
  -v /path/to/tokens:/tokens:ro \
  -v /path/to/project.json:/project/project.json:ro \
  speedwave/mcp-gitlab:latest
```

### Health Check

```bash
curl http://localhost:3004/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "mcp-gitlab",
  "version": "0.55.0",
  "tools": ["list_projects", "show_project", ...],
  "toolCount": 18
}
```

### MCP Request (JSON-RPC 2.0)

```bash
curl -X POST http://localhost:3004/ \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'
```

## Token Configuration

### Token File (`/tokens/token`)

```bash
# GitLab Personal Access Token (PAT)
# Scopes: api, read_repository, write_repository
glpat-xxxxxxxxxxxxxxxxxxxx
```

### Project Configuration (`/project/project.json`)

```json
{
  "gitlab": {
    "url": "https://gitlab.example.com"
  }
}
```

If `gitlab.url` is not present, defaults to `https://gitlab.com`.

## Client Methods

All methods from `src/client.ts`:

**Projects**:

- `listProjects(options?)` → `GitLabProject[]`
- `showProject(projectId)` → `GitLabProject`
- `searchCode(query, options?)` → `unknown[]`

**Merge Requests**:

- `listMergeRequests(projectId, options?)` → `GitLabMergeRequest[]`
- `showMergeRequest(projectId, mrIid)` → `GitLabMergeRequest`
- `createMergeRequest(projectId, options)` → `GitLabMergeRequest`
- `approveMergeRequest(projectId, mrIid)` → `void`
- `mergeMergeRequest(projectId, mrIid, options?)` → `GitLabMergeRequest`
- `updateMergeRequest(projectId, mrIid, options)` → `GitLabMergeRequest`
- `getMrChanges(projectId, mrIid)` → `unknown`

**Commits**:

- `listBranchCommits(projectId, branch, limit?)` → `GitLabCommit[]`
- `getCommitDiff(projectId, commitSha)` → `unknown`

**Pipelines**:

- `listPipelines(projectId, options?)` → `GitLabPipeline[]`
- `showPipeline(projectId, pipelineId)` → `unknown`
- `getJobLog(projectId, jobId, tailLines?)` → `string`
- `retryPipeline(projectId, pipelineId)` → `GitLabPipeline`

**Tags & Releases**:

- `createTag(projectId, options)` → `unknown`
- `createRelease(projectId, options)` → `unknown`

## Docker Compose Integration

Add to project's `docker-compose.yml`:

```yaml
services:
  mcp-gitlab:
    build:
      context: ~/.speedwave/speedwave/mcp-servers
      dockerfile: gitlab/Dockerfile
    container_name: speedwave_${PROJECT_NAME}_mcp_gitlab
    networks:
      - speedwave_network
    volumes:
      - ~/.speedwave/tokens/${PROJECT_NAME}:/tokens:ro
      - ~/.speedwave/config/${PROJECT_NAME}/project.json:/project/project.json:ro
    environment:
      - PORT=3004
      - NODE_ENV=production
    healthcheck:
      test: ['CMD', 'curl', '-sf', 'http://localhost:3004/health']
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped
```

## Logs

```bash
# Container logs
docker logs speedwave_PROJECT_mcp_gitlab

# Follow logs
docker logs -f speedwave_PROJECT_mcp_gitlab

# Last 50 lines
docker logs --tail 50 speedwave_PROJECT_mcp_gitlab
```

## Testing

```bash
# Test connection
curl http://localhost:3004/health

# Test origin validation (should FAIL with 403)
curl -X POST http://localhost:3004/ \
  -H "Origin: http://evil.com" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Test tools/list
curl -X POST http://localhost:3004/ \
  -H "Origin: http://localhost" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Test list_projects
curl -X POST http://localhost:3004/ \
  -H "Origin: http://localhost" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "list_projects",
      "arguments": {"limit": 5}
    },
    "id": 1
  }'
```

## Version History

- **v0.55.0** (2025-11-27) - Initial release
  - 18 GitLab tools
  - @gitbeaker/rest v41.0.0
  - Streamable HTTP transport
  - Security model v2.0 (origin validation, rate limiting)

## References

- **GitLab API**: https://docs.gitlab.com/ee/api/
- **@gitbeaker/rest**: https://github.com/jdalrymple/gitbeaker
- **MCP Spec**: https://modelcontextprotocol.io/
- **Speedwave Architecture**: /workspace/core/docs/ARCHITECTURE.md
- **MCP Implementation**: /workspace/core/docs/MCP.md

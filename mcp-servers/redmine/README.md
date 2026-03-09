# MCP Redmine Worker

Isolated Redmine MCP server with per-service token isolation for Speedwave.

## Overview

**Version**: 0.55.0  
**Port**: 3003 (internal Docker network)  
**Protocol**: MCP 2025-03-26 (Streamable HTTP)

This worker provides **15 Redmine tools** via the Model Context Protocol:

- 6 issue operations (list, show, search, create, update, comment)
- 3 time entry operations (list, create, update)
- 3 journal operations (list, update, delete)
- 3 user operations (list, resolve, getMappings)

## Architecture

### Security Model

**Blast Radius Containment**:

- ONLY has access to Redmine API key (mounted RO from `/tokens/api_key`)
- No access to other service tokens (Slack, SharePoint, etc.)
- If compromised, only Redmine data is exposed

**Token Isolation**:

```
Host:           ~/.speedwave/tokens/PROJECT/api_key [600]
Container:      /tokens/api_key [RO mount]
Process:        Read-only, cannot modify tokens
```

**Configuration**:

```
Host:           ~/.speedwave/config/PROJECT/project.json
Container:      /project/project.json [RO mount]
Contains:       Redmine URL, mappings (status, priority, tracker, activity)
```

### Network Isolation

- Internal Docker network only (no external ports)
- Accessed via `http://mcp-redmine:3003` from Claude container
- Origin validation (CVE-SPEED-001 fix)
- Rate limiting: 100 requests/minute per session

## Tools Reference

### Issue Operations

#### 1. listIssues

List Redmine issues with optional filters.

**Parameters**:

- `project_id` (string, optional): Filter by project ID/identifier
- `assigned_to_id` (string/number, optional): Filter by user ('me' for current user)
- `status_id` (string, optional): Filter by status ('open', 'closed', '\*')
- `parent_id` (number, optional): Filter by parent issue
- `limit` (number, optional): Max results (1-100, default 25)
- `offset` (number, optional): Pagination offset (default 0)

**Example**:

```json
{
  "project_id": "my-project",
  "assigned_to_id": "me",
  "status_id": "open",
  "limit": 50
}
```

#### 2. showIssue

Get detailed information about a specific issue.

**Parameters**:

- `issue_id` (number, required): Issue ID
- `include` (array, optional): Data to include: journals, attachments, relations, children, watchers

#### 3. searchIssues

Search issues by text query.

**Parameters**:

- `query` (string, required): Search query
- `project_id` (string, optional): Limit to specific project
- `limit` (number, optional): Max results (default 25)

#### 4. createIssue

Create a new issue.

**Parameters**:

- `project_id` (string, required): Project ID/identifier
- `subject` (string, required): Issue title
- `description` (string, optional): Textile markup description
- `tracker_id` (number, optional): Tracker ID (Bug, Feature, etc.)
- `status_id` (number, optional): Status ID
- `priority_id` (number, optional): Priority ID
- `assigned_to_id` (number, optional): Assigned user ID
- `parent_issue_id` (number, optional): Parent issue (for subtasks)
- `estimated_hours` (number, optional): Estimated hours

#### 5. updateIssue

Update an existing issue.

**Parameters**:

- `issue_id` (number, required): Issue ID to update
- All optional: `subject`, `description`, `tracker_id`, `status_id`, `priority_id`, `assigned_to_id`, `parent_issue_id`, `estimated_hours`, `notes`

#### 6. commentIssue

Add a comment to an issue.

**Parameters**:

- `issue_id` (number, required): Issue ID
- `comment` (string, required): Comment text (Textile markup)

### Time Entry Operations

#### 7. listTimeEntries

List time entries with optional filters.

**Parameters**:

- `issue_id` (number, optional): Filter by issue
- `project_id` (string, optional): Filter by project
- `user_id` (number, optional): Filter by user
- `from` (string, optional): From date (YYYY-MM-DD)
- `to` (string, optional): To date (YYYY-MM-DD)
- `limit` (number, optional): Max results (default 25)

#### 8. createTimeEntry

Log time on an issue or project.

**Parameters**:

- `hours` (number, required): Hours spent
- `issue_id` (number, optional): Issue ID (if not project-level)
- `project_id` (string, optional): Project ID (if not issue-level)
- `activity_id` (number, optional): Activity ID
- `comments` (string, optional): Time entry comments
- `spent_on` (string, optional): Date (YYYY-MM-DD, default today)

#### 9. updateTimeEntry

Update an existing time entry.

**Parameters**:

- `time_entry_id` (number, required): Time entry ID
- `hours` (number, optional): Updated hours
- `activity_id` (number, optional): Updated activity
- `comments` (string, optional): Updated comments

### Journal Operations

#### 10. listJournals

List all journals (comments/updates) for an issue.

**Parameters**:

- `issue_id` (number, required): Issue ID

#### 11. updateJournal

Update an existing journal entry.

**Parameters**:

- `issue_id` (number, required): Issue ID
- `journal_id` (number, required): Journal ID
- `notes` (string, required): Updated notes (Textile markup)

#### 12. deleteJournal

Delete a journal entry.

**Parameters**:

- `issue_id` (number, required): Issue ID
- `journal_id` (number, required): Journal ID to delete

### User Operations

#### 13. listUsers

List users (optionally filtered by project membership).

**Parameters**:

- `project_id` (string, optional): Filter by project membership

#### 14. resolveUser

Resolve user identifier to user ID.

**Parameters**:

- `identifier` (string, required): User identifier ('me', user ID, or username)

**Returns**: `{ user_id: number | null }`

#### 15. getMappings

Get project-specific Redmine ID mappings.

**Returns**:

```json
{
  "status_new": 1,
  "status_in_progress": 2,
  "status_resolved": 3,
  "priority_normal": 4,
  "priority_high": 5,
  "tracker_bug": 1,
  "tracker_feature": 2,
  "activity_development": 9,
  "activity_testing": 10,
  ...
}
```

## File Structure

```
redmine/
├── package.json              # Dependencies (express, cors, axios)
├── tsconfig.json             # TypeScript config (ES2022, NodeNext)
├── Dockerfile                # Multi-stage build (Alpine, port 3003)
├── README.md                 # This file
├── src/
│   ├── index.ts              # Main server (739 LOC)
│   ├── client.ts             # Redmine API client (488 LOC)
│   └── mcp/                  # MCP infrastructure (702 LOC)
│       ├── index.ts          # Module exports
│       ├── types.ts          # MCP protocol types (152 LOC)
│       ├── jsonrpc.ts        # JSON-RPC 2.0 handler (190 LOC)
│       ├── security.ts       # Security (origin validation, rate limiting) (173 LOC)
│       ├── session.ts        # Session management (85 LOC)
│       └── sse.ts            # Streamable HTTP/SSE (93 LOC)
└── dist/                     # Compiled JavaScript
```

**Total**: 1,929 lines of TypeScript

## Development

### Build

```bash
cd /workspace/core/runtime/speedwave/mcp-servers/redmine
npm install
npm run build
```

### Run Locally

```bash
# Set environment variables
export PORT=3003
export TOKENS_DIR=/path/to/tokens
export PROJECT_CONFIG=/path/to/project.json

# Start server
npm start
```

### Test Health Endpoint

```bash
curl http://localhost:3003/health
```

**Expected**:

```json
{
  "status": "ok",
  "service": "mcp-redmine",
  "version": "0.55.0",
  "tools": ["listIssues", "showIssue", ...]
}
```

### Test MCP Endpoint

```bash
curl -X POST http://localhost:3003/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'
```

## Docker Build

```bash
cd /workspace/core/runtime/speedwave/mcp-servers
docker build -f redmine/Dockerfile -t speedwave/mcp-redmine:0.55.0 .
```

## Dependencies

- **express** ^4.18.2 - HTTP server
- **cors** ^2.8.5 - CORS middleware
- **axios** ^1.6.0 - HTTP client (Redmine REST API)
- **typescript** ^5.3.0 - TypeScript compiler

## Configuration Files

### /tokens/api_key

```
YOUR_REDMINE_API_KEY_HERE
```

### /project/project.json

```json
{
  "redmine": {
    "url": "https://redmine.example.com",
    "mappings": {
      "status_new": 1,
      "status_in_progress": 2,
      "status_resolved": 3,
      "status_feedback": 4,
      "status_closed": 5,
      "status_rejected": 6,
      "priority_low": 3,
      "priority_normal": 4,
      "priority_high": 5,
      "priority_urgent": 6,
      "priority_immediate": 7,
      "tracker_bug": 1,
      "tracker_feature": 2,
      "tracker_task": 3,
      "tracker_support": 4,
      "activity_design": 8,
      "activity_development": 9,
      "activity_testing": 10,
      "activity_documentation": 11,
      "activity_support": 12,
      "activity_management": 13,
      "activity_devops": 14,
      "activity_review": 15
    }
  }
}
```

## Error Handling

All tools return structured errors:

**Success**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"issue\":{\"id\":123,...}}"
    }
  ]
}
```

**Error**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Authentication failed. Check your Redmine API key."
    }
  ],
  "isError": true
}
```

**Error Messages**:

- `Authentication failed. Check your Redmine API key.` (HTTP 401)
- `Permission denied.` (HTTP 403)
- `Resource not found.` (HTTP 404)
- `Validation error: {...}` (HTTP 422)
- `Network error. Check your Redmine URL.` (connection failed)

## Security Features

1. **Token Isolation**: API key read from RO mount, never exposed in responses
2. **Input Validation**: Textile markup sanitization (XSS prevention)
3. **Origin Validation**: Only internal Docker network allowed (CVE-SPEED-001 fix)
4. **Rate Limiting**: 100 requests/minute per session
5. **Error Sanitization**: No internal details in error messages
6. **Session Management**: Cryptographic UUID v4 session IDs
7. **Retry Logic**: Exponential backoff (3 retries, 1s → 2s → 4s)

## Troubleshooting

### Token Not Found

```
❌ Redmine: Failed to initialize: Token not found: /tokens/api_key
```

**Solution**: Mount token file to `/tokens/api_key` with chmod 600

### Invalid Config

```
❌ Redmine: Failed to initialize: Unexpected token
```

**Solution**: Check `/project/project.json` is valid JSON

### Authentication Failed

```
Authentication failed. Check your Redmine API key.
```

**Solution**: Verify API key in Redmine (My account → API access key)

### Network Error

```
Network error. Check your Redmine URL.
```

**Solution**: Verify `redmine.url` in project.json is accessible

## License

Apache-2.0 — see [LICENSE](../../LICENSE) at the repository root.

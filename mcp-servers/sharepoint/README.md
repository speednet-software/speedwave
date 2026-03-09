# MCP SharePoint Worker

Isolated SharePoint/Microsoft Graph API MCP server with per-service token isolation.

## Overview

This worker provides SharePoint integration for Speedwave's MCP architecture:

- **Port**: 3002 (internal Docker network)
- **Transport**: Streamable HTTP (MCP 2025-03-26)
- **Tools**: `list_files`, `sync`, `get_current_user`
- **Security**: Token isolation, origin validation, rate limiting

## Architecture

```
mcp-hub (port 4000)
    └─> HTTP bridge ─> mcp-sharepoint (port 3002)
                          └─> Microsoft Graph API
```

## Security Model

### Token Isolation

- **ONLY** has access to SharePoint tokens (`/tokens/`)
- Cannot access Slack, Redmine, or other service tokens
- Blast radius containment: compromise only exposes SharePoint

### Defense Layers

1. **File system**: Tokens mounted read-only from host
2. **Network isolation**: Docker network isolation (MCP servers run in isolated Docker network)
3. **Rate limiting**: 100 requests/minute per session
4. **Input validation**: Path traversal protection
5. **Error sanitization**: No internal details exposed

## Tools

### 1. `list_files`

List files and folders in SharePoint context directory.

**Parameters**:

- `path` (string, optional): Relative path within context directory

**Example**:

```json
{
  "name": "list_files",
  "arguments": {
    "path": "Documents/Project"
  }
}
```

**Response**:

```json
{
  "files": [
    {
      "name": "requirements.md",
      "path": "Documents/Project/requirements.md",
      "size": 4096,
      "lastModified": "2025-01-15T10:30:00Z",
      "isFolder": false,
      "webUrl": "https://..."
    }
  ]
}
```

### 2. `sync`

Upload/sync a local file to SharePoint with optional ETag Compare-And-Swap.

**Parameters**:

- `localPath` (string, required): Local file path to upload
- `sharepointPath` (string, required): Destination path in SharePoint
- `expectedEtag` (string, optional): Expected ETag for CAS
- `createOnly` (boolean, optional): Only create if doesn't exist
- `overwrite` (boolean, optional): Overwrite without ETag check

**Example**:

```json
{
  "name": "sync",
  "arguments": {
    "localPath": "/workspace/docs/plan.md",
    "sharepointPath": "Documents/plan.md",
    "createOnly": true
  }
}
```

**Response**:

```json
{
  "success": true,
  "etag": "W/\"abc123\"",
  "size": 2048
}
```

### 3. `get_current_user`

Get information about the authenticated SharePoint user.

**Parameters**: None

**Example**:

```json
{
  "name": "get_current_user",
  "arguments": {}
}
```

**Response**:

```json
{
  "displayName": "Alice Smith",
  "email": "alice@example.com",
  "userPrincipalName": "alice@example.com",
  "id": "abc-123-def-456"
}
```

## Token Configuration

Tokens must be mounted from host to `/tokens/` with these files:

| File            | Description            | Example                                   |
| --------------- | ---------------------- | ----------------------------------------- |
| `access_token`  | OAuth access token     | `eyJ0eXAiOiJKV1QiLCJub...`                |
| `refresh_token` | OAuth refresh token    | `0.AXcAaB3...`                            |
| `client_id`     | Azure AD app client ID | `abc-123-def-456`                         |
| `tenant_id`     | Azure AD tenant ID     | `xyz-789-uvw-012`                         |
| `site_id`       | SharePoint site ID     | `contoso.sharepoint.com,abc,def`          |
| `base_path`     | Context directory path | `Shared Documents/Projects/SpeedwaveCore` |

## Setup

### 1. Install Dependencies

```bash
cd mcp-servers/sharepoint
npm install
```

### 2. Build TypeScript

```bash
npm run build
```

### 3. Create Tokens Directory

```bash
mkdir -p /tmp/tokens
echo "your-access-token" > /tmp/tokens/access_token
echo "your-refresh-token" > /tmp/tokens/refresh_token
echo "your-client-id" > /tmp/tokens/client_id
echo "your-tenant-id" > /tmp/tokens/tenant_id
echo "your-site-id" > /tmp/tokens/site_id
echo "Shared Documents/Projects" > /tmp/tokens/base_path
chmod 600 /tmp/tokens/*
```

### 4. Run Server

```bash
export TOKENS_DIR=/tmp/tokens
export PORT=3002
npm start
```

## Docker Build

```bash
# From mcp-servers/ directory
docker build -f sharepoint/Dockerfile -t speedwave/mcp-sharepoint:latest .
```

## Testing

### Health Check

```bash
curl http://localhost:3002/health
```

Expected:

```json
{
  "status": "ok",
  "service": "mcp-sharepoint",
  "version": "0.55.0",
  "tools": ["list_files", "sync", "get_current_user"]
}
```

### Tool Invocation

```bash
curl -X POST http://localhost:3002/ \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'
```

## OAuth Token Refresh

The client automatically refreshes the access token when it expires (401 response):

1. Detects 401 Unauthorized
2. Calls OAuth refresh endpoint
3. Updates `access_token` (and optionally `refresh_token`)
4. Retries original request
5. Saves new tokens to `/tokens/` (if mount allows)

## Error Handling

All errors are sanitized before returning to client:

- File paths removed (`/path/to/file.ts` → `[file]`)
- Line numbers removed (`:123:45` → removed)
- Stack traces truncated (max 200 chars)

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Failed to list files"
  }
}
```

## Development

### Watch Mode

```bash
npm run watch
```

### Type Checking

```bash
npx tsc --noEmit
```

## MCP Protocol Compliance

- **Specification**: 2025-03-26
- **Transport**: Streamable HTTP (POST / with optional SSE)
- **JSON-RPC**: 2.0
- **Session Management**: `Mcp-Session-Id` header
- **Origin Validation**: Required (CVE-SPEED-001 fix)

## License

Apache-2.0 — see [LICENSE](../../LICENSE) at the repository root.

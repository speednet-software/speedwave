# MCP SharePoint Worker - File Structure

## Overview

Complete MCP SharePoint worker implementation with 1,308 lines of TypeScript code.

## Directory Structure

```
sharepoint/
├── package.json              # NPM dependencies (express, cors)
├── tsconfig.json             # TypeScript config (ES2022, NodeNext)
├── Dockerfile                # Alpine Node 24, port 3002
├── README.md                 # Documentation (tools, setup, testing)
├── .gitignore                # Node modules, dist, logs
│
└── src/
    ├── index.ts              # Main Express server (200 LOC)
    │                         #   - Port 3002
    │                         #   - Origin validation
    │                         #   - Tool registration
    │                         #   - Streamable HTTP
    │
    ├── client.ts             # SharePoint Graph API client (353 LOC)
    │                         #   - OAuth token refresh
    │                         #   - Path validation
    │                         #   - Tools: listFiles, syncFile, getCurrentUser
    │                         #   - Token persistence
    │
    └── mcp/
        ├── index.ts          # MCP exports (10 LOC)
        ├── types.ts          # MCP protocol types (153 LOC)
        ├── jsonrpc.ts        # JSON-RPC 2.0 handler (191 LOC)
        ├── security.ts       # Security functions (174 LOC)
        ├── session.ts        # Session management (86 LOC)
        └── sse.ts            # Streamable HTTP (94 LOC)
```

## File Descriptions

### Configuration Files

#### package.json

- **Version**: 0.55.0
- **Dependencies**: express, cors
- **DevDependencies**: @types/node, @types/express, @types/cors, typescript
- **Scripts**: build, watch, start, dev

#### tsconfig.json

- **Target**: ES2022
- **Module**: NodeNext (native ESM)
- **Strict**: true
- **Output**: ./dist/

#### Dockerfile

- **Base**: node:24-alpine
- **Port**: 3002
- **Healthcheck**: curl http://localhost:3002/health
- **User**: node (non-root)
- **ENV**: PORT=3002, TOKENS_DIR=/tokens

### Source Files

#### src/index.ts (200 LOC)

Main Express server with:

- CORS and JSON middleware
- Origin validation (CVE-SPEED-001 fix)
- Health endpoint (`GET /health`)
- MCP endpoint (`POST /` with Streamable HTTP)
- Tool registration (list_files, sync, get_current_user)

#### src/client.ts (353 LOC)

SharePoint/Graph API client with:

- OAuth token refresh on 401
- Path traversal protection
- Graph API calls with retry logic
- Tools:
  - `listFiles(params)` - List files/folders
  - `syncFile(params)` - Upload with ETag CAS
  - `getCurrentUser()` - User info
- Token persistence to `/tokens/`

#### src/mcp/types.ts (153 LOC)

MCP protocol TypeScript types:

- JSON-RPC 2.0 base types
- MCP protocol types (2025-03-26)
- Tool definitions
- Session types
- SSE event types

#### src/mcp/jsonrpc.ts (191 LOC)

JSON-RPC 2.0 message handler:

- Request validation
- Method routing (initialize, tools/list, tools/call)
- Error handling with sanitization
- Session management integration
- Rate limiting integration

#### src/mcp/security.ts (174 LOC)

Security functions:

- Token loading from `/tokens/`
- Origin validation (DNS rebinding protection)
- JSON-RPC message validation
- Error sanitization (no internal details)
- Session ID validation (UUID v4)
- Tool name validation
- Rate limiter (100 req/min)

#### src/mcp/session.ts (86 LOC)

Session management:

- Cryptographic session IDs (crypto.randomUUID)
- 30-minute timeout
- Automatic cleanup
- Session tracking

#### src/mcp/sse.ts (94 LOC)

Streamable HTTP (SSE):

- SSE stream initialization
- Message/batch sending
- Error handling
- Standard JSON response fallback

#### src/mcp/index.ts (10 LOC)

Re-exports all MCP infrastructure

## Token Configuration

Required tokens in `/tokens/`:

| File            | Description         | Example                                   |
| --------------- | ------------------- | ----------------------------------------- |
| `access_token`  | OAuth access token  | `eyJ0eXAiOiJKV1Qi...`                     |
| `refresh_token` | OAuth refresh token | `0.AXcAaB3...`                            |
| `client_id`     | Azure AD app ID     | `abc-123-def-456`                         |
| `tenant_id`     | Azure AD tenant ID  | `xyz-789-uvw-012`                         |
| `site_id`       | SharePoint site ID  | `contoso.sharepoint.com,abc,def`          |
| `base_path`     | Context directory   | `Shared Documents/Projects/SpeedwaveCore` |

## Tools

### 1. list_files

- **Parameters**: `path` (optional)
- **Returns**: Array of SharePointFile objects
- **Security**: Path traversal protection

### 2. sync

- **Parameters**: `localPath`, `sharepointPath`, `expectedEtag` (optional), `createOnly` (optional), `overwrite` (optional)
- **Returns**: `{ success, etag, size }`
- **Features**: ETag Compare-And-Swap, automatic folder creation

### 3. get_current_user

- **Parameters**: None
- **Returns**: User object (displayName, email, userPrincipalName, id)

## Security Features

1. **Token Isolation**: Only SharePoint tokens, no other services
2. **Origin Validation**: CVE-SPEED-001 fix (reject without Origin)
3. **Rate Limiting**: 100 requests/minute per session
4. **Input Validation**: Path traversal, tool name, session ID
5. **Error Sanitization**: No file paths, line numbers, stack traces
6. **Read-Only Mounts**: Tokens mounted RO (blast radius containment)
7. **Non-Root User**: Runs as `node` user in container
8. **OAuth Refresh**: Automatic token refresh on expiration

## Build Process

1. **Install**: `npm ci`
2. **Build**: `npm run build` (TypeScript → JavaScript)
3. **Prune**: `npm prune --omit=dev` (remove dev dependencies)
4. **Docker**: Multi-stage build (builder + production)

## Compliance

- **MCP Specification**: 2025-03-26
- **Transport**: Streamable HTTP (POST / with optional SSE)
- **JSON-RPC**: 2.0
- **Session Management**: `Mcp-Session-Id` header
- **Origin Validation**: Required

## Lines of Code

| File                | LOC       | Purpose                     |
| ------------------- | --------- | --------------------------- |
| src/index.ts        | 200       | Main server                 |
| src/client.ts       | 353       | Graph API client            |
| src/mcp/types.ts    | 153       | Protocol types              |
| src/mcp/jsonrpc.ts  | 191       | Message handler             |
| src/mcp/security.ts | 174       | Security functions          |
| src/mcp/session.ts  | 86        | Session management          |
| src/mcp/sse.ts      | 94        | Streamable HTTP             |
| src/mcp/index.ts    | 10        | Exports                     |
| **Total**           | **1,308** | **Complete implementation** |

## Testing

### Syntax Check

```bash
cd sharepoint
npm install
npx tsc --noEmit
```

### Build

```bash
npm run build
```

### Run

```bash
export TOKENS_DIR=/path/to/tokens
npm start
```

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

## Integration

This worker integrates with:

1. **mcp-hub**: HTTP bridge on internal Docker network
2. **SharePoint**: Microsoft Graph API (graph.microsoft.com)
3. **Docker Compose**: Service `mcp-sharepoint:3002`

## Status

✅ **Complete** - All files created with production-ready implementations

- No placeholders
- No TODOs
- Full error handling
- Complete security model
- Comprehensive documentation

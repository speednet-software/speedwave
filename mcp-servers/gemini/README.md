# MCP Gemini Worker

AI-powered chat using Gemini CLI.

## Overview

The MCP Gemini Worker provides secure, isolated access to Google's Gemini AI models through a single universal chat interface. Gemini automatically decides when to use Google Search based on your prompt, making it a versatile tool for:

- AI-powered conversations and analysis
- Code review and codebase questions
- Requirements analysis and document review
- Research with automatic web search when needed

## Architecture

```
mcp-hub (code-executor)
    ↓ HTTP bridge
mcp-gemini:3005
    ↓ child_process
Gemini CLI (gemini)
    ↓ API
Google AI API
```

## Security Model

### Token Isolation

- **ONLY** has access to Gemini API key (`/tokens/api_key`)
- NO access to other service tokens (Slack, SharePoint, etc.)
- Blast radius containment: compromise only exposes Gemini API

### File System Security

- Workspace mounted **read-only** at `/workspace`
- No direct file access - context passed as text
- Secure context processing

### Network Security

- Origin validation (CVE-SPEED-001 fix)
- Rate limiting per session
- No external ports exposed (internal network only)

## Tools

### chat

AI-powered chat using Gemini CLI. This is a universal tool that handles all interactions with Gemini AI. Gemini automatically decides when to use Google Search based on your prompt.

**Parameters**:

- `prompt` (required): Your question or instruction
- `context` (optional): Text content to analyze (omit for simple questions)
- `useGrounding` (optional): Set to `true` to force Google Search grounding
- `outputFormat` (optional): "text" | "json" | "markdown" (default: "text")

**Example**:

```json
{
  "prompt": "Find security vulnerabilities in this authentication code",
  "context": "import jwt from 'jsonwebtoken';\n\nfunction login(req, res) {\n  const token = jwt.sign({ user: req.body.username }, 'secret');\n  ...",
  "outputFormat": "markdown"
}
```

**Use Cases**:

- Code analysis and review
- Requirements analysis from Redmine/Jira
- Document review and summarization
- Research questions (Gemini uses Google Search automatically when needed)
- Content consistency checking
- Gap analysis

**Features**:

- **Automatic Google Search**: Gemini decides when to search the web based on your prompt
- **Context-aware**: Provide code, documents, or any text as context
- **Flexible output**: Choose text, JSON, or markdown format

## Configuration

### Environment Variables

| Variable            | Default            | Description                    |
| ------------------- | ------------------ | ------------------------------ |
| `PORT`              | `3005`             | HTTP server port               |
| `TOKENS_DIR`        | `/tokens`          | Token directory (RO mount)     |
| `WORKSPACE_DIR`     | `/workspace`       | Workspace directory (RO mount) |
| `GEMINI_CONFIG_DIR` | `/app/.gemini`     | Gemini CLI config directory    |
| `GEMINI_MODEL`      | `gemini-2.5-flash` | Default Gemini model           |

### Supported Models

- `gemini-2.5-flash` (default)
- `gemini-2.5-pro`
- `gemini-2.5-flash-lite`
- `gemini-2.0-flash`

## Docker Volume Mounts

```yaml
volumes:
  # API key (read-only)
  - ~/.speedwave/tokens/PROJECT/api_key:/tokens/api_key:ro

  # Workspace (read-only)
  - /path/to/workspace:/workspace:ro
```

## API Key Setup

The Gemini API key is read from `/tokens/api_key` and stored securely in `/app/.gemini/.env` with mode `600`.

**Expected token file format**:

```
# /tokens/api_key
AIzaSyD...your-api-key...
```

## CLI Integration

The worker uses the Gemini CLI installed globally via npm:

```bash
npm install -g @google-ai/gemini-cli
```

**CLI invocation**:

```bash
gemini -y -m gemini-2.5-flash -o json -p "Analyze this code @src/"
```

**Features**:

- Automatic retry on rate limiting (max 3 retries)
- Token usage tracking
- JSON output parsing
- Error sanitization

## Rate Limiting

The Gemini CLI automatically handles rate limiting with retry logic:

1. Detect rate limit error: `Please retry in 5.0s`
2. Wait specified duration
3. Retry (max 3 attempts)
4. Fail with error if still rate limited

## Health Check

```bash
curl http://localhost:3005/health
```

**Response**:

```json
{
  "status": "ok",
  "service": "mcp-gemini",
  "version": "0.62.2",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "tools": ["chat"],
  "initialized": true,
  "sessions": 0
}
```

## Development

### Build

```bash
npm run build
```

### Watch Mode

```bash
npm run watch
```

### Start

```bash
npm start
```

## Testing

### Test Health Endpoint

```bash
docker exec speedwave_PROJECT_claude curl http://mcp-gemini:3005/health
```

### Test MCP Endpoint

```bash
docker exec speedwave_PROJECT_claude curl -X POST http://mcp-gemini:3005/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'
```

### Test chat Tool

```bash
docker exec speedwave_PROJECT_claude curl -X POST http://mcp-gemini:3005/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "chat",
      "arguments": {
        "prompt": "Explain how async/await works in JavaScript",
        "outputFormat": "markdown"
      }
    },
    "id": 1
  }'
```

## Error Handling

### Common Errors

| Error                           | Cause                                | Solution                               |
| ------------------------------- | ------------------------------------ | -------------------------------------- |
| `Gemini client not initialized` | CLI not installed or API key invalid | Install CLI, verify API key            |
| `Rate limited`                  | Too many requests                    | Wait and retry automatically handled   |
| `Origin not allowed`            | Invalid origin header                | Use internal network or allowed origin |

## Logs

```bash
# View logs
docker compose logs mcp-gemini

# Follow logs
docker compose logs -f mcp-gemini

# Last 50 lines
docker compose logs --tail=50 mcp-gemini
```

## Version

**Version**: 0.62.2
**MCP Specification**: 2025-03-26
**Gemini CLI**: Latest

## References

- [Gemini AI Documentation](https://ai.google.dev/gemini)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Speedwave Architecture](../../docs/ARCHITECTURE.md)
- [Speedwave MCP Implementation](../../docs/MCP.md)

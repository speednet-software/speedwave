# ADR-035: MCP Spec Compliance — Streamable HTTP Transport

## Status

Accepted

## Context

Speedwave's MCP servers (hub and workers) used a custom HTTP transport with non-standard features: a `category` field on tools for progressive disclosure, per-tool HTTP endpoints, and custom SSE framing. Claude Code updated its MCP client to support the MCP specification 2025-03-26[^1] and 2025-11-25[^2], which define a standard Streamable HTTP transport with JSON-RPC 2.0 batching, session management, and tool annotations.

The non-standard transport caused compatibility issues: Claude Code's newer MCP client rejected connections due to unsupported protocol versions and missing standard endpoints.

## Decision

Migrate all MCP servers to MCP-spec-compliant Streamable HTTP transport:

1. **Single `POST /` endpoint** for all JSON-RPC 2.0 requests (replaces per-tool HTTP endpoints)
2. **`DELETE /` endpoint** for session termination
3. **`GET /health`** for health checks (unchanged)
4. **Session management** via `Mcp-Session-Id` header with server-generated UUIDs
5. **Protocol version negotiation** during `initialize` handshake — server accepts `2024-11-05`, `2025-03-26`, and `2025-11-25`
6. **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) replace the non-standard `category` field
7. **Progressive disclosure** via `search_tools` meta-tool (hub-level) replaces the removed `category` system

## Implementation

### New module: `shared/src/transport.ts`

Implements MCP Streamable HTTP transport utilities shared by all servers:

- `readSessionId(req)` — reads `Mcp-Session-Id` or `x-mcp-session-id` header
- `handleMCPPost(req, res, handler)` — processes single and batched JSON-RPC requests, validates protocol version header, routes to `JSONRPCHandler`
- `handleMCPDelete(req, res)` — terminates sessions per spec
- `createMCPServer(options)` — Express app factory with standard MCP endpoints, health check, and CORS

### Changes to `shared/src/jsonrpc.ts`

- Supports `initialize` / `notifications/initialized` handshake
- Paginated `tools/list` with cursor-based pagination (page size: 100)
- `tools/call` dispatches to registered tool handlers
- `ping` method returns empty result per spec[^3]
- Session state tracking (initialized flag, protocol version)

### Changes to workers

All worker tool definitions updated with `annotations` field (replacing removed `category`). Workers register tools via `createMCPServer()` factory from shared.

### Notification response code

Notifications return **202 Accepted** (not 204 No Content) per MCP spec 2025-11-25 requirement[^4]. This applies to both single notifications and batches containing only notifications.

### Accept header validation

POST requests are validated for Accept header compliance: clients must accept both `application/json` and `text/event-stream` per MCP spec[^5]. Returns 406 Not Acceptable when the Accept header is present but missing either content type. Wildcard `*/*` is accepted per RFC 9110 section 12.5.1[^6]. Initialize requests and requests without an Accept header are exempt from this validation.

### Version negotiation fallback

Server responds with `LATEST_PROTOCOL_VERSION` as fallback for unsupported client versions instead of rejecting with an error. Per MCP spec, servers MUST respond with the version they support rather than failing the handshake[^7].

### Changes to hub

Hub uses `JSONRPCHandler` directly (custom Express setup for meta-tools). Tool discovery from workers uses MCP `initialize` + `tools/list` instead of custom HTTP endpoints.

## Consequences

- All MCP servers are protocol-compliant with MCP spec 2024-11-05, 2025-03-26, and 2025-11-25
- External MCP clients can connect to Speedwave workers using standard MCP libraries
- The non-standard `category` field is removed from all tool definitions
- Progressive disclosure is handled at the hub level via `search_tools`, not per-tool metadata

[^1]: [MCP Specification 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/)

[^2]: [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/)

[^3]: [MCP Specification — Ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping)

[^4]: [MCP Specification 2025-11-25 — Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)

[^5]: [MCP Specification 2025-11-25 — Sending Requests via HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-requests-via-http)

[^6]: [RFC 9110 — Content Negotiation, Section 12.5.1](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.1)

[^7]: [MCP Specification 2025-11-25 — Lifecycle: Initialization](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization)

---
paths:
  - 'mcp-servers/**'
---

# MCP Servers Rules

- `mcp-servers/shared/` is the SSOT for MCP protocol utilities — all servers use it
- MCP Hub is the ONLY MCP server Claude sees (internal port 4000)
- Each MCP worker mounts only its own service credentials at `/tokens` read-only
- Hub has zero tokens — it routes requests to workers

## Test pattern

Follow `mcp-servers/hub/src/tools/gitlab/delete_tag.test.ts` as reference:

- Import `metadata` + `execute` from the handler
- **Metadata tests**: name, category, service, description, keywords, inputSchema (type, properties, required), outputSchema, example, inputExamples, deferLoading
- **Execute success cases**: mock the service client method with `vi.fn()`, verify return value and mock calls
- **Parameter validation**: missing, empty, null, undefined, falsy values
- **Error handling**: Error objects, non-Error with message/description, plain strings, undefined
- **Edge cases**: special characters, nested paths, large numeric IDs

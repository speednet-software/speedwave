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

Follow `mcp-servers/gitlab/src/tools/branch-tools.test.ts` (or `mcp-servers/redmine/src/tools/metadata.test.ts`) as reference:

- Import the worker's tool factory (e.g. `createBranchTools` from `./branch-tools.js`, or `createToolDefinitions` from `./index.js`) plus the types/helpers from `@speedwave/mcp-shared` (`Tool`, `notConfiguredMessage`). Call the factory and resolve each tool's `handler` via `tools.find((t) => t.tool.name === '<name>')?.handler`
- **Metadata tests**: name, description, annotations (readOnlyHint, destructiveHint), keywords, example, inputSchema (type, properties, required), and `_meta.deferLoading`
- **Execute success cases**: mock the service client method with `vi.fn()`, verify return value and mock calls
- **Parameter validation**: missing, empty, null, undefined, falsy values
- **Error handling**: Error objects, non-Error with message/description, plain strings, undefined
- **Edge cases**: special characters, nested paths, large numeric IDs

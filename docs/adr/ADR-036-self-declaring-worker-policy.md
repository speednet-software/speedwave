# ADR-036: Self-Declaring Worker Policy via `_meta`

## Status

Accepted

## Context

The MCP hub maintains a hardcoded `TOOL_POLICIES` map in `hub-tool-policy.ts` with 103 entries across 5 built-in services[^1]. Each entry defines hub-specific operational metadata for a tool:

- `deferLoading` — whether the tool is shown upfront to Claude or deferred behind `search_tools`
- `timeoutClass` — standard or long execution timeout
- `timeoutMs` — custom timeout override in milliseconds
- `osCategory` — OS sub-integration routing (reminders, calendar, mail, notes)

This map must be manually updated whenever a worker adds, removes, or renames a tool — violating DRY and SSOT principles. Workers already declare rich tool metadata (name, description, inputSchema, annotations, keywords) but not policy fields. The hub also maintains a `BUILT_IN_SERVICES` list that creates an artificial distinction between built-in and plugin services, with different discovery paths for each[^2].

## Decision

Workers declare policy metadata on each tool via the MCP specification's `_meta` field[^3]. The hub reads `_meta` from worker tool definitions during discovery and applies sensible defaults when absent. The `TOOL_POLICIES` map, `BUILT_IN_SERVICES` list, and skeleton fallback mechanism are removed entirely.

### Policy fields in `_meta`

Workers declare a `SpeedwaveMeta` structure in each tool's `_meta` field:

```typescript
interface SpeedwaveMeta {
  deferLoading?: boolean; // default: true
  timeoutClass?: 'standard' | 'long'; // default: 'standard'
  timeoutMs?: number; // default: undefined (uses global WORKER_REQUEST_MS)
  osCategory?: 'reminders' | 'calendar' | 'mail' | 'notes'; // default: undefined
}
```

### Default values when `_meta` is absent

| Field          | Default      | Rationale                                                                                         |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `deferLoading` | `true`       | With 100+ tools, showing all by default wastes tokens. Workers must opt in to upfront visibility. |
| `timeoutClass` | `'standard'` | Most tools complete within the standard timeout.                                                  |
| `timeoutMs`    | `undefined`  | Uses the global `WORKER_REQUEST_MS` constant.                                                     |
| `osCategory`   | `undefined`  | Only relevant for the OS service.                                                                 |

### Unified service handling

The hub treats all services identically — no `BUILT_IN_SERVICES` list, no `isPluginService()` check. Discovery follows a single path: fetch `tools/list` from worker, read `_meta`, apply defaults, register tools.

### Skeleton fallback removed

When a worker is unavailable at startup, the hub registers an empty tool set for that service (instead of building skeleton entries from the hardcoded policy map). Background refresh (every 5 minutes) populates tools when the worker becomes available. This is acceptable because a worker that is unavailable cannot serve tool calls regardless of registry state.

## Impact on Plugin Contract

Analyzed against the contract table in CLAUDE.md[^4]:

- **`_meta` is optional** — existing plugins without `_meta` continue working. All tools default to `deferLoading: true` (deferred behind `search_tools`).
- **No breaking changes** — the `speedwave-plugins` repository (presale plugin) does not reference `BUILT_IN_SERVICES`, `isPluginService`, or `hub-tool-policy`. Its use of `_meta` is limited to JSON-RPC session tracking, which is a different concern from tool-level metadata.
- **Behavioral change for plugins**: plugins without `_meta` previously had `deferLoading: false` (all tools shown upfront). After this change, they default to `deferLoading: true`. Plugins that want upfront visibility must add `_meta: { deferLoading: false }` to their tool definitions.

## Consequences

- Workers become the single source of truth for all tool metadata (contract + policy)
- Adding a new tool requires zero hub-side changes
- External MCP servers work without any hub configuration — sensible defaults apply
- The hub has zero hardcoded knowledge about specific tools or services
- Plugin developers must be aware of `_meta.deferLoading` default behavior (documented in `docs/guides/integrations.md`)

[^1]: `mcp-servers/hub/src/hub-tool-policy.ts` — TOOL_POLICIES map with 103 entries

[^2]: `mcp-servers/hub/src/service-list.ts` — BUILT_IN_SERVICES and isPluginService()

[^3]: [MCP Specification — Tool definition, \_meta field](https://modelcontextprotocol.io/specification/2025-11-25/server/tools/)

[^4]: CLAUDE.md — "Contract between Speedwave and plugins" table

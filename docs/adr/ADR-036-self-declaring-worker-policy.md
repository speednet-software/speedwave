# ADR-036: Self-Declaring Worker Policy via `_meta`

> **Status:** Accepted
> **Context:** The MCP hub used to hold a hardcoded per-tool policy map and a built-in/plugin service split, both of which had to be hand-edited whenever a worker changed its tools.

## Decision

Each worker declares its own hub-side policy on every tool through the MCP `_meta` field, and the hub reads it during discovery, applying sensible defaults when `_meta` is absent. The old hardcoded policy map, the built-in-vs-plugin service distinction, and the skeleton-fallback mechanism are gone — workers are the single source of truth for both tool contract and tool policy.

## Why

- The previous design duplicated, in the hub, knowledge that workers already owned. Any tool added, renamed, or removed in a worker forced a manual hub edit, violating DRY/SSOT.
- Built-in and plugin services were discovered along different code paths for no real benefit; a single discovery path is simpler and treats external/third-party MCP servers the same as first-party workers.
- A worker that is unavailable cannot serve tool calls anyway, so building skeleton tool entries from a hardcoded map added complexity without changing observable behavior.

## Policy fields and defaults

Per tool, `_meta` may carry: `deferLoading` (default `true` — the tool is discoverable via `search_tools` but not shown to Claude upfront), `timeoutClass` (`standard` or `long`; standard timeout applies when absent), `timeoutMs` (custom override; falls back to the global worker request timeout when absent), and `osCategory` (`reminders` / `calendar` / `mail` / `notes`, only meaningful for the `os` service). The `deferLoading: true` default keeps token usage low when many tools are registered; a worker opts a tool into upfront visibility with `_meta: { deferLoading: false }`.

## Where it lives in code

- `_meta` merge + defaulting — `mcp-servers/hub/src/tool-discovery.ts` (`mergeToolWithMeta`): reads `_meta`, validates each field, applies the defaults above, and warns when a tool ships no `_meta`.
- Policy fields on the merged tool shape — `mcp-servers/hub/src/hub-types.ts` (`deferLoading`, `timeoutClass`, `timeoutMs`, `osCategory` on `ToolMetadata`).
- Single discovery path / no built-in split — `mcp-servers/hub/src/service-list.ts` now only enumerates enabled services from `ENABLED_SERVICES`; there is no built-in-service list or plugin check.
- Empty-registry-instead-of-skeleton + 5-minute background refresh — `mcp-servers/hub/src/tool-registry.ts`: an unavailable worker leaves an empty registry entry that the periodic refresh populates once the worker comes up.
- `deferLoading` filtering during discovery — `mcp-servers/hub/src/search-tools.ts`.
- Plugin-author guidance — `docs/guides/integrations.md` ("Tool Policy via `_meta`").

## Impact on the plugin contract

- `_meta` is optional. Plugins shipping no `_meta` keep working; all their tools default to `deferLoading: true`.
- Behavioral change: before this ADR, plugins without policy data effectively showed tools upfront; now they default to deferred. A plugin wanting immediate visibility sets `_meta: { deferLoading: false }` on the relevant tools.
- No plugin references the removed hub internals, so this is not a breaking change to the contract surface in CLAUDE.md.

## Consequences

- Adding or changing a worker tool needs zero hub-side edits.
- External MCP servers work against the hub with no per-tool configuration — defaults apply.
- The hub holds no hardcoded knowledge of any specific tool or service.

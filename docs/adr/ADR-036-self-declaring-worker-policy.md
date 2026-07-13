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

Per tool, `_meta` may carry the MCP-spec-compliant prefixed keys[^1] from mcp-shared's `META_KEYS`: `speedwave.pl/defer-loading` (default `true`; the tool is discoverable via `search_tools` but not shown to Claude upfront), `speedwave.pl/timeout-class` (`standard` or `long`; standard timeout applies when absent), `speedwave.pl/timeout-ms` (custom override; falls back to the global worker request timeout when absent), `speedwave.pl/os-category` (`reminders` / `calendar` / `mail` / `notes`, only meaningful for the `os` service), and the identity trio `speedwave.pl/user-scoped`, `speedwave.pl/current-user-tool`, `speedwave.pl/self-param` (see [ADR-079](./ADR-079-identity-metadata-and-teaching-errors.md)). The `speedwave.pl/defer-loading: true` default keeps token usage low when many tools are registered; a worker opts a tool into upfront visibility with `_meta: { [META_KEYS.DEFER_LOADING]: false }`. Each prefixed key is read via `metaValue(meta, META_KEYS.X, 'legacyKey')`, which falls back to the matching unprefixed legacy key (`deferLoading`, `timeoutClass`, `timeoutMs`, `osCategory`, `userScoped`, `currentUserTool`, `selfParam`) so third-party plugin workers still emitting the old shape keep working.

## Where it lives in code

- `_meta` key SSOT: `mcp-servers/shared/src/meta-keys.ts` (`META_KEYS`, `metaValue`).
- `_meta` merge + defaulting: `mcp-servers/hub/src/tool-discovery.ts` (`mergeToolWithMeta`), which reads `_meta`, validates each field, applies the defaults above, and warns when a tool ships no `_meta`.
- Policy fields on the merged tool shape: `mcp-servers/hub/src/hub-types.ts` (`deferLoading`, `timeoutClass`, `timeoutMs`, `osCategory`, `userScoped`, `currentUserTool`, `selfParam` on `ToolMetadata`).
- Single discovery path / no built-in split: `mcp-servers/hub/src/service-list.ts` now only enumerates enabled services from `ENABLED_SERVICES`; there is no built-in-service list or plugin check.
- Empty-registry-instead-of-skeleton + 5-minute background refresh: `mcp-servers/hub/src/tool-registry.ts`. An unavailable worker leaves an empty registry entry that the periodic refresh populates once the worker comes up.
- `deferLoading` filtering during discovery: `mcp-servers/hub/src/search-tools.ts`.

## Impact on the plugin contract

- `_meta` is optional. Plugins shipping no `_meta` keep working; all their tools default to `deferLoading: true`.
- Behavioral change: before this ADR, plugins without policy data effectively showed tools upfront; now they default to deferred. A plugin wanting immediate visibility sets `_meta: { [META_KEYS.DEFER_LOADING]: false }` on the relevant tools.
- No plugin references the removed hub internals, so this is not a breaking change to the contract surface in CLAUDE.md.

## Consequences

- Adding or changing a worker tool needs zero hub-side edits.
- External MCP servers work against the hub with no per-tool configuration — defaults apply.
- The hub holds no hardcoded knowledge of any specific tool or service.

[^1]: [MCP specification 2025-06-18, Basic Protocol, "`_meta`"](https://modelcontextprotocol.io/specification/2025-06-18/basic): the `_meta` property is reserved by MCP for attaching additional metadata, with a defined prefix/name key format for implementation-specific keys.

# ADR-103: Custom MCP Tool Gate and Definition Pinning

> **Status:** Accepted
> **Date:** 2026-10-08
> **Context:** A Custom MCP server (ADR-100) lists its own tools through `tools/list` and executes `tools/call`[^1]. Its descriptions reach the model and its tools act with the user's credentials, and the specification tells clients to treat tool annotations from untrusted servers as untrusted[^1]. The user must decide per tool, and a tool whose definition changes after that decision must not keep the decision.

## Decision

1. **Decisions are per tool and pinned to the definition.** The user config keeps `tools: {<upstream name>: {state, definition_hash}}` with `state` ∈ `allowed`/`blocked`/`pending` (`custom_mcp/model.rs`). `definition_hash` is `sha256:` over the canonical JSON of the tool definition (`custom_mcp::policy::definition_hash`, keys sorted recursively), computed identically in Rust and in the guard's TypeScript; a shared fixture of vectors (`mcp-servers/shared/test/fixtures/definition-hash.json`) is read by both test suites. Tool decisions and egress domains are outside the consent digest, so they change without a new approval or a restart.

2. **The guard enforces them.** The Desktop writes `guard/policy.json` (`GuardPolicy`, re-read by the guard on every request, only that exact file name); the renderer writes an empty policy only when none exists and never overwrites one. The guard answers only `initialize`, `ping`, `tools/list` and `tools/call`; it lists a tool only with a decision, treats a definition whose hash differs from the approved one as `pending`, passes `tools/call` only for `allowed`, caps result and description sizes, strips upstream `_meta`, and sets the tool state for the hub through its own `_meta` key. A missing or unparsable policy denies everything (last good copy otherwise).

3. **The hub hides what the guard would refuse.** The hub drops tools that are not `allowed` when it merges a service's tools, so `search_tools` and the sandbox never offer them, and writes each service's raw tool catalog to `/audit/tool-catalog-<service>.json` for the Desktop review, which recomputes the hashes itself.

4. **PII stays tokenized by default.** Each Custom MCP service gets an explicit `pii_mode` in the hub's resolved policy (`ResolvedPiiPolicy::services`, ADR-083/084): `tokens` unless the user chose `plaintext` for that server or the organization forces a mode. Changing it changes the policy digest and recreates the hub.

## Consequences

- Denying a tool takes effect at the guard within a policy re-read; allowing one becomes visible in the hub at its next catalog refresh.
- A server update that changes a definition silently becomes `pending` for that tool until the user reviews it.

## Amendment (2026-10-12): an allowed tool reaches the hub within about 30 seconds

The hub's full background refresh runs every 5 minutes, so "visible at its next catalog refresh" could mean a 5-minute wait after the user allowed a tool. The hub now refreshes the `custom-*` services on a second interval of `CUSTOM_REFRESH_MS` (30 s), next to the full refresh (`mcp-servers/hub/src/tool-registry.ts::_startBackgroundRefresh`); the interval is started only when a custom service is enabled. Both intervals share one in-progress guard, so a tick that finds a refresh still running is skipped instead of overlapping it. An allowed tool therefore becomes visible in `search_tools` and the sandbox within about 30 seconds; a denied tool is still refused by the guard at the next `tools/call`, before the hub catches up. A refresh that fails keeps the service's last known tools (ADR-036 amendment of the same date), so a guard restart never hides the tools the user already allowed.

## Amendment (2026-10-12): the definition hash covers `outputSchema`

A tool may declare an `outputSchema`, and a client that receives one is told to validate structured results against it[^2]. Agents read it through `search_tools full_schema` and write sandbox code against it, so a server that changes it changes what the approved tool returns. The hashed document is now `{name, description, inputSchema, annotations, outputSchema}`, with an absent `outputSchema` hashed as `null` like the other optional fields (`mcp-servers/shared/src/tool-gate.ts::definitionHashInput`, `crates/speedwave-runtime/src/custom_mcp/policy.rs::definition_hash`):

- Changing only the `outputSchema` of an allowed tool makes it `changed`, like any other drift.
- The guard exposes the upstream `outputSchema` (validated like `inputSchema`: an object without `__proto__` keys that canonical JSON can encode, or the tool is dropped), the hub writes it into the tool catalog, and Desktop's catalog reader recomputes the hash with it (`custom_mcp/catalog.rs`). The definition stored in the guard policy carries it, so the offline listing keeps the approved hash.
- Every existing hash changes with the document, so a decision recorded before this amendment shows as `changed` once and needs one review. This lands before the feature ships, so no released decision is affected.

[^1]: Model Context Protocol specification 2025-06-18, Tools: `tools/list`, `tools/call`, and "clients MUST consider tool annotations to be untrusted unless they come from trusted servers". https://modelcontextprotocol.io/specification/2025-06-18/server/tools

[^2]: Model Context Protocol specification 2025-06-18, Tools, "Output Schema": "If an output schema is provided: Servers MUST provide structured results that conform to this schema. Clients SHOULD validate structured results against this schema." https://modelcontextprotocol.io/specification/2025-06-18/server/tools#output-schema

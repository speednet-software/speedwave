# ADR-079: Identity Metadata Trio and the Teaching-Error Contract

**Status:** Accepted

**Date:** 2026-07-10

## Context

Every built-in worker exposes some tools whose result, or an accepted parameter, depends on the identity of the authenticated caller ("my open issues", "MRs assigned to me", assigning a Jira issue to yourself). Each underlying API resolves that identity differently: Atlassian's `getMyself`, SharePoint's and Slack's and GitHub's `getCurrentUser`, Redmine's `resolveUser` with `identifier: "me"`, or a plain `"me"` value accepted inline by the tool's own parameter. Before this decision there was no declared link between a user-scoped tool and the helper (tool or parameter) that resolves that identity, so a model calling a user-scoped tool without first resolving "me" had no structured guidance toward the fix, only whatever a tool's free-text description happened to mention.

Separately, workers built validation-error messages ad hoc: some named the offending parameter and a next step, others returned a bare upstream error string. A model retrying a failed call could not reliably learn what to change.

## Decision

### Identity metadata trio

A tool declares up to three `_meta` keys via mcp-shared's `META_KEYS` ([ADR-036]), each an MCP-spec `_meta` key in the `speedwave.pl/` prefix namespace[^1]:

- `speedwave.pl/user-scoped` (boolean): the tool's result set, or an accepted parameter, depends on the authenticated caller's identity. This covers both read tools ("my X" queries) and write tools with an assignee-style parameter.
- `speedwave.pl/current-user-tool` (string): the name of a sibling tool in the same worker that resolves the caller's identity without an explicit id (e.g. `getCurrentUser`).
- `speedwave.pl/self-param` (string): a short hint naming the input parameter and value that let the caller reference themselves inline instead of a two-call round trip (e.g. Redmine's `"assigned_to: 'me'"`[^2], GitLab's `"scope: 'assigned_to_me' | 'created_by_me'"`[^3]). It is free text for the rendered description, but its leading identifier must name a real parameter in the tool's `inputSchema`.

A `user-scoped` tool is expected to declare at least one of `current-user-tool` or `self-param`, and both companions are validated at discovery in `discoverAndMergeService` (`mcp-servers/hub/src/tool-discovery.ts`): `dropDanglingCurrentUserTool` drops a `currentUserTool` pointer that names a tool absent from the service's discovered set, `dropDanglingSelfParam` drops a `self-param` whose leading parameter name is not an input parameter of the declaring tool (each logging a warning), and `warnMissingIdentityCompanion` warns once per tool when a user-scoped tool ends up with neither companion. The tool keeps serving: `renderDescriptionWithIdentity` (`mcp-servers/hub/src/search-tools.ts`) appends the "Results depend on the authenticated user." sentence, followed by the pointer-specific guidance for a correctly configured tool, or by a short misconfiguration hint ("No self-reference helper is configured for this tool") when neither companion is set. The identity sentence renders at both the `with_descriptions` and `full_schema` `search_tools` detail levels, and user-scoped tools are boosted for self-reference queries like "me".

### Teaching-error contract

A tool-validation failure returned to Claude follows a fixed shape via mcp-shared's `teachingErrorResult` / `teachingToolResult` / `missingParamResult` (`mcp-servers/shared/src/teaching-errors.ts`): what was wrong with the parameter (including the received value), which tool or parameter supplies a correct value, and the concrete next step, in that order, so a model can self-correct instead of guessing or retrying blindly. The echoed "received" value is truncated at `MAX_RECEIVED_LENGTH` (200 characters) with a trailing `...` marker, so an oversized or adversarially-crafted parameter value cannot inflate context on every failed retry.

This is the contract for new validation/teaching-error paths: missing or malformed parameters, not-found lookups with a recovery hint, numeric-id rejection. A worker's own upstream-API error formatter (e.g. a REST client's `formatError`) migrates to the shared shape as it is touched, not in one bulk pass; `.claude/rules/mcp-servers.md` states this as the present rule for new code.

## Why

- A hardcoded per-tool policy map in the hub already proved unmaintainable ([ADR-036]); embedding identity-resolution guidance in free-text tool descriptions with no structure repeats that mistake at the sentence level instead of the schema level.
- Dropping a dangling `currentUserTool` pointer or `self-param` at discovery, before any `search_tools` call, stops the hub from ever advertising an identity helper that does not exist. Because `self-param` values are descriptive hints (`"assigned_to: 'me'"`), the check validates the hint's leading identifier against the tool's declared input parameters rather than requiring a bare parameter name.
- A degrade-gracefully outcome (serve the tool with a weaker hint) was chosen over rejecting the tool outright: a worker author's `_meta` mistake should not silently remove a tool from the catalog Claude can call.
- A fixed three-part error shape gives a struggling model the same self-correction pattern regardless of which worker it is calling, instead of relearning each worker's error prose.

## Where it lives in code

- `mcp-servers/shared/src/meta-keys.ts`: `META_KEYS.USER_SCOPED` / `CURRENT_USER_TOOL` / `SELF_PARAM`, and `metaValue()`'s prefixed-then-legacy read order.
- `mcp-servers/shared/src/teaching-errors.ts`: `teachingErrorResult`, `teachingToolResult`, `missingParamResult`, `MAX_RECEIVED_LENGTH`.
- Discovery-time pointer validation: `mcp-servers/hub/src/tool-discovery.ts` (`dropDanglingCurrentUserTool`, `dropDanglingSelfParam`, `warnMissingIdentityCompanion`).
- Rendering into `search_tools` output: `mcp-servers/hub/src/search-tools.ts` (`renderDescriptionWithIdentity`, `buildSearchResult`).
- Per-worker adoption: gitlab, github, redmine, atlassian, slack, sharepoint each declare the trio on their identity-dependent tools; see [Identity-first behavior](../guides/integrations.md#identity-first-behavior) for the current per-service tool names.

## Consequences

- A model asking "my X" gets a structured pointer to the right identity-resolution call for that specific worker, instead of a worker-specific free-text convention it has to have seen before.
- A worker author who wires a `currentUserTool` pointer to a nonexistent tool, a `self-param` to a nonexistent parameter, or no companion at all finds out at discovery, via the warnings logged there. Either way the tool keeps serving with the identity sentence (plus a misconfiguration hint in the no-companion case) rather than breaking silently or disappearing.
- Adoption of the teaching-error shape is incremental across workers; a caller can still see a raw upstream error message from a worker error path that has not been migrated yet.
- Third-party plugin workers emitting the legacy unprefixed `_meta` keys (`userScoped`, `currentUserTool`, `selfParam`) keep working via `metaValue`'s fallback; new tool code uses the prefixed `META_KEYS` form.

## Footnotes

[^1]: Model Context Protocol specification, "General fields, `_meta`": the `_meta` property's key-name format (optional dot-separated label prefix followed by a slash, then a name). <https://modelcontextprotocol.io/specification/2025-11-25/basic#_meta>

[^2]: Redmine REST API, "Issues" wiki: `assigned_to_id` filter accepts `'me'` to fetch issues assigned to the logged-in user (API key or HTTP auth). <https://www.redmine.org/projects/redmine/wiki/Rest_Issues>

[^3]: GitLab REST API, "Merge requests" docs: the `scope` parameter accepts `created_by_me`, `assigned_to_me`, `reviews_for_me`, or `all`. <https://docs.gitlab.com/api/merge_requests/>

[ADR-036]: ADR-036-self-declaring-worker-policy.md

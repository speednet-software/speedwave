# ADR-053: Worker Implementation Policy — Own Thin Worker vs Wrapping an Official MCP Server

**Status:** Accepted

**Date:** 2026-05-11

## Context

Speedwave's external integrations are containerized MCP workers behind the hub (token-free Claude → hub:4000 → worker → service API). There are two ways such a worker has been built so far, and the choice has never been written down:

1. **Own thin worker** — a small TypeScript service in `mcp-servers/<svc>/` that imports the service's official client SDK, exposes a curated set of tools via `@speedwave/mcp-shared`'s `createMCPServer`, reads its credential from `/tokens:ro`, and is tested with vitest. This is how `slack`, `sharepoint`, `redmine`, and `gitlab` are built. The SDK does the heavy lifting (auth, pagination, rate-limit handling); the worker is glue: ~40 tool definitions mapping onto `client.<resource>.<method>(...)`.
2. **Wrap an official upstream MCP server** — ship a thin `package.json` that pins the official package plus a Containerfile that runs it. This is how `playwright` is built: `mcp-servers/playwright/package.json` is 14 lines pinning `@playwright/mcp`, and the Containerfile is ~125 lines (base image, one `npm install -g`, one `sed` patch for an upstream heartbeat incompatibility, and a `CMD` invoking the installed binary). Zero custom MCP logic, zero custom tool definitions.[^1][^2]

The trigger for writing this down is the GitHub integration (issue `SPW-7`). Unlike GitLab/Slack/Redmine — for which no official MCP server exists (only community/archived servers in the `modelcontextprotocol/servers` repository) — GitHub publishes an **official** MCP server: `github/github-mcp-server`. It is MIT-licensed, ships a Docker image (`ghcr.io/github/github-mcp-server`) and a Go binary, runs in local mode over stdio with a Personal Access Token in the `GITHUB_PERSONAL_ACCESS_TOKEN` env var, exposes ~110 tools across ~21 toolsets (issues, PRs, repos, Actions, code/secret scanning, discussions, gists, projects, …), and supports `--read-only` and `--toolsets a,b,c` to narrow the exposed surface. Its Go library API is explicitly marked unstable.[^3][^4]

So "just write an own worker like GitLab" is no longer the obvious answer for GitHub, and the question generalizes: **for any future integration, when do we build our own worker, and when do we wrap an official upstream MCP server?**

## Decision

**Default: build an own thin worker** (TypeScript + the service's official client SDK, the `mcp-servers/gitlab/` pattern).

**Wrap an official upstream MCP server only when ALL of the following hold:**

1. **An official MCP server exists, is mature, and is actively maintained by the owner of the service** — not a community fork, not an archived repository.
2. **It fits the stack technologically** — distributed as an npm/TypeScript package (like `@playwright/mcp`), so it lives inside `mcp-servers/` without introducing a second language toolchain or runtime.
3. **It is generic infrastructure, not a domain integration** — e.g. browser automation, consumed by multiple plugins and by Claude directly; integrating with a specific product API (GitHub, GitLab, Slack) is a domain integration, not infrastructure.
4. **Wrapping costs ≤ ~100 lines** — a Containerfile plus a pinned dependency, with no substantial patching needed to bend the upstream server to Speedwave's hub/transport/credential model.

### Application to GitHub

The criterion is **not met**: condition (2) fails — `github-mcp-server` is a Go binary, not an npm package, so wrapping it adds a Go toolchain to an otherwise all-TypeScript `mcp-servers/` directory — and condition (3) fails — integrating with the GitHub API is a domain integration, not generic infrastructure. Independently of the four-point gate, the following make an own worker the better choice (ordered by weight):

- **(a) Control over tool names.** An own worker keeps the repo's naming convention — camelCase, no service prefix, as `gitlab` uses (`listProjectIds`, `getMrFull`, `searchCode`, `listMrIds`).[^5] `github-mcp-server` uses its own convention (`issue_write`, `pull_request_read`), inconsistent with every other Speedwave worker.
- **(b) `_meta` per ADR-036.** Speedwave workers declare per-tool policy in the MCP `_meta` field (`deferLoading`, `timeoutClass`, …); ADR-036 removed the hub-side `TOOL_POLICIES` map and `BUILT_IN_SERVICES` list in favor of self-declaring workers.[^6] `github-mcp-server` does not declare `_meta`, so its ~110 tools would all fall to the `deferLoading: true` default (none shown upfront to Claude, all behind `search_tools`), or the hub would need a per-tool override map for that one service — re-introducing exactly the hardcoded knowledge ADR-036 eliminated.
- **(c) Consistent auth, secrets, and observability.** An own worker reads its token from `/tokens:ro` like every other worker, logs in the shared `@speedwave/mcp-shared` format, and is debugged by reading `src/`. A wrapped Go binary uses its own log format and flags; debugging an integration failure means reading upstream's output rather than stepping through our code.
- **(d) No second protocol/process to map.** An own worker speaks JSON-RPC directly to the hub via `createMCPServer`. Wrapping a third-party MCP means owning its protocol quirks and lifecycle — see ADR-039, where `@playwright/mcp`'s default Streamable-HTTP heartbeat had to be `sed`-patched out at image build time because it did not fit the hub's request-response cycle.[^7]
- **(e) Change cadence.** `github-mcp-server`'s library API is explicitly "unstable"; an upstream major bump to its tool surface becomes Speedwave's problem (Claude suddenly sees a different tool set).

The tool **count** ("~110 tools") is deliberately *not* an argument against wrapping — `--toolsets`/`--read-only` let the wrapper narrow it. It is mentioned here only to be set aside.

→ **GitHub gets an own thin worker, `mcp-servers/github/`, built on `@octokit/rest` (with `@octokit/plugin-throttling` and `@octokit/plugin-retry`), mirroring `mcp-servers/gitlab/`.**

### Retroactive explanation of existing workers

- `slack`, `sharepoint`, `redmine`, `gitlab` — **own workers**, because no official MCP server exists for them (only community/archived servers).
- `playwright` — **wrapped** (`@playwright/mcp`), because it satisfies all four conditions: official (Microsoft), npm package, generic infrastructure shared across plugins, ~125-line Containerfile.[^1][^2]
- `os` — neither; it is a host process per platform (ADR-010, ADR-013), out of scope of this policy.

## Rejected alternatives

- **A — Wrap `github/github-mcp-server`.** Rejected for reasons (a)–(e) above: Go toolchain inconsistent with the all-TypeScript `mcp-servers/`, upstream tool-naming convention, no `_meta` declarations, upstream log format/observability, a second protocol and lifecycle to own, and an "unstable" upstream API. The tool count is explicitly *not* part of this rejection — upstream supports narrowing it.
- **B — Use the remote hosted GitHub MCP server (`https://api.githubcopilot.com/mcp/`).** Rejected: it is designed around browser-based OAuth 2.1 + PKCE (integrated into Copilot IDEs); using it headless means sending the PAT as a bearer header to a GitHub-operated endpoint and depending on that hosted service's availability. Both contradict Speedwave's token-free-hub model and the self-contained-container posture (the hub has zero tokens; a worker holds only its own credential, mounted read-only).[^4]
- **C — Use raw `fetch`/`axios` against the GitHub REST API instead of Octokit.** Rejected: it re-implements Link-header pagination, primary and secondary rate-limit handling, retry/backoff, and loses the OpenAPI-generated TypeScript types — well over the ~100-line "stop and reconsider" threshold, and a known footgun (a cluster of ReDoS advisories in `@octokit/*` in Feb–Mar 2025 was in exactly the Link-header / auth-header parsing regexes — evidence to *pin and audit a maintained parser*, not to hand-roll one).[^8][^9][^10] Octokit provides pagination, throttling, and retry as official plugins.[^11][^12][^13]

## Consequences

**Positive.**

- One implementation pattern for all domain integrations — a contributor who understands `mcp-servers/gitlab/` understands `mcp-servers/github/`.
- Full control over tool names and response shapes; `_meta` per ADR-036 works without special-casing.
- The full GitHub API stays reachable for future needs (`octokit.graphql(...)` for nested-data queries that REST would split into many round-trips).[^14]
- A written criterion ends the "own vs wrap" debate for the next integration instead of re-litigating it each time.

**Negative.**

- More code to write and maintain than wrapping would require — ~40 tool definitions mapping onto `octokit.rest.*`, plus their tests.
- `@octokit/*` packages must be pinned (≥ the post-Feb-2025 patched versions) and kept current via `make audit`.[^9][^10]
- Speedwave does not benefit from the ~110 tools the official server ships; the GitHub worker's surface is whatever we choose to expose.

**Neutral.**

- "KISS — prefer existing tools over reimplementing" (CLAUDE.md) pulls toward wrapping. But Octokit *is* the existing tool here — the wheel we are not reinventing is pagination and rate-limit handling, which Octokit's plugins provide, not the GitHub API itself; mapping ~40 tools onto `octokit.rest.*` is glue, not a reimplementation. The Octokit ReDoS advisories are an argument *for pinning and auditing*, not an argument for or against Octokit per se.

## Sources

[^1]: `mcp-servers/playwright/package.json` in this repository — 14-line thin wrapper pinning `@playwright/mcp`.

[^2]: `mcp-servers/playwright/Containerfile` in this repository — base image, single `npm install -g`, single `sed` patch, `CMD` invoking the binary. Documented in ADR-039.

[^3]: GitHub official MCP server — repository, toolsets, `--read-only`/`--toolsets` flags, local (stdio + PAT) vs remote modes, MIT license, "Go library API is unstable" note: <https://github.com/github/github-mcp-server>

[^4]: GitHub Docs — "Set up the GitHub MCP Server" (local mode `GITHUB_PERSONAL_ACCESS_TOKEN`; remote endpoint `https://api.githubcopilot.com/mcp/` with OAuth 2.1 + PKCE or PAT bearer): <https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server>; Remote GitHub MCP Server GA announcement (2025-09-04): <https://github.blog/changelog/2025-09-04-remote-github-mcp-server-is-now-generally-available/>

[^5]: `mcp-servers/gitlab/src/tools/index.ts` in this repository — tools declared in camelCase with no service prefix (`listProjectIds`, `getMrFull`, `searchCode`, `listMrIds`).

[^6]: ADR-036 — Self-Declaring Worker Policy via `_meta` (per-tool `deferLoading`/`timeoutClass`/`timeoutMs`/`osCategory`; removal of the hub `TOOL_POLICIES` map and `BUILT_IN_SERVICES` list): `docs/adr/ADR-036-self-declaring-worker-policy.md`; MCP specification `_meta` field: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools/>

[^7]: ADR-039 — Playwright Shared Browser Service (the `sed` patch disabling `@playwright/mcp`'s Streamable-HTTP heartbeat at image build time, acknowledged as deliberate tech debt pending an upstream `--no-heartbeat` flag): `docs/adr/ADR-039-playwright-shared-browser-service.md`

[^8]: GitHub REST API best practices — Link-header pagination, conditional requests, primary and secondary rate limits: <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>; rate-limit details: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>

[^9]: GHSA-h5c3-5r3r-rr8q — ReDoS in `@octokit/plugin-paginate-rest` Link-header parsing (`paginate.iterator()`), fixed in 9.2.2 / 11.4.1: <https://github.com/advisories/GHSA-h5c3-5r3r-rr8q>

[^10]: GHSA-x4c5-c7rf-jjgv — ReDoS in `@octokit/endpoint` (`endpoint.parse()`), fixed in 9.0.6 / 10.1.3: <https://github.com/octokit/endpoint.js/security/advisories/GHSA-x4c5-c7rf-jjgv>; GHSA-xx4v-prfh-6cgc — ReDoS in `@octokit/request-error` via crafted `Authorization` header, fixed in 5.1.1 / 6.1.7: <https://github.com/octokit/request-error.js/security/advisories/GHSA-xx4v-prfh-6cgc>

[^11]: Octokit — GitHub's official JavaScript/TypeScript SDK (MIT), `@octokit/rest` / `@octokit/core` / `@octokit/graphql`: <https://github.com/octokit/octokit.js>

[^12]: `@octokit/plugin-throttling` — rate-limit handling per GitHub's guidelines (requires `onRateLimit` / `onSecondaryRateLimit` handlers): <https://github.com/octokit/plugin-throttling.js>

[^13]: `@octokit/plugin-retry` — automatic retry of transient request errors: <https://github.com/octokit/plugin-retry.js>; `@octokit/plugin-paginate-rest` — `octokit.paginate()` / `octokit.paginate.iterator()`: <https://github.com/octokit/plugin-paginate-rest.js>

[^14]: GitHub Docs — comparing the REST and GraphQL APIs (GraphQL fetches nested/related data in one request where REST needs several): <https://docs.github.com/en/rest/about-the-rest-api/comparing-githubs-rest-api-and-graphql-api>

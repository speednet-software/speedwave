---
paths:
  - 'mcp-servers/**'
---

# MCP Servers Rules

- `mcp-servers/shared/` is the SSOT for MCP protocol utilities — every built-in worker uses it, with one exception: `playwright` wraps Microsoft's `@playwright/mcp` and does not consume mcp-shared.
- MCP Hub is the ONLY MCP server Claude sees (internal port 4000); workers listen on port 3000 (`consts::PORT_WORKER`). Each worker mounts only its own credentials at `/tokens:ro`; the hub holds no external credentials.
- **New integration = own thin TypeScript worker by default:** built on `@speedwave/mcp-shared` + the service's official SDK (else thin axios), camelCase unprefixed tool names, `_meta.deferLoading` where applicable. Wrapping an upstream MCP server is allowed only when ALL four hold: official and owner-maintained, an npm/TS package, generic infrastructure (not a domain API), wrappable in ≤~100 lines. Only `playwright` qualifies today.
- OAuth-consuming workers never write tokens — refresh lives in the host-side `oauth` worker; use `authedRequest` from mcp-shared for every authenticated request. The `oauth` worker is never enumerated to Claude / never in the hub registry — do not wire it into `WORKER_*_URL` discovery (see security rules).
- **Slack OAuth invariants** (`mcp-servers/oauth/src/providers/slack.ts`): refresh tokens are single-use and rotate on every refresh, so the oauth worker serializes `refresh` per service (a rate-limited call with a still-valid token is a success-noop); the token exchange reads ONLY `authed_user.*` (a top-level `access_token` is a bot token — the app is user_scope-only, never request bot scopes); refresh state is persisted before the mounted access token so a crash never leaves a token without refresh state. A "fix" to a refresh race or "adding bot features" that breaks any of these breaks every Slack install's token chain.

## Adding a built-in worker touches many places — checklist

`consts.rs` service descriptor (`TOGGLEABLE_MCP_SERVICES`, resources on the descriptor) + `BUILT_IN_SERVICE_IDS` · `build.rs::IMAGES` entry with `hash_inputs` + `${IMAGE_*}` placeholder + resource placeholders in `compose.template.yml` + bundle-script list (all test-guarded) · `tzdata` in the image (MANUAL — nothing catches a miss) · hub env `WORKER_<SVC>_URL` wiring · optional `containers/claude-resources/*/integrations/<config_key>/` resources (+ BATS on/off test in `_tests/entrypoint/entrypoint.bats`) · user docs. Grep an existing worker (e.g. `redmine`) end-to-end rather than trusting this list to be exhaustive.

## Test pattern

Follow `mcp-servers/gitlab/src/tools/branch-tools.test.ts` (or `redmine/src/tools/metadata.test.ts`):

- Import the tool factory, resolve handlers via `tools.find((t) => t.tool.name === '<name>')?.handler`.
- Metadata tests: name, description, annotations (readOnlyHint, destructiveHint), keywords, example, inputSchema, `_meta.deferLoading`.
- Execute success cases (mock the client with `vi.fn()`), parameter validation (missing/empty/null/undefined/falsy), error handling (Error, non-Error shapes, strings, undefined), edge cases (special characters, nested paths, large IDs).

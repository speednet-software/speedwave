---
paths:
  - 'mcp-servers/**'
---

# MCP Servers Rules

- `mcp-servers/shared/` is the SSOT for MCP protocol utilities: every built-in worker uses it, with one exception, `playwright` wraps Microsoft's `@playwright/mcp` and does not consume mcp-shared.
- MCP Hub is the ONLY MCP server Claude sees (internal port 4000); workers listen on port 3000 (`consts::PORT_WORKER`). Each worker mounts only its own credentials at `/tokens:ro`; the hub holds no external credentials.
- **New integration = own thin TypeScript worker by default:** built on `@speedwave/mcp-shared` + the service's official SDK (else thin axios), camelCase unprefixed tool names, `_meta` policy keys where applicable. Wrapping an upstream MCP server is allowed only when ALL four hold: official and owner-maintained, an npm/TS package, generic infrastructure (not a domain API), wrappable in ≤~100 lines. Only `playwright` qualifies today.
- OAuth-consuming workers never write tokens: refresh lives in the host-side `oauth` worker; use `authedRequest` from mcp-shared for every authenticated request. The `oauth` worker is never enumerated to Claude, never in the hub registry, and must never be wired into `WORKER_*_URL` discovery (see security rules).
- **Slack OAuth invariants** (`mcp-servers/oauth/src/providers/slack.ts`): refresh tokens are single-use and rotate on every refresh, so the oauth worker serializes `refresh` per service (a rate-limited call with a still-valid token is a success-noop); the token exchange reads ONLY `authed_user.*` (a top-level `access_token` is a bot token, the app is user_scope-only, never request bot scopes); refresh state is persisted before the mounted access token so a crash never leaves a token without refresh state. A "fix" to a refresh race or "adding bot features" that breaks any of these breaks every Slack install's token chain.

## `_meta` keys: SSOT and identity contract

Tool `_meta` fields use MCP-spec-compliant prefixed keys from mcp-shared's `META_KEYS`: `speedwave.pl/defer-loading`, `speedwave.pl/timeout-class`, `speedwave.pl/timeout-ms`, `speedwave.pl/os-category`, plus the identity trio `speedwave.pl/user-scoped`, `speedwave.pl/current-user-tool`, `speedwave.pl/self-param`. Read every key via `metaValue(meta, META_KEYS.X, 'legacyKey')`: prefixed key wins if present, else fall back to the legacy unprefixed key (`deferLoading`, `userScoped`, …) so third-party plugin workers still emitting the old shape keep working. Never hand-write a `_meta` key string; import `META_KEYS`.

A tool whose result depends on the caller's identity (a "my X" question) MUST declare `speedwave.pl/user-scoped: true`, and any worker exposing user-scoped tools MUST also expose a current-user tool (its name declared via `speedwave.pl/current-user-tool` on the user-scoped tools, or a self-reference param via `speedwave.pl/self-param`). The hub renders this into the tool's `full_schema` description automatically and boosts user-scoped tools for self-reference queries (e.g. "me") in `search_tools`.

## Error and pagination contract

Every tool error goes through mcp-shared's `teachingErrorResult`: it states what was wrong with a parameter, which tool provides a correct value, and the suggested next step, in that order, so a model can self-correct instead of guessing. Every paginated `limit`/`pageSize`-style param is clamped with `clampPageSize` (finite positive integer, defaults on missing/NaN/non-numeric, capped at the tool's max) rather than a hand-rolled bound check.

**No silent partial effect:** a tool call that partially succeeds (e.g. some items of a batch updated, some rejected) must say so in its result, never return a bare success for a partial outcome. Silent partial success is indistinguishable from full success to the calling model and to the user.

## Adding a built-in worker touches many places (checklist)

`consts.rs` service descriptor (`TOGGLEABLE_MCP_SERVICES`, resources on the descriptor) + `BUILT_IN_SERVICE_IDS` · `build.rs::IMAGES` entry with `hash_inputs` + `${IMAGE_*}` placeholder + resource placeholders in `compose.template.yml` + bundle-script list (all test-guarded) · `tzdata` in the image (MANUAL, nothing catches a miss) · hub env `WORKER_<SVC>_URL` wiring · optional `containers/claude-resources/*/integrations/<config_key>/` resources (+ BATS on/off test in `_tests/entrypoint/entrypoint.bats`) · user docs. Grep an existing worker (e.g. `redmine`) end-to-end rather than trusting this list to be exhaustive.

## Test pattern

Follow `mcp-servers/gitlab/src/tools/branch-tools.test.ts` (or `redmine/src/tools/metadata.test.ts`):

- Import the tool factory, resolve handlers via `tools.find((t) => t.tool.name === '<name>')?.handler`.
- Metadata tests: name, description, annotations (readOnlyHint, destructiveHint), keywords, example, inputSchema, `_meta` policy keys (via `metaValue`, prefixed and legacy).
- Execute success cases (mock the client with `vi.fn()`), parameter validation (missing/empty/null/undefined/falsy), error handling (Error, non-Error shapes, strings, undefined), edge cases (special characters, nested paths, large IDs).

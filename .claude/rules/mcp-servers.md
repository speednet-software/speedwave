---
paths:
  - 'mcp-servers/**'
---

# MCP Servers Rules

- `mcp-servers/shared/` is the SSOT for MCP protocol utilities: every built-in worker uses it, with one exception, `playwright` wraps Microsoft's `@playwright/mcp` and does not consume mcp-shared.
- MCP Hub is the ONLY MCP server Claude sees (internal port 4000); workers listen on port 3000 (`consts::PORT_WORKER`). Each worker mounts only its own credentials at `/tokens:ro`; the hub holds no external credentials.
- **New integration = own thin TypeScript worker by default:** built on `@speedwave/mcp-shared` + the service's official SDK (else thin axios), camelCase unprefixed tool names, `_meta` policy keys where applicable. Wrapping an upstream MCP server is allowed only when ALL four hold: official and owner-maintained, an npm/TS package, generic infrastructure (not a domain API), wrappable in ≤~100 lines. Only `playwright` qualifies today.
- OAuth-consuming workers never write tokens: refresh lives in the host-side `oauth` worker; use `authedRequest` from mcp-shared for every authenticated request. The `oauth` worker is never enumerated to Claude, never in the hub registry, and must never be wired into `WORKER_*_URL` discovery (see security rules).
- **Slack OAuth invariants:** the initial PKCE token exchange (`desktop/src-tauri/src/slack_oauth_cmd.rs`) reads ONLY `authed_user.*` (a top-level `access_token` is a bot token; the app is user_scope-only, never request bot scopes). The host-side refresh (`mcp-servers/oauth/src/providers/slack.ts`): refresh tokens are single-use and rotate on every refresh, so the oauth worker serializes `refresh` per service (a rate-limited call with a still-valid token is a success-noop), and refresh state is persisted before the mounted access token so a crash never leaves a token without refresh state. A "fix" to a refresh race or "adding bot features" that breaks any of these breaks every Slack install's token chain.
- **`mcp-servers/policies/` (`@speedwave/policy-engine`) is a hub-consumed library, not a worker.** It has no `image`/compose service of its own; only `mcp-hub` (via `hub/src/policy.ts`) links against it. `templates/*.yaml` is a Rust↔TS shared surface: both `pii_policy.rs` (`include_str!`) and the TS `template-loader.ts` read the same files, so a template edit changes both sides. See [ADR-080](../../docs/adr/ADR-080-policy-engine-pii-tokenization.md). It also ships a prebuilt WASM artifact (`crates/pii-engine-wasm`, built by `build-wasm.sh` into `policies/wasm-pkg/` and copied into the hub image) that no TS code consumes yet — see F3.4.

## `_meta` keys: SSOT and identity contract

Tool `_meta` fields use MCP-spec-compliant prefixed keys from mcp-shared's `META_KEYS`: `speedwave.pl/defer-loading`, `speedwave.pl/timeout-class`, `speedwave.pl/timeout-ms`, `speedwave.pl/os-category`, plus the identity trio `speedwave.pl/user-scoped`, `speedwave.pl/current-user-tool`, `speedwave.pl/self-param`. Read every key via `metaValue(meta, META_KEYS.X, 'legacyKey')`: prefixed key wins if present, else fall back to the legacy unprefixed key (`deferLoading`, `userScoped`, …) so third-party plugin workers still emitting the old shape keep working. Never hand-write a `_meta` key string; import `META_KEYS`.

A tool whose result or accepted self-referential parameters depend on the caller's identity (a "my X" question, or a write tool with an assignee-style param) MUST declare `speedwave.pl/user-scoped: true`, and any worker exposing user-scoped tools MUST also expose a current-user tool (its name declared via `speedwave.pl/current-user-tool` on the user-scoped tools) or a self-reference hint via `speedwave.pl/self-param` (a short descriptive string, e.g. `"assigned_to: 'me'"`, not a bare parameter name). At discovery the hub validates both companions (`tool-discovery.ts`): `currentUserTool` accepts either the hub's camelCase method name or the worker's own tool name (normalized to camelCase and re-stored), and is dropped only when neither form resolves to a discovered tool; a `self-param` whose leading parameter name is not in the tool's `inputSchema` is dropped the same way (each with a warning), and the hub warns once per tool when a user-scoped tool ends up with neither companion. The tool keeps serving: `search_tools` appends the identity sentence to `description` at `with_descriptions`/`full_schema`, and additionally always sets a standalone `identityHint` field (same sentence, including the misconfiguration fallback when neither companion is configured) at every detail level — including `names_only`, the level `search_tools` itself recommends starting with — so a self-reference query never needs a second round trip just to learn how to supply identity. `search_tools` boosts user-scoped tools for self-reference queries (e.g. "me").

## Error and pagination contract

New tool validation errors (missing/invalid params, not-found lookups, teaching hints) go through mcp-shared's `teachingErrorResult`/`teachingToolResult`/`missingParamResult`: they state what was wrong with a parameter, which tool provides a correct value, and the suggested next step, in that order, so a model can self-correct instead of guessing. Existing worker-specific error formatters (e.g. a client's own `formatError`) migrate to this pattern as they are touched, not in bulk. New paginated `limit`/`pageSize`-style params are clamped with `clampPageSize` (finite positive integer, defaults on missing/0/negative/NaN/non-numeric, optionally capped at a max) rather than a hand-rolled bound check; existing params migrate as touched.

**No silent partial effect:** a tool call that partially succeeds (e.g. some items of a batch updated, some rejected) must say so in its result, never return a bare success for a partial outcome. Silent partial success is indistinguishable from full success to the calling model and to the user.

## Adding a built-in worker touches many places (checklist)

`consts.rs` service descriptor (`TOGGLEABLE_MCP_SERVICES`, resources on the descriptor) + `BUILT_IN_SERVICE_IDS` · `build.rs::IMAGES` entry with `hash_inputs` + `${IMAGE_*}` placeholder + resource placeholders in `compose.template.yml` + bundle-script list (all test-guarded) · `tzdata` in the image (MANUAL, nothing catches a miss) · hub env `WORKER_<SVC>_URL` wiring · optional `containers/claude-resources/*/integrations/<config_key>/` resources (+ BATS on/off test in `_tests/entrypoint/entrypoint.bats`). Grep an existing worker (e.g. `redmine`) end-to-end rather than trusting this list to be exhaustive.

## Test pattern

Follow `mcp-servers/gitlab/src/tools/branch-tools.test.ts` (or `redmine/src/tools/metadata.test.ts`):

- Import the tool factory, resolve handlers via `tools.find((t) => t.tool.name === '<name>')?.handler`.
- Metadata tests: name, description, annotations (readOnlyHint, destructiveHint), keywords, example, inputSchema, `_meta` policy keys (via `metaValue`, prefixed and legacy).
- Execute success cases (mock the client with `vi.fn()`), parameter validation (missing/empty/null/undefined/falsy), error handling (Error, non-Error shapes, strings, undefined), edge cases (special characters, nested paths, large IDs).

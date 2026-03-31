# ADR-034: MCP Error Guidance and Client Init Retry

## Status

Accepted

## Context

All four MCP worker servers (GitLab, Slack, Redmine, SharePoint) displayed user-facing error messages containing `Run: speedwave setup <service>`. This CLI command does not exist — the `speedwave` binary only supports `init`, `check`, `update`, `self-update`, and `plugin` subcommands[^1]. Integration configuration happens exclusively through the Desktop app's Integrations tab.

Additionally, each MCP server initializes its API client exactly once at startup via `initializeXXXClient()`. If this single attempt fails due to a transient error (DNS resolution delay in a freshly-started container, network not yet ready, external service temporarily unreachable), the client reference is permanently `null` for the container's lifetime. Every subsequent tool invocation returns a "not configured" error, even though credentials are properly mounted. This is especially problematic for GitLab, whose `initializeGitLabClient()` calls `testConnection()` — a real HTTP request to an external server[^2].

Three approaches were considered for the retry:

1. **Lazy initialization** — Initialize the client on the first tool call instead of at startup. This changes the initialization contract (from `index.ts` to per-tool) and complicates the graceful degradation pattern shared by all servers.
2. **Retry with exponential backoff** — Wrap the existing `initializeXXXClient()` call with a retry utility. No changes to internal initialization logic.
3. **Health-check triggered re-initialization** — Let the Hub detect unhealthy workers and trigger re-init. This requires new IPC between Hub and workers and violates the current stateless worker model.

## Decision

### Error message guidance

Replace all `Run: speedwave setup <service>` strings with `Configure this integration in the Speedwave Desktop app (Integrations tab).` via a centralized constant `SETUP_GUIDANCE` and helper functions `notConfiguredMessage(service)` and `withSetupGuidance(action)` in `mcp-servers/shared/src/errors.ts`. This is the single source of truth — no server hardcodes guidance text. Error responses follow the MCP protocol's `isError` flag convention[^5].

### Client initialization retry

We implement approach 2: a shared `retryAsync<T>(fn, options)` utility in `mcp-servers/shared/src/retry.ts`. Each server wraps its `initializeXXXClient()` call:

```typescript
const client = await retryAsync(initializeXXXClient, {
  maxRetries: 3,
  baseDelayMs: 2000,
  label: 'GitLab client init',
});
```

Key design decisions:

- **Exponential backoff with jitter** — Delays of 2 s, 4 s, 8 s (capped at 15 s) with 30 % random jitter[^3]. Jitter prevents thundering-herd effects when multiple containers restart simultaneously.
- **Catches exceptions** — `retryAsync` catches both `null` returns and thrown exceptions (e.g., `TypeError` from failed DNS resolution in `fetch`). Exceptions are logged as warnings but do not propagate.
- **`setTimeout`-based delays** — Standard Node.js timer API[^4] for scheduling retries. No external dependencies.
- **Total worst-case delay: ~14 s** — Acceptable for container startup, gives DNS/network time to stabilize.
- **No internal changes to `initializeXXXClient()`** — The retry wraps the existing function wholesale, preserving the graceful degradation contract ("returns null, doesn't throw").
- **SharePoint keeps fail-fast behavior** — After retry exhaustion, `process.exit(1)` is still called. The retry gives SharePoint a better chance to succeed on OAuth token refresh.

### Relationship to existing retry patterns

`sharepoint/src/token-manager.ts` already has `saveTokensWithRetry()` — a fixed-delay (100 ms) disk-write retry for token persistence. The new `retryAsync` serves a different use case (network initialization with exponential backoff) and lives in the shared package for reuse by all servers. No consolidation is needed.

## Consequences

- Users see correct guidance ("Desktop app Integrations tab") instead of a non-existent CLI command.
- Transient startup failures no longer permanently disable a service for the container's lifetime.
- Container startup time increases by up to ~14 s in the worst case (all retries fail). Normal case: no delay (first attempt succeeds).
- The `SETUP_GUIDANCE` constant is a single point to update if the wording ever changes.

[^1]: Speedwave CLI subcommands defined in `crates/speedwave-cli/src/main.rs` via clap `Subcommand` enum.

[^2]: `initializeGitLabClient()` in `mcp-servers/gitlab/src/client.ts` calls `client.testConnection()` which invokes `gitlab.Users.showCurrentUser()` — a GET request to the GitLab API.

[^3]: AWS Architecture Blog, "Exponential Backoff And Jitter." https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/

[^4]: Node.js Timers documentation — `setTimeout(callback, delay)`. https://nodejs.org/api/timers.html#settimeoutcallback-delay-args

[^5]: Model Context Protocol specification — tool result `isError` flag. https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/#error-handling

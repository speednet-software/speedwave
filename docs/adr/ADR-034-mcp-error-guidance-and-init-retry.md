# ADR-034: MCP Error Guidance and Client Init Retry

> **Status:** Accepted
> **Context:** MCP worker error messages pointed at a non-existent CLI command, and a single failed client init at startup permanently disabled a service.

## Decision

Two changes to every MCP worker (GitLab, Slack, Redmine, SharePoint, and later GitHub/Atlassian):

1. **Error guidance** — replace any "run a CLI setup command" text with one centralized message ("Configure this integration in the Speedwave Desktop app (Integrations tab)."), exposed through a single constant and two helpers so no server hardcodes the wording.
2. **Init retry** — wrap each server's `initializeXXXClient()` call in a shared exponential-backoff-with-jitter retry, so a transient failure at container startup (DNS not ready, network not up, service briefly unreachable) no longer leaves the client permanently `null`.

## Why

- The old text told users to run a `speedwave setup <service>` command that does not exist. The CLI's real named subcommands are `init`, `check`, `update`, `self-update`, `login`, `logout`, and `plugin` (see the USAGE help in `crates/speedwave-cli/src/main.rs`) — integration credentials are configured only in the Desktop app's Integrations tab.
- Workers initialize their API client once at startup. Before retry, a single transient failure set the client reference to `null` for the container's lifetime, so every later tool call returned "not configured" even though credentials were mounted correctly.
- Centralizing the guidance string means one place to change the wording, and keeps it identical across every worker.
- The retry wraps the existing init function wholesale, preserving each server's graceful-degradation contract (init returns `null` on missing/invalid config, it does not throw, so the server still starts unconfigured).

## How it behaves

- Backoff is exponential with additive jitter: base delays of 2s, 4s, 8s, capped at 15s, plus 0–30% random jitter on top (so total can slightly exceed the cap) — see `mcp-servers/shared/src/retry.ts`. Jitter avoids a thundering herd when many containers restart at once, the standard rationale for combining exponential backoff with randomized jitter[^1].
- The retry helper catches both `null` returns and thrown exceptions (e.g. a `TypeError` from a failed DNS lookup, the shape Node's `fetch()`/undici use to wrap a DNS resolution failure[^2]); exceptions are logged as warnings and do not propagate.
- SharePoint keeps its fail-fast behavior: after retries are exhausted it still exits non-zero. The retry just gives its OAuth token refresh more chances to succeed first.
- GitLab's `initializeGitLabClient()` no longer blocks on a network round-trip: it creates the client and returns immediately, then schedules `testConnection()` (which calls `gitlab.Users.showCurrentUser()`) in the background via `backgroundConnectionTest()`. The HTTP listener never waits on a slow or unreachable GitLab.

## Where it lives in code

- Guidance constant + `notConfiguredMessage()` / `withSetupGuidance()` helpers — `mcp-servers/shared/src/errors.ts`
- Shared retry utility `retryAsync<T>()` — `mcp-servers/shared/src/retry.ts`
- GitLab client + non-blocking init / background connection test — `mcp-servers/gitlab/src/client.ts`, `mcp-servers/gitlab/src/index.ts`
- Background connection test scheduler — `mcp-servers/shared/src/health-status.ts`
- CLI subcommand surface (the real command list) — `crates/speedwave-cli/src/main.rs`

## Rejected alternatives

- **Lazy init on first tool call** — would change the initialization contract from startup-time to per-tool and complicate the graceful-degradation pattern shared by all servers.
- **Health-check-triggered re-init from the Hub** — requires new Hub↔worker IPC and breaks the stateless-worker model.

[^1]: [Exponential Backoff And Jitter - AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) - jittered exponential backoff spreads out retry spikes and is the standard pattern AWS SDKs use for transient-failure retries.

[^2]: [nodejs/undici issue #1116 - network errors are wrapped in static "fetch failed" error](https://github.com/nodejs/undici/issues/1116) - confirms Node's `fetch()` wraps a DNS resolution failure (e.g. `getaddrinfo ENOTFOUND`) in a top-level `TypeError: fetch failed`.

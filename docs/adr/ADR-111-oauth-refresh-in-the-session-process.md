# ADR-111: OAuth refresh in the process that owns the session

> **Status:** Accepted
> **Date:** 2026-11-18
> **Context:** SPEED-1002. Slack stopped working about 12 hours after sign-in when a session ran in a project other than the one Desktop had active (for example `speedwave --project A` in a terminal while Desktop showed project B). The error was `WORKER_OAUTH_URL env var is not set; oauth worker is not enabled for this project`. A valid refresh token (30 days) sat unused on the machine. Supersedes [ADR-060](ADR-060-host-side-oauth-refresh-worker.md) in the part about the host `oauth` process.

## Context

[ADR-060](ADR-060-host-side-oauth-refresh-worker.md) put token refresh in a per-project Node process, `oauth`, spawned by Desktop alone. Compose wrote `WORKER_OAUTH_URL` and a per-service bearer into a consumer container only when that process was alive at render time.

- Desktop started the process only for its active project (`ensure_oauth_running`) and stopped it on a project switch (`teardown_oauth_for_project`). The CLI never started it.
- Every start of the process drew a new port and a new bearer. Containers that were already running kept the old values.
- So the configuration of a container depended on a process that lived shorter than the container and was managed by someone other than the user of the tokens.

A patch that recreated containers at sign-in was rejected: it leaves inactive projects without refresh, and it breaks again whenever the `oauth` process restarts. The direction "several active projects in Desktop" (SPEED-351) also rules out anything that knows a single active project.

## Decision

1. **The process that owns the session refreshes.** The CLI refreshes for its `--project` from the moment its containers are up until it exits. Desktop refreshes every project that has running containers, from their start to their stop. Both call the same code in `crates/speedwave-runtime/src/oauth_refresh/` (`spawn_session_refresher`, `refresh_now_with_timeout`). The Node `oauth` process, `crates/speedwave-runtime/src/oauth_process.rs`, `ensure_oauth_running` and `teardown_oauth_for_project` are removed.
2. **Providers move to Rust.** `slack`, `microsoft` and `generic` (plugins, including `client_credentials`) live in `oauth_refresh/`. The state file `oauth/<project>/<service>.json` keeps its format; writes go through `oauth_persist.rs` and `fs_perms`, the refresh token first and the access token second, as before. The `generic` provider validates the token URL with `url_validation::validate_url` on every refresh. Every provider request has a 30 s timeout (`consts::OAUTH_REFRESH_HTTP_TIMEOUT`), follows no redirects, reads at most 256 KiB (`consts::OAUTH_REFRESH_MAX_RESPONSE_BYTES`) and logs no `error_description` (ADR-069, "Security surface"). The audit log keeps its file (`consts::OAUTH_LOG_FILE`) and a line per refresh without token contents; rotation moved to `oauth_refresh/audit.rs`.
3. **A file lock serialises processes.** Before refreshing, a process takes an exclusive `fs2` lock on `oauth/<project>/<service>.lock` (`fs_perms::with_file_lock_in`), re-reads the state, and skips the provider call if another process already refreshed. Two processes at the threshold make one provider call. This matters because Slack refresh tokens are single-use and rotate (ADR-071).
4. **Schedule.** The expiry is checked every 10 s (`consts::OAUTH_REFRESH_CHECK_INTERVAL`). A token is refreshed when less than 25% of its lifetime remains (`consts::OAUTH_REFRESH_REMAINING_PERCENT`, lifetime is `expiresAt` minus `lastRefreshAt`) or when it has expired. A failure the user must fix (`ErrorCode::needs_reconnect`: `invalid_grant`, `scope_mismatch`, `missing_field`, `invalid_config`, `malformed_state`, `unknown_provider`) is audited once and the provider is not asked again for that state: every 10 s the process only compares a hash of `oauth/<project>/<service>.json` with the one taken at the failure, and returns to the normal due check when the file changed (a new sign-in, or another process refreshed it). Those local checks write no audit line, and `refresh_status` stays `reconnect_required`. A failure a later attempt can fix (`network`, `http`, `malformed`, `persist_failed`) is retried with a pause that starts at 10 s, doubles and stops at 2 min (`schedule::retry_delay`, `consts::OAUTH_REFRESH_BACKOFF_MAX`); a successful refresh or a changed state file resets it to 10 s. The per-service state is `service::Hold`, kept by the session loop in `oauth_refresh/mod.rs`. Before the session process starts `claude`, the CLI and Desktop run one check with a 5 s limit (`START_REFRESH_TIMEOUT`); a missing network does not block the start, and a check that runs out of time finishes in the background. Desktop finds the projects with running containers every 30 s (`desktop/src-tauri/src/session_refresh.rs`).
5. **A status file reports failures.** After a failed refresh the session process writes `refresh_status` next to the token (`consts::OAUTH_REFRESH_STATUS_FILE`, `/tokens/refresh_status` in the container): `{"state":"reconnect_required","at":"<RFC 3339>"}` when the provider rejected the grant (`invalid_grant` or the provider's equivalent), `{"state":"network_error","at":"..."}` for failures a later attempt can fix. A successful refresh, or a token that is not due, removes the file. The file is in `compose/workers.rs::VOLATILE_CREDENTIAL_FILES`, so writing it does not change the credentials digest and does not recreate containers. On `reconnect_required` the CLI prints a warning once per service and run, and Desktop shows a notification once per project and service.
6. **The container waits for the token file.** `authedRequest` and `authedSdkCall` in `mcp-servers/shared/src/oauth-authed-request.ts` no longer call anything. On an auth-failure status they read `/tokens/access_token`; if it equals the token in use, they poll it every 500 ms for up to 30 s (`TIMEOUTS.TOKEN_REFRESH_MS`) and retry with the new token. If the token is unchanged after 30 s, `refreshFailure` in `oauth-client.ts` throws an `OAuthRefreshError` worded by `refresh_status`:
   - `reconnect_required`: `Slack sign-in expired. Reconnect Slack in Speedwave Desktop: Settings, Integrations, Slack.`
   - `network_error`: `Slack token expired and Speedwave could not refresh it yet (network error at <time>). It tries again automatically.`
   - no file: `Slack token expired and has not been refreshed yet. Speedwave refreshes it while a session of this project runs.`

   The name comes from `/tokens/service_name` (`consts::OAUTH_SERVICE_NAME_FILE`), which the session process writes from the `TOGGLEABLE_MCP_SERVICES` display name or a plugin's `plugin.json` `name`; the worker falls back to the service id when the file is missing. The proactive path for JWT tokens (SharePoint) adopts a rewritten token without waiting.
7. **Compat endpoint for old plugin clients.** Plugins vendor a copy of the old client ([ADR-069](ADR-069-generic-plugin-oauth2.md)) and Speedwave does not control when they update. On an auth failure that copy calls `WORKER_OAUTH_URL` with the bearer from `/secrets/oauth-auth-token-<service>`, expects a JSON-RPC result whose `content[0].text` is JSON `{"expiresIn": <number>, "grantedScopes": [...]}`, then reads the token file. So:
   - `compose/mod.rs::apply_oauth_compat_in` always writes `WORKER_OAUTH_URL=consts::OAUTH_COMPAT_URL` (`http://mcp-hub:4000/oauth-compat`) and mounts a fixed bearer file (`consts::OAUTH_COMPAT_BEARER`) at `/secrets/oauth-auth-token-<service>:ro`, only into containers of enabled plugins with an `oauth` block. Built-in services get neither. The output does not depend on any process on the host.
   - `mcp-servers/hub/src/oauth-compat.ts` serves `POST /oauth-compat` in `mcp-hub`. A `tools/call` of `refresh` waits 15 s and answers `{"expiresIn": 0, "grantedScopes": []}`; the old client then re-reads the token file. Any other request gets 400. More than 16 waiting calls get 429. It checks no credentials, refreshes nothing, and is not in the hub's tool registry. `expiresIn` is always 0.
   - The endpoint stays until a minimum plugin version mechanism exists. Updating `glpi` and `stallion` to the new client is SPEED-1009.
8. **The `forget` operation is removed.** Nothing called it. Disconnecting an integration deletes the state file (`integrations_cmd.rs`).

## Rejected alternatives

- **Refresh inside the container.** It would put the refresh token in a container mount, which is the exposure ADR-060 removed.
- **Recreate containers at sign-in** (the patch). Leaves inactive projects unrefreshed and fails again when the `oauth` process restarts.
- **Keep the `oauth` process and make Desktop start it for every project.** Keeps a second moving part whose address and bearer change on every start and that the CLI cannot own.
- **Make the CLI supervise the `oauth` process.** Two supervisors killed each other's workers in the past (ADR-068, "Not every exit 137 is OOM").

## Consequences

- Refresh no longer depends on which project Desktop shows. With Desktop closed and only the CLI running, the CLI's project keeps refreshing, which ends the 12-hour fuse recorded in ADR-071.
- With no session process running for a project (no CLI session and no running containers in Desktop), nothing refreshes. A container call that finds an expired token waits 30 s, then fails with the message from decision 6.
- The refresh token still stays on the host. Containers mount only the access token `:ro`, and workers write no tokens.
- ADR-008 still holds: there is no daemon. The refresher is a thread inside the CLI or Desktop process and ends with it.
- ADR-060 stays valid for its storage and mount invariants: the off-mount state file, the `:ro` `/tokens` mount, the per-project audit log and the file modes. Its worker process, the `refresh` and `forget` tools, the bearer map, the Desktop-only spawner and the refresh rate limit are replaced by this ADR.
- The host no longer packs or supervises an `oauth` Node process. `mcp-servers/oauth` is gone from the Desktop bundle, and `host_worker_warnings` no longer warns about a missing refresh worker.
- Plugin containers keep a stable `WORKER_OAUTH_URL`. A plugin that ships the new client ignores it.
- The shared client changed in `mcp-servers/shared`, and the vendored copies in plugins are manual-sync copies; the compat endpoint covers the copies that have not been updated.

## Security surface

- The channel from a container to a refresh process is gone. The ADR-060 threat model (a compromised container with the address and bearer calling `refresh`) no longer applies: no container can ask anything to refresh.
- New surface: `POST /oauth-compat` on `mcp-hub`, reachable from the containers of the project, `claude` included. It has no credentials to protect and changes nothing. It holds a request for 15 s and returns a constant answer, and at most 16 requests wait at once, so its worst case is 16 idle connections of the hub. Accepted by Mikołaj Kąkol on 2026-11-18 (SPEED-1002).
- The bearer file in plugin containers holds a fixed placeholder, not a secret.
- `refresh_status` carries a state and a time and no token. It is written with `fs_perms::write_restricted_file`.
- No other relaxation. A refresh that runs in the CLI or Desktop process uses the host's network, as the `oauth` process did.

## References

- [ADR-008](ADR-008-no-background-daemon.md): no daemon
- [ADR-060](ADR-060-host-side-oauth-refresh-worker.md): the host-side refresh worker this ADR supersedes in part
- [ADR-069](ADR-069-generic-plugin-oauth2.md): plugin OAuth, vendored client
- [ADR-071](ADR-071-slack-oauth-pkce-user-tokens.md): Slack rotating tokens

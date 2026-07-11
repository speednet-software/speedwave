# ADR-060: Host-Side OAuth Refresh Worker (`oauth`)

> **Status:** Accepted
> **Context:** SharePoint was the only worker mounting `/tokens:rw` (the lone exception to the `:ro` invariant, per ADR-009) so it could refresh its own OAuth token in-container. That `:rw` mount widened the blast radius of a worker compromise and made every `/tokens` read a refresh-token leak risk.

## Decision

Move OAuth token refresh out of the SharePoint container into a new **`oauth`** worker: a per-project host-side MCP process (Node.js, no container) that holds each OAuth service's `refresh_token` + IdP application identity and exposes two tools, `refresh` and `forget`. The worker is never enumerated to Claude and never appears in the hub's tool registry — its only callers are other workers in the same project (SharePoint; Slack joined with [ADR-071](ADR-071-slack-oauth-pkce-user-tokens.md), plugins with [ADR-069](ADR-069-generic-plugin-oauth2.md)), which reach it directly, bypassing the zero-token hub. With refresh moved out, the SharePoint `/tokens` mount becomes `:ro` like every other worker and now contains only `access_token` and `site_id`.

## Why

- **Restores the `:ro`-everywhere invariant systemically**, not by convention — `refresh_token`, `client_id`, `tenant_id` are no longer in any container mount, so a worker code bug or RCE cannot leak or rewrite them.
- **Per-project, not global:** OAuth state is per-project (different projects connect different sites/identities). Project context comes from the worker's injected URL, so there is no model-controllable `project` parameter to forge — same model proven by `host_exec` (ADR-054).
- **Direct worker → oauth, not via hub:** routing refresh through the hub would force the hub to hold a bearer (a zero-tokens regression), and the hub's `callWorker()` is one-way (hub → worker).
- **Per-service bearer auth** eliminates service-name confusion: each consumer gets its own bearer mounted at `/secrets/oauth-auth-token-<service>:ro`; the worker maps bearer → service host-side, so `refresh`/`forget` take no `service` parameter from the model.
- **Easy to extend** to future IdPs: add a provider module, declare the service descriptor; IdP-specific identity nests under `providerData` in the on-disk state, with no new `:rw` exception per provider.

## What it does NOT close

Live compromise is **not** mitigated by isolation alone. An attacker with RCE in the SharePoint worker holds the bearer + URL and can call `refresh` legitimately for as long as the worker runs (and already has the in-memory access token). Partial defenses: a refresh rate limit (default ~1 per 30 min per service while the token is still valid), an append-only audit log, and the IdP's own access-token TTL plus user/admin revocation. The architectural gain is the offline-exfiltration and code-path-bug classes — not live compromise. `forget()` only deletes Speedwave's local copy; full revocation requires the user/admin acting at the Microsoft account or Azure AD side.[^1]

## Where it lives in code

- OAuth state + bearer-map storage and lifecycle (host) — `crates/speedwave-runtime/src/oauth_process.rs`, modeled on `crates/speedwave-runtime/src/host_exec_process.rs`
- Restricted (0o600) file writes for state/port/pid/bearer — `crates/speedwave-runtime/src/fs_perms.rs`
- Worker dispatcher + provider registry — `mcp-servers/oauth/src/tools.ts`, `mcp-servers/oauth/src/providers/registry.ts`, `mcp-servers/oauth/src/providers/types.ts`, `mcp-servers/oauth/src/providers/microsoft.ts`
- `WORKER_OAUTH_URL` + per-service bearer injection into OAuth-consuming services — `crates/speedwave-runtime/src/compose.rs` (`apply_oauth_config_with_paths`)
- `:ro`-everywhere mount enforcement (no SharePoint special case) — `crates/speedwave-runtime/src/compose.rs` (`validate_service_volume_mounts`)
- SharePoint credential descriptor (`access_token`, `site_id` only) and OAuth state field allowlist — `crates/speedwave-runtime/src/consts.rs` (`credential_files`, `oauth_state_fields`)
- OAuth request scopes SSOT — `crates/speedwave-runtime/src/consts.rs` (`SHAREPOINT_OAUTH_SCOPES`)
- Spawn on project switch / compose-up when an OAuth service is enabled — `desktop/src-tauri/src/main.rs` (`ensure_oauth_running`). The Desktop app is the **sole** spawner; the CLI (a Desktop-dependent client) does not spawn the worker — it reads the Desktop-held lock/bearer-map from disk. A second CLI-side supervisor caused the dual-supervisor exit-137 cycle, removed per ADR-068 §"Not every exit 137 is OOM".
- Device-code flow[^2] that seeds the state — `desktop/src-tauri/src/oauth_cmd.rs`
- SharePoint token manager (now health-only, no token writes) — `mcp-servers/sharepoint/src/token-manager.ts`

## On-disk shape

State lives at `~/.speedwave/oauth/<project>/<service>.json` (mode 0o600, parent 0o700), never mounted into any container. Each file carries `provider`, `providerData` (IdP-specific keys — for Microsoft `clientId` + `tenantId`), `scopes`, `grantedScopes`, `refreshToken`, `expiresAt`, `lastRefreshAt`. A bearer → service map and an append-only audit log (rotated past ~1 MiB, one historical copy) sit alongside it in the same per-project directory. The whole tree is enumerated by the file-security check, so a world-readable mode regression is caught by `speedwave check` and auto-fixed on startup.

A startup migration (`crates/speedwave-runtime/src/oauth_state_migration.rs`, also reused by Desktop's in-process repair) nests any legacy top-level `clientId`/`tenantId` under `providerData` — shape-only, idempotent, secrets are never fabricated or moved. The re-authorize banner is computed regardless of `configured` so a file too damaged to migrate still surfaces a recovery path.

## Shared refresh-retry helper

On-demand `refresh` is no longer re-implemented per worker. Every OAuth consumer (built-in workers plus plugins via a vendored copy) calls a shared `authedRequest` helper in `mcp-shared` (`mcp-servers/shared/src/oauth-authed-request.ts`): it issues the HTTP request, and on an auth-failure status calls `oauth.refresh()`, re-reads `/tokens/access_token`, and retries once — so the refresh-retry logic is SSOT, not duplicated. The auth-failure trigger is `[401]` by default per RFC 6750's `invalid_token` response,[^3] and consumers may add non-standard statuses (a GLPI 11 instance is observed to return `400` for an expired token (unverified: observed instance behavior, not a documented contract; see ADR-069)). A `5xx` is a server fault and never triggers refresh. SharePoint delegates both its reactive and proactive (JWT `exp`[^4]) refresh to this helper.

## Rejected alternatives

- **Keep SharePoint's `:rw` exception (ADR-009's original choice).** A `:rw` mount lets a compromised container rewrite the refresh token to one the attacker controls, persisting access past a user revoke, and any `/tokens` read path is a leak risk. Moving refresh host-side makes the gate systemic.
- **Refresh via the hub.** Would force the hub to hold a bearer (zero-tokens regression) and reverse the one-way hub → worker call direction for no gain.
- **A single global oauth worker.** Would require a model-supplied `project` parameter that a compromised caller could forge; the per-project model removes that parameter entirely.
- **Confidential-client / `client_secret` flow.** Out of scope — no secret exists today (device-code is a public-client flow[^2]); migrating would need app re-registration, a new consent UI, and credential rotation.

## References

- ADR-009 — [per-project isolation; retired SharePoint `:rw` exception](ADR-009-per-project-isolation-preserved.md)
- ADR-054 — [host_exec worker (per-project host-side worker shape)](ADR-054-host-exec-worker.md)
- ADR-013 — [mcp-os as a host-side process](ADR-013-mcp-os-as-host-process-implementation.md)
- Microsoft Identity — device authorization grant (public client): <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code>
- Microsoft Identity — refresh-token redemption: <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token>
- Microsoft Identity — refresh-token revocation is a user/admin operation: <https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens#token-revocation>

[^1]: Microsoft identity platform - refresh tokens can only be revoked by user action (change password, SSPR, explicit revoke) or admin action (password reset, revoke all refresh tokens); the client app cannot revoke them itself: <https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens#token-revocation>

[^2]: Microsoft identity platform - OAuth 2.0 device authorization grant: the client's token request carries only `client_id` and `device_code`, no client secret, confirming it is a public-client flow: <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code>

[^3]: RFC 6750 - a protected resource returns `401 Unauthorized` with `error="invalid_token"` when the access token is expired or otherwise invalid: <https://datatracker.ietf.org/doc/html/rfc6750#section-3.1>

[^4]: RFC 7519 (JSON Web Token) - the `exp` (expiration time) claim identifies the time on or after which the JWT must not be accepted for processing: <https://datatracker.ietf.org/doc/html/rfc7519#section-4.1.4>

# ADR-071: Slack OAuth2 PKCE — tokenless sign-in with rotating user tokens

## Status

Accepted

## Context

The original Slack integration required users to create their own Slack app and paste two manual tokens (`bot_token` + `user_token`) into Speedwave. That setup burden kept the integration hidden in the Desktop UI, and the long-lived tokens sat unrotated in the worker mount. Meanwhile every operation in the worker already ran on the **user** token — the bot token's only job was a startup health check.

Slack made PKCE generally available to all developers in March 2026[^1], which removes the historical blocker: a public client (desktop app) can now complete the full `authorization_code` flow **without a `client_secret`**[^2], so a single Speednet-registered Slack app can serve every Speedwave install with nothing but its public `client_id` bundled in the binary.

Speedwave already has the infrastructure this flow needs: a host-side `oauth` refresh worker with per-service bearers ([ADR-060](ADR-060-host-side-oauth-refresh-worker.md)) and a loopback-redirect PKCE flow built for plugins ([ADR-069](ADR-069-generic-plugin-oauth2.md)).

## Decision

1. **One public Slack app, registered by Speednet.** PKCE enabled (one-way operation that marks the app as a public client[^1]), token rotation enabled, public distribution activated (a checklist, not a review — only Slack Marketplace listing requires review[^3]). The `client_id` is a public identifier bundled as `consts::SLACK_OAUTH_CLIENT_ID` — the same pattern as the GitHub OAuth app.
2. **`user_scope` only — Claude acts as the signed-in human.** A user token (`xoxp`) inherits the user's identity, so messages posted via `chat.postMessage` appear as that person, not a bot[^4]. Bot scopes are not requested — Slack forbids them on desktop redirects anyway[^2]. The `bot_token` is removed entirely (it served only `auth.test`).
3. **Loopback redirect on a fixed port.** The app registers `http://localhost:41739/callback`; Slack treats `localhost` redirects as desktop redirects for PKCE-enabled apps[^2] (the RFC 8252 loopback pattern[^5]). Slack matches the passed `redirect_uri` against the registered URLs[^6], so the port is pinned (`consts::SLACK_OAUTH_REDIRECT_PORT`). Because the browser may resolve `localhost` to either `127.0.0.1` or `::1`, the listener binds both stacks and accepts on whichever connects. The callback plumbing is shared with the plugin flow via `oauth_loopback.rs` (extracted from `plugin_oauth_cmd.rs`).
4. **Slack-specific exchange parsing.** Slack diverges from RFC 6749 §5: errors arrive as HTTP 200 + `{ok:false, error}`[^7], and in a `user_scope` exchange the user token is nested under `authed_user` — a top-level `access_token` would be a bot token[^8]. The exchange therefore reads **only** `authed_user.{access_token, refresh_token, expires_in, scope}` and hard-fails when rotation fields are absent (rotation off = misconfigured app).
5. **Rotating tokens through the ADR-060 worker.** Access tokens expire after 12 hours (43 200 s) and are refreshed via `oauth.v2.access` with `grant_type=refresh_token`[^9]; PKCE refreshes need no `client_secret`[^2]. A dedicated `slack` provider in `mcp-servers/oauth` carries the token URL as a module constant (zero SSRF surface) and maps Slack's `ok:false` error slugs onto the worker's error taxonomy. Because Slack refresh tokens are **single-use** (each refresh rotates them[^9]), the worker serializes `refresh` per service and turns a rate-limited call with a still-valid token into a success-noop so a lost single-flight race self-heals.
6. **Storage split (ADR-060 invariants).** `tokens/<project>/slack/access_token` is the only worker-visible artifact (`:ro` mount, rewritten on every refresh); the rotating refresh token plus workspace identity (`teamName`, `authedUserId`, and a best-effort `authedUserName` resolved via `users.info` at sign-in for the UI card) live off-mount in `oauth/<project>/slack.json`. The state file is persisted **before** the access token so a crash between the writes never leaves a mounted token without refresh state.
7. **Worker reads per-call, refreshes reactively.** Slack tokens are not JWTs, so proactive-expiry checks do not apply; the worker's `slackCall` wrapper treats `token_expired`/`invalid_auth` as refresh triggers (terminal states like `token_revoked` are not retried), re-reads the rotated token, and recreates the `WebClient`.
8. **UI: one "Sign in with Slack" button.** The descriptor (`uses_oauth_refresh: true`, both auth fields `oauth_flow: true`) drives compose injection, the re-auth banner, and the credentials card with no Slack-specific template branches.
9. **Files: read inline or hand off via the workspace.** The `files:read` scope lets the worker download `url_private` content with the bearer header. Text files (markdown, code, logs, JSON) are returned inline by `getFileContent`; binary files (PDF, office docs, images) are refused inline and instead written by `downloadFile` to `/workspace/.speedwave/slack/<id>-<name>` (the hidden per-worker convention the office worker also uses), where the office worker and Claude can read them. Slack therefore mounts `${PROJECT_DIR}:/workspace:rw` — the same profile SharePoint already carries (ADR-060) — validated by the dedicated `SLACK_*` volume rules (mirroring `SHAREPOINT_*`): `/tokens:ro`, `/workspace:rw`, per-service oauth bearer, nothing else. Downloaded filenames are reduced to a separator-free, leading-dot-stripped basename so a hostile filename cannot escape `.speedwave/slack/`.
10. **Direct messages — full read/write, confirmation-gated, names resolved in-worker.** The scope set widens by six (`im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `mpim:write`) so the worker can list, read, and open 1:1 and group DMs[^11]; sending rides the existing `chat:write` (chat.postMessage posts to any conversation the user can write to). In DMs the user-token identity model (point 2) bites hardest — a sent message is indistinguishable from one the human typed — so the skill enforces a product rule: **no send of any kind, channel or DM, without the user's explicit confirmation of recipient and verbatim text**; `conversations.open` alone is silent on the recipient side and is not confirmation-gated. Author IDs in returned messages are resolved to display names inside the worker via the already-granted `users:read` (`users.list`, cached per process with a 1 h TTL) — no new scope, no per-message round-trips. Security posture is unchanged: no new mounts and no new volume rules — the delta is scope width on the same ≤12 h rotating token. Widening makes every pre-DM grant a strict subset of the required set, so the descriptor-driven re-auth banner (point 8) fires once per existing install; the app's **User Token Scopes** at api.slack.com must list the six scopes before users re-consent, otherwise authorize fails with `invalid_scope`.

## Consequences

- Setup drops from "create an app, copy two tokens" to one browser consent. No Speedwave server infrastructure is involved — the exchange runs entirely on the user's machine.
- Compromise blast radius shrinks: the container only ever holds a ≤12 h access token; the refresh token never enters any container.
- PKCE refresh tokens expire after 30 days[^2], so an idle install needs a fresh sign-in monthly. The Desktop banner (descriptor-driven staleness check on `lastRefreshAt`) and the worker's error message both point at re-connecting.
- Refresh runs in the Desktop-supervised host worker (ADR-060): with Desktop closed and only the CLI running, refresh stops once the current token expires (a 12-hour fuse).
- Workspace admins with app approval enabled must approve the Speedwave app once per workspace; the consent-denied callback surfaces that guidance.
- Dev (`~/.speedwave-dev`) and production installs on one machine share the fixed redirect port; they collide only during an active sign-in, with an explicit "port in use" error.

### Residual risks (accepted)

- **Crash window between rotation and persist.** Slack revokes the previous refresh token shortly after use[^9]; a crash after the IdP round-trip but before the state write strands the grant. The window is minimized (no awaits between refresh and persist) and recovery is one click on the re-auth banner — the same class of risk every rotating-token client carries.
- **Old manual tokens are not revoked.** There is no install base (the integration was UI-hidden), so no migration or cleanup path exists; the manual-token layout simply ceases to be read.

## Alternatives considered

- **Keep manual tokens** — rejected: the setup burden is why the integration stayed hidden; long-lived unrotated secrets in the mount are strictly worse than 12 h rotating ones.
- **Bot token flow** — rejected: posts would appear as an app, not the human; per-human attribution is the product requirement (same rationale as plugin OAuth identity, ADR-069).
- **Confidential client with an embedded secret** — rejected: a secret bundled in a public binary is not a secret; PKCE exists precisely for this case[^10].
- **Device authorization grant** — not offered by Slack's OAuth implementation[^8].
- **Per-organization app registration** — rejected: reintroduces the manual setup this ADR removes; kept possible implicitly (the flow is data-driven by `consts`), but not surfaced.

[^1]: <https://docs.slack.dev/changelog/2026/03/30/pkce/>

[^2]: <https://docs.slack.dev/authentication/using-pkce/>

[^3]: <https://api.slack.com/start/distributing/public>

[^4]: <https://docs.slack.dev/reference/scopes/chat.write/>

[^5]: <https://www.rfc-editor.org/rfc/rfc8252#section-7.3>

[^6]: <https://docs.slack.dev/authentication/installing-with-oauth/>

[^7]: <https://docs.slack.dev/apis/web-api/#errors>

[^8]: <https://docs.slack.dev/reference/methods/oauth.v2.access/>

[^9]: <https://docs.slack.dev/authentication/using-token-rotation/>

[^10]: <https://www.rfc-editor.org/rfc/rfc7636>

[^11]: <https://docs.slack.dev/reference/methods/conversations.open/>

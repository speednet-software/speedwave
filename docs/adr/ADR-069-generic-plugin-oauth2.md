# ADR-069: Generic Plugin OAuth2 via the Host-Side Worker

> **Status:** Accepted
> **Context:** Plugins (separate `speedwave-plugins` repo) need to authenticate against third-party services from the Settings UI. The host-side `oauth` worker (ADR-060) previously hard-coded one IdP (Microsoft, `refresh_token` grant only) and the device-code initial flow was bespoke per built-in. The lead plugin (GLPI) requires **per-human attribution** — the service's audit log must show the actual user who authorized, not a shared technical account.

## Decision

Extend ADR-060 with a **data-driven** OAuth2 path for plugins. A plugin declares an `oauth` block in `plugin.json` (grant type, endpoints, scopes, auth style, which `auth_fields` carry the client id/secret). The worker gains a single `generic` provider driven by that declaration instead of a per-IdP module. Secrets (`client_secret`, `refresh_token`) stay **off-mount** under `~/.speedwave/oauth/<project>/<slug>.json`; only a short-lived bearer access token reaches the plugin container, exactly as for SharePoint. The design covers three grants; `authorization_code` ships first and the install-time `SUPPORTED_OAUTH_GRANT_TYPES` gate widens per-PR as each grant lands.

## Identity model — per-human is the norm

OAuth grants differ in **who acts**, which is the whole point for GLPI:

- **`authorization_code`** (and `device_code`) are **user-delegated**: the human signs in through their own browser session and the IdP issues a token carrying their identity, so actions performed by the agent on their behalf are attributed to them. This is the same model SharePoint already uses (device-code: a specific human consents via Microsoft).[^1][^7]
- **`client_credentials`** is a **machine identity**: actions land on the OAuth client's technical account regardless of which human is present.[^2] It does **not** satisfy GLPI's per-human requirement and is in scope only for genuinely machine-to-machine services.

GLPI's API supports all three grants, and the actor in its historical records derives from the session bound to the access token,[^3] so `authorization_code` is the primary grant. Speedwave ships as a single installable app per developer machine, so the existing per-project state granularity (`oauth/<project>/<slug>.json`) is already per-human — no per-user dimension is added. The service log shows the human "via OAuth client speedwave-<slug>" (standard OAuth delegation); no additional host-side agent-action trail is recorded.

## authorization_code flow (loopback + PKCE)

The host runs the initial exchange:

1. Generate a PKCE verifier + S256 challenge[^4] and a random `state` (CSRF).
2. Bind a one-shot callback server on **`127.0.0.1:<port>`** — the browser-side loopback, deliberately distinct from `host_bind_address()` (which targets container reach — the WSL adapter IP under **NAT**, but loopback fronted by the ADR-079 guest relay under **mirrored** mode). A fixed `redirect_port` is supported for IdPs that require a registered redirect URI; otherwise an ephemeral port is used.[^5]
3. Open the browser to `authorize_url` with `redirect_uri` + `state` + `code_challenge`.
4. Receive the callback, verify `state`, exchange the `code` (+ verifier) for access + refresh tokens, and persist the full state via the shared writer.

## Instance-specific endpoints (self-hosted IdPs)

A self-hosted IdP (e.g. GLPI[^8]) has no fixed `authorize_url`/`token_url` — they derive from the instance base URL the user enters. The manifest expresses this with `base_url_field` (naming an `auth_fields` key) plus `authorize_suffix`/`token_suffix`; it is mutually exclusive with the static `token_url`/`authorize_url`. The host resolves `base + suffix` from the seed at authorize time and **SSRF-validates the resolved URL then** (not at install, where the base is unknown). The **resolved** absolute URL is persisted into `providerData.tokenUrl`, so the worker's refresh path is unchanged. The base value is projected from the seed (SSOT) into the worker's `/tokens` mount so the worker can reach the API.

## Where it lives in code

- Manifest schema + validation (grant gating, per-grant endpoints, SSRF, scope caps) — `crates/speedwave-runtime/src/plugin.rs` (`PluginOAuthSpec`, `validate_oauth_spec`).
- PKCE/CSRF generation — `crates/speedwave-runtime/src/pkce.rs`.
- On-disk OAuth-state writer (shared by SharePoint, GitHub, plugins) — `crates/speedwave-runtime/src/oauth_persist.rs`.
- SSRF validator (shared SSOT) — `crates/speedwave-runtime/src/url_validation.rs`.
- Generic worker provider + discriminated grant state — `mcp-servers/oauth/src/providers/generic.ts`, `mcp-servers/oauth/src/oauth-state.ts`.
- Host-side flows — `desktop/src-tauri/src/plugin_oauth_cmd.rs` (authorization_code) and the shared `oauth_flow::run_device_poll` for device-code.
- Compose injection + worker respawn on consumer-set change — `crates/speedwave-runtime/src/compose.rs` (`oauth_consumer_service_ids`, `oauth_consumer_compose_name`), `desktop/src-tauri/src/main.rs` (`ensure_oauth_running`).
- UI — `desktop/src/src/app/shared/oauth-connect/` (shared connect component), `plugin-credentials-form`, `plugin-detail`.

## Refresh-retry in plugin workers

Plugins reuse the shared `authedRequest` refresh-retry (ADR-060) by **vendoring** it — copying `oauth-authed-request.ts` plus a trimmed `oauth-client` into the plugin's own `src/server/`, the same literal-copy pattern already used for the rest of `mcp-shared` (since `@speedwave/mcp-shared` is not published to npm, a plugin cannot import it). Plugins must **not** hand-roll their own refresh loop. GLPI opts `400` into the auth-failure status set alongside the default `401`, because in our testing a GLPI 11 instance returns HTTP `400` (not `401`) for an expired token (observed instance behavior, not a documented contract).

## Security surface

Manifest-declared URLs are dialed by the host, so every endpoint goes through the shared SSRF validator (https-only, no private/loopback) at install and again on each worker refresh — a signed plugin is **not** exempt.[^6] The worker hardens the data-driven token request (timeout, no redirect-following, content-type + body-size cap) and redacts IdP `error_description` free text. The `:ro`-everywhere token-mount invariant (ADR-060) is preserved: plugin OAuth secrets never enter `/tokens`.

## Rejected alternatives

- **Per-IdP provider modules for each plugin service.** Does not scale to arbitrary plugins; the manifest already carries the per-IdP differences, so one data-driven provider suffices.
- **`client_credentials` as the default.** Rejected for GLPI — no per-human attribution. Kept only as an opt-in for machine services.
- **A second loopback bind via `host_bind_address()`.** Wrong address: that SSOT is for container→host reach, not the browser's loopback callback.

## References

- ADR-060 — [host-side OAuth refresh worker](ADR-060-host-side-oauth-refresh-worker.md)
- ADR-051 — [plugin signature runtime verification](ADR-051-plugin-signature-runtime-verification.md)

[^1]: OAuth 2.0 authorization code grant — the resource owner authenticates at the authorization server and the issued token represents that user: <https://datatracker.ietf.org/doc/html/rfc6749#section-4.1>

[^2]: OAuth 2.0 client credentials grant — used when the client acts on its own behalf, not for a user: <https://datatracker.ietf.org/doc/html/rfc6749#section-4.4>

[^3]: GLPI REST API supports `authorization_code`, `password`, and `client_credentials` grants at `/api.php/token`: <https://github.com/glpi-project/glpi/blob/11.0/bugfixes/resources/api_doc.MD>

[^4]: PKCE (Proof Key for Code Exchange), S256 challenge method: <https://datatracker.ietf.org/doc/html/rfc7636#section-4.2>

[^5]: OAuth 2.0 for Native Apps — loopback interface redirection and arbitrary-port allowance: <https://datatracker.ietf.org/doc/html/rfc8252#section-7.3>

[^6]: OWASP SSRF prevention — validate and restrict outbound request targets: <https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html>

[^7]: SharePoint's device-code flow is user-delegated — a specific human authenticates at Microsoft and the issued token represents that user (ADR-060 §"Decision"): <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code>

[^8]: GLPI 11 is self-hosted; its High-Level REST API v2 OAuth endpoints are `<instance>/api.php/authorize` and `<instance>/api.php/token`, derived from the user's instance URL: <https://help.glpi-project.org/documentation/modules/configuration/general/api/restful-api-v2>

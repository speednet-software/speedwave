# ADR-063: Generic HostBridge skeleton for host-side WebSocket relays

> **Status:** Accepted
> **Context:** The IDE Bridge was the only host-side WebSocket bridge in the Desktop process; new bridges (for plugins that pair a container worker with a desktop-side companion app) would have duplicated ~95% of its security-sensitive infrastructure.

## Decision

Extract the shared bridge skeleton — loopback TCP listener, `0o600` lock file under `~/.speedwave/<name>-bridge/<port>.lock`, UUID auth token with constant-time compare, Origin/subprotocol policy, watchdog, graceful shutdown — into one audited `HostBridge` type. It supports two connection modes: **Endpoint** (one client, the handler runs for the connection lifetime — used by the IDE Bridge to proxy to the upstream IDE or answer MCP stubs) and **Pairing** (two declared roles connect and the bridge relays every text/binary frame between them verbatim, with a per-frame size cap that closes the pair with WebSocket status 1009).

## Why

- One place to get the security model right: every hand-rolled `0o600` lock file is a place to get permissions wrong, so the skeleton (TCP + lock file + UUID + Origin/subprotocol + watchdog) lives in a single audited module. Adding a third bridge is handler logic only, not a re-implementation of the relay.
- Two auth transports are needed: a request **header** for worker/Node clients that can set arbitrary upgrade headers, and a `?token=` **query parameter** for browser clients, which the WebSocket API forbids from setting custom upgrade headers[^1].
- Origin policy follows from the transport: `RejectIfPresent` (the historical IDE Bridge rule — Claude Code and the `ws` Node client never send Origin, so its presence implies a browser CSRF attempt (unverified)) versus `AcceptIfAuthIsQueryParam` (a browser client is allowed only when it authenticated via query param; a header-auth worker that also carries Origin is a forged combo and is rejected).
- The lock file uses an atomic create-temp-then-rename write, which closes the short window where a partial write could expose the file if directory permissions were ever weakened. A watchdog re-creates the lock file (default every 5 s) if it is deleted, mirroring the IDE Bridge's behaviour.
- Pairing collisions are refused at the HTTP layer with 409 Conflict[^2] before the upgrade, because WebSocket Close frames are only meaningful after a successful opening handshake[^3] — so a third or same-role connection cannot be refused with a close code.
- A `pair_id` generation counter prevents a race where a very fast pair disconnect would clear the active slot after the main loop had already recorded a new pair.

## Manifest options (stable port and persistent token)

For plugins that pair a worker with an external app the user configures once, the manifest `host_bridge` block accepts a `preferred_port` (must be > 1023) that binds and hard-fails if busy — no random-port fallback, because a silent port change would invalidate the external app's saved URL with no signal to the user. A `persistent_token: bool` loads the UUID from `<data_dir>/plugin-state/<slug>/bridge-token` (chmod `0o600`) instead of regenerating it per session; uninstall removes the whole `plugin-state/<slug>/` so reinstall regenerates the token. Validation rejects `persistent_token` without `preferred_port`, since the companion app's saved URL would go stale on every restart anyway. The persistence threat-model delta is small: the secret lives in a `0o600` file inside an owner-only `0o700` directory, and an attacker with read access there already has read access to the user's home.

## Where it lives in code

- Generic skeleton (`HostBridge`, `ConnectionMode`, `AuthScheme`, `OriginPolicy`, `PairingConfig`, `RoleCollisionPolicy`, `new_with_options`) — `desktop/src-tauri/src/bridges/host_bridge.rs` (~1389 LOC of implementation plus 64 test functions spanning ~1715 lines)
- IDE Bridge, refactored to `ConnectionMode::Endpoint` — `desktop/src-tauri/src/bridges/ide_bridge.rs` (its 43 test functions — 38 synchronous, 5 async — pass unchanged after the refactor; the old top-level `desktop/src-tauri/src/ide_bridge.rs` was removed)
- Per-plugin bridge built from a manifest `host_bridge` block, including `translate_collision_policy` — `desktop/src-tauri/src/bridges/plugin_host_bridge.rs`
- Manifest schema (`HostBridgeManifest`: `roles`, `collision_policy`, `preferred_port`, `persistent_token`) and validation — `crates/speedwave-runtime/src/plugin.rs`
- Owner-only `0o700` directory helper added for the bridge lock dirs — `set_owner_only_dir` in `desktop/src-tauri/src/fs_perms.rs`
- Module index and bridge manager wiring — `desktop/src-tauri/src/bridges/mod.rs`, imports in `desktop/src-tauri/src/main.rs` and `desktop/src-tauri/src/reconcile.rs`

## Rejected alternatives

- Duplicating the IDE Bridge skeleton per new bridge — multiplies the security surface (each new `0o600` lock file is another chance to get permissions wrong) and scatters the threat model across modules.
- Random-port fallback when `preferred_port` is busy — silently invalidates a companion app's saved URL with no signal to the user; the bridge hard-fails instead.

## Amendment (2026-10-08): HttpForward mode for host-local HTTP MCP servers

**Context.** Custom MCP servers may already run on the user's machine as HTTP endpoints bound to loopback, for example a desktop design tool's own MCP server. A host-mode guard container must reach such a server, and nothing else on the host. The guard speaks MCP Streamable HTTP: `POST` for JSON-RPC (answered with JSON or an SSE stream), `GET` for a server-sent event stream, `DELETE` to end a session, with `Mcp-Session-Id`, `MCP-Protocol-Version` and `Last-Event-ID` headers.[^4] A WebSocket mode cannot carry that, and a second hand-rolled listener would duplicate the skeleton this ADR exists to centralise.

**Decision.** `HostBridge` gains a third mode, `ConnectionMode::HttpForward(HttpForwardConfig)` (`desktop/src-tauri/src/bridges/http_forward.rs`), an HTTP/1.1 server on hyper 1.x[^5] that reuses everything else: bind through `bind_with_retry` on `host_bind_address()`, the lock file and its watchdog, the ADR-080 mirror relay ensure/re-ensure/remove, and `stop`.

- **Routing by bearer.** `HttpForwardConfig.routes` is a shared `bearer → Upstream { port, path, server }` table, re-read on every request, so its owner adds and removes routes without restarting the listener; a route removed mid-session answers the next request with 401. The only credential is `Authorization: Bearer <token>`[^6] (scheme case-insensitive), compared with `constant_time_eq` against every route without an early exit. `build()` requires `OriginPolicy::RejectIfPresent` and no top-level auth scheme.
- **Request checks**, in order: no matching bearer → 401; `Origin` present → 403; path-and-query other than exactly `/` → 404; a method other than `POST`/`GET`/`DELETE` → 405 with `Allow`; a body over `body_cap` (4 MiB) → 413, by `Content-Length` and by counting streamed bytes. The request body is buffered (it is capped), the response is streamed frame by frame, so SSE events reach the guard as the upstream writes them.
- **The upstream is never a hostname.** A route carries a port and a path; the relay always dials the loopback literal `http_forward.rs::HOST_LOCAL_UPSTREAM_IP` and sets `Host: 127.0.0.1:<port>`. The relay therefore cannot be turned into an SSRF primitive: a bearer selects one of the user's approved local ports, nothing else. It deliberately dials loopback instead of `host_bind_address()`, because a host app listens on loopback even when the bind address is the WSL NAT adapter IP.
- **Headers.** Hop-by-hop headers (`Connection` and every header it lists, `Keep-Alive`, `Proxy-Connection`, `Proxy-Authorization`, `Proxy-Authenticate`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`)[^7] are stripped in both directions, as are `Expect` (the relay has already buffered the whole body, so there is nothing left to continue), `Content-Length` (hyper re-frames), `Authorization`, `Host`, `Cookie`, `Set-Cookie`, `Forwarded`, `X-Forwarded-*` and `Origin`. `Mcp-Session-Id`, `MCP-Protocol-Version`, `Accept`, `Content-Type` and `Last-Event-ID` pass through, and the response's `Mcp-Session-Id` and `Content-Type` come back.
- **Failures.** A 3xx from the upstream becomes 502 and is never followed. A refused or timed-out connect (5 s), or no response headers within the request bound (300 s), becomes 502 with the JSON-RPC body `{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"host_app_unavailable"}}`, which the guard turns into "<App> is not running". A response body is cut off (the stream is aborted, never ended cleanly) past `response_cap` (16 MiB, counted across chunks), past the 300 s bound for a non-SSE body, or after 120 s without a frame on an SSE body.
- **Connections.** At most `max_connections` (64) connections are served at once: the listener takes a semaphore permit before each `accept`, so further clients wait in the kernel backlog until a connection ends (hyper closes one that sends no complete request head within 30 s, its default `header_read_timeout` once a timer is set[^8]). A failed `accept` (for example `EMFILE`) releases its permit and backs off 50 ms, doubling to at most 1 s, instead of spinning; the first failure of a run is logged at warn, the rest at debug.
- **Logs** name the method, status, server name and byte counts, never a body, a header value or a bearer. `HttpForwardConfig`'s `Debug` prints the route count only.
- **Lock placement.** A new builder knob `lock_dir` puts the lock outside `<data_dir>/<name>-bridge/`, because one relay serves one project and the 33-character bridge name cannot carry a project name. A second knob, `on_watchdog_tick`, runs the owner's callback on every ~30 s relay re-ensure tick, which lets the owner follow an addressing flip without a thread of its own.

**Consequences.** `hyper` (server, client and http1 features) and `hyper-util` (server, tokio) become direct Desktop dependencies; both were already in `desktop/src-tauri/Cargo.lock` through reqwest, so the lockfile only gains the dependency edges. The first owner is `bridges/custom_host_relay.rs` (ADR-080 amendment of the same date). The skeleton now has three modes; a new host-side HTTP relay is an `HttpForward` bridge, never a new listener.

## Related

- ADR-062 — Playwright host-gateway access, which uses the same `host.docker.internal` canonical alias the bridges expose to containers (`docs/adr/ADR-062-playwright-host-gateway-access.md`).

[^1]: The WebSocket `constructor(url, protocols)` accepts only a URL and an optional subprotocol list - no mechanism to set arbitrary request headers such as `Origin` or auth headers: https://websockets.spec.whatwg.org/

[^2]: HTTP 409 Conflict - "the request could not be completed due to a conflict with the current state of the target resource": https://www.rfc-editor.org/rfc/rfc9110.html#name-409-conflict

[^3]: RFC 6455 defines the Closing Handshake and Close frame status codes as part of an already-established connection (Sections 1.4, 5.5.1, 7): https://www.rfc-editor.org/rfc/rfc6455.html

[^4]: MCP Streamable HTTP transport (POST/GET/DELETE, SSE responses, `Mcp-Session-Id`, `MCP-Protocol-Version`, resumption with `Last-Event-ID`): https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http

[^5]: hyper 1.x HTTP/1 server and client connection APIs: https://docs.rs/hyper/1/hyper/server/conn/http1/index.html and https://docs.rs/hyper/1/hyper/client/conn/http1/index.html

[^6]: RFC 6750, the OAuth 2.0 Bearer Token usage of the `Authorization` request header: https://www.rfc-editor.org/rfc/rfc6750#section-2.1

[^7]: RFC 9110 §7.6.1, the `Connection` header and the fields an intermediary removes before forwarding (it names `Proxy-Connection`, `Keep-Alive`, `TE`, `Transfer-Encoding` and `Upgrade`): https://www.rfc-editor.org/rfc/rfc9110.html#name-connection. `Proxy-Authenticate`, `Proxy-Authorization` and `Trailer` come from the hop-by-hop list of the obsoleted RFC 2616 §13.5.1 (which spells the last one `Trailers`): https://www.rfc-editor.org/rfc/rfc2616#section-13.5.1

[^8]: hyper 1.x `server::conn::http1::Builder::header_read_timeout`, 30 s by default, requires a timer: https://docs.rs/hyper/1/hyper/server/conn/http1/struct.Builder.html#method.header_read_timeout

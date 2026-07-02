# ADR-063: Generic HostBridge skeleton for host-side WebSocket relays

> **Status:** Accepted
> **Context:** The IDE Bridge was the only host-side WebSocket bridge in the Desktop process; new bridges (for plugins that pair a container worker with a desktop-side companion app) would have duplicated ~95% of its security-sensitive infrastructure.

## Decision

Extract the shared bridge skeleton — loopback TCP listener, `0o600` lock file under `~/.speedwave/<name>-bridge/<port>.lock`, UUID auth token with constant-time compare, Origin/subprotocol policy, watchdog, graceful shutdown — into one audited `HostBridge` type. It supports two connection modes: **Endpoint** (one client, the handler runs for the connection lifetime — used by the IDE Bridge to proxy to the upstream IDE or answer MCP stubs) and **Pairing** (two declared roles connect and the bridge relays every text/binary frame between them verbatim, with a per-frame size cap that closes the pair with WebSocket status 1009).

## Why

- One place to get the security model right: every hand-rolled `0o600` lock file is a place to get permissions wrong, so the skeleton (TCP + lock file + UUID + Origin/subprotocol + watchdog) lives in a single audited module. Adding a third bridge is handler logic only, not a re-implementation of the relay.
- Two auth transports are needed: a request **header** for worker/Node clients that can set arbitrary upgrade headers, and a `?token=` **query parameter** for browser clients, which the WebSocket API forbids from setting custom upgrade headers (per the WHATWG HTML spec).
- Origin policy follows from the transport: `RejectIfPresent` (the historical IDE Bridge rule — Claude Code and the `ws` Node client never send Origin, so its presence implies a browser CSRF attempt) versus `AcceptIfAuthIsQueryParam` (a browser client is allowed only when it authenticated via query param; a header-auth worker that also carries Origin is a forged combo and is rejected).
- The lock file uses an atomic create-temp-then-rename write, which closes the short window where a partial write could expose the file if directory permissions were ever weakened. A watchdog re-creates the lock file (default every 5 s) if it is deleted, mirroring the IDE Bridge's behaviour.
- Pairing collisions are refused at the HTTP layer with 409 Conflict before the upgrade, because WebSocket Close frames are only meaningful after a successful opening handshake (RFC 6455 §4.4) — so a third or same-role connection cannot be refused with a close code.
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
- User-facing flow — "Bridge plugins — dev UX" in `docs/guides/integrations.md`

## Rejected alternatives

- Duplicating the IDE Bridge skeleton per new bridge — multiplies the security surface (each new `0o600` lock file is another chance to get permissions wrong) and scatters the threat model across modules.
- Random-port fallback when `preferred_port` is busy — silently invalidates a companion app's saved URL with no signal to the user; the bridge hard-fails instead.

## Related

- ADR-062 — Playwright host-gateway access, which uses the same `host.docker.internal` canonical alias the bridges expose to containers (`docs/adr/ADR-062-playwright-host-gateway-access.md`).

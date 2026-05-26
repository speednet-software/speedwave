# ADR-063: Generic HostBridge skeleton for host-side WebSocket relays

**Status:** Accepted
**Date:** 2026-05-21

## Context

Speedwave shipped one host-side WebSocket bridge in the Desktop process:
the **IDE Bridge** (`desktop/src-tauri/src/ide_bridge.rs`, ~1841 LOC),
which pairs Claude Code inside the container with a local IDE
(VS Code / Cursor). Future bridges (host-side relays for plugins that
need to pair a container worker with a desktop-side companion app) will
share ~95% of the IDE Bridge's infrastructure: TCP listener on
`127.0.0.1`, lock file at `~/.speedwave/<name>-bridge/<port>.lock`,
UUID v4 auth token, constant-time compare,
`tokio_tungstenite::accept_hdr_async`, Origin / subprotocol policy,
watchdog re-creating the lock file, stale-lock cleanup, graceful
shutdown via `tokio::sync::broadcast`. Duplicating that skeleton for
every new bridge would multiply the security surface (every place that
hand-rolls a 0o600 lock file is one place to get the
permissions wrong), and would scatter the threat model across modules.

The differences between bridges live in the connection handler:

- **IDE Bridge** is an **endpoint** — Claude is the only client, and
  the bridge either answers MCP stubs or transparently proxies to the
  upstream IDE.
- **Figma Bridge** is a **relay** — two clients (the `mcp-figma`
  worker in the container and the "Speedwave DS Bridge" plugin loaded
  in Figma Desktop) connect to it, and the bridge forwards every frame
  between them verbatim.

We also need to support two authentication transports:

- **Header** (`x-claude-code-ide-authorization`, `x-figma-bridge-auth`) —
  workers / Node clients that can set arbitrary headers on the
  WebSocket upgrade.
- **Query parameter** (`?token=<uuid>`) — browser-based clients (Figma
  plugin UI iframe). Browsers cannot set custom headers on the
  WebSocket upgrade.[^1]

## Decision

Extract the shared skeleton into
`desktop/src-tauri/src/bridges/host_bridge.rs` as a `HostBridge` type
with two connection modes:

```rust
pub enum ConnectionMode {
    Endpoint,
    Pairing(PairingConfig),
}
```

### Endpoint mode

Handler closure receives an already-authenticated `WebSocketStream` plus
a `ConnectionContext` (peer addr, path, query, matched auth scheme,
selected subprotocol, shutdown receiver). The handler runs for the
lifetime of the connection. IDE Bridge plugs in proxy + stub logic this
way.

### Pairing mode

`PairingConfig.roles: HashMap<&'static str, AuthScheme>` declares one
role per concurrent connection. The bridge pairs **different** roles
only — connecting twice as the same role evicts the older pending slot.
Once both roles are present, the bridge spawns a relay that forwards
text and binary frames in both directions; a per-frame size cap
(`max_frame_bytes`) is enforced via `tokio_tungstenite::WebSocketConfig`
so violations close the pair with WebSocket status 1009.

### Authentication

`AuthScheme::{Header(name), QueryParam(name)}` — the validator checks
the matching transport, the matched scheme is reported back in
`AuthMatch` so the consumer can use it for diagnostics or role
discrimination.

### Origin policy

```rust
pub enum OriginPolicy {
    RejectIfPresent,
    AcceptIfAuthIsQueryParam,
}
```

`RejectIfPresent` is the historical IDE Bridge policy (Claude Code and
the `ws` Node client never set Origin; browsers always do — so Origin
implies CSRF). `AcceptIfAuthIsQueryParam` is for bridges with a browser
client: Origin is allowed iff the request authenticated via query
param. A worker (Header auth) that also carries Origin is treated as a
forged combo and rejected.

### Lock file

Atomic write: create a `tempfile::NamedTempFile` in the same directory
as the final path, chmod 0o600 (Unix) / Windows ACL, write, flush,
`persist()` (atomic rename on Unix, `MoveFileExW(REPLACE_EXISTING)` on
Windows).[^2] This replaces the pre-HostBridge "open with mode 0o600 +
truncate + write" recipe — the new pattern eliminates the short window
where a partial write would expose the file to other processes if the
directory permissions were ever weakened.

A watchdog thread re-creates the lock file every `watchdog_interval`
(default 5 s) if it has been deleted, mirroring the IDE Bridge's
existing behaviour.

### Pre-handshake collision response: HTTP 409

Pairing-mode `accept_hdr_async` callback rejects with HTTP 409 Conflict
_before_ the WebSocket upgrade when a pair is already active or when a
same-role collision must be denied. WebSocket Close frames cannot be
sent until the upgrade is accepted, so the only protocol-compliant way
to refuse the third connection is at the HTTP layer.[^3]

### Shutdown propagation

A single `tokio::sync::broadcast::Sender<()>` fans out to: the accept
loop (`tokio::select!` between `listener.accept()` and `shutdown.recv()`),
the watchdog (polls between sleeps), and every connection handler
(receives a `broadcast::Receiver<()>` in `ConnectionContext` /
`run_relay`). `HostBridge::stop()` sends one signal, joins the threads,
and removes the lock file. `Drop` calls `stop().ok()` so a never-started
bridge still cleans up.

### Pair-id race fix

In Pairing mode, the relay task is `tokio::spawn`-ed _after_ the bridge
state records the pair as active. The state stores a `pair_id: u64`
generation counter, and the relay task only clears `active` if the
recorded id still matches. This avoids the race where a very fast pair
disconnect would clear `active` _after_ the main loop wrote a new
`Some(...)` value.

### Manifest options: stable port and persistent token

Two optional `host_bridge` fields refine the lifecycle for plugins
that pair a worker with an external app the user configures once:

- `preferred_port: Option<u16>` (must be > 1023) — `HostBridge::new_with_options`
  binds `127.0.0.1:<p>` and hard-fails if the port is busy. No random-port
  fallback: a silent port change would invalidate the external app's
  saved URL with no signal to the user.
- `persistent_token: bool` — when `true`, the UUID is loaded from
  `<data_dir>/plugin-state/<slug>/bridge-token` (chmod 0o600). First
  startup generates and writes it via `runtime_fs_perms::write_restricted_file`;
  later startups reuse it. `remove_plugin` deletes the whole
  `plugin-state/<slug>/` so reinstall regenerates the token.

The user-facing flow lives in `docs/guides/integrations.md` →
"Bridge plugins — dev UX".

Threat model delta for `persistent_token: true`: the secret's lifetime
extends from one Speedwave session to "until plugin uninstall". The
file is chmod 0o600 inside an owner-only-700 directory; an attacker
with read access to `~/.speedwave/` already has read access to the
user's home, so persistence does not meaningfully widen the practical
attack surface.

## Files touched

| File                                            | Change                                         |
| ----------------------------------------------- | ---------------------------------------------- |
| `desktop/src-tauri/src/bridges/mod.rs`          | NEW                                            |
| `desktop/src-tauri/src/bridges/host_bridge.rs`  | NEW (~1100 LOC + ~40 tests)                    |
| `desktop/src-tauri/src/bridges/ide_bridge.rs`   | MOVED + REFACTORED to use HostBridge::Endpoint |
| `desktop/src-tauri/src/ide_bridge.rs`           | DELETED                                        |
| `desktop/src-tauri/src/fs_perms.rs`             | + `set_owner_only_dir()` for 0o700 dir perms   |
| `desktop/src-tauri/src/main.rs`, `reconcile.rs` | import paths + cleanup integration             |

## Consequences

### Positive

- One audited place for TCP+lock-file+UUID+Origin/subprotocol +
  watchdog. Adding a third bridge (Sketch plugin? Blender add-on?) is
  ~250 LOC of handler logic, not 1800.
- Pre-handshake HTTP 409 gives clients a proper protocol-layer error
  instead of an opaque connection drop.
- Atomic lock-file write closes the partial-write window without
  changing the public surface of `IdeBridge` (43 existing tests pass
  unchanged after the refactor).
- Pairing relay forwards binary frames as-is, so future plugins that
  need a chunked-binary protocol over the bridge can opt into it
  without further infrastructure work.

### Negative

- `HostBridge` is _not_ a perfect zero-cost abstraction: the
  per-connection handler is `Arc<dyn Fn>` and the relay path does an
  extra task spawn per pair. Both are measured against the dominant
  cost (TCP accept + TLS-free WebSocket handshake + tungstenite frame
  parsing) and are not in the critical path of any user-visible
  latency.

### Neutral

- `RoleCollisionPolicy` exposes both `Reject` (pre-handshake HTTP 409)
  and `EvictOlder` (drop older pending stream, accept the new one).
  The IDE Bridge uses `EvictOlder` exclusively; plugins opt in to
  `Reject` via `host_bridge.collision: "reject"` in their manifest
  (translated by `plugin_host_bridge::translate_collision_policy`).

## References

- `desktop/src-tauri/src/ide_bridge.rs` history pre-refactor (43 tests
  retained).
- ADR-062 — Playwright host-gateway access (uses the same
  `host.docker.internal` canonical alias the bridges expose to
  containers).

## Footnotes

[^1]:
    WebSocket API standard does not expose a way to set custom
    request headers on the upgrade.
    https://html.spec.whatwg.org/multipage/web-sockets.html#the-websocket-interface

[^2]:
    `tempfile::NamedTempFile::persist` documentation describes the
    Unix `rename(2)` and Windows `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`
    guarantees. https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html#method.persist

[^3]:
    RFC 6455 §4.4 — close codes are only meaningful after a
    successful opening handshake. https://www.rfc-editor.org/rfc/rfc6455#section-4.4

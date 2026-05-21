# ADR-064: Figma Bridge host relay

**Status:** Accepted
**Date:** 2026-05-21

## Context

Speedwave is shipping a Figma plugin (`speedwave-plugins/figma`) whose
main feature is `figma_plugin_*` MCP tools that write into Figma files
(variables, components, styles, images). The Figma write surface lives
inside the Figma Desktop sandbox and cannot be hit over plain HTTP:

- **Figma REST** can only write Variables, and only on the Enterprise
  plan.[^1] Our target plan is Organization; REST is therefore
  read-only for us.
- **Figma Remote MCP** is in beta and post-beta is paid; we are not
  going to gate a Speedwave feature on Figma's metered API.[^2]
- **Figma Plugin API** can write everything, on every plan, with no
  rate limit — but it runs **inside the Figma Desktop sandbox**, with
  no `fetch`/`WebSocket` in the sandbox itself and no `listen()` in
  the iframe UI. The plugin can be a WebSocket *client* only.[^3]

The plugin worker (`mcp-figma`) lives in the container and **cannot
listen on the host** either — Speedwave containers run with
`cap_drop: ALL`, `read_only`, no `ports:` mapping. Both sides of the
desired channel are clients-only, so we need a third process to listen
and relay between them. That third process is the **Figma Bridge** in
Speedwave Desktop.

## Decision

Add `desktop/src-tauri/src/bridges/figma_bridge.rs` as a thin wrapper
over `HostBridge` (ADR-063) in `Pairing` mode with two roles:

| Role | Auth scheme | Client |
|---|---|---|
| `worker` | Header `x-figma-bridge-auth` | `mcp-figma` container (Node `ws` client) |
| `plugin` | Query parameter `?token=<uuid>` | Figma Desktop plugin UI iframe (browser WebSocket API — no header support) |

```rust
let config = HostBridgeConfig::builder("figma")
    .pairing(PairingConfig {
        roles: HashMap::from([
            ("worker", AuthScheme::Header("x-figma-bridge-auth")),
            ("plugin", AuthScheme::QueryParam("token")),
        ]),
        pending_slot_timeout: Some(Duration::from_secs(300)),
    })
    .origin_policy(OriginPolicy::AcceptIfAuthIsQueryParam)
    .subprotocol(SubprotocolPolicy { accepted: &[] })
    .max_frame_bytes(Some(1024 * 1024))
    .lock_body(/* schema below */)
    .build()?;
```

### Frame size cap: 1 MiB

Enforced by `WebSocketConfig::{max_message_size, max_frame_size}`.
Violations trigger WebSocket close 1009 (Message Too Big)[^4] and the
generic relay tears the pair down. The cap is high enough for every
current `figma_plugin_*` payload but low enough that a malicious
plugin cannot exhaust desktop memory by spamming megabyte messages.

### Origin policy: `AcceptIfAuthIsQueryParam`

The Figma plugin UI iframe runs in a Chromium browser context inside
Figma Desktop and **always** sets `Origin`. We accept the Origin iff
the request authenticated via query parameter (which only the plugin
UI is supposed to do). A worker that sets Origin is treated as a
forged combo and rejected at the HTTP layer.

### Two credential views

The plugin worker (inside the container) and the Figma Desktop plugin
UI (outside the container) need different URLs for the same port:

| Caller | URL | Source |
|---|---|---|
| `mcp-figma` worker | `ws://host.docker.internal:<port>/` | Compose env var declared by the plugin manifest (`FIGMA_BRIDGE_URL`) |
| Figma Desktop plugin UI | `ws://127.0.0.1:<port>/` | Tauri command `figma_bridge_get_credentials` |

The token is identical for both (same UUID minted by `HostBridge::new`).
This duality is exposed via two methods on `FigmaBridge`:

- `compose_info()` → `FigmaBridgeComposeInfo { port, auth_token }`. The
  Desktop's `reconcile::current_bridges_info()` combines it with the
  env-var names from the plugin manifest's `host_bridge` block to
  produce a generic `speedwave_runtime::compose::HostBridgeRegistration`
  that the renderer consumes.
- `credentials_for_local_ui()` → `FigmaBridgeCredentials { local_ui_url,
  token }` (formats `127.0.0.1` directly).

### Bridge is always running

`init_and_start_figma_bridge` runs once at Desktop startup, regardless
of whether the Figma plugin is installed or enabled in any project.
Same lifecycle pattern as IDE Bridge — when the plugin is disabled the
bridge sits idle on an OS-assigned port. The trade-off is one extra
TCP socket bound to `127.0.0.1`; the win is that `render_compose` can
inject `FIGMA_BRIDGE_URL` without first racing to start the bridge,
and the user-visible "copy URL+token into the Figma plugin" flow is
available the moment Desktop is up.

### Lock file schema

```json
{
  "pid": <speedwave-desktop-pid>,
  "port": <bridge-port>,
  "ideName": "Speedwave DS Bridge",
  "transport": "ws",
  "authToken": "<uuid>"
}
```

Stored at `~/.speedwave/figma-bridge/<port>.lock` with permissions
0o600 / Windows ACL (file) and 0o700 / Windows ACL (parent dir),
written atomically via `tempfile::NamedTempFile::persist` (ADR-063).
The `port` field is also derivable from the file name; embedding it
keeps the JSON self-describing for ad-hoc diagnostics.

### Compose injection

`render_compose` gains a `bridges: &HostBridgesInfo` parameter — a
flat `Vec<HostBridgeRegistration>` keyed by plugin slug. Each
registration carries the port, token, and the env-var **names** the
plugin manifest declared in its `host_bridge` block:

```rust
struct HostBridgeRegistration {
    plugin_slug: String,
    port: u16,
    auth_token: String,
    url_env: String,    // e.g. "FIGMA_BRIDGE_URL"
    token_env: String,  // e.g. "FIGMA_BRIDGE_TOKEN"
}
```

When a plugin's manifest declares `host_bridge` *and* a matching
registration is present, the renderer injects:

```yaml
services:
  mcp-figma:
    environment:
      - FIGMA_BRIDGE_URL=ws://host.docker.internal:<port>/
      - FIGMA_BRIDGE_TOKEN=<uuid>
    extra_hosts:
      - "host.docker.internal:${HOST_GATEWAY_IP}"
```

When no registration matches the plugin's slug (e.g. CLI build, or
Desktop before the bridge has started), no env vars are injected; the
worker reports `BRIDGE_NOT_CONFIGURED` and the bridge tools cleanly
degrade. The CLI's render call-sites (`crates/speedwave-cli/src/main.rs`,
`crates/speedwave-runtime/src/{update,project}.rs`) pass
`&HostBridgesInfo::default()`; the Desktop's `setup_wizard.rs` and
`containers_cmd.rs` pass `crate::reconcile::current_bridges_info()`,
which reads the process-global `OnceLock<SharedFigmaBridge>` published
by `main.rs::setup()` once the bridge starts and joins it with the
manifest fields.

Core (`crates/speedwave-runtime`) contains zero references to the
string `"figma"` — the renderer dispatches on `manifest.host_bridge`
presence + `plugin_slug` match. Adding a second host-bridged plugin
(e.g. a future browser-extension companion) needs only a manifest with
its own `host_bridge` block and a Desktop side that publishes a
matching `HostBridgeRegistration`.

## Threat model

- **Bridge bound to 127.0.0.1** — not reachable from LAN, only the
  host's loopback. The container reaches it through the Lima vzNAT /
  WSL2 catch-all forwarder for non-privileged loopback ports.
- **UUID v4 token** (122-bit random, OS CSPRNG via `getrandom`) —
  brute force infeasible within any session.
- **Constant-time token comparison** prevents timing side channels.
- **One pair at a time** — third connection rejected with HTTP 409
  before WebSocket upgrade. Prevents a hostile process from holding
  the bridge open while a legitimate user can never sneak in.
- **Frame size cap 1 MiB** — defends against memory exhaustion from a
  rogue plugin (or a worker compromised through a malicious Figma
  file).
- **Lock file 0o600 in 0o700 directory** — token unreadable by other
  users on the host. Windows ACL granting `GENERIC_ALL` to the current
  user only.
- **Token never logged** — `HostBridge::Debug` redacts; the bridge has
  no other code path that prints the token. The Desktop event channel
  emits `figma_bridge_event` with role + state only.

Residual risks:

- A user-mode process running as the same UID can read the lock file.
  This is the same residual risk as IDE Bridge (ADR-061 / ADR-060) and
  matches the platform-standard assumption that same-uid processes are
  inside the trust boundary.
- A malicious Figma plugin running concurrently in the same Figma
  Desktop instance could try to connect to the bridge. It would need
  the token, which is shown only in the Speedwave Desktop UI's "Copy
  credentials" panel. We do not defend against the user copy-pasting
  the token into another plugin.

## Out of scope

- **Chunked WS frames** for `export_snapshot` v0.2 of the plugin. The
  current bridge forwards single frames up to 1 MiB; framing larger
  payloads is a plugin-level concern.
- **Mutual TLS / certificate pinning.** The bridge runs on loopback;
  TLS would be overhead without benefit.
- **Per-project Figma Bridge.** One bridge per Desktop instance is
  enough: the contract is one paired session at a time, and switching
  projects does not require restarting the bridge.

## References

- ADR-063 — Generic HostBridge skeleton.
- `speedwave-plugins/figma/PRD.md` — product context.
- `speedwave-plugins/figma/docs/integration/speedwave-core-changes.md`
  — the change request that motivated this PR.

## Footnotes

[^1]: Figma REST API — Variables endpoints documented as Enterprise
  only. https://www.figma.com/developers/api#variables
[^2]: Figma Remote MCP — public beta announcement (March 2025) noting
  post-beta pricing. https://help.figma.com/hc/en-us/articles/32132100833559
[^3]: Figma Plugin API — sandbox does not expose `fetch`, `WebSocket`,
  or network listeners. https://www.figma.com/plugin-docs/api/api-overview/
[^4]: RFC 6455 §7.4.1 — close code 1009 "Message Too Big".
  https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1

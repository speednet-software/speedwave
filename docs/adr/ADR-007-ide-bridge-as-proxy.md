# ADR-007: IDE Bridge as Proxy

> **Status:** Accepted (Windows bind revised by [ADR-079](ADR-079-wsl2-mirrored-container-host-relay.md))
> **Context:** Claude runs inside a VM (Lima on macOS, WSL2 on Windows) and cannot see the host's IDE lock files, yet Claude Code's IDE integration depends on them.
>
> **Update (ADR-079):** the "binds the WSL vEthernet adapter IP on Windows" note below holds only under **NAT** networking. Under **mirrored** networking (the default) the bridge binds `127.0.0.1` and containers reach it via a guest-side `socat` relay — invisible to the LAN either way.

## Decision

Speedwave runs an on-host **IDE Bridge** that impersonates an IDE to the isolated Claude process. Claude connects to the bridge over WebSocket (believing it is talking to a real editor); the bridge forwards `openFile` / `getDiagnostics` events to the actual VS Code or JetBrains extension on the host.

## Why

- Claude Code's [IDE integration protocol](https://code.claude.com/docs/en/ide-integrations) is lock-file + WebSocket: an editor writes `~/.claude/ide/<port>.lock`, Claude reads the port from the filename and connects to `ws://<host>:<port>`. The bridge writes that lock file on the host and serves the WebSocket itself.
- The bridge speaks the same MCP JSON-RPC 2.0 dialect IDE extensions use, so one bridge serves every editor (VS Code, JetBrains, Neovim, Zed) — no per-editor code.
- Keeping the bridge on the host preserves container isolation: Claude never gains host filesystem access; only the bridge does.

## How it connects

- The bridge writes its lock file under `<data_dir>/ide-bridge/<port>.lock` on the host; that directory is mounted read-only into the Claude container at `/home/speedwave/.claude/ide`, so Claude sees the standard `~/.claude/ide/<port>.lock` path.
- The bridge binds a host TCP listener; containers reach it through the canonical gateway alias `host.docker.internal`, injected into each container's `extra_hosts` and mapped to the per-platform gateway IP ([Lima user-mode vzNAT](https://lima-vm.io/docs/config/network/user/) on macOS, WSL2 NAT on Windows). One alias, one code path; only the resolved host IP differs per platform.
- `render_compose()` injects `CLAUDE_CODE_IDE_HOST_OVERRIDE=host.docker.internal` into the Claude container so Claude Code connects to the bridge instead of its default `127.0.0.1`. See ADR-014 for the platform mechanism.

## Security

- **Bind address:** the host listener binds via `compose::host_bind_address()` — `127.0.0.1` on macOS, the WSL vEthernet adapter IP on Windows (invisible from the LAN). Never a public interface.
- **Auth token:** a per-session UUID v4 token, compared in constant time. With a loopback/adapter-only bind plus an unguessable per-session token, brute force is infeasible — no TTL or rate limiting needed.
- **Origin rejection:** WebSocket upgrades carrying an `Origin` header are rejected with HTTP 403, blocking CSRF from a malicious web page — the mitigation for the WebSocket origin-validation class of attack tracked as [CVE-2025-52882](https://nvd.nist.gov/vuln/detail/CVE-2025-52882) (see ADR-014).
- **Lock file permissions:** lock file `0o600`, directory `0o700`; on Windows an owner-only ACL.
- **Watchdog:** a background thread re-writes the lock file every 5 s if it disappears (container restart, volume cleanup).
- **Cleanup:** the lock file is removed on session end via an RAII `Drop` impl; stale lock files from crashed sessions are swept at startup.

## Where it lives in code

- IDE Bridge (lock-file body `ideName`/`workspaceFolders`/`transport`/`runningInWindows`/`authToken`, display name `Speedwave`, WebSocket proxy, `Drop` cleanup) — `desktop/src-tauri/src/bridges/ide_bridge.rs`
- Shared bridge mechanics (`host_bind_address` binding, `constant_time_eq`, 5 s watchdog, HTTP 403 origin rejection, atomic lock-file write with `0o600`/`0o700`) — `desktop/src-tauri/src/bridges/host_bridge.rs`
- Lock-dir mount and IDE host override injection — `crates/speedwave-runtime/src/compose.rs` (`ide_host_override`); template line `${IDE_LOCK_DIR}:/home/speedwave/.claude/ide:ro` in `containers/compose.template.yml`
- Gateway alias SSOT — `crates/speedwave-runtime/src/consts.rs::HOST_GATEWAY_ALIAS` (`host.docker.internal`)

## Rejected alternatives

- **Run the IDE inside the VM, or punch a host path through to Claude** — would defeat container isolation, the whole point of the v1 security model.
- **Per-editor adapters** — unnecessary: the IDE protocol is identical across editors, so a single bridge covers all of them.

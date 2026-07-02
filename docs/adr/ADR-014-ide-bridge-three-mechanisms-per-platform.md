# ADR-014: IDE Bridge — One TCP Mechanism, Per-Platform Gateway

> **Status:** Accepted
> **Context:** Claude runs inside a VM/container (Lima on macOS, WSL2 on Windows) and must reach an IDE Bridge listening on the host.

## Decision

The IDE Bridge is a single host-side TCP listener. Claude connects to it over WebSocket through the canonical gateway alias `host.docker.internal`, which each platform resolves to its own gateway IP. There is one mechanism, not three — the only per-platform difference is the IP that the alias resolves to (Lima vzNAT on macOS, the WSL2 adapter IP on Windows).

## Why

- One uniform code path beats per-platform socket plumbing — the host listener, lock-file protocol, and security model are identical on macOS and Windows.
- `host.docker.internal` is injected into the container's `/etc/hosts` via Compose `extra_hosts`, so the container reaches the host without exposing any port to the LAN (see ADR-010 for the network model).
- The bridge binds on `compose::host_bind_address()`, not a hardcoded loopback literal — on Windows WSL2 mirrored mode breaks 127.0.0.1 reachability, so the host must bind the same WSL adapter IP the container resolves the alias to.

## How it works

1. The bridge binds a random host port via `bind_with_retry()` using `compose::host_bind_address()` (retries once on `EADDRNOTAVAIL` after invalidating the cached adapter IP).
2. `render_compose()` injects `CLAUDE_CODE_IDE_HOST_OVERRIDE` into the Claude container, set to the gateway alias, so Claude Code's hardcoded `ws://127.0.0.1` is overridden.
3. A lock file is written to `~/.speedwave/ide-bridge/<port>.lock` on the host and mounted read-only into the container at `~/.claude/ide/`.
4. Claude Code reads the lock file, derives the port from the filename, and connects to `ws://<gateway-alias>:<port>`, which the per-platform NAT routes to the host listener.

The lock-file body carries `pid: 1` (the host PID is meaningless in the container PID namespace, so init — always alive — is used for Claude Code's `kill -0` liveness check), `ideName: "Speedwave"`, `transport: "ws"`, `runningInWindows`, `workspaceFolders`, and a per-session `authToken`. There is no `port`/`wsUrl` field — the port comes from the filename.

## Where it lives in code

- Host listener, bind logic, watchdog, constant-time token compare — `desktop/src-tauri/src/bridges/host_bridge.rs` (`bind_with_retry`, `constant_time_eq`; default watchdog interval 5s)
- IDE-specific lock-file body, Origin rejection, lock-file write — `desktop/src-tauri/src/bridges/ide_bridge.rs` (`build_ide_lock_file`, `write_lock_file_static`)
- Bind address resolution and `CLAUDE_CODE_IDE_HOST_OVERRIDE` injection — `crates/speedwave-runtime/src/compose.rs` (`host_bind_address`, `ide_host_override` returns `consts::HOST_GATEWAY_ALIAS`)
- Gateway alias SSOT — `crates/speedwave-runtime/src/consts.rs` (`HOST_GATEWAY_ALIAS = "host.docker.internal"`)
- Read-only `~/.claude/ide` mount — `containers/compose.template.yml`
- Windows owner-only ACL on the lock file — `desktop/src-tauri/src/fs_perms.rs` (`set_windows_acl_owner_only`, via `SetNamedSecurityInfoW` / `SetEntriesInAclW`)

## Security

- Lock file is `chmod 0o600`, its directory `0o700`; on Windows an owner-only ACL is applied via `set_windows_acl_owner_only`.
- Per-session UUID v4 auth token (122 bits from the OS CSPRNG), compared in constant time via XOR accumulation. With a loopback-equivalent bind plus this token, brute force is infeasible — no TTL or rate limiting needed.
- WebSocket upgrades carrying an `Origin` header are rejected with HTTP 403. Browsers set `Origin`; Claude Code and IDE extensions do not. This is the mitigation for the WebSocket origin-validation class of attack tracked as [CVE-2025-52882](https://nvd.nist.gov/vuln/detail/CVE-2025-52882).
- A background watchdog re-creates the lock file if it disappears (container restart, volume cleanup). The file is removed on session end via an RAII `Drop`; stale files from crashed sessions are cleaned up at startup by probing the TCP port.

## Rejected alternatives

- **Lima Unix-socket reverse forward** — would need a socat TCP→`ws+unix://` proxy inside the VM. The `CLAUDE_CODE_IDE_HOST_OVERRIDE` env var gives a simpler, uniform TCP solution across both platforms.
- **Parsing `resolv.conf` on Windows to find the host IP** — fragile; the value can change between WSL2 sessions. The gateway alias resolved at compose time is stable.

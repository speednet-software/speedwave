# ADR-014: IDE Bridge — Three Mechanisms Per Platform

## Decision

The IDE Bridge uses a **unified TCP-based approach** across all platforms — it listens on `127.0.0.1:<random_port>` on the host. Each platform provides a different DNS routing mechanism so that Claude (inside a VM or container) can reach the host's loopback address.

## Rationale

Each platform has a different isolation boundary between the container runtime and the host. However, all provide a gateway DNS name that resolves to the host from inside the VM/container:[^1]

| Platform | Isolation               | Gateway DNS name              | How it works                                                                                          |
| -------- | ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| macOS    | Lima VM                 | `host.lima.internal`[^2]      | Lima's hostagent registers this DNS in gvproxy; resolves to host gateway IP                           |
| Linux    | nerdctl (native, no VM) | `host.docker.internal`[^3]    | nerdctl / containerd adds this entry to `/etc/hosts` inside containers (Docker-compatible convention) |
| Windows  | WSL2                    | `host.speedwave.internal`[^4] | `extra_hosts: host.speedwave.internal:host-gateway` in compose; nerdctl resolves to host IP           |

## How It Works

1. IDE Bridge binds `127.0.0.1:0` (random port) on the host[^5]
2. `render_compose()` injects `CLAUDE_CODE_IDE_HOST_OVERRIDE=<gateway_dns>` into the Claude container environment[^6]
3. Lock file is written to `~/.speedwave/ide-bridge/<port>.lock` on the host
4. Host directory is mounted read-only into the container as `/home/speedwave/.claude/ide/`[^7]
5. Claude Code reads the lock file, derives the port from the filename, and connects to `ws://<CLAUDE_CODE_IDE_HOST_OVERRIDE>:<port>`
6. The gateway DNS name routes the connection from the VM/container to the host's loopback

```
Claude (in VM/container)
  → ws://host.lima.internal:<port>  (macOS)
  → ws://host.docker.internal:<port>  (Linux)
  → ws://host.speedwave.internal:<port>  (Windows)
  → IDE Bridge on host (127.0.0.1:<port>)
  → proxies to real IDE (if connected)
```

## Lock File Format

The lock file is written by `IdeBridge::write_lock_file()` at `~/.speedwave/ide-bridge/<port>.lock`:

```json
{
  "pid": 1,
  "workspaceFolders": ["/workspace"],
  "ideName": "Speedwave",
  "transport": "ws",
  "runningInWindows": false,
  "authToken": "<session-uuid>"
}
```

**Notes:**

- `pid: 1` — Claude Code runs `kill -0 <pid>` to check liveness. The host PID doesn't exist in the container's PID namespace, so PID 1 (container init) is used instead — it is always alive.
- `ideName: "Speedwave"` — identifies this as the Bridge, not a real IDE.
- `transport: "ws"` — WebSocket transport (the only supported mode).
- No `port` or `wsUrl` field — Claude Code derives the port from the lock file **filename** (e.g. `12345.lock` → port 12345) and constructs the URL using `CLAUDE_CODE_IDE_HOST_OVERRIDE`.

## Rejected Alternatives

- **Lima Unix socket reverse forward** — Lima supports `reverse: true` for Unix sockets[^8], but this would require a socat TCP proxy inside the VM to bridge `ws://` TCP to `ws+unix://`. The `CLAUDE_CODE_IDE_HOST_OVERRIDE` env var (available since Claude Code 1.x) provides a simpler, uniform solution across all platforms.
- **`resolv.conf` parsing on Windows** — fragile; may change between WSL2 sessions.

## Security

- **Lock file permissions:** `chmod 0o600` on the lock file; `chmod 0o700` on the lock directory (`~/.speedwave/ide-bridge/`). On Windows, the file is restricted via `SetNamedSecurityInfoW` ACL (owner-only access).[^9]
- **Auth token:** per-session UUID v4 generated at bridge startup; constant-time comparison via XOR to prevent timing attacks. With `127.0.0.1` binding + UUID v4 (122 bits of randomness from OS CSPRNG), brute force is infeasible — no TTL or rate limiting needed.
- **Origin header rejection:** WebSocket connections with an `Origin` header are rejected (HTTP 403). Browsers set `Origin` on WebSocket upgrades; Claude Code and IDE extensions do not. This prevents CSRF-style attacks from malicious web pages.[^10]
- **Lock file watchdog:** a background thread re-creates the lock file every 5s if it disappears (container restart, volume cleanup, accidental deletion).
- **Cleanup:** lock file removed on session end via `Drop` impl (RAII). Stale lock files from crashed sessions are cleaned up at startup by probing the TCP port.

---

[^1]: All three gateway mechanisms route container → host traffic without exposing the port to the LAN. See ADR-010 for the full network security model.

[^2]: [Lima Network — user-mode networking (vzNAT, host.lima.internal)](https://lima-vm.io/docs/config/network/user/)

[^3]: [nerdctl command reference — host.docker.internal](https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md)

[^4]: [nerdctl command reference — --add-host / host-gateway](https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md)

[^5]: `ide_bridge.rs:624` — `TcpListener::bind("127.0.0.1:0")`

[^6]: `compose.rs:436` — `ide_host_override()` returns platform-specific gateway DNS; injected as `CLAUDE_CODE_IDE_HOST_OVERRIDE` via compose template

[^7]: `compose.template.yml:26` — `${IDE_LOCK_DIR}:/home/speedwave/.claude/ide:ro`

[^8]: [Lima PR #836 — reverse Unix socket forwarding](https://github.com/lima-vm/lima/pull/836)

[^9]: `ide_bridge.rs:472` — `set_windows_acl_owner_only()` using `SetNamedSecurityInfoW` / `SetEntriesInAclW`

[^10]: [CVE-2025-52882 — Claude Code WebSocket protocol analysis](https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882/)

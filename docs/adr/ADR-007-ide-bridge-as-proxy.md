# ADR-007: IDE Bridge as Proxy

## Decision

Speedwave.app acts as a proxy between the isolated Claude process (Lima VM / nerdctl / WSL2) and the IDE on the host.

## Problem

Claude Code integrates with IDEs via WebSocket + lock file:[^19]

- IDE extension writes `~/.claude/ide/<port>.lock`
- Claude CLI detects the lock file and connects via `ws://127.0.0.1:<port>`
- IDE opens edited files automatically

When Claude runs inside a Lima VM, it has a different network namespace and cannot see the host's lock files. Security requires isolation. These are contradictory requirements.

## Solution

```
Lima VM / nerdctl container / WSL2
└── claude → WebSocket → Speedwave.app (believes it is an IDE)

Speedwave.app (host)
├── writes ~/.speedwave/ide-bridge/<port>.lock (mounted as ~/.claude/ide/ in container)
├── receives events from Claude (openFile, getDiagnostics)
└── forwards to real VS Code / JetBrains extension

VS Code → opens file automatically ✓
```

Speedwave.app is an **active MCP proxy** — it implements the same MCP JSON-RPC 2.0 protocol[^20] used by IDE extensions, but runs on the host with full filesystem access.

The protocol is identical across all editors (VS Code, JetBrains, Neovim[^21], Zed) — one Bridge supports all of them.

## Per-Platform Connectivity

The IDE Bridge listens on `127.0.0.1:<random_port>` on the host (TCP, all platforms). Each platform provides a gateway DNS name so Claude can reach the host from inside the VM/container:

| Platform | Gateway DNS name           | How Claude reaches the Bridge                                                                              |
| -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| macOS    | `host.lima.internal`[^27]  | Lima's hostagent registers DNS in gvproxy; resolves to host gateway IP                                     |
| Linux    | `host.docker.internal`[^4] | nerdctl / containerd adds this entry to `/etc/hosts` inside containers (compatible with Docker convention) |
| Windows  | `host.speedwave.internal`  | `extra_hosts: host.speedwave.internal:host-gateway` in compose; nerdctl resolves to host IP[^28]           |

`render_compose()` injects `CLAUDE_CODE_IDE_HOST_OVERRIDE=<gateway_dns>` into the Claude container environment. Claude Code uses this env var to override the default `127.0.0.1` host when connecting to IDEs.

See ADR-014 for the full platform mechanism details.

## Lock File Format

Written by `IdeBridge::write_lock_file()` at `~/.speedwave/ide-bridge/<port>.lock`:

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

Lock file paths on host:

- macOS / Linux: `~/.speedwave/ide-bridge/<port>.lock`
- Windows: `%USERPROFILE%\.speedwave\ide-bridge\<port>.lock`

The host directory is mounted read-only into the Claude container as `/home/speedwave/.claude/ide/`[^15], so Claude sees the standard `~/.claude/ide/<port>.lock` path. Claude derives the port from the **filename** (e.g. `12345.lock` → port 12345).

## Security

- **Lock file permissions:** `chmod 0o600` on lock file, `chmod 0o700` on lock directory; Windows: owner-only ACL via `SetNamedSecurityInfoW`
- **Auth token:** per-session UUID v4; constant-time XOR comparison to prevent timing attacks. With `127.0.0.1` binding + UUID v4 (122 bits of randomness from OS CSPRNG), brute force is infeasible — no TTL or rate limiting needed.
- **Origin header rejection:** WebSocket connections with an `Origin` header are rejected (HTTP 403) to prevent CSRF from malicious web pages[^20]
- **Lock file watchdog:** background thread re-creates lock file every 5s if it disappears (container restart, volume cleanup)
- **Cleanup:** lock file removed on session end via `Drop` impl (RAII); stale lock files from crashed sessions cleaned up at startup

---

[^4]: [nerdctl command reference — host.docker.internal](https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md)

[^15]: `compose.template.yml:26` — `${IDE_LOCK_DIR}:/home/speedwave/.claude/ide:ro`

[^19]: [Claude Code IDE integrations — VS Code extension](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

[^20]: [CVE-2025-52882 — Claude Code WebSocket protocol analysis](https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882/)

[^21]: [coder/claudecode.nvim - Neovim IDE integration](https://github.com/coder/claudecode.nvim)

[^27]: [Lima Network — user-mode networking (vzNAT, host.lima.internal)](https://lima-vm.io/docs/config/network/user/)

[^28]: [nerdctl command reference — --add-host / host-gateway](https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md)

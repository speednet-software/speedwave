# IDE Bridge

The IDE Bridge allows Claude (running inside a container) to interact with VS Code and JetBrains IDEs on the host.

## How It Works

Speedwave.app acts as an active MCP proxy between Claude (isolated in a Lima VM / nerdctl container / WSL2) and the real IDE on the host. The flow:

1. **IDE Bridge binds** a random TCP port on `127.0.0.1` and writes a lock file to `~/.speedwave/ide-bridge/<port>.lock`.
2. **Host directory is mounted** read-only into the Claude container as `~/.claude/ide/`.
3. **Claude detects the lock file**, derives the port from the **filename** (e.g. `37100.lock` → port 37100), and connects via WebSocket using the platform-specific gateway DNS name (`host.lima.internal` on macOS, `host.docker.internal` on Linux, `host.speedwave.internal` on Windows).
4. **IDE Bridge receives events** from Claude (e.g. `openFile`, `getDiagnostics`) and forwards them to the real IDE extension.
5. **The IDE responds** — VS Code opens files automatically as Claude edits them.

### Lock File Format

The Bridge writes a lock file with the following JSON structure:

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

The port is encoded in the **filename**, not in the JSON body. Claude Code derives the port from the filename and constructs the WebSocket URL using `CLAUDE_CODE_IDE_HOST_OVERRIDE`.

### External IDE Detection

Speedwave also detects external IDEs (VS Code, Cursor, JetBrains) that write their own lock files to `~/.claude/ide/`. The health monitor scans this directory every 5 seconds:

1. Reads all `*.lock` files.
2. Skips lock files created by Speedwave itself (matching own PID).
3. Derives the port from the JSON `"port"` field if present, otherwise falls back to the **filename** (external IDEs like Cursor encode the port only in the filename).
4. Verifies liveness: checks PID is alive (`kill -0` on Unix, `tasklist` on Windows) **and** TCP port is reachable (50ms timeout).
5. Reports detected IDEs in the health dashboard.

### `selected_ide` — SSOT for "actively connected"

`get_system_health.ide_bridge.selected_ide` is the single source of truth for whether an IDE is actively routed through the Bridge. The status bar in `/logs` and the IDE Bridge integrations panel both read from it.

The field is `null` in three cases that the UI should treat identically (show "not connected"):

1. The user has not yet selected an IDE via the picker (`select_ide` Tauri command).
2. The previously selected IDE is no longer detected — for example the editor process exited between health polls, or its lock file was removed. The runtime resolves `selected_ide` by joining the user-config selection against the live `detected_ides` list, so a stale port from a crashed IDE never surfaces.
3. The backend config read failed (a `log::warn!` is emitted in `health.rs::build_bridge_health` so the regression is traceable).

`detected_ides` may contain multiple entries (the daemon scans every lock file under `~/.claude/ide/`); `selected_ide` always resolves to at most one of them. The top-level `port` and `ws_url` describe the _first_ detected IDE for legacy compatibility — frontends that need the routed-through port should prefer `selected_ide.port` and `selected_ide.ws_url`.

## Supported IDEs

Any editor that implements the Claude Code IDE protocol is supported:

- **VS Code** — via the Claude Code extension
- **Cursor** — built-in Claude Code integration
- **JetBrains** (IntelliJ, WebStorm, PyCharm, etc.) — via the Claude Code plugin
- **Neovim** — via [claudecode.nvim](https://github.com/coder/claudecode.nvim)
- **Zed** — via built-in integration

The IDE Bridge uses the same MCP JSON-RPC 2.0 protocol as all editor extensions, so one Bridge supports all of them.

## Platform Specifics

| Platform | Gateway DNS               | Isolation        | Notes                                               |
| -------- | ------------------------- | ---------------- | --------------------------------------------------- |
| macOS    | `host.lima.internal`      | Lima VM          | Lima's hostagent registers DNS in gvproxy           |
| Linux    | `host.docker.internal`    | nerdctl (native) | nerdctl adds this to `/etc/hosts` inside containers |
| Windows  | `host.speedwave.internal` | WSL2             | `extra_hosts` in compose resolves to host IP        |

On all platforms, the Bridge binds to `127.0.0.1` only — the port is never exposed to the LAN.

## See Also

- [ADR-007: IDE Bridge as Proxy](../adr/ADR-007-ide-bridge-as-proxy.md)
- [ADR-014: IDE Bridge — Three Mechanisms Per Platform](../adr/ADR-014-ide-bridge-three-mechanisms-per-platform.md)

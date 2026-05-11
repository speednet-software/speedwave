# ADR-054: `host-exec` — Host-Side MCP Worker for the Project Toolchain

**Status:** Accepted

**Date:** 2026-05-11

**Tracking:** SPW-83 (migrated from GitHub issue `speednet-software/speedwave#299`)

> **Accepted 2026-05-11.** This ADR records a deliberate, scoped weakening of Speedwave's container-isolation model — see §Consequences/Negative. Accepted with the open questions below resolved inline (see §"Open questions").

## Context

Claude Code runs inside the `claude` container, which is built on `node:24-bookworm-slim` — Node.js plus git, nothing else. It cannot compile, test, lint, or run the user's project: no JDK, no Gradle/Maven, no Go, no .NET, no Flutter, no Python interpreter, and no access to the Docker / docker-compose stack the user runs on their host machine for project services (database, Redis, queues). Every developer has a different toolchain and a different environment layout; installing all of it inside the container is neither feasible nor desirable, and would bloat the image and the threat surface for everyone.

This is the single most-requested capability gap. It is also a gap users are **already filling by hand, insecurely**: at least one user, asked by Claude (running inside the Speedwave container) for help, was walked through writing a ~30-line Node "agent" (`<workspace>/test-agent/agent.js`), starting it themselves on their Mac bound to `0.0.0.0:8765` with a shared token written to `<workspace>/test-agent/.token` (i.e. inside the repo, where it can be committed and where every MCP worker that mounts `/workspace` can read it), and pointing Claude at it via `host.docker.internal:8765`. Claude then ran `./gradlew test` on the host and, with no confirmation, also ran arbitrary piped shell commands (`find … | xargs … | node -e "…"`) inside the container to parse the results. It worked — because the user owns the machine and authorised it — but it is `host-exec` with none of the mitigations: LAN-exposed, token-in-repo, zero per-call confirmation, an LLM-generated unreviewed agent process running with the user's privileges. The lesson is not "Speedwave has a hole" (it does not — the container still has no tokens, `cap_drop: ALL`, read-only fs; the user voluntarily built a bridge that the threat model already assumes a user *can* build). The lesson is: **ship a safe, official path before more `agent.js` files appear on `0.0.0.0` with tokens in git.**

Speedwave's entire isolation model exists to ensure that a compromise of Claude does **not** yield code execution on the user's machine: token-free `claude` container, `cap_drop: ALL`, `no-new-privileges`, read-only filesystem, `tmpfs` `/tmp` with `noexec,nosuid`, per-project isolated networks, plus a kernel-level isolation layer (Lima VM on macOS, WSL2 on Windows, rootless user namespaces on Linux).[^security] Letting Claude run `./gradlew test` on the host is, by definition, a deliberate weakening of that model. This ADR is about doing it as narrowly and as safely as the design allows — opt-in, empty by default, user-local configuration, per-recipe confirmation, a hard ban on shell interpreters — and writing down the residual risk that remains even then.

There is already a host-side MCP worker in the codebase to use as the template: `mcp-os` (ADR-010, ADR-013). It is a TypeScript MCP server (`mcp-servers/os/src/index.ts`) spawned as a child Node process by the Tauri backend; the Rust side (`desktop/src-tauri/src/mcp_os_process.rs`, ~1700 lines) is a process manager only — spawn, stop, health-check, port/PID/token bookkeeping, stale-process cleanup. It binds to `127.0.0.1` on the host (never `0.0.0.0`, because it runs outside the container network and must not be reachable from the LAN[^mcpos-bind]), and containers reach it via the platform gateway DNS name (`host.lima.internal` on macOS, `host.docker.internal` on rootless Linux, `host.speedwave.internal` on Windows[^gateway]). `render_compose()` injects `WORKER_OS_URL=http://<gateway>:<port>` into the `mcp-hub` container so the hub can forward to it; Claude never talks to `mcp-os` directly — everything goes through the hub. `host-exec` is the same shape with a different payload.

## Decision

Add **`host-exec`**: a host-side MCP worker, behind the MCP hub, that runs **only the commands a user has explicitly added to a whitelist in the Desktop UI → Integrations**, in the project directory, with no shell, with per-recipe confirmation, and returns the command's result (exit code + capped stdout/stderr + status) to Claude through the hub.

It is built on the existing `mcp-os` infrastructure — same process-manager pattern in Tauri, same `127.0.0.1`-only bind, same gateway routing, same `WORKER_<NAME>_URL`-into-hub wiring, same per-app-session bearer token — not a new mechanism. It is **a separate worker**, not an extension of `mcp-os`, for the reasons below.

### Why a separate worker, not part of `mcp-os`

1. **Different responsibility (SRP).** `mcp-os` integrates with host *system APIs* — Calendar/Mail/Reminders/Notes via AppleScript/EventKit (macOS), D-Bus/EDS (Linux), WinRT/MAPI (Windows)[^mcpos-apis] — with a fixed, baked-in tool set and zero per-project configuration. `host-exec` runs a user-defined whitelist of arbitrary developer commands in a project directory. Two different domains; merging them mixes concerns.
2. **Privilege escalation.** The `mcp-os` process on macOS is code-signed with entitlements (`apple-events.plist`, `calendars.plist`) and has been granted TCC consent for Calendar/Mail/Reminders.[^mcpos-tcc][^adr049] A command executor must **not** inherit those — `./gradlew test` runs `build.gradle`, i.e. arbitrary code; that code must not run with access to the user's mailbox and calendar. `host-exec` ships with **no** PIM entitlements.
3. **Per-worker blast radius.** A compromise of `host-exec` must expose only what `host-exec` can do (the whitelist) — not the Calendar/Mail data reachable from `mcp-os`. Keeping them as separate processes keeps the blast radii separate, which is the v1 invariant: a compromised worker exposes only its own service.[^security]
4. **Lifecycle.** `mcp-os` lives per app session, always on. `host-exec` is per-project, toggled on/off via `integrations.hostExec.enabled` in the project config — a different lifecycle, a different enable surface.

### What `host-exec` is *not*

- It is **not** a Docker bridge. `docker compose up` is just one whitelist recipe; the worker does `spawn("docker", ["compose","up","-d"], {cwd: projectDir})` and the host's `docker` CLI talks to the host's Docker daemon exactly as if the user typed it in a terminal. **No Speedwave container ever gets `docker.sock` or `DOCKER_HOST`** — that would be de-facto root on the host and would violate ADR-008/ADR-009/ADR-013.[^docker-sock]
- It is **not** a generic shell. There is no `exec: "bash"` recipe, no `shell: true`, no "pass through extra arguments". See §Hard ban on interpreters.
- It does **not** install anything. The host toolchain is whatever the user already has; Speedwave's container images are unchanged.

## Architecture

```
┌─ container "claude" ─────────────────┐
│  Claude Code ──MCP/stdio──► (nothing) │
└──────────────┬───────────────────────┘
               │ HTTP, hub only
               ▼
┌─ container "mcp-hub" :4000 (zero tokens) ─┐
│  aggregates tools from workers             │
└──┬────────┬────────┬────────┬─────────────┘
   ▼        ▼        ▼        ▼ HTTP + Bearer (gateway routing, ADR-010)
 slack   gitlab  sharepoint  ┌─ HOST (Tauri / Desktop app) ───┐
(containers)                  │  mcp-os    :PORT_A (existing)   │
                              │  host-exec :PORT_B (new)        │
                              │    └ whitelist from project cfg │
                              │       spawn(shell:false, cwd)   │
                              │          ▼                      │
                              │   gradlew / npm / docker / …     │
                              │          ▼                      │
                              │   host Docker daemon             │
                              └─────────────────────────────────┘
```

Reuse of `mcp-os` mechanics, verbatim:

- **Process manager in Tauri** (`desktop/src-tauri/src/host_exec_process.rs`) spawns `node mcp-servers/host-exec/dist/index.js` with `PORT=0` (OS picks a free port), reads `{"port":<N>}` from the child's first stdout line, writes `<data_dir>/host-exec-port`, `<data_dir>/host-exec-pid`, `<data_dir>/host-exec-auth-token`, kills any stale process from a previous session via the PID file. This mirrors `McpOsProcess` field-for-field.
- **Bind:** `127.0.0.1:<dynamic>` on the host. Never `0.0.0.0`. Containers reach it via the platform gateway DNS name (`host.lima.internal` / `host.docker.internal` / `host.speedwave.internal`) — `mcp_os_gateway_url()` in `compose.rs` already encodes this; `host-exec` gets the analogous `host_exec_gateway_url()`.
- **Hub wiring:** `compose.rs` injects `WORKER_HOST_EXEC_URL=http://<gateway>:<port>` into the `mcp-hub` container (the analogue of `WORKER_OS_URL`), and `host-exec` is added to `ENABLED_SERVICES` only when the project has `integrations.hostExec.enabled = true`. The hub fetches the worker's tool list over HTTP+Bearer during discovery and forwards calls; it relays the worker's full result (including `exitCode` and `stderr`) back to Claude. `host-exec` declares its hub policy via the `_meta` field on each tool (ADR-036) — `timeoutClass: 'long'` for build/test recipes, a custom `timeoutMs` that bounds the call slightly above the worker's own per-command timeout.
- **`host-exec` is NOT a compose service.** Like `mcp-os`, it is a host process, not a container. It appears in compose only as the `WORKER_HOST_EXEC_URL` env var on the hub. It has **no `/tokens` mount** — its only "credential" is the whitelist in the project config, which it reads directly from the host filesystem (it runs on the host).
- **Auth:** UUIDv4 bearer token generated per app session (same as `mcp-os`); every hub→worker request must carry `Authorization: Bearer <token>`.

## Configuration — Desktop UI → Integrations

**The user configures it. Speedwave puts nothing there for them** — zero defaults, zero stack auto-detection. The whitelist starts **empty**; `host-exec` with no recipes means Claude can run nothing.

- **Lives user-local** (`~/.speedwave/config.json` / `<data_dir>/config.json`), **not in the repo's `.speedwave.json`.** The repo is untrusted input — per `.claude/rules/security.md`, repo config must never override security-class fields, and the SSRF/provider rules in CLAUDE.md establish the precedent that `provider`/`base_url`-class fields are never repo-overridable. An executable command whitelist is squarely in that category. Adding a command is an explicit user action in the UI — the same "explicit user action" the security rules require for URLs and other sensitive inputs. The repo may at most carry an *example* in its README; the executable whitelist never arrives from the repo.
- **UI:** a new tile in the existing Integrations module (per-project, like Slack/SharePoint/plugins). Toggle on/off; when on, a list of recipes with an "Add command" button. Backed by the same pattern as plugin settings (`*_save_settings` / `*_load_settings` Tauri commands, `plugin_cmd.rs` as the model).
- **The UI must warn plainly** on enable: *"Claude will be able to run these commands on your computer. These commands can execute arbitrary code from this repository."* Not hidden behind a pretty tile.

Sketch:

```
Integrations › Host Exec                                    [ ● enabled ]

 Commands Claude may run on your machine, in this project's folder.
 ⚠ These commands can execute arbitrary code from this repository.

 ┌──────────────────────────────────────────────────────────────┐
 │ test          ./gradlew test                      ask  ✏️ 🗑️ │
 │ build         ./gradlew build -x test           session ✏️ 🗑️ │
 │ fe-build      npm run build  (cwd: frontend)     always ✏️ 🗑️ │
 │ compose-up    docker compose up -d                 ask  ✏️ 🗑️ │
 │ psql          docker compose exec -T db psql -c {sql}  ask ✏️🗑️│
 │   └ sql: must match  ^SELECT .{0,500}$                        │
 └──────────────────────────────────────────────────────────────┘
                                                  [ + Add command ]
```

### Config schema

Added under `integrations` in `crates/speedwave-runtime/src/config.rs` (SSOT). Shape (subject to detail during implementation):

```jsonc
"integrations": {
  "hostExec": {
    "enabled": true,
    "commands": {
      "test":       { "exec": "./gradlew", "args": ["test"], "confirm": "ask" },
      "build":      { "exec": "./gradlew", "args": ["build", "-x", "test"], "confirm": "session" },
      "fe-build":   { "exec": "npm", "cwdSub": "frontend", "args": ["run", "build"], "confirm": "always" },
      "compose-up": { "exec": "docker", "args": ["compose", "up", "-d"], "confirm": "ask" },
      "psql":       { "exec": "docker", "args": ["compose", "exec", "-T", "db", "psql", "-c", "{sql}"],
                      "params": { "sql": { "pattern": "^SELECT .{0,500}$" } }, "confirm": "ask" }
    }
  }
}
```

Rules enforced by config validation:

- **Claude sees recipe names only** (`host-exec__test`, `host-exec__build`, …). It never composes a command string and never names the binary to run; it supplies only named parameters. The hub policy (`_meta`) and the worker's tool schema expose only the declared `params`.
- **`args` is an array of literals plus named parameters substituted into fixed positions.** No "pass the rest through", no splatting. Anything not in the recipe never reaches the process. A parameter token (`{sql}`) may appear inside an arg element (`psql -c {sql}` → argv element `["…","psql","-c","<value>"]`), and the substitution is a single argv element, never re-split.
- **`exec`** is a relative path (`./gradlew`, `npm`, `docker`) — resolved against the project directory or `PATH`, never an absolute path supplied by Claude; the worker does not let Claude choose what to execute.
- **`cwdSub`** (optional) is a subdirectory **inside** the project directory (monorepo support). Path-traversal guard: no `..`, no absolute paths, must resolve (after canonicalisation) to a path under the project root. Same logic as the bind-mount path checks.
- **`params.<name>.pattern`** is a regex that must compile; the value Claude supplies must fully match it (anchored, `^…$`), and there is a length cap on the value. A recipe with `{name}` in `args` but no matching `params` entry is rejected. Recipe names must be unique and slug-shaped.
- **`confirm`**: `ask` (default — prompt the user every time) | `session` (prompt once per recipe, then silent for the rest of the app session) | `always` (never prompt — the user has deliberately trusted this recipe in this project). The default for a freshly added recipe, and for any recipe the UI classifies as state-changing (`migrate`, `psql`, `compose-*`), is `ask`. Whether `always` ships in v1 at all, or only `ask`/`session`, is an open question below — leaning toward shipping `always` but defaulting conservatively.

### Hard ban on interpreters / meta-tools

Config validation **rejects** any recipe whose `exec` is an interpreter or meta-tool that can execute an arbitrary string: `bash`, `sh`, `zsh`, `dash`, `ksh`, `fish`, `eval`, `env`, `xargs`, `find`, `python`, `python3`, `perl`, `ruby`, `node`, `deno`, `awk`, `ssh`, `sshpass`, `make` (and a parameterised `make {target}` — `make test` as a literal is fine, `make {x}` is not). This list lives in `crates/speedwave-runtime/src/consts.rs` as the SSOT (the same pattern as `RESERVED_ENV_KEYS` and `BUILT_IN_SERVICE_IDS`), consumed by config validation and documented in `docs/architecture/security.md`. `shell: false` always; there is no option to enable a shell.

Rationale: the entire construction rests on the user *knowing in advance* what will run, because they declared it. `bash -c {cmd}` destroys that — it is literally a raw host shell with the added lie that it "passed validation". You cannot write a regex that distinguishes "safe" bash from malicious bash (`$IFS`, `${x:0:1}`, base64 + `eval`, glob expansion, command substitution — the defender always loses). A user who needs a one-liner splits it into named recipes, or wraps it in their own script *in the repo* with a fixed, parameter-free interface (`./scripts/ci.sh build`) and adds `{"exec":"./scripts/ci.sh","args":["build"]}` — which is again "a concrete command the user understands", not a shell through the back door. (`./gradlew`, `npm run X`, `docker compose …` also ultimately execute repo-controlled code — that is the residual risk below — but they are *purpose-specific* tools, not "run whatever Claude types"; the line is drawn there.)

### What belongs on a whitelist, and what does not by default

- **Yes:** operations on an *already-prepared* environment — `test`, `build`, `lint`, `format`; migrations against the local database; read-only queries against the local database (with a regex); controlling the project's services (`docker compose up/down/logs/ps`); code generation from local sources.
- **Not by default** (a user may add it, deliberately, at their own risk): anything that *fetches and executes code from the network* — `npm install` / `npm ci`, `gradle --refresh-dependencies`, `mvn dependency:resolve`, `go mod download`. The environment is the user's / CI's job, not the agent's; a `postinstall` script in `node_modules` is code execution on the host. The UI's "Add command" dialog and `docs/guides/integrations.md` state this; we do not pre-populate or auto-suggest these.

## Reading a command's result

Every `host-exec__<recipe>` call returns a structured result to Claude as a ToolResult through the hub. **Mode: "fire and wait for exit"** — the worker runs the command, waits for it to finish, returns the whole thing as one result. No streaming in v1 (see open questions). The worker enforces a per-command **timeout** with `SIGKILL` on expiry, and recipes are expected to be non-interactive (`--watchAll=false`, `-d`, `-T` for `compose exec`); processes get **no stdin**.

Result contract (shape, not final field names):

```jsonc
{
  "status": "exited" | "killed_timeout" | "spawn_error",
  "exitCode": 1,            // null when status != "exited"
  "signal": null,           // e.g. "SIGKILL" when killed by the timeout
  "stdout": "...",          // may be truncated — see "truncated"
  "stderr": "...",          // separate from stdout; Claude must know which stream is the error
  "truncated": false,       // true if output exceeded the cap and a tail was kept
  "durationMs": 4231,
  "command": "test",        // recipe name (NOT raw argv — full argv goes to the host log)
  "cwd": "frontend"         // subdirectory if cwdSub was set, otherwise "."
}
```

Rules:

- **`exitCode != 0` is NOT an MCP tool error.** "I ran `gradlew test`; the result is: tests failed, exit 1, here is stderr" is a correct, *successful* tool response. An MCP tool *error* is returned only for: unknown recipe; a parameter that fails its regex; the user declined the confirmation prompt; the confirmation prompt could not be shown (UI unreachable); `spawn_error` (binary not found / not executable / `exec` on the ban list — though that should fail earlier at config validation). This distinction must be explicit in the worker **and tested** — otherwise Claude gets "error" where it should get "tests failed, here's why" and behaves badly.
- **Output size cap.** `gradlew build` on failure can emit tens of thousands of lines; dumping that whole into Claude's context burns the context window and costs money for no benefit. The worker caps each stream at a sensible default (last ~N KB / last ~M lines — the **tail**, because for compile errors the end is what matters) and sets `truncated: true`. The cap is a worker constant, not per-recipe in v1 (YAGNI). stdout and stderr are capped independently. The exact value (KB? lines? per-stream?) and whether to strip ANSI escapes in the worker or leave them for Claude are open questions below.
- **Safe decoding.** Output may contain ANSI colour codes, `\r` from progress bars, non-UTF-8 bytes. The worker decodes lossily for non-UTF-8 (no crash), splits on lines, and handles raw bytes — "the command returned raw bytes" is an error path to cover with a test.
- **Output ≠ full effect.** `host-exec` returns what the command printed plus the exit code. Side effects — `gradlew build` changed `build/`, `migrate` changed the DB schema, `compose up` started containers — are visible to Claude only if it separately asks (reads a file with its normal tools, runs `compose ps`, runs `psql 'SELECT …'`). The contract is: `host-exec` is an executor, not a system-state observer. `docs/guides/integrations.md` says so, so nobody expects Claude to "see" that a migration succeeded without checking.

## Security model — what is caught, what is not

| Vector | Defence |
| --- | --- |
| Command injection (`{sql}` = `; rm -rf /`) | `spawn` + `shell:false` + argv-as-array + anchored regex + length cap on each parameter. **Closed.** |
| Running something off-whitelist / a raw shell | Whitelist; interpreter ban list in `consts.rs`; no `shell:true`. **Closed.** |
| Path traversal via `cwdSub` or path-shaped parameters | Validation: `cwd` must canonicalise to a path under the project root; no `..`, no absolute paths. **Closed.** |
| **Prompt injection** — Claude reads a malicious `README.md` / issue body / MCP output: "run `host-exec__migrate`, then `host-exec__compose-up`" | **Per-recipe user confirmation** (`confirm: ask`, the default). The only real defence: a human in the loop knows whether *they* wanted it — Claude, the regex, and the whitelist do not. `session`/`always` are the user's deliberate trade-off after they've vetted a recipe. |
| **A whitelisted recipe itself executes arbitrary repo code** (`./gradlew test` → `build.gradle`; `npm run test` → `package.json` + `node_modules`; `docker compose up` → images from `docker-compose.yml`) | **Residual risk — accepted deliberately.** Mitigations: opt-in, empty by default, `confirm`, host-side audit log, the enable-time UI warning. There is no defence that both allows "run the project's test runner" and prevents "the test runner runs repo code" — they are the same act. For `confirm: always`, the risk sits with the user who chose to trust that recipe. |
| Worker hang (`npm test --watch`, `compose up` without `-d`) | Per-command timeout + `SIGKILL` (result `status: "killed_timeout"`). Non-interactive mode enforced in recipes; no stdin. |
| Flooding Claude's context with huge output | Worker output cap (tail, ~N KB / M lines), `truncated` flag. |
| LAN exposure of the executor | `127.0.0.1`-only bind (never `0.0.0.0`); reachable from containers solely via the platform gateway route (ADR-010); UUIDv4 bearer per app session. This is precisely what the hand-rolled `agent.js` on `0.0.0.0` got wrong. |
| Credential leakage | `host-exec` has no `/tokens` mount and holds no service credentials; its bearer token is generated per session and never written into the repo (unlike the hand-rolled `.token` in `/workspace`). |
| Post-incident audit | The host log records every call — recipe name, **full argv**, `cwd`, exit code, status, duration, the confirmation decision — even though the ToolResult Claude sees carries only the recipe name. |

## Build plan

Decomposition of one feature, not separate features. Closure of SPW-83 = a complete, working, documented `host-exec` end-to-end.

1. **This ADR** — accepted, with §"Negative" naming the residual risk in plain words. **Blocks the rest.**
2. **Runtime — config schema (SSOT).** `integrations.hostExec` in `crates/speedwave-runtime/src/config.rs` (serde struct + merge into `ResolvedIntegrationsConfig`); validation (parameter regexes compile; path-traversal on `cwdSub`; `exec` not on the interpreter ban list; recipe names unique and slug-shaped; every `{name}` in `args` has a `params` entry). Interpreter ban list → `crates/speedwave-runtime/src/consts.rs`. Tests: happy / unknown field / `exec` on ban list / regex doesn't compile / `cwdSub` with `..` / `cwdSub` absolute / empty whitelist / duplicate name / `{name}` in `args` without `params` / repo `.speedwave.json` attempting to set `hostExec` is ignored.
3. **Worker `host-exec`.** `mcp-servers/host-exec/src/index.ts` on `@speedwave/mcp-shared` (`createMCPServer`). Reads the whitelist; exposes each recipe as an MCP tool with `_meta` (`timeoutClass`/`timeoutMs`); validates parameters; `spawn(exec, argv, {cwd, shell:false, stdio:["ignore","pipe","pipe"]})`; collects stdout/stderr separately with the cap + `truncated`; per-command timeout + `SIGKILL`; returns the result contract from §"Reading a command's result"; distinguishes `exitCode != 0` (successful ToolResult) from an MCP tool error; logs the full argv to the host log. `Dockerfile`/build wiring for the host process (the worker runs on the host via the bundled Node, like `mcp-os` — no container image, but it still ships in `mcp-servers/` and is built/typechecked/tested with the rest; if a `Dockerfile` is added later it installs `tzdata` per the SSOT-alignment rule in CLAUDE.md). Tests: happy (exit 0) / exit ≠ 0 (= successful ToolResult, not error) / unknown recipe / parameter fails regex / timeout (→ `killed_timeout`) / spawn failure (→ `spawn_error`) / output > cap (→ `truncated`, tail preserved) / non-UTF-8 in output / `..` in a path-shaped parameter rejected / stdout vs stderr kept separate / no stdin reaches the child.
4. **Process manager (Tauri).** `desktop/src-tauri/src/host_exec_process.rs` — spawn/stop/health-check the Node process, port/PID/token files under `<data_dir>/`, stale-process cleanup; pattern copied from `mcp_os_process.rs`. Constants (`HOST_EXEC_AUTH_TOKEN_FILE`, `HOST_EXEC_PORT_FILE`, `HOST_EXEC_PID_FILE`, `HOST_EXEC_LOG_FILE`) in `consts.rs`. Tests mirror the `McpOsProcess` tests.
5. **Hub wiring + compose.** `compose.rs`: `apply_host_exec_config()` (the analogue of `apply_mcp_os_config()`) — read `<data_dir>/host-exec-port` and `-auth-token`, inject `WORKER_HOST_EXEC_URL=http://<gateway>:<port>` into `mcp-hub`, add `host-exec` to `ENABLED_SERVICES` iff `integrations.hostExec.enabled`; `host_exec_gateway_url()` (analogue of `mcp_os_gateway_url()`). `host-exec` is not a compose service. Hub fetches the worker's tools and relays results (including `exitCode`/`stderr`) to Claude; the existing `_meta`-based discovery (ADR-036) covers `host-exec` with no hub-side special-casing. Tests: env injected when enabled + token present; not injected when disabled or token absent; `ENABLED_SERVICES` membership.
6. **Tauri commands.** `host_exec_save_settings` / `host_exec_load_settings` in `desktop/src-tauri/src/` (pattern: `plugin_cmd.rs`), registered in the command list. Save validates the whitelist (the same rules as step 2, surfaced as a readable error, not a 500). Tests: happy + error path.
7. **Frontend (Desktop UI).** `HostExecCommand` model in `desktop/src/src/app/models/`; a service; a screen in the Integrations module (tile + toggle + recipe list + "Add command" dialog with fields: name / exec / args / optional parameters with regex / `cwdSub` / `confirm`); client-side validation matching the backend (readable error, not a stack trace); the enable-time warning. Tests.
8. **Per-call confirmation UI.** A toast/dialog: "Claude wants to run `<name>` (`<argv>`) in `<cwd>` — Allow / Allow for session / Deny". Default `ask`. Honours `confirm` from the config (`session` → prompt once per recipe per session; `always` → no prompt). Deny → MCP tool error "denied by user". The worker must block on the host's decision (the worker calls back to the Tauri side, or the Tauri side gates the hub→worker call — design detail to settle in implementation). Tests: each of the three modes + Deny + the `session` memory across subsequent calls.
9. **Docs.** `docs/guides/integrations.md` (host-exec section — how to configure, recipe-selection rules, the warnings, how Claude reads the result / `exitCode != 0` is not an error / output may be truncated / output ≠ full state, and an explicit anti-pattern note: do not hand-roll an agent on `0.0.0.0` with a token in the repo — here's why, and here's the safe path); `docs/architecture/security.md` (host-exec as a deliberate weakening of the model + the mitigations + the residual risk + the interpreter ban list); `docs/getting-started/configuration.md` (`integrations.hostExec`). Link this ADR from `docs/adr/README.md` and the new sections from `docs/README.md`.
10. **E2E.** `make test-e2e`: "config with `test` (`confirm: session`) → Claude calls `host-exec__test` → it runs in the project dir → `exitCode` + output come back"; "a command not on the whitelist is refused"; "`confirm: ask` → without confirmation the command does not start"; "a command exiting 1 → Claude gets a successful ToolResult with stderr, not an error".

## Definition of Done

Closure of SPW-83 = a complete, working `host-exec` end-to-end:

- [ ] This ADR accepted (§"Negative" names, in plain words, that a whitelist containing build/test means code from the repo runs on the host).
- [ ] `integrations.hostExec` in the SSOT (`config.rs`); interpreter ban list in `consts.rs`; validation + tests (happy / edge / error / state).
- [ ] Worker `host-exec` (`mcp-servers/host-exec/`) — `shell:false`, parameter regexes, path-traversal guard, timeout + `SIGKILL`, output cap + `truncated`, result contract (`status`/`exitCode`/`stdout`/`stderr`/…), `exitCode != 0` as a successful ToolResult, full-argv host logging, `_meta` policy; tests.
- [ ] Process manager in Tauri (`host_exec_process.rs`) + tests.
- [ ] `WORKER_HOST_EXEC_URL` injected into the hub via `compose.rs`; `host-exec` in `ENABLED_SERVICES` only when enabled; hub fetches tools and relays results (with `exitCode`/`stderr`) to Claude; `host-exec` is not a compose service; tests.
- [ ] Tauri commands `host_exec_save/load_settings` + tests (happy + error).
- [ ] Desktop UI: Integrations tile, "Add command" dialog with validation, enable-time warning, model + service + tests.
- [ ] Per-call confirmation UI (`ask`/`session`/`always`), default `ask`, Deny → tool error; tests.
- [ ] Docs updated: `integrations.md` (incl. result reading + the `0.0.0.0`-agent anti-pattern), `security.md`, `configuration.md`; ADR linked from `docs/adr/README.md`; new doc sections linked from `docs/README.md`.
- [ ] E2E: happy path + off-whitelist refused + `confirm:ask` blocks without confirmation + exit ≠ 0 returned as a successful ToolResult.
- [ ] `make check-all` green; if any shared path in `compose.rs` (the plugin-contract surface in CLAUDE.md) is touched, verify compatibility with the `speedwave-plugins` sibling repo.

## Consequences

### Positive

- The single biggest capability gap closes: Claude can build, test, lint, run migrations, and drive the project's docker-compose stack — using the user's real toolchain, with nothing installed in the container.
- It replaces an unsafe hand-rolled pattern (already observed in the wild: an LLM-generated agent on `0.0.0.0` with a token committable to the repo and no confirmation) with an opt-in, loopback-only, confirmed, audited, reviewed component.
- Architecturally it is "another host-side worker like `mcp-os`" — same process-manager pattern, same routing, same hub wiring, same auth — so it adds little new surface area and reuses tested mechanics.
- The whitelist is user-local and per-project: the user controls exactly what is permitted, the repo cannot inject it, and a different project gets a different (or empty) whitelist.

### Negative

- **This is a deliberate weakening of Speedwave's isolation model.** Up to now, a compromise of Claude (e.g. via prompt injection from a malicious `README.md`, issue body, or MCP response) could at worst manipulate the data reachable by whatever worker Claude tricked — never execute code on the host. With `host-exec` enabled and a whitelist containing build/test recipes, that ceiling is raised: a successful prompt injection (or a malicious repo, since `./gradlew test` runs `build.gradle`, `npm run test` runs `node_modules`, `docker compose up` runs `docker-compose.yml`-defined images) leads to **code execution on the user's machine**, in the project directory, with the user's privileges and no sandbox. `cwdSub` confinement is cosmetic against this — the spawned process can read `~/.ssh`, `~/.aws`, make outbound network calls, etc.
- The per-recipe confirmation (`confirm: ask`) is the primary mitigation for prompt injection — but it depends on a human reading the prompt and on the user not setting `confirm: always` for a recipe whose repo they don't fully trust. The gap between "what the user thinks they added" (`test`) and "what they actually added" (arbitrary repo code) is closed by the confirmation + the enable-time warning, not by any regex.
- `confirm: always` is a real foot-gun and is offered only because per-call prompting for `gradlew test` on every iteration is unworkable in practice; the default is conservative (`ask`), and state-changing recipes default to `ask` regardless.
- On macOS/Windows the `host-exec` process must be code-signed and (if it ever needs a restricted platform API, which it should not) entitled — but explicitly **without** the PIM entitlements that `mcp-os` carries; getting that wrong would let `./gradlew` reach the user's Calendar/Mail.
- DNS-rebinding against the loopback-bound worker is an accepted residual risk for the same reason it is for the host-side HTTP surface in ADR-041 — bounded by the bearer token and by the worker doing nothing dangerous on a bare GET; the dangerous surface (running a recipe) requires the bearer token *and* a recipe that exists in the user's whitelist *and* (unless `always`) a confirmation. Do not introduce a codepath that lets an attacker add to the whitelist without explicit user action — that would invalidate this.

### Neutral / deferred

- No streaming of partial output in v1 (fire-and-wait-for-exit). Watch mode is forced off in recipes anyway, so commands finish; streaming can be added later if there is real demand (Rule of Three).
- The exact output cap value (KB vs lines, per-stream) and whether to strip ANSI in the worker are settled during implementation.
- Whether to allow an `env` map per recipe (per-command environment variables) is deferred; if added, the same caution as `RESERVED_ENV_KEYS` applies (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PATH`, `HOME`, `IFS`, `BASH_ENV`, …).
- On Linux, exactly how to point at the user's "real" Docker (Docker Desktop / OrbStack / Colima / a rootful daemon) alongside Speedwave's own rootless nerdctl — a config field? socket auto-detection? — is deferred. On macOS/Windows there is no collision (Speedwave = Lima/WSL2; "the host's Docker" = a separate install with a separate socket).
- Whether `confirm: always` ships in v1 at all, or only `ask`/`session` (less to test, strictly safer), is an open question — leaning toward shipping it, defaulting conservatively.

## Open questions (to resolve before / during implementation)

- Streaming vs fire-and-wait — recommendation: fire-and-wait for v1.
- Output cap: KB or line count? per-stream? strip ANSI in the worker?
- `env` per recipe — allow it? If so, with the `RESERVED_ENV_KEYS` caution.
- Linux: how to target the user's Docker alongside Speedwave's rootless nerdctl.
- Ship `confirm: always` in v1, or start with `ask`/`session` only?
- Confirmation plumbing: does the worker call back to Tauri for the decision, or does the Tauri side gate the hub→worker call? (Affects where the "block until user decides" lives.)

## Related

- ADR-008 (no background daemon) — `host-exec` runs only while the Desktop app runs, as a child of it; no separate daemon.
- ADR-009 (per-project isolation preserved) — `host-exec` has no `/tokens` mount; its config is per-project; it does not relax any container constraint.
- ADR-010, ADR-013 (`mcp-os` as host process — per-platform, implementation) — the template for `host-exec`'s process manager, bind policy, and gateway routing.
- ADR-036 (self-declaring worker policy via `_meta`) — `host-exec` declares its hub policy this way; no hub-side special-casing.
- ADR-037 (code signing and bundled-binary signing) — `host-exec`, if it ships any Mach-O of its own, is signed; without PIM entitlements.
- ADR-038 (single internal worker port) — `host-exec` is a host process, so the in-container worker-port convention does not apply to it; it gets a dynamic loopback port and a `WORKER_HOST_EXEC_URL` on the hub, exactly like `mcp-os`.
- ADR-041 (local LLM model discovery) — precedent for host-side HTTP hardening and for "DNS rebinding against user-originated targets is accepted, do not let attackers inject the target without user action".
- ADR-049 (TCC sub-identifiers and Apple Events gate) — why `mcp-os` carries PIM entitlements and why `host-exec` must not.
- ADR-001 (eliminate Docker Desktop) — Speedwave does not use Docker Desktop as its runtime; "the host's Docker" is a separate, user-installed thing.
- `.claude/rules/security.md`, CLAUDE.md (SSRF/provider rules, `RESERVED_ENV_KEYS`, plugin contract) — the existing precedents this ADR follows: untrusted repo config never overrides security-class fields; SSOT lists in `consts.rs`; plugin-contract compatibility when `compose.rs` changes.

---

[^security]: Speedwave security model and v1 invariants — `docs/architecture/security.md` and `.claude/rules/security.md` in this repository.
[^mcpos-bind]: "mcp-os ... binds to `127.0.0.1:4007` on the host. It never binds to `0.0.0.0` because it runs outside the container network and must not be exposed to the LAN." — `docs/adr/ADR-010-mcp-os-as-host-process-per-platform.md` §Network Model, this repository.
[^gateway]: Per-platform container→host gateway DNS names (`host.lima.internal` / `host.docker.internal` / `host.speedwave.internal`) — `docs/adr/ADR-010-mcp-os-as-host-process-per-platform.md` §Network Model; `crates/speedwave-runtime/src/consts.rs` (`LIMA_HOST`, `NERDCTL_LINUX_HOST`, `WSL_HOST`), this repository. Lima registers `host.lima.internal` via its hostagent / gvisor-tap-vsock: https://lima-vm.io/docs/config/network/ . nerdctl/containerd adds `host.docker.internal`: https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md .
[^mcpos-apis]: `mcp-os` integrates Calendar/Mail/Reminders/Notes via AppleScript/EventKit (macOS), CalDAV + zbus/EDS (Linux), WinRT + mapi-rs (Windows) — `docs/adr/ADR-010-mcp-os-as-host-process-per-platform.md` and `docs/adr/ADR-013-mcp-os-as-host-process-implementation.md`, this repository. macOS TCC gating of these APIs: https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsusagedescription .
[^mcpos-tcc]: `mcp-os` runs on the host because AppleScript/EventKit (macOS), D-Bus/EDS (Linux), and WinRT/MAPI (Windows) are host-only APIs gated by per-process user consent (TCC on macOS) and inaccessible from inside a container — `docs/adr/ADR-013-mcp-os-as-host-process-implementation.md` §Rationale, this repository. macOS TCC: https://developer.apple.com/documentation/security/app-sandbox / https://support.apple.com/guide/security/controlling-app-access-to-files-secddd1d86a6/web .
[^adr049]: TCC sub-identifiers and the Apple Events gate for bundled helpers — `docs/adr/ADR-049-tcc-sub-identifiers-and-applevents-gate.md`, this repository.
[^docker-sock]: Mounting the Docker daemon socket into a container grants effective root on the host (the Docker daemon runs as root and can mount the host filesystem into a new container) — Docker documentation, "Docker daemon attack surface": https://docs.docker.com/engine/security/#docker-daemon-attack-surface . Speedwave's prohibition on mounting host sockets into containers — `docs/adr/ADR-009-per-project-isolation-preserved.md`, `docs/adr/ADR-013-mcp-os-as-host-process-implementation.md`, this repository.
[^adr036]: Self-declaring worker policy via the MCP `_meta` field; `BUILT_IN_SERVICES` removed, workers discovered uniformly — `docs/adr/ADR-036-self-declaring-worker-policy.md`, this repository. MCP `_meta` field in the specification: https://modelcontextprotocol.io/specification .
[^adr041]: Host-side HTTP hardening (`redirect::Policy::none()`, bounded timeout, capped body, `Content-Type` allow-list) and the accepted residual risk of DNS rebinding against user-originated URLs — `docs/adr/ADR-041-local-llm-model-discovery.md`, this repository.

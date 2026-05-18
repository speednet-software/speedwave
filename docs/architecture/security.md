# Security Model

Security is a core obsession in Speedwave. Every architectural decision preserves or improves the security model.

## Principles

The following security principles are inherited from Speedwave v1 and are **non-negotiable**:

- **Claude container isolation** — no tokens, no container socket, container user UID 1000:1000 (containerd runs inside a VM on both macOS and Windows, so no user-namespace remapping is needed; see [ADR-059](../adr/ADR-059-drop-linux-support.md))
- **OWASP container hardening** — `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, `tmpfs: /tmp:noexec,nosuid`
- **Token isolation** — each MCP worker mounts **only its own** service credentials at `/tokens` read-only. A compromised worker exposes only that service. The `sharepoint` and `office` workers additionally mount the project directory at `/workspace:rw` because their tools read/write project files; other workers (slack, gitlab, github, redmine, atlassian, playwright) have no `/workspace` access.
- **Hub has zero tokens** — compromise of the hub exposes nothing
- **Kernel-level isolation** — Lima VM (macOS) / WSL2 (Windows) provides an additional isolation layer on top of container isolation
- **Resource limits** — CPU + memory caps per container
- **Verified downloads** — pinned version with SHA256-verified binary downloads (verified by official installer via GCS manifest)
- **Minimal health endpoints** — return only `{ "status": "ok" }`, no service metadata leaked

## Container Hardening

All containers follow OWASP container hardening guidelines:

- `cap_drop: ALL` — drop all Linux capabilities
- `no-new-privileges: true` — prevent privilege escalation
- `read_only: true` — read-only root filesystem
- `tmpfs: /tmp:noexec,nosuid` — temporary filesystem with restricted execution
- Resource limits: CPU and memory caps defined per container in `compose.template.yml`

**The `claude` container's `$HOME` is writable by design.** `${CLAUDE_HOME}` is bind-mounted at `/home/speedwave` as `:rw` because Claude Code self-installs there (`entrypoint.sh` writes `~/.local/bin`, `~/.bashrc`, `~/.claude/*`, `~/.claude.json` — Anthropic All-Rights-Reserved, can't be bundled — see [ADR-052](../adr/ADR-052-anthropic-oauth-login-flow.md)), and `${PROJECT_DIR}` is mounted at `/workspace:rw` because Claude edits code. Consequences:

- A toolchain Claude installs into `$HOME` (e.g. a JDK tarball — `apt`/`sudo` fail in the hardened container, but `curl … | tar -x` into `$HOME` works) **persists per-project** (it's in `claude-home/<project>/`), is **uncontrolled** (whatever a `curl | bash` pulls), but is **confined to the container** plus the Lima / WSL2 / rootless layer — it does not reach the host. It is also re-installed on a fresh project / data-dir reset, and it grows `claude-home/<project>/` unboundedly. It is **not** a substitute for **Host Exec** (no Docker; pollutes `claude-home`; ephemeral).
- Because `/workspace` is `:rw`, a prompt-injected Claude doesn't need a malicious repo from outside — it can write a malicious `build.gradle` / `package.json` script _itself_ and then (if Host Exec is enabled and a whitelisted recipe runs that toolchain) have it executed on the host. `cwdSub` confinement is cosmetic against this; the real mitigation is the trust decision to enable Host Exec at all and the whitelist the user chose at enable time — there is no per-call confirmation (see [Host Exec → deliberate, scoped weakening](#host-exec--deliberate-scoped-weakening) below).

Neither the IDE Bridge lock dir (`${IDE_LOCK_DIR}` → `~/.claude/ide/`, mounted `:ro`) nor the clipboard bridge gives the container any further writable host path or a way to make the host execute something.

## Token Isolation

Each MCP worker container mounts **only its own** service credentials:

```
~/.speedwave/tokens/<project>/<service>/  → /tokens (read-only mount)
```

- Slack worker sees only Slack tokens
- GitLab worker sees only GitLab tokens
- Hub has **zero** token mounts — it routes requests to workers via HTTP

**`/tokens` is `:ro` for all workers.** OAuth refresh moved to the host-side `oauth` worker which writes the refreshed `access_token` to the same per-project tokens directory — the worker only ever reads it (see [ADR-060](../adr/ADR-060-host-side-oauth-refresh-worker.md)).

Anthropic OAuth credentials are managed entirely by Claude Code inside the `CLAUDE_HOME` bind-mount (`~/.speedwave/claude-home/<project>/.claude/.credentials.json`); Speedwave does not touch them. See [ADR-052](../adr/ADR-052-anthropic-oauth-login-flow.md) for the login-flow rationale.

### Clipboard wrappers (OSC 52)

The `claude` image bakes `/usr/local/bin/{pbcopy,xclip,xsel,wl-copy,clip.exe}` as five symlinks to one shell script (`osc52-copy.sh`) that base64-encodes stdin and writes an [OSC 52](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Operating-System-Commands) sequence to `/dev/tty`. Compatible host terminals interpret it as a clipboard write request — incompatible terminals ignore it.

The wrapper is **write-only by design**: it never reads the host clipboard (OSC 52 query/paste would require a terminal-side response handshake and would leak host clipboard contents into the container). It touches only its own stdin and `/dev/tty`, runs as the unprivileged container user, and adds no new mounts. See [ADR-052](../adr/ADR-052-anthropic-oauth-login-flow.md).

## Threat Model

When implementing any feature, ask these questions:

1. **Does this require relaxing any of the above principles?** If yes — find a different approach.
2. **Does this add a new attack surface?** Document it and mitigate it.
3. **Does this require mounting host filesystem into a container?** Minimize scope, use `:ro` wherever possible.

### Local attacker with home-directory write access

Speedwave's threat model includes a non-privileged process running as the same user — a malicious npm `postinstall` script, a browser exploit, or any locally-executed code that can write under `~/`. The container hardening above stops a _compromised container_ from escaping; it does not stop a _host_ process from rewriting the files Speedwave reads.

`~/.speedwave/plugins/<slug>/` is writable by the user, so any path that reads from it is in this attacker's reach. Plugin Ed25519 signatures are therefore enforced as a **runtime invariant**, not just an install gate (see [ADR-051](../adr/ADR-051-plugin-signature-runtime-verification.md)):

- Every read of a plugin tree (compose render, image build, claude-resources mount, UI listing) goes through `signing::verify_plugin_signature_cached` — the cache is keyed by canonical path AND content digest, so any byte change to any file forces a fresh Ed25519 check.
- Mutable per-plugin state lives at `~/.speedwave/plugin-state/<slug>/`, not under `plugins/<slug>/`, so writing the `image_pending` marker does not invalidate the digest.
- `plugin::compute_plugin_digest` rejects symlinks. Without this, an attacker dropping `claude-resources/skills/foo.md → /etc/passwd` could fold arbitrary host content into the digest of an otherwise-innocent tree.
- Install is atomic: lock + staging dir on the same filesystem + `rename` swap + cleanup, so a concurrent install or a crash mid-replace cannot leave a half-A/half-B Frankenstein.
- Startup runs `plugin::audit_all` — the Desktop blocks with a recovery dialog (Tauri 2 `tauri-plugin-dialog`) on any failure; the CLI exits 2. Recovery commands (`plugin remove`, `plugin install`, `plugin list`, `init`) skip the audit so users can always reach the recovery path.

`~/.speedwave/tokens/<project>/<service_id>/<key>` is mode 0600 by `set_owner_only` and lives outside the plugin tree, so token files are not part of the plugin signature surface — but they are also write-protected against unprivileged tampering by filesystem ACLs.

### Host Exec — deliberate, scoped weakening

**Host Exec** (`host_exec`, [ADR-054](../adr/ADR-054-host-exec-worker.md)) is the one place Speedwave deliberately and explicitly relaxes the container-isolation model: it runs a user-defined whitelist of project-toolchain commands (`./gradlew test`, `npm run build`, `docker compose up`, …) **on the host machine, with the user's privileges, in the project folder**, behind the per-project MCP hub. It exists because Claude — running in the hardened, token-free `claude` container — otherwise cannot build/test/lint the project or drive the host's Docker; users were already filling that gap insecurely by hand (an LLM-generated agent on `0.0.0.0` with a token committed to the repo). Host Exec is the safe-as-possible version of that capability, not a removal of the boundary.

**Mitigations (what keeps it as narrow as it can be):**

- **Off by default; the whitelist is empty.** A project with `host_exec` disabled — or enabled with no recipes — lets Claude run nothing. Enabling it requires confirming a **blocking danger modal** in the Desktop UI that spells out the consequences — **and that click is the consent**: there is no per-call confirmation; once enabled, Claude runs any whitelisted recipe (with any param values matching the recipe's regexes) without further prompting, and the audit log is the after-the-fact record (see [ADR-054 §"No per-call confirmation"](../adr/ADR-054-host-exec-worker.md)). Claude Code in the container runs `--dangerously-skip-permissions`, so a per-call prompt would have to be a parallel mechanism (and wouldn't cover the `speedwave` CLI either); the honest model is "deliberate enable + whitelist + per-recipe regex params + the ban lists + the audit log", not per-call human-in-the-loop. If you want a recipe to require your attention each time, don't whitelist it.
- **User-local config only.** The whitelist lives in `~/.speedwave/config.json` (`integrations.hostExec`). The repo `.speedwave.json` layer **ignores `host_exec` entirely** — an executable command whitelist is a security-class field, like the LLM `provider`/`base_url` (`config::apply_integrations_layer`'s `from_repo` gate). A hostile repo cannot grant itself execution.
- **Fixed command names + regex-constrained params; an amber warning for the dangerous ones.** Claude calls a recipe by name and supplies only the declared parameters; it never composes a command string. The Desktop add/edit dialog shows an amber inline warning when a recipe matches `host_exec::is_container_lifecycle_recipe` (`exec` basename ∈ {`docker`,`docker-compose`,`podman`} with `up`/`down`/`exec`/`rm`/`prune` in `args` — effectively `docker run` with whatever mounts/privileges a Claude-editable compose file declares, ≈ host root) or the broader state-changing heuristic (DB clients, migrations) — but neither is blocking; enabling `host_exec` is the per-project consent.
- **Fixed commands, not free-form strings.** `exec` + a fixed `args` list; `{name}` parameter tokens substitute into fixed positions and each substitution is **one** argv element, never re-split. Validation (`host_exec::validate_host_exec_config`) rejects an `exec` whose basename is a **shell/eval launcher** (`bash sh zsh … busybox toybox` — `consts::HOST_EXEC_SHELL_LAUNCHERS`), and rejects a **bare `{param}`** as the whole element after a meta-tool (`node python make npm … awk` — `consts::HOST_EXEC_META_TOOLS`); a literal sub-command (`npm run build`, `make test`) is fine. `shell: false`, always; no `-c`/eval option. **Both lists are by basename and not exhaustive** — a renamed interpreter or another interpreter taking a Claude-controlled program string as a non-bare-param arg (`sed -e '{prog}'`, `git -c core.pager={x}`) is not caught; documented residual.
- **`127.0.0.1`-only worker; per-(project, app-session) bearer.** Each project gets its own worker process on a dynamic loopback port; the hub→worker auth token (`~/.speedwave/host-exec/<project>/auth-token`, mode 0600, bind-mounted into the hub as `/secrets/host_exec-auth-token:ro`) is a fresh UUIDv4 minted per app session and never appears in the repo. Two projects' workers share nothing.
- **Recipe child env is a strict allowlist.** Spawned recipes get only `PATH` (the recovered login-shell PATH, not Finder's stub), `HOME`/`USERPROFILE`, `TMPDIR`/`TMP`/`TEMP`, `LANG`/`LC_*`, `JAVA_HOME`, `DOCKER_HOST`, the platform minimum, **plus the recipe's own literal `env` map** — never `HOST_EXEC_AUTH_TOKEN`/`HOST_EXEC_CONFIG_PATH`/`PORT`. Recipe `env` keys that are reserved (`RESERVED_ENV_KEYS`) are rejected.
- **Config file 0600; host log 0600; log redacts `env` values.** The per-project worker snapshot (`~/.speedwave/host-exec/<project>/config.json`) and the audit log (`~/.speedwave/host-exec/<project>/log`) are both `0600` (the spawner pre-creates the log before launching the worker, and the worker's `appendFile` also asserts `0600`). The snapshot may hold a recipe's `env` literals (possibly secrets — the UI warns against that). The log records the full argv, cwd, exit code, status, duration — **it is the only after-the-fact record (there is no per-call confirmation)**; it **redacts recipe `env` values** (keys only) but logs the **argv verbatim** — so a recipe whose `args` substitute a `{param}` logs whatever value Claude supplied, which may be sensitive (e.g. a credential in a `psql -c '{sql}'` query).
- **Bounded execution; process-tree kill.** A per-command timeout (≈7 min) kills the **whole process group** (`kill(-pid, SIGKILL)` on Unix / `taskkill /T /F /PID` on Windows) so a runaway Gradle daemon / `docker compose` child can't outlive the call. Per-stream output caps (tail kept, ANSI stripped) bound what comes back.
- **Fail-closed on whitelist change.** The worker re-reads its config snapshot per tool call, so a removed/disabled recipe stops working immediately regardless of hub-cache state; a whitelist edit also respawns the worker and recreates the project's hub container so the tool set re-discovers.

**Residual risk (documented and accepted — see [ADR-054 §Negative](../adr/ADR-054-host-exec-worker.md)):**

- **A whitelist with build/test means repo code runs on the host.** `npm run`, `make`, `gradle`, `docker compose` all execute repo-controlled code — often via `/bin/sh` themselves. The `shell:false` + launcher/meta-tool bans are **defense-in-depth, not a guarantee**: they close `{"exec":"bash","args":["-c","{cmd}"]}` and "run whatever Claude types through `npm`", not "no repo code ever runs". The ban lists are by **basename** and not exhaustive, so `./node_modules/.bin/node …`, a renamed interpreter, `sed -e '{prog}'`, `git -c core.pager={x}` etc. are not caught.
- **A `docker compose up` recipe is host root.** It runs `docker-compose.yml`, which Claude can rewrite (`/workspace:rw`) to add `privileged: true` + `volumes: ["/:/host:rw"]` — full host takeover from a "build" recipe. Strictly worse than a `gradlew test` recipe (which runs as the user, no privilege escalation). The UI warns when you add such a recipe; beyond that there is no per-call gate (it's all gated behind the enable consent) — a user who whitelists it has accepted that a recipe can host-root them.
- **Claude can write the repo then run it.** `/workspace` is `:rw` (Claude edits code), so a prompt-injected Claude can author a malicious `build.gradle`/`package.json`/`docker-compose.yml` and then run a whitelisted recipe over it. `cwdSub` confinement doesn't help. The mitigation is the trust decision to enable Host Exec at all and the whitelist the user chose — **prompt injection is mitigated, not eliminated.**
- **A recipe child has no cgroup / ulimit.** Unlike the `claude` container's CPU/mem caps, a recipe child is a plain host process; for the up-to-7-min window before the timeout it can consume all CPU/RAM/PIDs (same as the user running the command in a terminal). Accepted residual.
- **An absolute-path `exec` is a user-chosen footgun.** The editor flags an absolute `exec` ("make sure it's the one you mean"), but a user can choose it.
- **No per-call confirmation, by design.** This is an accepted property, not a residual to fix — enabling Host Exec is the consent for the whole project's whitelist; if you want a recipe gated each time, don't whitelist it (run it yourself), or split it so the dangerous part isn't a recipe.

In short: treat any enabled Host Exec recipe as "this repository's code, on my machine, with my privileges, runnable by Claude without a prompt" — because that is exactly what it is. Enable it only for repositories you trust, and only whitelist commands you're OK with Claude running unattended.

### Security Boundaries

- **Host ↔ VM**: Lima/WSL2 kernel isolation
- **VM ↔ Container**: nerdctl/containerd container isolation with OWASP hardening
- **Container ↔ Container**: per-project network isolation (`speedwave_<project>_network`)
- **Worker ↔ Worker**: token isolation — each worker has access only to its own service credentials

All MCP workers listen on the same internal port (`PORT_WORKER`, see [ADR-038](../adr/ADR-038-single-internal-worker-port.md)) inside their own container namespaces; the hub disambiguates workers by DNS service name. Port numbers carry no security weight — the three pillars above (token, network, hardening) do not depend on per-worker port uniqueness.

## Executor Sandbox (MCP Hub)

The MCP Hub executes model-generated JavaScript in a restricted `AsyncFunction` sandbox. Security is provided by multiple layers:

- **Forbidden pattern denylist** — regex-based validation blocks dangerous APIs (`eval`, `require`, `process`, `globalThis`, etc.) and prototype chain traversal vectors (`.constructor`, `.__proto__`, `getPrototypeOf`, `Reflect`, `Proxy`, bracket-notation equivalents) before code execution
- **Restricted context** — only whitelisted globals (service bridges, `JSON`, `Date`, `Math`, `Array`, `Object`, etc.) are injected into the sandbox scope
- **Execution timeout** — prevents denial-of-service via infinite loops
- **PII tokenization** — sensitive data is replaced with tokens before reaching the model

This is **defense-in-depth**: even if the sandbox is bypassed, the attacker lands in a container with zero tokens, `cap_drop: ALL`, `no-new-privileges`, and a read-only filesystem. See [ADR-029](../adr/ADR-029-sandbox-prototype-chain-hardening.md) for the prototype chain hardening decision.

## SSRF Protection (SEC-015)

The MCP Hub HTTP bridge validates all outbound worker URLs at the single resolution
point (`getWorkerUrl()`) before any `fetch()` call:

- **Canonical URL allowlist**: Only Docker internal service names (`mcp-*`) and
  platform host gateways (`host.{lima,docker,containers,speedwave}.internal`) are accepted
- **Port enforcement**: Port must be present and in range 1-65535
- **Protocol enforcement**: Only `http:` (internal Docker network, no TLS needed)
- **No pathname/query**: Worker URLs must be bare endpoints
- **Redirect blocking**: All `fetch()` calls use `redirect: 'error'`

Invalid URLs are treated as unconfigured services (fail-closed).

## SecurityCheck — Compose and Host Validation

`SecurityCheck::run()` validates the generated compose YAML and host filesystem state before any `compose_up`. If any rule is violated, containers are blocked from starting (fail-closed). Both CLI (`speedwave check`, `speedwave`) and Desktop (blocking overlay) enforce this gate.

Every rule below corresponds to a variant in the `SecurityRule` enum. Compose YAML checks use `serde_yaml_ng` for structured parsing — never string matching on raw YAML. Host filesystem checks use `symlink_metadata()` to avoid following symlinks.

### YAML Validation

| Rule               | Scope        | What it checks                                |
| ------------------ | ------------ | --------------------------------------------- |
| `YAML_PARSE_ERROR` | Compose file | Compose YAML can be parsed by `serde_yaml_ng` |

### Container Hardening Rules

| Rule           | Scope           | What it checks                                      |
| -------------- | --------------- | --------------------------------------------------- |
| `CAP_DROP_ALL` | All containers  | `cap_drop: [ALL]` is present                        |
| `NO_NEW_PRIVS` | All containers  | `security_opt: [no-new-privileges:true]` is present |
| `READ_ONLY_FS` | claude, mcp-hub | `read_only: true` is set                            |
| `TMPFS_NOEXEC` | claude, mcp-hub | `/tmp` is mounted as `tmpfs` with `noexec,nosuid`   |

### Token / Secret Isolation Rules

| Rule               | Scope   | What it checks                                                                                     |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------- |
| `NO_TOKENS_CLAUDE` | claude  | No `TOKEN`, `KEY`, or `SECRET` env vars (allowlist: `CLAUDE_*`, `ANTHROPIC_*`, `IS_SANDBOX`, etc.) |
| `NO_TOKENS_HUB`    | mcp-hub | No env vars except `WORKER_*_URL`, `PORT`, and `ENABLED_SERVICES`                                  |

### Network Security Rules

| Rule                          | Scope                     | What it checks                                                                                   |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `PORTS_LOCALHOST`             | All containers with ports | All exposed ports bind to `127.0.0.1`, not `0.0.0.0`                                             |
| `NO_SOCKET_CLAUDE`            | claude                    | No `docker.sock` or `nerdctl.sock` volume mounts                                                 |
| `NO_EXTERNAL_LLM_KEYS_CLAUDE` | claude                    | No `OPENAI_*`, `GEMINI_*`, `DEEPSEEK_*`, `OPENROUTER_*` env vars (these belong in the LLM proxy) |
| `NO_PORTS_WORKERS`            | Built-in MCP workers      | Built-in services must not expose ports at all — inter-container communication uses Docker DNS   |

### Container User Rule

| Rule             | Scope          | What it checks                                                                     |
| ---------------- | -------------- | ---------------------------------------------------------------------------------- |
| `CONTAINER_USER` | All containers | `user:` field matches `container_user()` (UID 1000:1000 on both macOS and Windows) |

### Plugin Security Rules

| Rule                             | Scope           | What it checks                                                                  |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------- |
| `PLUGIN_NO_PRIVILEGED`           | Plugin services | `privileged: true` is not set                                                   |
| `PLUGIN_NO_HOST_NETWORK`         | Plugin services | `network_mode: host` is not set                                                 |
| `PLUGIN_MANIFEST_MISSING`        | Plugin services | Signed manifest exists for the plugin                                           |
| `PLUGIN_VOLUME_LONG_FORM`        | Plugin services | Volumes use short-form strings only (no YAML mappings)                          |
| `PLUGIN_TOKEN_PATH_MISMATCH`     | Plugin services | `/tokens` mount host path matches `~/.speedwave/tokens/<project>/<service_id>/` |
| `PLUGIN_TOKEN_MOUNT_MODE`        | Plugin services | `/tokens` mount mode matches the signed manifest (`:ro` or `:rw`)               |
| `PLUGIN_WORKSPACE_PATH_MISMATCH` | Plugin services | `/workspace` mount host path matches `{project_dir}`                            |
| `PLUGIN_WORKSPACE_MOUNT_MODE`    | Plugin services | `/workspace` mount mode is `:rw`                                                |
| `PLUGIN_NO_EXTRA_VOLUMES`        | Plugin services | No volumes beyond `/tokens` and `/workspace`                                    |
| `PLUGIN_MISSING_TOKENS_MOUNT`    | Plugin services | `/tokens` mount is present                                                      |
| `PLUGIN_MISSING_WORKSPACE_MOUNT` | Plugin services | `/workspace` mount is present                                                   |

### Plugin Manifest Validation

`validate_manifest` (`crates/speedwave-runtime/src/plugin.rs`) is run both at install time and at every load-side path (compose render, image build). Beyond the basic slug/version/format checks it enforces:

- **`extra_env` reserved keys** — a plugin must not inject env vars that Speedwave reserves (`PORT`, auto-injected) or that are dynamic-linker / language-runtime / shell-environment hijack vectors (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PATH`, `HOME`, `SHELL`, `IFS`, `BASH_ENV`, `ENV`). The list is `consts::RESERVED_ENV_KEYS` (SSOT — see CLAUDE.md), matched case-insensitively. The same list also rejects a [Host Exec](#host-exec--deliberate-scoped-weakening) recipe's `env` keys; alongside it, `consts::HOST_EXEC_SHELL_LAUNCHERS` (banned `exec` basenames — shell/eval launchers) and `consts::HOST_EXEC_META_TOOLS` (interpreters/package-script runners that may not take a bare-`{param}` argument) are sibling SSOT lists consumed by `host_exec::validate_host_exec_config` — edit `consts.rs`, not the validators.
- **`token_mount: read_write`** — rejected unconditionally for plugins. No built-in service currently uses `:rw` for tokens — [ADR-060](../adr/ADR-060-host-side-oauth-refresh-worker.md) moved SharePoint OAuth refresh to the host-side `oauth` worker. Built-in service slugs are blocked earlier in the function, so any plugin reaching this check is by definition unauthorised.
- **`mem_limit` / `cpu_limit`** — parsed numerically and bounded by `PLUGIN_MEM_LIMIT_MAX_MIB` / `PLUGIN_CPU_LIMIT_MAX`. An explicit `0` (Docker's "no limit") is rejected so a plugin cannot bypass the cap.
- **Slug collision** — a slug whose derived compose name (`mcp-<slug>`) or whose bare form matches a built-in service is rejected, so a plugin cannot shadow `mcp-hub`, `claude`, etc. via a silent YAML-mapping overwrite.
- **`settings_schema`** — must be a JSON object ≤ 64 KiB. Full Draft-7 validation of saved settings happens desktop-side in `plugin_save_settings` (the runtime crate has no JSON-Schema dependency).

See [ADR-051](../adr/ADR-051-plugin-signature-runtime-verification.md) for the full rationale and the runtime-invariant model.

### SharePoint Volume Rules

Same checks as plugin volumes, applied to the built-in SharePoint service. As of [ADR-060](../adr/ADR-060-host-side-oauth-refresh-worker.md) SharePoint mounts `/tokens:ro` like every other worker; OAuth refresh moved to the host-side `oauth` worker. The token-mount-mode check is the generic `PLUGIN_TOKEN_MOUNT_MODE` (re-used for built-in workers) — there is no dedicated SharePoint variant any more.

| Rule                                 | What it checks                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `SHAREPOINT_VOLUME_LONG_FORM`        | Short-form volumes only                                                    |
| `SHAREPOINT_TOKEN_PATH_MISMATCH`     | Token mount path matches expected                                          |
| `SHAREPOINT_WORKSPACE_PATH_MISMATCH` | Workspace mount path matches expected                                      |
| `SHAREPOINT_WORKSPACE_MOUNT_MODE`    | Workspace mount mode is `:rw`                                              |
| `SHAREPOINT_NO_EXTRA_VOLUMES`        | Allowlisted extras only: `/tokens`, `/workspace`, per-service oauth bearer |
| `SHAREPOINT_MISSING_TOKENS_MOUNT`    | Token mount present                                                        |
| `SHAREPOINT_MISSING_WORKSPACE_MOUNT` | Workspace mount present                                                    |

### Host File Security Rules

| Rule                      | Scope                       | What it checks                                                                         |
| ------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `FILE_SECURITY_VIOLATION` | Host filesystem (Unix only) | Sensitive files/directories have correct permissions AND are owned by the current user |

**Permission requirements:**

Sensitive directories must be `0o700` (owner rwx only):

- `~/.speedwave/secrets/<project>/` — worker auth tokens (including the Host Exec hub→worker bearer)
- `~/.speedwave/snapshots/<project>/` — compose rollback snapshots
- `~/.speedwave/ide-bridge/` — IDE bridge lock files
- `~/.speedwave/tokens/<project>/` — token parent directory
- `~/.speedwave/tokens/<project>/<service>/` — per-service token directories
- `~/.speedwave/host-exec/<project>/` — per-project Host Exec worker state (config snapshot, PID, port, log)

Sensitive files must be `0o600` (owner rw only):

- `~/.speedwave/secrets/<project>/*` — service auth tokens. Reads of these files reject symbolic links — `is_symlink()` is checked before `is_file()` to defeat host-write attackers planting a symlink to a substitute UUID.
- `~/.speedwave/tokens/<project>/<service>/*` — plugin credentials
- `~/.speedwave/host-exec/<project>/auth-token` — the Host Exec hub→worker bearer (a fresh UUIDv4 per app session; bind-mounted into the hub container as `/secrets/host_exec-auth-token:ro`)
- `~/.speedwave/host-exec/<project>/config.json` — Host Exec recipe whitelist snapshot the worker reads (may contain a recipe's `env` literals; `host_exec_save_settings` writes it `0o600` via `write_host_exec_config_snapshot`)
- `~/.speedwave/snapshots/<project>/*.json` — compose snapshots
- `~/.speedwave/ide-bridge/*.lock` — IDE bridge auth tokens
- `~/.speedwave/bundle-state.json` — bundle reconciliation state

**Ownership requirement:** All sensitive files and directories must be owned by the current user (UID match). This prevents scenarios where files have correct mode bits but are owned by a different user (e.g. root), making them inaccessible to the container runtime.

**Limitations:** Validates Unix mode bits and UID only — not ACLs, xattrs, or Windows DACLs. On Windows, this check is a no-op. Symlinks within scanned directories are skipped (not followed) to prevent traversal attacks. Missing paths are silently skipped — they may not exist for fresh projects or unused integrations.

**Auto-fix on startup:** Before running SecurityCheck, all container start paths (CLI, Desktop, update, rollback) call `ensure_data_dir_permissions()` which automatically fixes incorrect mode bits on security-sensitive directories (→ `0o700`) and files (→ `0o600`). Errors from `set_permissions` are propagated as startup failures. The `speedwave check` command does NOT auto-fix — it reports violations for diagnostic purposes. Ownership (UID) mismatches are NOT auto-fixed (requires root); SecurityCheck reports them with remediation instructions.

### Workspace Path Protection

Because the full project directory is mounted as `/workspace:rw`, the `path-validator.ts` denylist blocks MCP workers from accessing sensitive paths within the workspace: `.git/`, `.env`, and `.speedwave/`. This provides defense-in-depth — even if an MCP worker is compromised, it cannot exfiltrate repository history, environment secrets, or Speedwave configuration.

### Shared Infrastructure

`SecurityExpectedPaths` is computed once and shared between `render_compose()` and `SecurityCheck::run()` to prevent path drift. On Windows, paths are translated from `C:\Users\...` to `/mnt/c/Users/...` for WSL2 compatibility.

## OS Prerequisite Checks

`os_prereqs::check_os_prereqs()` validates host-level requirements before any container operations:

- **Windows**: Verifies WSL2 is available via `wsl.exe --status` (10s timeout). If missing, reports actionable remediation (DISM commands or Windows Features GUI).
- **macOS**: No OS prerequisites — Lima runtime is bundled by Speedwave.

These checks run at multiple points: setup wizard (before VM init), container start (blocking overlay in Desktop, exit in CLI), and update/rollback. Violations produce `PrereqViolation` structs with remediation text, following the same pattern as `SecurityCheck` violations.

Both OS prereq failures and `SecurityCheck` compose violations block the application — containers never start if either check fails.

**Windows uninstall cleanup (ADR-048):** The NSIS uninstaller offers an opt-in `MessageBox` that, when accepted, performs `wsl --unregister Speedwave` and `RMDir /r $PROFILE\.speedwave` on the host. The default for unattended (`/S`) uninstalls is to preserve data (`/SD IDNO`). If `SPEEDWAVE_DATA_DIR` is set (ADR-031), the data-dir removal is skipped and the user is instructed to remove that path manually; only the WSL distro is unregistered.

Additionally, `check_os_warnings()` provides non-blocking diagnostic warnings (e.g. nested virtualization detected) logged via `log::warn!` during system checks. These warnings do not block container operations but appear in `speedwave check` output and Desktop log files.

## Third-party services

Some MCP workers reach external SaaS endpoints from inside their container. The `claude` container itself never makes outbound HTTP — every third-party hop is mediated by a worker with a narrow scope and an audited data flow.

### Context7 (library documentation)

The `mcp-context7` worker calls `https://context7.com/api/v2/*` (Upstash) to resolve library names to IDs and fetch documentation snippets.

**Data sent to Upstash on every call:**

- Query string (the natural-language question the user typed)
- `libraryName` / `libraryId` (e.g. `"react"` / `/facebook/react`)
- Optional API key (`ctx7sk_…`) when configured — sent in `Authorization: Bearer`
- `User-Agent: Speedwave-Context7/<version>` and standard HTTP headers
- Source IP (the worker's egress IP — Upstash documents that IPs are stored encrypted)

**Per Context7's documented data use, queries may be retained and used for benchmarking and reranking, including by third-party LLMs.** Anything sensitive in the user's question crosses a trust boundary — the same way it would if Claude itself called the API.

**Anonymous mode (no key):** ~200 requests per day per source IP (from the `ratelimit-limit` response header). For a multi-user host on one corporate NAT this is shared across all users; if it runs out, Upstash returns 429 with a `ratelimit-reset` Unix timestamp. There is no SLA and no DPA in anonymous mode — for compliance-sensitive deployments, each developer should generate a free key at [context7.com/dashboard](https://context7.com/dashboard).

**Container constraints (identical to other workers):** `cap_drop: ALL`, `no-new-privileges`, `read_only`, `tmpfs /tmp:noexec,nosuid`, 128 MiB memory cap. The `api_key` file is mounted `:ro`. Redirects from Context7 are explicitly NOT followed (undici v7 default + `mapErrorStatus` rejects 3xx). HTTP body is capped at 5 MiB by `readBodyLimited` in `client.ts` (drains the stream with a byte counter and aborts cleanly before the 128 MiB container cap would OOM-kill the worker). Timeouts cap time independently: 30 s headers + 30 s body via undici options.

## Redmine API Proxy Commands

The Desktop app includes two Tauri commands that make HTTP requests to external Redmine instances during integration configuration: `validate_redmine_credentials` and `fetch_redmine_enumerations`. These run on the Desktop host process, not inside containers, because the MCP Redmine worker doesn't exist during configuration — the user hasn't saved credentials yet.

**SSRF mitigations:**

- Reuses `url_validation::validate_url()` core logic (scheme, host, and IP validation with 50+ tests)
- **Blocked:** loopback IPs (127.0.0.0/8, ::1), link-local/metadata IPs (169.254.0.0/16 including cloud metadata endpoint 169.254.169.254)
- **Allowed with warning:** RFC1918 private IPs (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and IPv6 Unique Local Addresses (fc00::/7, RFC 4193) — self-hosted Redmine on private networks is the primary use case
- Redirects blocked via `reqwest::redirect::Policy::none()`
- Only fixed Redmine API paths requested (not arbitrary URLs)
- Response shape validated via typed deserialization (non-Redmine JSON rejected)
- Custom `User-Agent` header, no cookie jar, no auth headers beyond `X-Redmine-API-Key`
- 5-15s request timeouts

**RFC1918 and IPv6 ULA divergence from MCP Hub:** MCP Hub blocks ALL private IPs because it runs in a container with no legitimate private targets. Desktop Redmine proxy allows RFC1918 and IPv6 ULA (fc00::/7) because: (1) Desktop runs on the host, not in a container; (2) self-hosted Redmine on private networks is the primary use case; (3) loopback, link-local, and metadata IPs remain blocked. IPv6 ULA is the direct analog of RFC1918 for IPv6 networks. This divergence is intentional — the security postures serve different threat models.

**SecurityCheck scope:** These commands run on the Desktop host process, not inside containers — they are outside SecurityCheck's compose validation scope. SSRF protection is implemented directly in the command handlers via `validate_redmine_host_url()`.

**Known limitations (pre-existing, shared with SharePoint OAuth):**

- `rustls-tls` uses bundled CA roots, not the OS certificate store. Corporate users with custom CAs may see TLS errors.
- No automatic system proxy detection (`default-features = false` in reqwest). Corporate users behind HTTP proxies may see connection timeouts.
- HTTP cleartext warning logged when `http://` scheme is used (credentials transmitted without encryption).

## LLM Model Discovery Commands

The Desktop app includes a Tauri command `discover_llm_models` that probes a local LLM server during Settings configuration, and a companion validator `validate_llm_base_url` reused by `update_llm_config` (the save path). Both run on the Desktop host process, not inside containers — see ADR-041 for the full threat model.

**SSRF mitigations:**

- Shared validator `validate_llm_base_url` (`desktop/src-tauri/src/llm_cmd.rs`) is called by BOTH the discovery probe and the save path. One policy, two callsites — a future tightening of URL validation reaches both automatically.
- **Blocked:** link-local / metadata IPs (169.254.0.0/16, fe80::/10, IPv6-mapped variants), RFC 5737 TEST-NET, RFC 2544 benchmarking, RFC 3849 documentation prefix, RFC 6666 discard prefix, multicast, unspecified (0.0.0.0, ::).
- **Allowed with warning:** loopback (127.0.0.0/8, ::1), RFC 1918 private IPv4, IPv6 ULA (fc00::/7), public IPs, public domains — consistent with the user-input threat model applied to Redmine (self-written URLs are user's own decision).
- Redirects blocked via `reqwest::redirect::Policy::none()` — `302 Location: http://169.254.169.254/` cannot bypass the classifier.
- Response body capped at 5 MiB via shared `http_util::read_body_limited` (same helper as Redmine).
- 5-second request timeout; mid-load models fall back to the free-text input.
- Case-insensitive `Content-Type` check rejects `text/html` responses (user pointed at a non-LLM URL).
- Fixed endpoints per provider (`/api/tags` for Ollama, `/v1/models` for OpenAI-compatible servers) — never arbitrary paths.
- Response shape validated via typed deserialization (`OllamaTagsResponse`, `OpenAIModelsResponse`) — non-matching JSON rejected.
- No cookies, no auth headers, custom `User-Agent` header.

**Policy divergence from Redmine:** both commands share 95% of the policy. Redmine blocks loopback (`PrivatePolicy::BlockLoopback`) because a self-hosted Redmine on 127.0.0.1 is unusual and likely a misconfiguration. LLM discovery allows loopback (`PrivatePolicy::AllowLoopback`) because `default_base_url` for every local provider resolves to `host.docker.internal` (rewritten to `127.0.0.1` on the host side — see `rewrite_container_alias_to_loopback`). Both policies share a single implementation (`url_validation::is_private_on_premise` with a `PrivatePolicy` parameter) so future IP-classification tightening reaches both.

**Residual risk, documented and accepted** (see ADR-041):

- DNS rebinding — a user-written hostname whose first DNS lookup returns a public IP but subsequent connects return a metadata IP can bypass the validator. Mitigation: probe output is a typed `Vec<String>` rendered as `<option>` text (no pivot); user-initiated only; 5s timeout bounds the race.
- Save-path public-domain SSRF — analogous to Redmine. User-written URL is user's own threat. If a codepath ever allows URL injection without user consent, this decision must revisit.

**SecurityCheck scope:** Same as Redmine — these commands run on the Desktop host process, outside SecurityCheck's compose validation scope. SSRF protection is implemented directly in the command handlers.

## Host-Side Audio Capture (Meeting Transcription)

Meeting transcription runs **on the Desktop host** — the Claude container has no audio access (a v1 invariant), so this is a separate threat surface, like the LLM-discovery and Redmine commands. The full design and rationale is [ADR-056](adr/ADR-056-host-side-audio-transcription.md); the security-relevant points:

- **Opt-in, off by default, no repo override.** The feature is gated behind a top-level user-config flag (`~/.speedwave/config.json`). Repository `.speedwave.json` **cannot** enable it (privacy invariant — a repo must not be able to turn on the user's microphone). With the flag off, no capture code runs.
- **Capture surface.** When enabled, the app can record the host's system-audio loopback (what the user hears — the other call participants) and the microphone, mixed into one stream (the "Whole meeting" default). Each platform uses its OS primitive: macOS CoreAudio process taps via the bundled `audio-capture-cli` (14.4+), and Windows WASAPI loopback via `cpal`. The bundled macOS CLI is a signed Mach-O (`pl.speedwave.desktop.audio-capture`, embedded `Info.plist`) — see _Binary Authenticity_ below.
- **OS permission prompts.** The microphone prompt fires via the public `AVCaptureDevice.requestAccess` API. The **system-audio** ("System Audio Recording") prompt has _no public trigger_ on macOS, so `audio-capture-cli` requests it via the private `TCCAccessRequest(kTCCServiceAudioCapture)` API (the AudioCap / AudioTee approach; works on a notarized `.dmg`, not an App Store app). This is the one private-platform-API dependency in the codebase; it is `dlopen`/`dlsym`-guarded — if a future macOS removes the symbol the CLI exits "permission unavailable" and the UI deep-links the user to System Settings, rather than crashing — and isolated to one commented function (the precedent for a guarded private call is `desktop/src-tauri/src/fs_perms.rs`). ADR-056 decision 3 records this; the public alternative (ScreenCaptureKit audio) was rejected for needing the heavyweight Screen Recording permission and having macOS 15 audio-only defects.
- **Files on disk.** Recordings and transcripts live under `~/.speedwave/transcripts/<id>/` (`audio.wav` + `transcript.json`, `0600`). Models live under `~/.speedwave/models/{whisper,diarization}/` (`0700` dirs, `0600` files), SHA-256-verified on download. There is no auto-retention in v1 — the user deletes recordings manually (the UI also offers "discard audio, keep transcript").
- **"Local" is true only for inference.** Whisper transcription and sherpa diarization run locally — no audio leaves the machine for inference. **Model downloads use the network** (HTTPS to Hugging Face / GitHub via the model-store's redirect-allowlist + streaming hash — same hardening posture as elsewhere; see ADR-056 decision 9). **"Send to Claude"** uploads the rendered transcript _text_ to the user's configured LLM provider (with a confirm dialog). The UI states both on every relevant surface.

## Authentication Gate

Claude Code must be authenticated (OAuth or API key) before the app allows
chat access. Enforced at two layers:

- **Backend (`start_chat`, `resume_conversation`):** Runs `claude auth status`
  inside the container before spawning an interactive session. Returns a clear
  error if not authenticated, preventing the hang that occurs when Claude
  prompts for interactive login on stdin while the frontend waits for
  stream-json on stdout.

- **Frontend (`ProjectStateService` / `AuthTerminalComponent`):** After
  containers are running, calls `get_auth_status`. If neither OAuth nor API key
  is configured, the auth overlay offers two ways to log in:
  - **Primary — "Open terminal and log in" (`start_oauth_login`).** Spawns the
    host's terminal application (iTerm2 → Apple Terminal on macOS; PowerShell on
    Windows) running `speedwave login`,
    so the user types `/login` at Claude Code's prompt. The command string
    handed to the terminal is built by `build_auth_command_for_platform` (same
    renderer as the copy-paste fallback), and every component that flows into it
    is constrained: the project name passes `validate_project_name` and is
    shell/PowerShell-quoted; the macOS AppleScript path additionally rejects
    control characters and only accepts a `$SHELL` that is a plain absolute path
    (otherwise falls back to `/bin/zsh`). Speedwave never performs OAuth itself
    and never sees the token — Claude Code owns the credential lifecycle.
  - **Fallback — copy-paste command (`get_auth_command`).** The same command
    string, shown as text for the user to run in any terminal of their choice.
    When the Desktop app's data directory differs from the default
    (`~/.speedwave`), the command includes an `export SPEEDWAVE_DATA_DIR=...`
    prefix (PowerShell: `$env:SPEEDWAVE_DATA_DIR = '...'`). The value comes from
    the Desktop app's own data directory, determined at process start and never
    re-read from the terminal session's environment.

  A complementary host-side helper, the **clipboard bridge** (`clipboard_bridge.rs`),
  watches `<data_dir>/claude-home/<project>/.clipboard-bridge` — a file written
  by the in-container `osc52-copy.sh` wrapper — and copies new content to the
  host clipboard (deduplicated, capped at 64 KB, opened with a single
  size-limited read so a container cannot swap in a huge payload between a
  size check and the read). This makes Claude Code's "press `c` to copy the
  auth URL" work even in terminals that ignore OSC 52 (e.g. Apple Terminal).

## Binary Authenticity

Speedwave desktop artifacts are cryptographically signed at two layers that protect different install paths.

### Layer 1 — OS-level code signing (Developer ID + notarization)

Every Mach-O binary shipped inside `Speedwave.app` (bundled Lima, Node.js, Swift helpers, Rust CLI) is signed with the Speednet Developer ID Application certificate, uses Hardened Runtime, and carries an RFC 3161 timestamp from Apple. The full bundle is submitted to Apple Notary Service, and the resulting ticket is stapled so Gatekeeper validates offline.

Hardened Runtime restricts platform APIs by default; specific binaries carry entitlements to opt back in (virtualization for limactl, Apple Events for mail/notes CLIs, calendars/EventKit for calendar/reminders CLIs, JIT for Node.js). See [ADR-037](../adr/ADR-037-code-signing-and-bundled-binary-signing.md#entitlements-inventory) for the full inventory.

This layer gates **first-time installs** (user downloads the DMG) and all launches thereafter. It protects against:

- **Tampering in transit** — a modified binary fails Gatekeeper signature verification on launch
- **Supply-chain impersonation** — only holders of the Speednet private key can produce artifacts that pass Gatekeeper
- **Malware insertion post-download** — Hardened Runtime blocks common injection vectors (DYLD env vars, library validation bypass)

Signing responsibility and implementation details are in [ADR-037](../adr/ADR-037-code-signing-and-bundled-binary-signing.md). Operational setup and certificate rotation are in [Release Signing Guide](../contributing/release-signing.md).

### Layer 2 — Tauri updater Ed25519 signatures

Orthogonal to OS signing, the Tauri auto-updater verifies every downloaded update against an Ed25519 public key embedded in the app binary (`desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey`). The corresponding private key is stored as `TAURI_SIGNING_PRIVATE_KEY` in CI.

This layer gates **auto-updates** for already-installed users. An attacker who compromised the GitHub Releases endpoint but not the CI signing key cannot ship an update — the updater refuses to install unsigned or wrongly-signed artifacts.

### What each layer actually protects

| Install path                                   | Layer 1 (Apple Dev ID)                             | Layer 2 (Tauri Ed25519) |
| ---------------------------------------------- | -------------------------------------------------- | ----------------------- |
| First install — user downloads DMG from GitHub | Required                                           | Not checked             |
| Auto-update on already-installed app           | Required (Gatekeeper still validates the new .app) | Required                |

Compromising the **Apple Developer ID key alone** is sufficient to ship malware to new users via a replaced GitHub Release asset — Layer 2 doesn't run on a fresh install. Compromising the **Tauri Ed25519 key alone** is sufficient to deliver a malicious update that installs but fails Gatekeeper on first launch (users see a runtime crash, not a silent breach). Compromising **both** is sufficient to ship malware to all users silently.

Treat the Apple Developer ID as the primary secret. The Tauri key is a defense-in-depth layer against compromises of the GitHub release infrastructure, not a substitute for Apple Developer ID protection.

## See Also

- [ADR-009: Per-Project Isolation Preserved](../adr/ADR-009-per-project-isolation-preserved.md)
- [ADR-059: Drop Linux Support](../adr/ADR-059-drop-linux-support.md)
- [ADR-037: Code Signing and Bundled Binary Signing](../adr/ADR-037-code-signing-and-bundled-binary-signing.md)
- [ADR-051: Plugin Signature Runtime Verification](../adr/ADR-051-plugin-signature-runtime-verification.md)
- [ADR-054: Host Exec — Host-Side Per-Project Toolchain Worker](../adr/ADR-054-host-exec-worker.md)
- [Release Signing Guide](../contributing/release-signing.md)

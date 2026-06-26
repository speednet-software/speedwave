# Security Model

Security is a core obsession in Speedwave. Every architectural decision preserves or improves the security model.

## Principles

The following security principles are inherited from Speedwave v1 and are **non-negotiable**:

- **Claude container isolation** — no tokens, no container socket, container user UID 1000:1000 (containerd runs inside a VM on both macOS and Windows, so no user-namespace remapping is needed; see [ADR-059](../adr/ADR-059-drop-linux-support.md))
- **OWASP container hardening** — `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, `tmpfs: /tmp:noexec,nosuid`
- **Token isolation** — each MCP worker mounts **only its own** service credentials at `/tokens` read-only. A compromised worker exposes only that service. The `sharepoint`, `office`, and `slack` workers additionally mount the project directory at `/workspace:rw` because their tools read/write project files (slack writes downloaded files there for the office worker and Claude to read — [ADR-071](../adr/ADR-071-slack-oauth-pkce-user-tokens.md)); other workers (gitlab, github, redmine, atlassian, playwright, context7) have no `/workspace` access.
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

- A toolchain Claude installs into `$HOME` (e.g. a JDK tarball — `apt`/`sudo` fail in the hardened container, but `curl … | tar -x` into `$HOME` works) **persists per-project** (it's in `claude-home/<project>/`), is **uncontrolled** (whatever a `curl | bash` pulls), but is **confined to the container** plus the Lima / WSL2 layer — it does not reach the host. It is also re-installed on a fresh project / data-dir reset, and it grows `claude-home/<project>/` unboundedly.
- Because `/workspace` is `:rw`, a prompt-injected Claude can write a malicious `build.gradle` / `package.json` script into the repo — but it has **no channel to execute that script on the host**. Code in `/workspace` only runs inside the container (or the Lima / WSL2 layer); there is no host-side command-execution path reachable from the container.

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

Anthropic OAuth credentials are managed entirely by Claude Code inside the `CLAUDE_HOME` bind-mount (`~/.speedwave/claude-home/<project>/.claude/.credentials.json`); Speedwave does not touch them. See [ADR-052](../adr/ADR-052-anthropic-oauth-login-flow.md) for the login-flow rationale. With the proxy forwarder in the inference path ([ADR-073](../adr/ADR-073-embedded-per-project-litellm-proxy.md)) the OAuth `Authorization` header transits the passthrough leg verbatim — the forwarder holds no Anthropic credential of its own, which is exactly what keeps the forwarding transparent.

**LLM provider keys (ADR-073)** follow the worker token regime, not the claude-env regime: values live in `~/.speedwave/tokens/<project>/llm/<provider_id>_api_key` (0600) and mount `:ro` into the `proxy` container only, where compose injects them as `SPW_KEY_<PROVIDER_ID>` env names the forwarder resolves from `/tokens`. They never enter the `claude` container and never appear in the rendered `proxy.json` (which carries `SPW_KEY_<ID>` env-name references only). The one deliberate exception is the Anthropic API key, which stays on the `claude` container env as before (ADR-040 residual risk) because the passthrough forwards `x-api-key` and that preserves `/model` alias semantics. The `SpeedwaveProxyVolumes` SecurityCheck rule pins the forwarder's mount profile (config `:ro`, llm-tokens `:ro`, usage as the only `:rw`, no host network).

### Clipboard wrappers (OSC 52)

The `claude` image bakes `/usr/local/bin/{pbcopy,xclip,xsel,wl-copy,clip.exe,powershell.exe}` as six symlinks to one shell script (`osc52-copy.sh`) that base64-encodes stdin and writes an [OSC 52](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Operating-System-Commands) sequence to `/dev/tty`. Compatible host terminals interpret it as a clipboard write request — incompatible terminals ignore it. The `powershell.exe` name exists because on Windows hosts Claude Code self-detects platform `wsl` and copies via `Set-Clipboard`; the wrapper routes that to the same write path and fails read-style PowerShell commands (`Get-Clipboard`, `ContainsImage`) with exit 1. A dummy `WAYLAND_DISPLAY` env (injected by `defaults.rs::base_env()`) satisfies Claude Code's clipboard-tool probe — no Wayland/X11 socket is mounted and the wrapper never talks to a display server.

The wrapper **never issues an OSC 52 query/paste**: an OSC 52 read would require a terminal-side response handshake and would leak host clipboard contents into the container, so that path is deliberately absent. It does serve one host-originated value: when invoked with `-o`/`--out`/`--paste` (e.g. `xclip -t image/png -o`), it reads the image the user pasted in the Desktop UI from `/workspace/.speedwave/pastes/clip.png` (`SPEEDWAVE_CLIP_FILE`) — that file is written by `desktop/src-tauri/src/paste_cmd.rs::save_pasted_image` from the user's clipboard (see [ADR-065](../adr/ADR-065-image-attachments-structured-input.md)). The write path base64-encodes stdin to `/dev/tty`; the read path reads only that one workspace-mounted file. It runs as the unprivileged container user and adds no new mounts. See [ADR-052](../adr/ADR-052-anthropic-oauth-login-flow.md).

## Log Sanitization

SSOT: `crates/speedwave-runtime/src/log_sanitizer.rs` (Rust) mirrored by `mcp-servers/shared/src/sanitizer.ts` (TypeScript). Every log line written by Desktop, CLI, the worker drain, and host-side MCP services passes through `sanitize()` before reaching disk or stdout. Redacted patterns:

- **Credentials**: Bearer / Authorization / X-Redmine-API-Key headers, JWTs (`eyJ…`), generic `password=` / `secret=` / `api_key=` assignments, URL userinfo (`://user:pass@`), URL query secrets (`?token=…`).
- **Provider tokens**: Slack (`xox[bpars]-…`), GitHub (`ghp_`, `ghs_`, `gho_`, `ghu_`, `github_pat_`), GitLab (`glpat-…`), Atlassian (`ATATT…`), Anthropic (`sk-ant-…`), generic OpenAI-style (`sk-…`).
- **HTTP cookies**: both `Cookie:` and `Set-Cookie:` header values.
- **PEM private keys**: full BEGIN/END blocks.
- **Host paths / PII**: `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` — the username segment is replaced with `<user>` while the path tail is preserved.

Rust and TS rule counts are pinned by `EXPECTED_RULE_COUNT` / `RULE_COUNT` constants; both test suites fail if the lists drift.

## Threat Model

When implementing any feature, ask these questions:

1. **Does this require relaxing any of the above principles?** If yes — find a different approach.
2. **Does this add a new attack surface?** Document it and mitigate it.
3. **Does this require mounting host filesystem into a container?** Minimize scope, use `:ro` wherever possible.

### Local attacker with home-directory write access

Speedwave's threat model includes a non-privileged process running as the same user — a malicious npm `postinstall` script, a browser exploit, or any locally-executed code that can write under `~/`. The container hardening above stops a _compromised container_ from escaping; it does not stop a _host_ process from rewriting the files Speedwave reads.

`~/.speedwave/plugins/<slug>/` is writable by the user, so any path that reads from it is in this attacker's reach. Plugin Ed25519 signatures are therefore enforced as a **runtime invariant**, not just an install gate (see [ADR-051](../adr/ADR-051-plugin-signature-runtime-verification.md)):

- Every read of a plugin tree (compose render, image build, claude-resources mount, UI listing) goes through `signing::verify_plugin_signature_cached` — the cache is keyed by canonical path AND content digest, so any byte change to any file forces a fresh Ed25519 check.
- Mutable per-plugin state lives at `~/.speedwave/plugin-state/<slug>/`, not under `plugins/<slug>/`, so writing the `image_pending` marker or the `bridge-token` does not invalidate the digest.
- `signing::compute_plugin_digest` rejects symlinks. Without this, an attacker dropping `claude-resources/skills/foo.md → /etc/passwd` could fold arbitrary host content into the digest of an otherwise-innocent tree.
- Install is atomic: lock + staging dir on the same filesystem + `rename` swap + cleanup, so a concurrent install or a crash mid-replace cannot leave a half-A/half-B Frankenstein.
- Startup runs `plugin::audit_all` — the Desktop blocks with a recovery dialog (Tauri 2 `tauri-plugin-dialog`) on any failure; the CLI exits 2. Recovery commands (`plugin remove`, `plugin install`, `plugin list`, `init`) skip the audit so users can always reach the recovery path.

`~/.speedwave/tokens/<project>/<service_id>/<key>` is mode 0600 by `set_owner_only` and lives outside the plugin tree, so token files are not part of the plugin signature surface — but they are also write-protected against unprivileged tampering by filesystem ACLs.

### Security Boundaries

- **Host ↔ VM**: Lima/WSL2 kernel isolation
- **VM ↔ Container**: nerdctl/containerd container isolation with OWASP hardening
- **Container ↔ Container**: per-project network isolation (`speedwave_<project>_network`)
- **Worker ↔ Worker**: token isolation — each worker has access only to its own service credentials

All MCP workers listen on the same internal port (`PORT_WORKER`, see [ADR-038](../adr/ADR-038-single-internal-worker-port.md)) inside their own container namespaces; the hub disambiguates workers by DNS service name. Port numbers carry no security weight — the three pillars above (token, network, hardening) do not depend on per-worker port uniqueness.

## Host Bridges

Speedwave Desktop runs the IDE Bridge on the generic host-bridge
skeleton (`desktop/src-tauri/src/bridges/host_bridge.rs`, see
[ADR-063](../adr/ADR-063-host-bridge-generic.md)). It pairs Claude Code
(in the container) with a local IDE on the host (Endpoint mode). Lock
file: `~/.speedwave/ide-bridge/<port>.lock`. Mounted into the container
as `/home/speedwave/.claude/ide/` (`:ro`).

Security invariants:

- **Bind only to `127.0.0.1`** (kernel-assigned port). Not reachable from
  LAN.
- **UUID v4 auth token per session** (regenerated on every Desktop
  start; never persisted across restarts).
- **Constant-time token comparison** prevents timing side channels.
- **Origin header policy** rejects browser CSRF (`RejectIfPresent`).
- **Lock file `0o600` in `0o700` parent dir** — token unreadable by other
  users on the host. Atomic write via `tempfile::NamedTempFile::persist`
  closes the partial-write window.
- **Token never logged.** `HostBridge::Debug` redacts the token; the
  Desktop event channel emits role + state only.

Residual risk: a user-mode process running as the same UID as the
Desktop can read the lock file. This matches the platform assumption
that same-uid processes are inside the trust boundary.

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
  the canonical host gateway alias `host.docker.internal` are accepted
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

| Rule               | Scope   | What it checks                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_TOKENS_CLAUDE` | claude  | Flags any env var whose name contains `TOKEN`, `KEY`, or `SECRET` (case-insensitive substring) unless it exactly equals one of four allowlisted names: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DISABLE_AUTOUPDATER`. Not prefix matching — `IS_SANDBOX` is not allowlisted (it contains none of the patterns) |
| `NO_TOKENS_HUB`    | mcp-hub | Flags any env var whose name contains `TOKEN`, `KEY`, or `SECRET` unless its name starts with `WORKER_` or `PORT`. Non-matching names (`ENABLED_SERVICES`, `TZ`, …) carry no secret pattern and pass — tokens reach the hub only as `/secrets/*` file mounts, never env vars                                                                   |

### Network Security Rules

| Rule                          | Scope                     | What it checks                                                                                                                                                                   |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORTS_LOCALHOST`             | All containers with ports | All exposed ports bind to `127.0.0.1`, not `0.0.0.0`                                                                                                                             |
| `NO_SOCKET_CLAUDE`            | claude                    | No `docker.sock` or `nerdctl.sock` volume mounts                                                                                                                                 |
| `NO_EXTERNAL_LLM_KEYS_CLAUDE` | claude                    | No external-LLM-provider env vars — blocks 9 prefixes: `OPENAI_`, `AZURE_OPENAI_`, `GEMINI_`, `DEEPSEEK_`, `OPENROUTER_`, `COHERE_`, `MISTRAL_`, `TOGETHER_`, `GROQ_`            |
| `NO_PORTS_WORKERS`            | Built-in MCP workers      | Built-in services must not expose ports at all — inter-container communication uses Docker DNS                                                                                   |
| `SpeedwaveProxyVolumes`       | proxy                     | Mount profile is exactly `/config:ro` + `tokens/<project>/llm:/tokens:ro` + `/usage:rw`, and no `network_mode` ([ADR-073](../adr/ADR-073-embedded-per-project-litellm-proxy.md)) |

**Host-gateway alias distribution.** `host.docker.internal` is statically present in `extra_hosts` for `claude` and `mcp-playwright` (see [ADR-062](../adr/ADR-062-playwright-host-gateway-access.md)), and dynamically injected for `mcp-hub` and OAuth-consumer services (sharepoint, slack — ADR-071) by `ensure_host_gateway_extra_host()`. Other built-in workers (github, gitlab, atlassian, redmine, context7, office) have no host-side dependency and therefore no `extra_hosts` entry. The underlying IP routing to the VM gateway exists for every container regardless — the alias only adds DNS convenience.

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

- **`extra_env` reserved keys** — a plugin must not inject env vars that Speedwave reserves (`PORT`, auto-injected) or that are dynamic-linker / language-runtime / shell-environment hijack vectors (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PATH`, `HOME`, `SHELL`, `IFS`, `BASH_ENV`, `ENV`). The full list (18 entries) is `consts::RESERVED_ENV_KEYS` (SSOT — see CLAUDE.md), matched case-insensitively.
- **`token_mount: read_write`** — rejected unconditionally for plugins. No built-in service currently uses `:rw` for tokens — [ADR-060](../adr/ADR-060-host-side-oauth-refresh-worker.md) moved SharePoint OAuth refresh to the host-side `oauth` worker. Built-in service slugs are blocked earlier in the function, so any plugin reaching this check is by definition unauthorised.
- **`mem_limit` / `cpu_limit`** — parsed numerically and bounded by `PLUGIN_MEM_LIMIT_MAX_MIB` / `PLUGIN_CPU_LIMIT_MAX`. An explicit `0` (Docker's "no limit") is rejected so a plugin cannot bypass the cap.
- **Slug collision** — a slug whose derived compose name (`mcp-<slug>`) or whose bare form matches a built-in service is rejected, so a plugin cannot shadow `mcp-hub`, `claude`, etc. via a silent YAML-mapping overwrite.
- **`settings_schema`** — must be a JSON object ≤ 64 KiB. Full Draft-7 validation of saved settings happens desktop-side in `plugin_save_settings` (the runtime crate has no JSON-Schema dependency).
- **`oauth` endpoints** — when a plugin declares an `oauth` block, its `token_url` / `authorize_url` / `device_authorization_url` are dialed **by the host** during the Authorize flow and on every worker refresh. Each is therefore run through the shared SSRF validator (`url_validation::validate_url`, https-only, no localhost / private / loopback target) at install and again at use. A signed plugin is **not** exempt — the Ed25519 signature proves the manifest's integrity, not that its declared targets are safe. The grant type is gated against a supported-grants allow-list so a plugin cannot declare a flow the host will not perform. OAuth client secrets and refresh tokens are written **off-mount** to `~/.speedwave/oauth/<project>/<slug>.json` (never `/tokens`), so the `:ro`-everywhere mount invariant is preserved — see [ADR-069](../adr/ADR-069-generic-plugin-oauth2.md).

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

### Slack Volume Rules

Identical profile to SharePoint, applied to the built-in Slack service ([ADR-071](../adr/ADR-071-slack-oauth-pkce-user-tokens.md)): `/tokens:ro`, `/workspace:rw` (file downloads land in `/workspace/.speedwave/slack/`), plus its per-service oauth bearer — nothing else. The token-mount-mode check re-uses the generic `PLUGIN_TOKEN_MOUNT_MODE`.

| Rule                            | What it checks                                                             |
| ------------------------------- | -------------------------------------------------------------------------- |
| `SLACK_VOLUME_LONG_FORM`        | Short-form volumes only                                                    |
| `SLACK_TOKEN_PATH_MISMATCH`     | Token mount path matches expected                                          |
| `SLACK_WORKSPACE_PATH_MISMATCH` | Workspace mount path matches expected                                      |
| `SLACK_WORKSPACE_MOUNT_MODE`    | Workspace mount mode is `:rw`                                              |
| `SLACK_NO_EXTRA_VOLUMES`        | Allowlisted extras only: `/tokens`, `/workspace`, per-service oauth bearer |
| `SLACK_MISSING_TOKENS_MOUNT`    | Token mount present                                                        |
| `SLACK_MISSING_WORKSPACE_MOUNT` | Workspace mount present                                                    |

### Host File Security Rules

| Rule                      | Scope                       | What it checks                                                                         |
| ------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `FILE_SECURITY_VIOLATION` | Host filesystem (Unix only) | Sensitive files/directories have correct permissions AND are owned by the current user |

**Permission requirements:**

Sensitive directories must be `0o700` (owner rwx only):

- `~/.speedwave/secrets/<project>/` — worker auth tokens
- `~/.speedwave/snapshots/<project>/` — compose rollback snapshots
- `~/.speedwave/ide-bridge/` — IDE bridge lock files
- `~/.speedwave/tokens/<project>/` — token parent directory
- `~/.speedwave/tokens/<project>/<service>/` — per-service token directories

Sensitive files must be `0o600` (owner rw only):

- `~/.speedwave/secrets/<project>/*` — service auth tokens. Reads of these files reject symbolic links — `is_symlink()` is checked before `is_file()` to defeat host-write attackers planting a symlink to a substitute UUID.
- `~/.speedwave/tokens/<project>/<service>/*` — plugin credentials
- `~/.speedwave/plugin-state/<slug>/bridge-token` — persisted host-bridge auth token (written `0o600` by Desktop's `HostBridge` when the manifest opts into `persistent_token`; read back — symlink-rejected, UUID-validated — by off-Desktop compose renders, ADR-074)
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

- Reuses `url_validation::validate_url()` core logic (scheme, host, and IP validation with 50+ tests; the validator is the SSOT in `speedwave-runtime` since ADR-069, re-exported by desktop)
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

Meeting transcription runs **on the Desktop host** — the Claude container has no audio access (a v1 invariant), so this is a separate threat surface, like the LLM-discovery and Redmine commands. The full design and rationale is [ADR-056](../adr/ADR-056-host-side-audio-transcription.md); the security-relevant points:

- **Beta-gated, no repo override.** The tab is gated behind the beta-features flag (ADR-058); there is no separate per-feature toggle. Repository `.speedwave.json` **cannot** enable host-audio recording (privacy invariant — a repo must not be able to turn on the user's microphone; the repo config carries no transcription field at all). No capture code runs until the user explicitly presses Start.
- **Capture surface.** When enabled, the app can record the host's system-audio loopback (what the user hears — the other call participants) and the microphone, mixed into one stream (the "Whole meeting" default). Each platform uses its OS primitive: macOS CoreAudio process taps via the bundled `audio-capture-cli` (14.4+), and Windows WASAPI loopback via `cpal`. The bundled macOS CLI is a signed Mach-O (`pl.speedwave.desktop.audio-capture`, embedded `Info.plist`) — see _Binary Authenticity_ below.
- **OS permission prompts.** The microphone prompt fires via the public `AVCaptureDevice.requestAccess` API. The **system-audio** ("System Audio Recording") prompt has _no public trigger_ on macOS, so `audio-capture-cli` requests it via the private `TCCAccessRequest(kTCCServiceAudioCapture)` API (the AudioCap / AudioTee approach; works on a notarized `.dmg`, not an App Store app). This is the one private-platform-API dependency in the codebase; it is `dlopen`/`dlsym`-guarded — if a future macOS removes the symbol the CLI exits "permission unavailable" and the UI deep-links the user to System Settings, rather than crashing — and isolated to one commented function (the precedent for a guarded private call is `desktop/src-tauri/src/fs_perms.rs`). ADR-056 decision 3 records this; the public alternative (ScreenCaptureKit audio) was rejected for needing the heavyweight Screen Recording permission and having macOS 15 audio-only defects.
- **Files on disk.** Recordings and transcripts live under `~/.speedwave/transcripts/<id>/` (`audio.wav` + `transcript.json`, `0600`). Models live under `~/.speedwave/models/whisper/` (`0700` dirs, `0600` files), SHA-256-verified on download. There is no auto-retention — the user deletes recordings manually (a single delete removes audio + transcript together).
- **"Local" is true only for inference.** Whisper transcription runs locally — no audio leaves the machine for inference. **Model downloads use the network** (HTTPS to Hugging Face / GitHub via the model-store's redirect-allowlist + streaming hash — same hardening posture as elsewhere; see ADR-056 decision 9). **"Send to Claude"** uploads the rendered transcript _text_ to the user's configured LLM provider (with a confirm dialog). The UI states both on every relevant surface.

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

## Windows Host MCP Worker Lifecycle (Job Object)

On Windows, every host MCP worker (`mcp-os`, `oauth`) is attached at spawn to a Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK`. Parent (`Speedwave.exe`) crash → kernel closes the Job handle → child `node.exe` terminates automatically. The NSIS `NSIS_HOOK_PREINSTALL` sweep is the fallback for orphans that survive the parent (e.g. v0.10.x workers spawned before Job Object support shipped). See [ADR-048](../adr/ADR-048-windows-uninstall-cleanup.md) §"PRE-INSTALL orphan worker sweep" for the architectural decision.

### Accepted residual risks

- **`JOB_OBJECT_LIMIT_BREAKAWAY_OK` permits descendants to escape the job.** A worker subprocess that spawns with `CREATE_BREAKAWAY_FROM_JOB` (UAC elevation prompts, MSI subprocesses, some `cmd /c start /b` patterns) produces a descendant that survives a parent crash. This is intentional — without the flag those legitimate spawns fail with `ERROR_ACCESS_DENIED`. The NSIS PRE-INSTALL sweep is the safety net: it kills any orphan whose `ExecutablePath` is under `$INSTDIR\nodejs\` regardless of how it escaped.
- **TOCTOU window between `Command::spawn` and `AssignProcessToJobObject`** (~microseconds, unbounded under heavy scheduler load). Grandchildren spawned in that window inherit no job and survive parent crash. The atomic fix (`PROC_THREAD_ATTRIBUTE_JOB_LIST` in `STARTUPINFOEX`, or `CREATE_SUSPENDED` + `ResumeThread`) requires bypassing `std::process::Command` and is deferred. Mitigations: (a) host MCP workers do not spawn grandchildren during their synchronous startup phase, (b) the NSIS sweep catches any orphan that does slip through.
- **`AssignProcessToJobObject` failure in nested-job environments** (debugger, Windows Sandbox, MSIX container, PCA compatibility job) returns `ERROR_ACCESS_DENIED`. Parent-crash protection is disabled for that worker; the code logs at error level and the NSIS sweep remains the only orphan defence on next install.

## See Also

- [ADR-009: Per-Project Isolation Preserved](../adr/ADR-009-per-project-isolation-preserved.md)
- [ADR-048: Windows Uninstall Cleanup (incl. PRE-INSTALL orphan sweep)](../adr/ADR-048-windows-uninstall-cleanup.md)
- [ADR-059: Drop Linux Support](../adr/ADR-059-drop-linux-support.md)
- [ADR-037: Code Signing and Bundled Binary Signing](../adr/ADR-037-code-signing-and-bundled-binary-signing.md)
- [ADR-051: Plugin Signature Runtime Verification](../adr/ADR-051-plugin-signature-runtime-verification.md)
- [Release Signing Guide](../contributing/release-signing.md)

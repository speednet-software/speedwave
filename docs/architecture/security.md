# Security Model

Security is a core obsession in Speedwave. Every architectural decision preserves or improves the security model.

## Principles

The following security principles are inherited from Speedwave v1 and are **non-negotiable**:

- **Claude container isolation** — no tokens, no container socket, per-platform container user (UID 1000 on macOS/Windows, UID 0 in Linux rootless user namespace — see [ADR-026](../adr/ADR-026-linux-rootless-container-user.md))
- **OWASP container hardening** — `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, `tmpfs: /tmp:noexec,nosuid`
- **Token isolation** — each MCP worker mounts **only its own** service credentials at `/tokens` read-only. A compromised worker exposes only that service. All MCP workers also mount the project directory at `/workspace:rw` for file operations.
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

## Token Isolation

Each MCP worker container mounts **only its own** service credentials:

```
~/.speedwave/tokens/<project>/<service>/  → /tokens (read-only mount)
```

- Slack worker sees only Slack tokens
- GitLab worker sees only GitLab tokens
- Hub has **zero** token mounts — it routes requests to workers via HTTP

**Exception:** SharePoint uses `:rw` mount for OAuth token refresh (see [ADR-009](../adr/ADR-009-per-project-isolation-preserved.md)).

## Threat Model

When implementing any feature, ask these questions:

1. **Does this require relaxing any of the above principles?** If yes — find a different approach.
2. **Does this add a new attack surface?** Document it and mitigate it.
3. **Does this require mounting host filesystem into a container?** Minimize scope, use `:ro` wherever possible.

### Security Boundaries

- **Host ↔ VM**: Lima/WSL2 kernel isolation
- **VM ↔ Container**: nerdctl/containerd container isolation with OWASP hardening
- **Container ↔ Container**: per-project network isolation (`speedwave_<project>_network`)
- **Worker ↔ Worker**: token isolation — each worker has access only to its own service credentials

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

| Rule             | Scope          | What it checks                                                                                                                                                                                  |
| ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTAINER_USER` | All containers | `user:` field matches the platform-expected value from `container_user()` (UID 1000 on macOS/Windows, UID 0 on Linux rootless — see [ADR-026](../adr/ADR-026-linux-rootless-container-user.md)) |

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

### SharePoint Volume Rules

Same checks as plugin volumes, applied to the built-in SharePoint service. SharePoint uses `:rw` token mount for OAuth refresh (see [ADR-009](../adr/ADR-009-per-project-isolation-preserved.md)).

| Rule                                 | What it checks                        |
| ------------------------------------ | ------------------------------------- |
| `SHAREPOINT_VOLUME_LONG_FORM`        | Short-form volumes only               |
| `SHAREPOINT_TOKEN_PATH_MISMATCH`     | Token mount path matches expected     |
| `SHAREPOINT_TOKEN_MOUNT_MODE`        | Token mount mode is `:rw`             |
| `SHAREPOINT_WORKSPACE_PATH_MISMATCH` | Workspace mount path matches expected |
| `SHAREPOINT_WORKSPACE_MOUNT_MODE`    | Workspace mount mode is `:rw`         |
| `SHAREPOINT_NO_EXTRA_VOLUMES`        | No extra volumes                      |
| `SHAREPOINT_MISSING_TOKENS_MOUNT`    | Token mount present                   |
| `SHAREPOINT_MISSING_WORKSPACE_MOUNT` | Workspace mount present               |

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

- `~/.speedwave/secrets/<project>/*` — service auth tokens
- `~/.speedwave/tokens/<project>/<service>/*` — plugin credentials
- `~/.speedwave/snapshots/<project>/*.json` — compose snapshots
- `~/.speedwave/ide-bridge/*.lock` — IDE bridge auth tokens
- `~/.speedwave/bundle-state.json` — bundle reconciliation state

**Ownership requirement:** All sensitive files and directories must be owned by the current user (UID match). This prevents scenarios where files have correct mode bits but are owned by a different user (e.g. root), making them inaccessible to the container runtime.

**Limitations:** Validates Unix mode bits and UID only — not ACLs, xattrs, or Windows DACLs. On Windows, this check is a no-op. Symlinks within scanned directories are skipped (not followed) to prevent traversal attacks. Missing paths are silently skipped — they may not exist for fresh projects or unused integrations.

### Workspace Path Protection

Because the full project directory is mounted as `/workspace:rw`, the `path-validator.ts` denylist blocks MCP workers from accessing sensitive paths within the workspace: `.git/`, `.env`, and `.speedwave/`. This provides defense-in-depth — even if an MCP worker is compromised, it cannot exfiltrate repository history, environment secrets, or Speedwave configuration.

### Shared Infrastructure

`SecurityExpectedPaths` is computed once and shared between `render_compose()` and `SecurityCheck::run()` to prevent path drift. On Windows, paths are translated from `C:\Users\...` to `/mnt/c/Users/...` for WSL2 compatibility.

## OS Prerequisite Checks

`os_prereqs::check_os_prereqs()` validates host-level requirements before any container operations:

- **Windows**: Verifies WSL2 is available via `wsl.exe --status` (10s timeout). If missing, reports actionable remediation (DISM commands or Windows Features GUI).
- **Linux**: Verifies `newuidmap` is installed (required for rootless user namespaces).
- **macOS**: No OS prerequisites — Lima runtime is bundled by Speedwave.

These checks run at multiple points: setup wizard (before VM init), container start (blocking overlay in Desktop, exit in CLI), and update/rollback. Violations produce `PrereqViolation` structs with remediation text, following the same pattern as `SecurityCheck` violations.

Both OS prereq failures and `SecurityCheck` compose violations block the application — containers never start if either check fails.

Additionally, `check_os_warnings()` provides non-blocking diagnostic warnings (e.g. nested virtualization detected) logged via `log::warn!` during system checks. These warnings do not block container operations but appear in `speedwave check` output and Desktop log files.

## Redmine API Proxy Commands

The Desktop app includes two Tauri commands that make HTTP requests to external Redmine instances during integration configuration: `validate_redmine_credentials` and `fetch_redmine_enumerations`. These run on the Desktop host process, not inside containers, because the MCP Redmine worker doesn't exist during configuration — the user hasn't saved credentials yet.

**SSRF mitigations:**

- Reuses `url_validation::validate_url()` core logic (scheme, host, and IP validation with 50+ tests)
- **Blocked:** loopback IPs (127.0.0.0/8, ::1), link-local/metadata IPs (169.254.0.0/16 including cloud metadata endpoint 169.254.169.254)
- **Allowed with warning:** RFC1918 private IPs (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) — self-hosted Redmine on private networks is the primary use case
- Redirects blocked via `reqwest::redirect::Policy::none()`
- Only fixed Redmine API paths requested (not arbitrary URLs)
- Response shape validated via typed deserialization (non-Redmine JSON rejected)
- Custom `User-Agent` header, no cookie jar, no auth headers beyond `X-Redmine-API-Key`
- 5-15s request timeouts

**RFC1918 divergence from MCP Hub:** MCP Hub blocks ALL private IPs because it runs in a container with no legitimate private targets. Desktop Redmine proxy allows RFC1918 because: (1) Desktop runs on the host, not in a container; (2) self-hosted Redmine on RFC1918 is the primary use case; (3) loopback and metadata IPs remain blocked. This divergence is intentional — the security postures serve different threat models.

**SecurityCheck scope:** These commands run on the Desktop host process, not inside containers — they are outside SecurityCheck's compose validation scope. SSRF protection is implemented directly in the command handlers via `validate_redmine_host_url()`.

**Known limitations (pre-existing, shared with SharePoint OAuth):**

- `rustls-tls` uses bundled CA roots, not the OS certificate store. Corporate users with custom CAs may see TLS errors.
- No automatic system proxy detection (`default-features = false` in reqwest). Corporate users behind HTTP proxies may see connection timeouts.
- HTTP cleartext warning logged when `http://` scheme is used (credentials transmitted without encryption).

## Authentication Gate

Claude Code must be authenticated (OAuth or API key) before the app allows
chat access. Enforced at two layers:

- **Backend (`start_chat`, `resume_conversation`):** Runs `claude auth status`
  inside the container before spawning an interactive session. Returns a clear
  error if not authenticated, preventing the hang that occurs when Claude
  prompts for interactive login on stdin while the frontend waits for
  stream-json on stdout.

- **Frontend (`ProjectStateService`):** After containers are running, calls
  `get_auth_status`. If neither OAuth nor API key is configured, sets status to
  `auth_required` — an overlay displays a CLI command (`get_auth_command`) for
  the user to copy into their own terminal to complete OAuth login. The command
  is displayed as text only (never executed by the app), eliminating shell
  injection risk. When the Desktop app's data directory differs from the
  default (`~/.speedwave`), the command includes an
  `export SPEEDWAVE_DATA_DIR=...` prefix. The value comes from the Desktop
  app's own data directory, which is determined at process start and never
  re-read from the terminal session's environment.

## See Also

- [ADR-009: Per-Project Isolation Preserved](../adr/ADR-009-per-project-isolation-preserved.md)
- [ADR-026: Linux Rootless nerdctl — Per-Platform Container User](../adr/ADR-026-linux-rootless-container-user.md)

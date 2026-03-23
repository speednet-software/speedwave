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

## SecurityCheck — Workspace Mount Validation

`SecurityCheck::run()` validates the `/workspace:rw` mount for both plugin services and built-in SharePoint:

- **Host path** must match `{project_dir}` (via `SecurityExpectedPaths`)
- **Mode** must be `:rw`
- **Presence** — both `/tokens` and `/workspace` mounts are required
- **Long-form volumes** (YAML mappings) are rejected — only short-form strings allowed

`SecurityExpectedPaths` is computed once and shared between `render_compose()` and `SecurityCheck::run()` to prevent path drift.

Because the full project directory is now mounted, the `path-validator.ts` denylist blocks MCP workers from accessing sensitive paths within the workspace: `.git/`, `.env`, and `.speedwave/`. This provides defense-in-depth — even if an MCP worker is compromised, it cannot exfiltrate repository history, environment secrets, or Speedwave configuration.

## OS Prerequisite Checks

`os_prereqs::check_os_prereqs()` validates host-level requirements before any container operations:

- **Windows**: Verifies WSL2 is available via `wsl.exe --status` (10s timeout). If missing, reports actionable remediation (DISM commands or Windows Features GUI).
- **Linux**: Verifies `newuidmap` is installed (required for rootless user namespaces).
- **macOS**: No OS prerequisites — Lima runtime is bundled by Speedwave.

These checks run at multiple points: setup wizard (before VM init), container start (blocking overlay in Desktop, exit in CLI), and update/rollback. Violations produce `PrereqViolation` structs with remediation text, following the same pattern as `SecurityCheck` violations.

Both OS prereq failures and `SecurityCheck` compose violations block the application — containers never start if either check fails.

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
  `auth_required` — an overlay with an "Authenticate" button opens a native
  terminal (`open_auth_terminal`) for the user to complete OAuth login.

## See Also

- [ADR-009: Per-Project Isolation Preserved](../adr/ADR-009-per-project-isolation-preserved.md)
- [ADR-026: Linux Rootless nerdctl — Per-Platform Container User](../adr/ADR-026-linux-rootless-container-user.md)

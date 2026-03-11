# Security Model

Security is a core obsession in Speedwave. Every architectural decision preserves or improves the security model.

## Principles

The following security principles are inherited from Speedwave v1 and are **non-negotiable**:

- **Claude container isolation** — no tokens, no container socket, per-platform container user (UID 1000 on macOS/Windows, UID 0 in Linux rootless user namespace — see [ADR-026](../adr/ADR-026-linux-rootless-container-user.md))
- **OWASP container hardening** — `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, `tmpfs: /tmp:noexec,nosuid`
- **Token isolation** — each MCP worker mounts **only its own** service credentials at `/tokens` read-only. A compromised worker exposes only that service
- **Hub has zero tokens** — compromise of the hub exposes nothing
- **Kernel-level isolation** — Lima VM (macOS) / WSL2 (Windows) provides an additional isolation layer on top of container isolation
- **Resource limits** — CPU + memory caps per container
- **Verified downloads** — SHA256-verified binary downloads in Containerfile
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

## See Also

- [ADR-009: Per-Project Isolation Preserved](../adr/ADR-009-per-project-isolation-preserved.md)
- [ADR-026: Linux Rootless nerdctl — Per-Platform Container User](../adr/ADR-026-linux-rootless-container-user.md)

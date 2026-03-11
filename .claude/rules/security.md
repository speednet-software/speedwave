# Security Rules

**Security is a core obsession, not an afterthought.** Every architectural decision must preserve or improve the security model established in Speedwave v1. When in doubt, choose the more secure option.

## Security principles inherited from v1 (non-negotiable)

- Claude container: no tokens, no container socket, per-platform container user (UID 1000 on macOS/Windows, UID 0 in Linux rootless user namespace — see ADR-026)
- OWASP container hardening: `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, `tmpfs: /tmp:noexec,nosuid`
- Token isolation: each MCP worker mounts **only its own** service credentials at `/tokens` read-only — a compromised worker exposes only that service. Exception: SharePoint uses `:rw` for OAuth token refresh (see ADR-009)
- Hub has zero tokens — compromise of the hub exposes nothing
- Lima VM / WSL2: kernel-level isolation layer on top of container isolation
- Resource limits per container (CPU + memory caps)
- SHA256-verified binary downloads in Containerfile
- Health endpoints return only `{ "status": "ok" }` — no service metadata leaked

## When implementing any feature, ask:

- Does this require relaxing any of the above? If yes — find a different approach.
- Does this add a new attack surface? Document it and mitigate it.
- Does this require mounting host filesystem into a container? Minimize scope, use `:ro` wherever possible.

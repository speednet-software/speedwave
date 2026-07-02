# ADR-009: Per-Project Isolation Preserved

> **Status:** Accepted — but the SharePoint `:rw` token-mount exception this ADR documented was retired. Refresh moved to a host-side `oauth` worker; SharePoint now mounts `/tokens:ro` like every other built-in worker (see [ADR-060](ADR-060-host-side-oauth-refresh-worker.md)).
> **Context:** Carry the v1 per-project isolation model forward unchanged.

## Decision

Each project gets its own isolated container network and its own dedicated tokens directory — identical to Speedwave v1. A compromise in one project's worker cannot reach another project's network or credentials.

## Why

- Per-project network (`speedwave_<project>_network`) keeps one project's containers off another project's wire — built by `render_compose()` from the network name `{compose_prefix}_{project}_network`.
- Per-project tokens directory (`~/.speedwave/tokens/<project>/`) means each project's service credentials live in their own tree; a worker only ever sees its own service's subdirectory.
- The VM isolation layer (Lima + Apple VZ on macOS, WSL2 + Hyper-V on Windows) adds a kernel-level hypervisor boundary beneath the container hardening. Linux as a host platform was dropped — see [ADR-059](ADR-059-drop-linux-support.md).
- OWASP container hardening (`cap_drop: ALL`, `no-new-privileges`, `read_only`) remains unchanged on both platforms.

## Token mounts

Each MCP worker mounts **only its own** service credentials at `/tokens`, and every mount is read-only (`:ro`). There is no `:rw` exception anymore.

When this ADR was first written, SharePoint was the single exception: it mounted `/tokens:rw` so the worker could write refreshed Microsoft OAuth `access_token` / `refresh_token` back to disk. That exception was removed. Token refresh now runs in a host-side `oauth` worker (a per-project Node process outside any container) that holds `refresh_token` / `client_id` / `tenant_id` and exposes `refresh` / `forget`; the SharePoint container only reads `access_token` through a `:ro` mount. SharePoint's `token-manager.ts` no longer writes tokens — it just records refresh-side errors for the worker's health endpoint.

## Where it lives in code

- Per-project network + tokens-dir wiring — `crates/speedwave-runtime/src/compose.rs` (`render_compose`, `resolve_tokens_dir_in`)
- SharePoint `/tokens:ro` mount — `containers/compose.template.yml` (the `mcp-sharepoint` service volumes)
- `:ro`-everywhere enforcement (no SharePoint special case) — `crates/speedwave-runtime/src/compose.rs` (`SecurityRule`, `validate_service_volume_mounts`)
- Host-side refresh worker rationale and threat model — [ADR-060](ADR-060-host-side-oauth-refresh-worker.md)
- SharePoint health-only token manager — `mcp-servers/sharepoint/src/token-manager.ts`
- Platform/VM isolation specifics — [docs/architecture/platform-matrix.md](../architecture/platform-matrix.md)

## Rejected alternatives

- **Keep the SharePoint `:rw` exception (this ADR's original choice).** Originally accepted as "low risk, the container already holds valid tokens in memory." ADR-060 reversed this: a `:rw` mount lets a compromised SharePoint container rewrite the refresh token to one the attacker controls — persisting access past a user revoke — and any code path reading `/tokens` is a refresh-token leak risk. Moving refresh to a host-side worker keeps `refresh_token` out of every container, so the gate is systemic rather than convention.

---

[OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)

# ADR-009: Per-Project Isolation Preserved

## Decision

Each project has its own container network and tokens — identical to Speedwave v1.

## Rationale

The v1 security model is fully preserved:

```
Lima VM (shared, single instance)
├── project acme-corp
│   ├── speedwave_acme-corp_network (isolated network)
│   └── ~/.speedwave/tokens/acme-corp/ (dedicated tokens)
└── project megabank
    ├── speedwave_megabank_network (isolated network)
    └── ~/.speedwave/tokens/megabank/ (dedicated tokens)
```

Lima VM adds an additional isolation layer (kernel-level hypervisor) that Docker Desktop did not provide. OWASP container hardening (`cap_drop: ALL`, `no-new-privileges`, `read_only`) remains unchanged.[^23]

## Token Mounts

Each MCP worker mounts **only its own** service credentials at `/tokens`. All mounts are read-only (`:ro`) **except SharePoint**, which requires `:rw` because Microsoft OAuth tokens expire[^24] and `token-manager.ts` writes refreshed `access_token` / `refresh_token` back to disk.

**Risk accepted:** a compromised SharePoint container with `:rw` could corrupt its own tokens (denial of service until re-authentication) or create arbitrary files in its tokens directory. It cannot access other services' credentials. The alternative — token refresh via a host-side proxy — would add complexity without meaningful security gain, since the container already holds valid tokens in memory.

---

[^23]: [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)

[^24]: [Microsoft identity platform — OAuth 2.0 authorization code flow (token refresh)](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token)

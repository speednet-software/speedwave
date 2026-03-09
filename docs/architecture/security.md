# Security Model

Security is a core obsession in Speedwave. Every architectural decision preserves or improves the security model.

## Principles

<!-- Content to be written: Claude container isolation (no tokens, no socket), OWASP container hardening, token isolation, Lima/WSL2 kernel-level isolation -->

## Container Hardening

<!-- Content to be written: cap_drop ALL, no-new-privileges, read_only filesystem, tmpfs /tmp:noexec,nosuid, resource limits -->

## Token Isolation

<!-- Content to be written: per-service credentials, read-only mounts, SharePoint exception (ADR-009) -->

## Threat Model

<!-- Content to be written: attack surfaces, mitigations, security boundaries -->

## See Also

- [ADR-009: Per-Project Isolation Preserved](../adr/ADR-009-per-project-isolation-preserved.md)

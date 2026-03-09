# Containers

Speedwave uses OCI containers (via nerdctl) for isolation and reproducibility. Each project gets its own network and set of containers.

## Container Topology

<!-- Content to be written: per-project containers (claude, mcp_hub, mcp_<service>), network isolation -->

## Compose Template

<!-- Content to be written: compose.template.yml as SSOT, render_compose() generation -->

## Image Build

<!-- Content to be written: Containerfiles, build context bundling, SHA256 verification -->

## See Also

- [ADR-001: Eliminate Docker Desktop](../adr/ADR-001-eliminate-docker-desktop.md)
- [ADR-017: Claude Code in Container via entrypoint.sh](../adr/ADR-017-claude-code-in-container-via-entrypoint.md)

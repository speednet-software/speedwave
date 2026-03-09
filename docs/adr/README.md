# Architecture Decision Records

This directory contains all Architecture Decision Records (ADRs) for Speedwave. Each ADR documents a significant architectural choice, its context, and consequences.

## Index

| #                                                                      | Title                                                   | Status   |
| ---------------------------------------------------------------------- | ------------------------------------------------------- | -------- |
| [ADR-000](ADR-000-product-principles.md)                               | Speedwave — Product Principles                          | Accepted |
| [ADR-001](ADR-001-eliminate-docker-desktop.md)                         | Eliminate Docker Desktop                                | Accepted |
| [ADR-002](ADR-002-lima-as-vm-manager-on-macos.md)                      | Lima as VM Manager on macOS                             | Accepted |
| [ADR-003](ADR-003-bundled-nerdctl-full-on-linux.md)                    | Bundled nerdctl-full on Linux                           | Accepted |
| [ADR-004](ADR-004-wsl2-and-nerdctl-on-windows.md)                      | WSL2 + nerdctl on Windows                               | Accepted |
| [ADR-005](ADR-005-two-interfaces-cli-and-desktop.md)                   | Two Interfaces — CLI and Desktop                        | Accepted |
| [ADR-006](ADR-006-chat-ui-via-stream-json.md)                          | Chat UI via claude -p --stream-json                     | Accepted |
| [ADR-007](ADR-007-ide-bridge-as-proxy.md)                              | IDE Bridge as Proxy                                     | Accepted |
| [ADR-008](ADR-008-no-background-daemon.md)                             | No Background Daemon — Desktop App Is Sufficient        | Accepted |
| [ADR-009](ADR-009-per-project-isolation-preserved.md)                  | Per-Project Isolation Preserved                         | Accepted |
| [ADR-010](ADR-010-mcp-os-as-host-process-per-platform.md)              | mcp-os as Host Process Per Platform                     | Accepted |
| [ADR-011](ADR-011-user-configuration-passed-to-claude-code.md)         | User Configuration Passed to Claude Code                | Accepted |
| [ADR-012](ADR-012-github-as-ci-cd-and-distribution-platform.md)        | GitHub as CI/CD and Distribution Platform               | Accepted |
| [ADR-013](ADR-013-mcp-os-as-host-process-implementation.md)            | mcp-os as Host Process — Implementation Details         | Accepted |
| [ADR-014](ADR-014-ide-bridge-three-mechanisms-per-platform.md)         | IDE Bridge — Three Mechanisms Per Platform              | Accepted |
| [ADR-015](ADR-015-addon-system-open-core-model.md)                     | Addon System — Open-Core Model                          | Accepted |
| [ADR-016](ADR-016-cross-platform-cli-path.md)                          | Cross-Platform CLI PATH                                 | Accepted |
| [ADR-017](ADR-017-claude-code-in-container-via-entrypoint.md)          | Claude Code in Container via entrypoint.sh              | Accepted |
| [ADR-018](ADR-018-llm-provider-switching-proxy-as-container.md)        | LLM Provider Switching — Proxy as Container             | Accepted |
| [ADR-019](ADR-019-git-branching-model-and-release-flow.md)             | Git Branching Model and Release Flow                    | Accepted |
| [ADR-020](ADR-020-legal-compliance-and-license-analysis.md)            | Legal Compliance & License Analysis                     | Accepted |
| [ADR-021](ADR-021-bundled-dependencies-and-zero-install-strategy.md)   | Bundled Dependencies and Zero-Install Strategy          | Accepted |
| [ADR-022](ADR-022-bundled-claude-resources-and-project-coexistence.md) | Bundled .claude Resources and Project-Level Coexistence | Accepted |
| [ADR-023](ADR-023-appimage-static-runtime-for-fuse-independence.md)    | AppImage Static Runtime for FUSE Independence           | Accepted |

## Creating a New ADR

Use the next available number and follow the naming convention:

```
ADR-NNN-short-kebab-case-title.md
```

Then add the new entry to the index table above. See [ADR Writing Standards](../../CLAUDE.md#adr-writing-standards) for the footnotes requirement — every factual claim must have a source URL.

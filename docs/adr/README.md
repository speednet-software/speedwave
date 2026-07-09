# Architecture Decision Records

This directory contains all Architecture Decision Records (ADRs) for Speedwave. Each ADR documents a significant architectural choice, its context, and consequences.

## Index

| #                                                                      | Title                                                                                                                  | Status                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [ADR-000](ADR-000-product-principles.md)                               | Speedwave — Product Principles                                                                                         | Accepted                      |
| [ADR-001](ADR-001-eliminate-docker-desktop.md)                         | Eliminate Docker Desktop                                                                                               | Accepted                      |
| [ADR-002](ADR-002-lima-as-vm-manager-on-macos.md)                      | Lima as VM Manager on macOS                                                                                            | Accepted                      |
| [ADR-003](ADR-003-bundled-nerdctl-full-on-linux.md)                    | Bundled nerdctl-full on Linux                                                                                          | Superseded by ADR-059         |
| [ADR-004](ADR-004-wsl2-and-nerdctl-on-windows.md)                      | WSL2 + nerdctl on Windows                                                                                              | Accepted                      |
| [ADR-005](ADR-005-two-interfaces-cli-and-desktop.md)                   | Two Interfaces — CLI and Desktop                                                                                       | Accepted                      |
| [ADR-006](ADR-006-chat-ui-via-stream-json.md)                          | Chat UI via claude -p --stream-json                                                                                    | Accepted                      |
| [ADR-007](ADR-007-ide-bridge-as-proxy.md)                              | IDE Bridge as Proxy                                                                                                    | Accepted                      |
| [ADR-008](ADR-008-no-background-daemon.md)                             | No Background Daemon — Desktop App Is Sufficient                                                                       | Accepted                      |
| [ADR-009](ADR-009-per-project-isolation-preserved.md)                  | Per-Project Isolation Preserved                                                                                        | Accepted                      |
| [ADR-010](ADR-010-mcp-os-as-host-process-per-platform.md)              | mcp-os as Host Process Per Platform                                                                                    | Accepted                      |
| [ADR-011](ADR-011-user-configuration-passed-to-claude-code.md)         | User Configuration Passed to Claude Code                                                                               | Accepted                      |
| [ADR-012](ADR-012-github-as-ci-cd-and-distribution-platform.md)        | GitHub as CI/CD and Distribution Platform                                                                              | Accepted                      |
| [ADR-013](ADR-013-mcp-os-as-host-process-implementation.md)            | mcp-os as Host Process — Implementation Details                                                                        | Accepted                      |
| [ADR-014](ADR-014-ide-bridge-three-mechanisms-per-platform.md)         | IDE Bridge — Three Mechanisms Per Platform                                                                             | Accepted                      |
| [ADR-015](ADR-015-plugin-system.md)                                    | Plugin System                                                                                                          | Accepted                      |
| [ADR-016](ADR-016-cross-platform-cli-path.md)                          | Cross-Platform CLI PATH                                                                                                | Accepted                      |
| [ADR-017](ADR-017-claude-code-in-container-via-entrypoint.md)          | Claude Code in Container via entrypoint.sh                                                                             | Accepted                      |
| [ADR-018](ADR-018-llm-provider-switching-proxy-as-container.md)        | LLM Provider Switching — Proxy as Container                                                                            | Superseded by ADR-040         |
| [ADR-019](ADR-019-git-branching-model-and-release-flow.md)             | Git Branching Model and Release Flow                                                                                   | Accepted                      |
| [ADR-020](ADR-020-legal-compliance-and-license-analysis.md)            | Legal Compliance & License Analysis                                                                                    | Accepted                      |
| [ADR-021](ADR-021-bundled-dependencies-and-zero-install-strategy.md)   | Bundled Dependencies and Zero-Install Strategy                                                                         | Accepted                      |
| [ADR-022](ADR-022-bundled-claude-resources-and-project-coexistence.md) | Bundled .claude Resources and Project-Level Coexistence                                                                | Accepted                      |
| [ADR-023](ADR-023-appimage-static-runtime-for-fuse-independence.md)    | AppImage Static Runtime for FUSE Independence                                                                          | Superseded by ADR-025         |
| [ADR-024](ADR-024-e2e-testing-strategy.md)                             | Desktop E2E Testing Strategy                                                                                           | Accepted                      |
| [ADR-025](ADR-025-linux-deb-packaging.md)                              | Linux .deb Packaging (Replaces AppImage)                                                                               | Superseded by ADR-059         |
| [ADR-026](ADR-026-linux-rootless-container-user.md)                    | Linux Rootless nerdctl — Per-Platform Container User                                                                   | Superseded by ADR-059         |
| [ADR-027](ADR-027-native-directory-structure.md)                       | Native Directory Structure                                                                                             | Accepted                      |
| [ADR-028](ADR-028-tauri-over-electron.md)                              | Tauri v2 over Electron for Desktop Shell                                                                               | Accepted                      |
| [ADR-029](ADR-029-sandbox-prototype-chain-hardening.md)                | Sandbox Prototype Chain Hardening                                                                                      | Accepted                      |
| [ADR-030](ADR-030-bundle-reconcile-after-app-update.md)                | Bundle Reconcile After App Update                                                                                      | Accepted                      |
| [ADR-031](ADR-031-data-dir-env-var-for-instance-isolation.md)          | Data Dir Env Var for Instance Isolation                                                                                | Accepted                      |
| [ADR-032](ADR-032-nested-virtualization-resilience.md)                 | Nested Virtualization Resilience                                                                                       | Accepted                      |
| [ADR-033](ADR-033-permission-autofix-on-startup.md)                    | Permission Auto-Fix on Startup                                                                                         | Accepted                      |
| [ADR-034](ADR-034-mcp-error-guidance-and-init-retry.md)                | MCP Error Guidance and Client Init Retry                                                                               | Accepted                      |
| [ADR-035](ADR-035-mcp-spec-compliance-streamable-http.md)              | MCP Spec Compliance — Streamable HTTP Transport                                                                        | Accepted                      |
| [ADR-036](ADR-036-self-declaring-worker-policy.md)                     | Self-Declaring Worker Policy via `_meta`                                                                               | Accepted                      |
| [ADR-037](ADR-037-code-signing-and-bundled-binary-signing.md)          | Code Signing and Bundled Binary Signing                                                                                | Accepted                      |
| [ADR-038](ADR-038-single-internal-worker-port.md)                      | Single Internal Worker Port                                                                                            | Accepted                      |
| [ADR-039](ADR-039-playwright-shared-browser-service.md)                | Playwright Shared Browser Service                                                                                      | Accepted                      |
| [ADR-040](ADR-040-remove-litellm-direct-provider-injection.md)         | Remove LiteLLM — Direct Local Provider Injection                                                                       | Superseded in part by ADR-073 |
| [ADR-041](ADR-041-local-llm-model-discovery.md)                        | Local LLM Model Discovery and SSRF Policy                                                                              | Accepted                      |
| [ADR-042](ADR-042-json-patch-stream-protocol.md)                       | JSON Patch (RFC 6902) as the Stream-to-UI Protocol                                                                     | Retired                       |
| [ADR-043](ADR-043-msgstore-history-plus-stream.md)                     | MsgStore — Broadcast Channel Plus Bounded History                                                                      | Retired                       |
| [ADR-044](ADR-044-entry-index-provider.md)                             | EntryIndexProvider — Atomic Counter for Stable Keys                                                                    | Retired                       |
| [ADR-045](ADR-045-one-slot-queued-message.md)                          | One-Slot Queued Message Per Session (Replace, Not FIFO)                                                                | Accepted                      |
| [ADR-046](ADR-046-native-session-resume-for-retry.md)                  | Native Session Resume for Assistant-Message Retry                                                                      | Accepted                      |
| [ADR-047](ADR-047-plugin-install-progress-events.md)                   | Plugin Install Progress Events                                                                                         | Accepted                      |
| [ADR-048](ADR-048-windows-uninstall-cleanup.md)                        | Windows Uninstall Cleanup — Unregister WSL Distro                                                                      | Accepted                      |
| [ADR-049](ADR-049-tcc-sub-identifiers-and-applevents-gate.md)          | TCC Sub-Identifiers and Unified AppleEvents Permission Gate                                                            | Accepted                      |
| [ADR-050](ADR-050-host-timezone-propagation.md)                        | Host Timezone Propagation Into Containers                                                                              | Accepted                      |
| [ADR-051](ADR-051-plugin-signature-runtime-verification.md)            | Plugin Signature as a Runtime Invariant                                                                                | Accepted                      |
| [ADR-052](ADR-052-anthropic-oauth-login-flow.md)                       | Claude Code Login Surface + Clipboard Bridge                                                                           | Accepted                      |
| [ADR-053](ADR-053-worker-implementation-own-vs-wrap-official-mcp.md)   | Worker Implementation — Own Thin Worker vs Wrapping an Official MCP Server                                             | Accepted                      |
| [ADR-054](ADR-054-host-exec-worker.md)                                 | `host_exec` — Per-Project Host-Side MCP Worker for the Project Toolchain                                               | Reverted                      |
| [ADR-055](ADR-055-built-in-office-document-worker.md)                  | Built-in `office` MCP Worker — Word/Excel/PowerPoint/PDF Read · Write · Convert · Charts                               | Accepted                      |
| [ADR-056](ADR-056-host-side-audio-transcription.md)                    | Host-Side Audio Capture and Local Meeting Transcription                                                                | Proposed                      |
| [ADR-057](ADR-057-lazy-build-of-enabled-worker-images.md)              | Lazy Build of Enabled Worker Container Images                                                                          | Accepted                      |
| [ADR-058](ADR-058-beta-features-toggle.md)                             | Beta Features Toggle in the Tray Menu                                                                                  | Accepted                      |
| [ADR-059](ADR-059-drop-linux-support.md)                               | Drop Linux Support — Windows and macOS Only                                                                            | Accepted                      |
| [ADR-060](ADR-060-host-side-oauth-refresh-worker.md)                   | Host-Side OAuth Refresh Worker (`oauth`)                                                                               | Accepted                      |
| [ADR-061](ADR-061-windows-crt-runtime-alignment.md)                    | Windows CRT Runtime Alignment for sherpa-onnx + whisper.cpp                                                            | Superseded by ADR-075         |
| [ADR-062](ADR-062-playwright-host-gateway-access.md)                   | Playwright Host-Gateway Access via Static `extra_hosts`                                                                | Accepted                      |
| [ADR-063](ADR-063-host-bridge-generic.md)                              | Generic HostBridge skeleton for host-side WebSocket relays                                                             | Accepted                      |
| [ADR-064](ADR-064-canonicalize-bypass-for-wsl-unc.md)                  | Bypass `canonicalize()` for WSL UNC project paths on Windows                                                           | Accepted                      |
| [ADR-065](ADR-065-image-attachments-structured-input.md)               | Image attachments via structured `WireContentBlock[]` user input                                                       | Accepted                      |
| [ADR-066](ADR-066-locked-runtime-per-project-compose-lock.md)          | `LockedRuntime` wrapper enforcing per-project compose transaction lock                                                 | Accepted                      |
| [ADR-067](ADR-067-host-addressing-ssot-windows-wsl2-mirrored.md)       | `HostAddressing` SSOT — host bind / container gateway under WSL2 mirrored networking                                   | Accepted                      |
| [ADR-068](ADR-068-resource-budget-ssot.md)                             | Resource budget SSOT — container memory/CPU + adaptive VM sizing (fixed 6 GiB Claude)                                  | Accepted                      |
| [ADR-069](ADR-069-generic-plugin-oauth2.md)                            | Generic plugin OAuth2 via host-side worker — per-human identity, PKCE loopback                                         | Accepted                      |
| [ADR-070](ADR-070-appleevents-kernel-process-id-gate.md)               | AppleEvents permission gate via `typeKernelProcessID` addressing                                                       | Accepted                      |
| [ADR-071](ADR-071-slack-oauth-pkce-user-tokens.md)                     | Slack OAuth2 PKCE — tokenless sign-in with rotating user tokens                                                        | Accepted                      |
| [ADR-072](ADR-072-per-image-build-input-hash-tags.md)                  | Per-image build-input hash tags + BuildKit cache retention — rebuild only changed images                               | Accepted                      |
| [ADR-073](ADR-073-embedded-per-project-speedwave-proxy.md)             | Embedded per-project Speedwave proxy — Rust Anthropic-passthrough forwarder, multi-provider routing + usage accounting | Accepted                      |
| [ADR-074](ADR-074-cli-host-bridge-reconstruction.md)                   | Reconstruct host-bridge env from disk for off-Desktop compose renders                                                  | Accepted                      |
| [ADR-075](ADR-075-remove-speaker-diarization.md)                       | Remove speaker diarization — clean timestamped transcript, full sherpa-onnx removal                                    | Accepted                      |
| [ADR-076](ADR-076-mdm-enforceable-otlp-telemetry.md)                   | MDM-enforceable OTLP telemetry — user self-service + org policy via a system managed-config file                       | Accepted                      |
| [ADR-077](ADR-077-bundled-official-anthropic-plugins.md)               | Bundle official Anthropic Claude Code plugins (runtime install at start + pre-baked TS server)                         | Accepted                      |
| [ADR-078](ADR-078-claude-hook-registration.md)                         | Claude Code hook registration — hooks.json declarations merged into settings.json at container start                   | Accepted                      |
| [ADR-079](ADR-079-policy-engine-pii-tokenization.md)                   | Policy engine: PII tokenization via a resolved, host-rendered policy mounted read-only into mcp-hub                    | Accepted                      |

## Creating a New ADR

Use the next available number and follow the naming convention:

```
ADR-NNN-short-kebab-case-title.md
```

Then add the new entry to the index table above. See [ADR Writing Standards](../../.claude/rules/documentation.md#adr-writing-standards) for the footnotes requirement — every factual claim must have a source URL.

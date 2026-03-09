# ADR-000: Speedwave — Product Principles

> **Status:** Accepted
> **Context:** Shared context for all Architecture Decision Records

---

## Product Principles

| Principle                              | Description                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Zero dependencies beyond Speedwave** | User downloads one file from GitHub Releases. No Docker Desktop, Node.js, or Python required. Speedwave bundles everything. |
| **Cross-platform**                     | Windows, macOS, Linux — identical UX                                                                                        |
| **Two usage modes**                    | CLI (like standard Claude Code) or Desktop app (chat UI)                                                                    |
| **Per-project isolation**              | Each project: isolated network, tokens, and containers                                                                      |
| **Easy configuration**                 | Environment variables and settings passed directly to Claude Code                                                           |

These principles govern all architectural decisions in Speedwave. Each ADR should be evaluated against these principles.

### Zero Dependencies — Platform Implementation

The "zero dependencies" principle is fulfilled differently per platform, reflecting each platform's idiomatic dependency management (see ADR-021 for full rationale):

- **macOS**: Lima is bundled inside `.app/Contents/Resources/lima/`. The user does not need `brew install lima` — the application ships with everything required. `LIMA_HOME=~/.speedwave/lima` isolates from any user-installed Lima instance.
- **Linux**: nerdctl-full is bundled inside the AppImage. No system package manager dependency is required — the user downloads the AppImage and everything is included. See ADR-003 and ADR-021 for details.
- **Windows**: WSL2 is auto-installed by the Setup Wizard via `wsl --install --no-distribution` with UAC elevation. A named distribution (`Speedwave`) is created via `wsl --import` for isolation.
- **CLI**: The CLI is a thin client that requires a running Desktop application with completed setup. It does not bundle runtime dependencies.

# ADR-000: Speedwave — Product Principles

> **Status:** Accepted
> **Context:** Shared context for all Architecture Decision Records

---

## Product Principles

| Principle                              | Description                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Zero dependencies beyond Speedwave** | User downloads one file from GitHub Releases. No Docker Desktop, Node.js, or Python required. Speedwave bundles everything. |
| **Cross-platform**                     | Windows and macOS — identical UX                                                                                            |
| **Two usage modes**                    | CLI (like standard Claude Code) or Desktop app (chat UI)                                                                    |
| **Per-project isolation**              | Each project: isolated network, tokens, and containers                                                                      |
| **Easy configuration**                 | Environment variables and settings passed directly to Claude Code                                                           |

These principles govern all architectural decisions in Speedwave. Each ADR should be evaluated against these principles.

### Zero Dependencies — Platform Implementation

The "zero dependencies" principle is fulfilled differently per platform, reflecting each platform's idiomatic dependency management (see ADR-021 for full rationale):

- **macOS**: Lima is bundled inside `.app/Contents/Resources/lima/`. The user does not need `brew install lima` — the application ships with everything required. `LIMA_HOME=~/.speedwave/lima` isolates from any user-installed Lima instance.
- **Windows**: WSL2 is auto-installed by the Setup Wizard via `wsl --install --no-distribution`[^1] with UAC elevation. A named distribution (`Speedwave`) is created via `wsl --import`[^2] for isolation.
- **CLI**: The CLI is a thin client that requires a running Desktop application with completed setup. It does not bundle runtime dependencies.

[^1]: `wsl --install` with the `--no-distribution` option installs WSL without a default Linux distribution: [Basic commands for WSL - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#install).

[^2]: `wsl --import <Distribution Name> <InstallLocation> <FileName>` imports a tar file as a new, independently named distribution: [Basic commands for WSL - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#import-a-distribution).

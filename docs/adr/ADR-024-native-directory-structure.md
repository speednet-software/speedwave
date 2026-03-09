# ADR-024: Native Directory Structure

> **Status:** Accepted

---

## Context

Speedwave's macOS-specific CLI binaries (Reminders, Calendar, Mail, Notes) were originally placed at the repository root as `swift-reminders/`, `swift-calendar/`, `swift-mail/`, and `swift-notes/`. This had two problems:

1. **Root-level clutter** — four directories at the top level for a single platform, alongside `crates/`, `mcp-servers/`, `desktop/`, and other groups.
2. **Language-specific naming** — the `swift-` prefix describes the implementation language, not the purpose. Per ADR-010, Linux and Windows will use Rust binaries for the same OS integration.[^1] A language-neutral grouping is needed.

Other top-level directories in the repository already group by purpose: `crates/` for Rust libraries, `mcp-servers/` for TypeScript MCP servers, `desktop/` for the Tauri app.[^2] The native OS CLI binaries deserve the same treatment.

## Decision

Move all platform-specific native OS CLI binaries under a `native/` directory, organized by platform:

```
native/
├── macos/
│   ├── reminders/    # was swift-reminders/
│   ├── calendar/     # was swift-calendar/
│   ├── mail/         # was swift-mail/
│   └── notes/        # was swift-notes/
├── linux/            # placeholder (future Rust crate, per ADR-010)
└── windows/          # placeholder (future Rust crate, per ADR-010)
```

### Path mapping

| Old path           | New path                  |
| ------------------ | ------------------------- |
| `swift-reminders/` | `native/macos/reminders/` |
| `swift-calendar/`  | `native/macos/calendar/`  |
| `swift-mail/`      | `native/macos/mail/`      |
| `swift-notes/`     | `native/macos/notes/`     |

### Build target rename

The Makefile target `build-swift` is renamed to `build-native-macos` to reflect the platform-centric (not language-centric) grouping. The `build-os-cli` aggregate target continues to work unchanged.

## Consequences

### Positive

- **Scalable structure** — when Linux/Windows native CLI binaries are implemented (ADR-010), they slot into `native/linux/` and `native/windows/` with zero structural changes.
- **Consistent naming** — directory names describe the platform and domain (e.g., `native/macos/reminders`), not the implementation language.
- **Cleaner root** — four root-level directories consolidated into one.

### Negative

- **One-time migration** — all references to `swift-*/` paths in Makefile, `platform-runner.ts`, tests, and `CLAUDE.md` required updating.
- **Deeper nesting** — build artifacts are now at `native/macos/<pkg>/.build/release/` instead of `swift-<pkg>/.build/release/` (one extra directory level).

### Neutral

- `Package.swift` files inside each package use relative paths (`"Sources"`, `"Tests"`) and required no changes.
- `.gitignore` patterns (`.build/`, `.swiftpm/`) match at any depth and required no changes.

---

[^1]: ADR-010: mcp-os as Host Process Per Platform — defines that Linux uses a Rust binary (`native-os-cli`) and Windows uses a Rust binary (`native-os-cli.exe`) for the same OS integration purpose. See `docs/adr/ADR-010-mcp-os-as-host-process-per-platform.md`.

[^2]: Speedwave repository structure overview: [`CLAUDE.md`](../../CLAUDE.md) § Repository Structure.

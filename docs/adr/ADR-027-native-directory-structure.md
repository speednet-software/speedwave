# ADR-027: Native Directory Structure

> **Status:** Accepted
> **Context:** macOS-specific native CLI binaries lived at the repo root as `swift-*/` directories — root clutter plus language-centric naming that did not fit the planned Windows Rust equivalent.

## Decision

Group all platform-specific native OS CLI binaries under a single `native/` directory, organized by platform: `native/macos/` for the Swift binaries and `native/windows/` as a placeholder for the future Rust binary (per ADR-010). The macOS side moved from the old root-level `swift-reminders/`, `swift-calendar/`, `swift-mail/`, `swift-notes/` to `native/macos/reminders/`, `native/macos/calendar/`, `native/macos/mail/`, `native/macos/notes/`. A `native/macos/shared/` Swift library package (`SharedCLI`) holds utilities common to the binaries (error formatting, ISO-8601 date helpers, color parsing, calendar resolution, and an AppleScript runner used only by `mail` and `notes`); each CLI package depends on it by relative path. The corresponding build target was renamed from `build-swift` to `build-native-macos`.

## Why

- **Scalable structure** — Windows native binaries (ADR-010) slot into `native/windows/` with zero structural change; the placeholder README is already there.
- **Consistent naming** — directory names describe platform and domain (`native/macos/reminders`), matching how `crates/`, `mcp-servers/`, and `desktop/` group by purpose rather than implementation language.
- **Cleaner root** — four root-level directories consolidated into one.
- **Shared library** — common Swift utilities live in one package instead of being copied per binary.

## Where it lives in code

- macOS native binaries — `native/macos/` (`reminders/`, `calendar/`, `mail/`, `notes/`, `audio-capture/`, plus the `shared/` `SharedCLI` library). The `audio-capture/` package was added after this ADR (it ships alongside the original four) and is built by the same target.
- Shared Swift library sources — `native/macos/shared/Sources/SharedCLI/` (utilities, date/color helpers, calendar resolution, AppleScript runner).
- Windows placeholder — `native/windows/README.md` (future `native-os-cli.exe` Rust binary, per ADR-010).
- Build target — `build-native-macos` in `Makefile` (compiles every package under `native/macos/`); the `build-os-cli` aggregate depends on it. Swift tests run via `test-swift`.
- Directory-grouping convention — root `CLAUDE.md`.
- Runtime consumer rationale — `docs/adr/ADR-010-mcp-os-as-host-process-per-platform.md` (the `mcp-os` host process calls these binaries).

## Notes

- `Package.swift` files use relative source paths and needed no change; `.gitignore` patterns (`.build/`, `.swiftpm/`) match at any depth.[^1]
- Build artifacts now sit one level deeper, at `native/macos/<pkg>/.build/release/`.[^2]

[^1]: [Git - gitignore Documentation](https://git-scm.com/docs/gitignore) - a pattern with no leading or middle slash matches at any level below the `.gitignore` file's directory.

[^2]: [Swift.org - Building a Server-Side Swift Package](https://www.swift.org/documentation/server/guides/building.html) - Swift Package Manager places build artifacts under `.build/<platform-triple>/<configuration>/` by default.

# Engineering Principles

These principles govern every decision in Speedwave — from architecture to a single function. When in doubt, apply them.

## KISS — Keep It Simple, Stupid

Speedwave is a **thin orchestration layer**, not a reimplementation of Lima, nerdctl, or containerd. Prefer calling the right tool over building a custom solution. A short CLI that shells out to `nerdctl exec` beats a CLI that reimplements container exec from scratch.

- If you're writing more than ~100 lines for something that already exists as a CLI tool — stop and reconsider
- Avoid clever abstractions; prefer obvious code that a new contributor understands in 5 minutes
- `speedwave` binary: starts containers, launches Claude, plus `check`/`init`/`login`/`logout`/`update`/`self-update` and the `plugin` subcommands (`install`/`list`/`remove`/`enable`/`disable`) — nothing more

## YAGNI — You Aren't Gonna Need It

Build only what's on the implementation plan. Do not add features "for future extensibility" unless they're explicitly required now.

- No `speedwave logs`, `speedwave status`, `speedwave stop` as CLI subcommands (Desktop GUI handles these). Exception: `speedwave update` and `speedwave self-update` are available because terminal users need to update without opening the GUI
- No token migration tool (v2 is a fresh install)
- No built-in observability unless a project explicitly configures `OTEL_EXPORTER_OTLP_ENDPOINT`
- When tempted to add a flag/option — ask "does any user need this today?"

## DRY — Don't Repeat Yourself

CLAUDE.md lists every SSOT and SSOT-alignment pair — read it for the full surface. The principles here:

- If the same logic appears in two places — extract it to `speedwave-runtime` (or `mcp-servers/shared/` for MCP code).
- Generated files (e.g. per-project compose) are never hand-edited — change the template + renderer.
- For Anthropic model strings, network/SSRF policy, and any other catalogue/policy with an SSOT in CLAUDE.md: edit the SSOT, do not hard-code the value at the call site.
- SSOT-alignment pairs from CLAUDE.md (e.g. `bundle-build-context.sh` ↔ `build.rs::IMAGES`, `sign-bundled-binaries.sh` ↔ `tauri.macos.conf.json`) must be updated together in the same commit. Asymmetric edits silently break bundling/signing.

## SOLID (applied to this codebase)

- **Single Responsibility** — `ContainerRuntime` only manages containers; `ide_bridge.rs` only handles IDE events; `setup_wizard.rs` only runs setup. Do not mix concerns.
- **Open/Closed** — Adding a new platform = new `impl ContainerRuntime` alongside `LimaRuntime` / `WslRuntime`, zero changes to external callers
- **Liskov Substitution** — `LimaRuntime` (macOS) and `WslRuntime` (Windows) are interchangeable; the public `LockedRuntime` façade wraps `Box<dyn ContainerRuntime>` and callers never see the trait directly
- **Interface Segregation** — `ContainerRuntime` trait has only the methods callers actually need
- **Dependency Inversion** — high-level modules (`speedwave-cli`, `desktop`) depend on the public `LockedRuntime` interface, not on Lima/WSL2 directly. The internal `ContainerRuntime` trait remains `pub(crate)` and is never exposed outside the runtime crate

## Rule of Three

Don't abstract until you see the same pattern three times. One occurrence: inline it. Two: note it. Three: extract it.

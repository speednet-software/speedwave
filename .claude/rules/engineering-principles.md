# Engineering Principles

These principles govern every decision in Speedwave — from architecture to a single function. When in doubt, apply them.

## KISS — Keep It Simple, Stupid

Speedwave is a **thin orchestration layer**, not a reimplementation of Lima, nerdctl, or containerd. Prefer calling the right tool over building a custom solution. A short CLI that shells out to `nerdctl exec` beats a CLI that reimplements container exec from scratch.

- If you're writing more than ~100 lines for something that already exists as a CLI tool — stop and reconsider
- Avoid clever abstractions; prefer obvious code that a new contributor understands in 5 minutes
- `speedwave` binary: starts containers, launches Claude, plus `check`/`update`/`self-update`/`addon install` subcommands — nothing more

## YAGNI — You Aren't Gonna Need It

Build only what's on the implementation plan. Do not add features "for future extensibility" unless they're explicitly required now.

- No `speedwave logs`, `speedwave status`, `speedwave stop` as CLI subcommands (Desktop GUI handles these). Exception: `speedwave update` and `speedwave self-update` are available because terminal users need to update without opening the GUI
- No token migration tool (v2 is a fresh install)
- No built-in observability unless a project explicitly configures `OTEL_EXPORTER_OTLP_ENDPOINT`
- When tempted to add a flag/option — ask "does any user need this today?"

## DRY — Don't Repeat Yourself

- `crates/speedwave-runtime/` is the SSOT for all container logic — CLI and Desktop both import it, zero duplication
- `mcp-servers/shared/` is the SSOT for MCP protocol utilities — all servers use it
- `compose.template.yml` is the SSOT for container definitions — `render_compose()` generates per-project files from it, never hand-edit generated files
- If the same logic appears in two places — extract it to `speedwave-runtime`

## SOLID (applied to this codebase)

- **Single Responsibility** — `ContainerRuntime` only manages containers; `ide_bridge.rs` only handles IDE events; `setup_wizard.rs` only runs setup. Do not mix concerns.
- **Open/Closed** — Adding a new platform = new `impl ContainerRuntime` (e.g., `NerdctlRuntime`), zero changes to existing code
- **Liskov Substitution** — `LimaRuntime`, `NerdctlRuntime`, `WslRuntime` are interchangeable; callers use `Box<dyn ContainerRuntime>` exclusively
- **Interface Segregation** — `ContainerRuntime` trait has only the methods callers actually need
- **Dependency Inversion** — high-level modules (`speedwave-cli`, `desktop`) depend on the `ContainerRuntime` trait, not on Lima/nerdctl/WSL2 directly

## Rule of Three

Don't abstract until you see the same pattern three times. One occurrence: inline it. Two: note it. Three: extract it.

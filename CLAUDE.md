# Speedwave

## Project Goal

Speedwave is an AI platform that connects Claude Code with external services (Slack, SharePoint, GitLab, Redmine, Mail, Calendar) without requiring Docker Desktop. It ships as a single installable application (.dmg on macOS, .exe on Windows, .deb on Linux).

## Product Principles

- **Zero dependencies beyond Speedwave** — user downloads one file from GitHub Releases. No Docker Desktop, no Node.js, no Python. Speedwave bundles everything needed (Lima/WSL2, containerd/nerdctl). Claude Code cannot be bundled (Anthropic All Rights Reserved), so it is installed **inside the Claude container** by `entrypoint.sh` at container start using `curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}"` with a pinned version. The user authenticates with Anthropic directly — Speedwave never handles Anthropic credentials.
- **Cross-platform** — works on Windows, macOS, and Linux with the same UX
- **Two usage modes** — CLI (like standard Claude Code in a terminal) or Desktop app (chat UI) — user chooses
- **Per-project isolation** — each project has its own network, tokens, and containers; projects cannot interfere with each other
- **Easy configuration** — users can configure environment variables and settings that are passed directly to Claude Code

## Two Interfaces

| Interface               | User      | Usage                                 |
| ----------------------- | --------- | ------------------------------------- |
| CLI (`speedwave`)       | Developer | Terminal → interactive Claude Code    |
| Desktop (Speedwave.app) | Anyone    | Chat UI + setup + system integrations |

## Repository Structure

```
speedwave-v2/
├── crates/
│   ├── speedwave-runtime/   # SSOT: ContainerRuntime trait + implementations
│   └── speedwave-cli/       # CLI client (~340 lines + tests)
├── native/
│   ├── macos/               # macOS: Swift CLI binaries (reminders, calendar, mail, notes)
│   ├── linux/               # Linux: Rust native-os-cli (planned)
│   └── windows/             # Windows: Rust native-os-cli (planned)
├── desktop/
│   ├── src-tauri/           # Rust backend (Tauri) — includes IDE Bridge + mcp-os process
│   └── src/                 # Angular frontend
├── mcp-servers/             # TypeScript MCP servers (hub, slack, sharepoint, os, etc.)
│   └── os/                  # mcp-os worker — runs on host, calls native CLI binaries
├── containers/              # OCI Containerfiles, compose.template.yml (nerdctl compose, all platforms)
├── scripts/                 # Build/CI helper scripts (bundle-build-context.sh)
├── docs/
│   └── adr/                 # Architecture Decision Records
├── .lima-version            # SSOT for pinned Lima version
└── CLAUDE.md
```

## Architecture

```
Speedwave.app (host — core of the system)
├── Tauri app (host process)
│   ├── spawns: node mcp-servers/os/dist/index.js  ← mcp-os (TypeScript MCP worker)
│   │   ├── macOS:   native/macos/{reminders,calendar,mail,notes}/*-cli (Swift, EventKit + AppleScript)
│   │   ├── Linux:   native-os-cli (Rust, zbus D-Bus + CalDAV) — planned, not yet implemented
│   │   └── Windows: native-os-cli.exe (Rust, windows-rs WinRT + mapi-rs MAPI) — planned, not yet implemented
│   ├── IDE Bridge (Rust module in src-tauri/)
│   │   ├── Writes ~/.speedwave/ide-bridge/<port>.lock (mounted as ~/.claude/ide/ in container)
│   │   ├── WebSocket MCP server on 127.0.0.1:<port> for Claude (via gateway DNS)
│   │   └── Proxies events → real VS Code / JetBrains extension
│   ├── Chat UI (Angular)
│   │   └── claude -p --output-format=stream-json (subprocess)
│   ├── System Tray (macOS/Windows: click-toggle + menu; Linux: menu-only, requires libappindicator)
│   └── Lima VM (macOS, LIMA_HOME=~/.speedwave/lima) / WSL2 (Windows) / native (Linux) management
└── ~/.local/bin/speedwave → symlink to CLI binary (user-scope, no sudo)

Lima VM / WSL2 / native (security isolation)
└── containers per project (nerdctl)
    ├── speedwave_<project>_claude  (no tokens, no Docker socket)
    ├── speedwave_<project>_mcp_hub (internal port 4000) — ONLY MCP server Claude sees
    │   ├── search_tools → discovers OS tools alongside Slack, GitLab, etc.
    │   ├── execute_code → os.listReminders(), os.createEvent(), etc.
    │   └── HTTP bridge → mcp-os on host via WORKER_OS_URL
    └── speedwave_<project>_mcp_<service> (own tokens only)
```

## Key Principles

### SSOT (Single Source of Truth)

- `crates/speedwave-runtime/` is the SSOT for all Lima/WSL2/nerdctl logic
- CLI and Desktop both import `speedwave-runtime` as a Cargo dependency — zero duplication
- `mcp-servers/` is the SSOT for external service integrations
- `scripts/bundle-build-context.sh` is the SSOT for the list of MCP services bundled into the Desktop app; the `IMAGES` constant in `crates/speedwave-runtime/src/build.rs` must stay aligned for container builds

### ContainerRuntime Trait

All container operations go through a single trait (no Tauri coupling — runtime crate is pure Rust):

```rust
trait ContainerRuntime: Send + Sync {
    fn compose_up(&self, project: &str) -> anyhow::Result<()>;
    fn compose_down(&self, project: &str) -> anyhow::Result<()>;
    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>>;
    fn container_exec(&self, container: &str, cmd: &[&str]) -> Command;
    fn container_exec_piped(&self, container: &str, cmd: &[&str]) -> Command;
    fn is_available(&self) -> bool;
    fn ensure_ready(&self) -> anyhow::Result<()>;
    fn build_image(&self, tag: &str, context_dir: &str, containerfile: &str) -> anyhow::Result<()>;
    fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String>;
    fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String>;
    fn compose_up_recreate(&self, project: &str) -> anyhow::Result<()>;
}
// Implementations: LimaRuntime, NerdctlRuntime, WslRuntime
```

### Per-Project Isolation

Each project has its own network and tokens:

```
~/.speedwave/tokens/<project>/<service>/  # per-worker, read-only mount
speedwave_<project>_network               # isolated container network
```

### IDE Bridge — How It Works

Claude (inside Lima VM) cannot reach VS Code on the host.
Speedwave.app acts as a proxy:

1. Writes `~/.speedwave/ide-bridge/<port>.lock` on the host (mounted as `~/.claude/ide/` in container)
2. Claude connects to the Bridge (believing it is an IDE)
3. Bridge forwards events (openFile, getDiagnostics) to VS Code
4. VS Code opens files automatically as Claude edits them

### Project Context

- CLI: context = working directory (`cd ~/projects/acme && speedwave`)
- Desktop: project switcher, config stored in `~/.speedwave/config.json`

```json
{
  "projects": [{ "name": "acme-corp", "dir": "/Users/user/projects/acme-corp" }],
  "active_project": "acme-corp"
}
```

### User Configuration

Users can configure per-project environment variables and LLM provider:

```json
{
  "projects": [
    {
      "name": "acme-corp",
      "dir": "/Users/user/projects/acme-corp",
      "claude": {
        "env": {
          "ANTHROPIC_MODEL": "claude-opus-4-6",
          "CUSTOM_VAR": "value"
        },
        "llm": {
          "provider": "anthropic"
        }
      }
    }
  ],
  "active_project": "acme-corp"
}
```

Config merges three levels: defaults → repo `.speedwave.json` → user `~/.speedwave/config.json` (highest priority). See ADR-011 for full details.

## Platform Matrix

| OS      | VM              | Containers              | mcp-os                    | Installer       |
| ------- | --------------- | ----------------------- | ------------------------- | --------------- |
| macOS   | Lima + Apple VZ | nerdctl                 | AppleScript / EventKit    | .dmg            |
| Linux   | none (native)   | nerdctl (rootless)      | CalDAV (EDS via zbus)     | .deb            |
| Windows | WSL2 + Hyper-V  | nerdctl (wsl.exe proxy) | WinRT + mapi-rs (Outlook) | .exe (NSIS/MSI) |

### Platform Notes

**macOS:**

- Lima manages the VM using Apple Virtualization Framework (same hypervisor as Docker Desktop 4.15+)
- Lima is bundled inside `.app/Contents/Resources/lima/` with `LIMA_HOME=~/.speedwave/lima` for isolation (see ADR-021)
- IDE lock file: `~/.claude/ide/<port>.lock`

**Linux:**

- nerdctl-full (rootless) is bundled inside the .deb package — no additional system package dependencies for the container runtime
- On first launch, nerdctl-full is extracted to `~/.speedwave/nerdctl-full/` and containerd starts as a systemd --user service
- System requirements: uidmap, systemd --user, /etc/subuid + /etc/subgid
- Optional: `libappindicator3-1` or `libayatana-appindicator3-1` for system tray icon support (app works without it — falls back to a regular visible window)
- mcp-os: no EventKit equivalent; CalDAV (RFC 4791) is the cross-DE standard; `zbus` crate for GNOME EDS access
- IDE lock file: `~/.claude/ide/<port>.lock`

**Windows:**

- `wsl.exe -d Speedwave -- nerdctl ...` called from Tauri/Rust
- `windows-rs` (Microsoft-maintained) for WinRT API access
- `mapi-rs` (Microsoft-maintained) for Outlook mail/calendar
- Setup Wizard auto-installs WSL2, imports Ubuntu rootfs, and sets up nerdctl-full
- IDE lock file: `%USERPROFILE%\.claude\ide\<port>.lock`

## Security

**Security is a core obsession, not an afterthought.** Every architectural decision must preserve or improve the security model established in Speedwave v1. When in doubt, choose the more secure option.

### Security principles inherited from v1 (non-negotiable)

- Claude container: no tokens, no container socket, unprivileged user `speedwave`
- OWASP container hardening: `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, `tmpfs: /tmp:noexec,nosuid`
- Token isolation: each MCP worker mounts **only its own** service credentials at `/tokens` read-only — a compromised worker exposes only that service. Exception: SharePoint uses `:rw` for OAuth token refresh (see ADR-009)
- Hub has zero tokens — compromise of the hub exposes nothing
- Lima VM / WSL2: kernel-level isolation layer on top of container isolation
- Resource limits per container (CPU + memory caps)
- SHA256-verified binary downloads in Containerfile
- Health endpoints return only `{ "status": "ok" }` — no service metadata leaked

### When implementing any feature, ask:

- Does this require relaxing any of the above? If yes — find a different approach.
- Does this add a new attack surface? Document it and mitigate it.
- Does this require mounting host filesystem into a container? Minimize scope, use `:ro` wherever possible.

## Logging

All Rust code uses the `log` crate facade for diagnostic output. **Never use `eprintln!` or `println!` for logging** — the only acceptable use of `eprintln!` is for direct user-facing CLI output (e.g., "speedwave check FAILED") and the panic hook's last-resort fallback.

### Architecture

| Binary                        | Backend                                         | Config                                     |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Desktop (`speedwave-desktop`) | `tauri-plugin-log` v2 (file + stdout + webview) | Initialized in `main.rs` `.plugin()` chain |
| CLI (`speedwave`)             | `env_logger` (stderr, respects `RUST_LOG`)      | Initialized at CLI `main()` start          |
| Library (`speedwave-runtime`) | `log` crate facade only (no backend opinion)    | Callers provide the backend                |

- **SSOT for secret redaction:** `crates/speedwave-runtime/src/log_sanitizer.rs` — all log output passes through `sanitize()` via `.format()` callbacks in both Desktop and CLI loggers. Secrets never reach disk or stdout.
- **Desktop log files:** `~/Library/Logs/pl.speedwave.desktop/` (macOS), `~/.local/share/pl.speedwave.desktop/logs/` (Linux). Rotation: 50 MB per file, `KeepAll`, cleanup to 10 files on startup.
- **CLI:** `RUST_LOG=debug speedwave check` enables debug output on stderr.

### Rules for writing log statements

- **Level selection:** `error!` for failures preventing operation, `warn!` for degraded/fallback conditions, `info!` for significant lifecycle events, `debug!` for diagnostic details, `trace!` for verbose internals.
- **No prefixes in log messages** — the log format `[{level}][{target}]` already provides context. Do not add `"[tauri] update:"` or `"IDE Bridge:"` prefixes. Exception: when logging from a module that handles multiple subsystems (e.g., `main.rs` tray handlers), a short prefix like `"tray:"` is acceptable for disambiguation.
- **Never log secrets.** Do not log tokens, passwords, API keys, HTTP Authorization headers, request/response bodies, or PEM keys. The `log_sanitizer` is a safety net, not a license to log secrets. When logging errors that might contain credentials, redact explicitly.
- **Structs containing secrets must not derive `Debug`** — implement a manual `Debug` that redacts sensitive fields, or wrap secret fields in a newtype with a redacting `Debug` impl.
- **Container/external logs** returned to the frontend (e.g., `get_container_logs`) must pass through `sanitize()` before being sent to the webview.

### Adding new sanitizer rules

When adding a new secret pattern to `log_sanitizer.rs`:

1. Add the regex + replacement to the `RULES` `LazyLock` initialization
2. Add at least one positive test (secret is redacted) and one false-positive test (normal text is unchanged)
3. Run `make test` — all sanitizer tests are in `crates/speedwave-runtime/src/log_sanitizer.rs`

## Commands

**Use `Makefile` for all build/test/check operations.** Do not call cargo/npm directly — the Makefile ensures correct working directories and consistent flags.

```bash
make setup-dev      # first-time: check prerequisites + install all dependencies
make test           # run all tests (Rust + MCP)
make check          # lint + clippy + type-check + format
make check-all      # full quality gate: check + test + coverage + audit
make coverage-html  # generate HTML coverage reports and open in browser
make audit          # check dependencies for known vulnerabilities
make dev            # start desktop in dev mode (Tauri + Angular hot reload)
make build          # build everything
make fmt            # format all code
make status         # quick health check
```

Granular targets: `make test-rust`, `make test-cli`, `make test-mcp`, `make test-os`, `make test-e2e`, `make test-desktop-build`, `make build-runtime`, `make build-cli`, `make build-native-macos`, `make build-os-cli`, `make build-mcp`, `make build-angular`, `make build-tauri`, `make download-lima`, `make check-clippy`, `make check-angular`, `make audit-rust`, `make audit-mcp`, `make coverage-rust`, `make coverage-mcp`.

## Engineering Principles

These principles govern every decision in Speedwave — from architecture to a single function. When in doubt, apply them.

### KISS — Keep It Simple, Stupid

Speedwave is a **thin orchestration layer**, not a reimplementation of Lima, nerdctl, or containerd. Prefer calling the right tool over building a custom solution. A short CLI that shells out to `nerdctl exec` beats a CLI that reimplements container exec from scratch.

- If you're writing more than ~100 lines for something that already exists as a CLI tool — stop and reconsider
- Avoid clever abstractions; prefer obvious code that a new contributor understands in 5 minutes
- `speedwave` binary: starts containers, launches Claude, plus `check`/`update`/`self-update`/`addon install` subcommands — that's it

### YAGNI — You Aren't Gonna Need It

Build only what's on the implementation plan. Do not add features "for future extensibility" unless they're explicitly required now.

- No `speedwave logs`, `speedwave status`, `speedwave stop` as CLI subcommands (Desktop GUI handles these). Exception: `speedwave update` and `speedwave self-update` are available because terminal users need to update without opening the GUI
- No token migration tool (v2 is a fresh install)
- No built-in observability unless a project explicitly configures `OTEL_EXPORTER_OTLP_ENDPOINT`
- When tempted to add a flag/option — ask "does any user need this today?"

### DRY — Don't Repeat Yourself

- `crates/speedwave-runtime/` is the SSOT for all container logic — CLI and Desktop both import it, zero duplication
- `mcp-servers/shared/` is the SSOT for MCP protocol utilities — all servers use it
- `compose.template.yml` is the SSOT for container definitions — `render_compose()` generates per-project files from it, never hand-edit generated files
- If the same logic appears in two places — extract it to `speedwave-runtime`

### SOLID (applied to this codebase)

- **Single Responsibility** — `ContainerRuntime` only manages containers; `ide_bridge.rs` only handles IDE events; `setup_wizard.rs` only runs setup. Do not mix concerns.
- **Open/Closed** — Adding a new platform = new `impl ContainerRuntime` (e.g., `NerdctlRuntime`), zero changes to existing code
- **Liskov Substitution** — `LimaRuntime`, `NerdctlRuntime`, `WslRuntime` are interchangeable; callers use `Box<dyn ContainerRuntime>` exclusively
- **Interface Segregation** — `ContainerRuntime` trait has only the methods callers actually need (see trait definition above)
- **Dependency Inversion** — high-level modules (`speedwave-cli`, `desktop`) depend on the `ContainerRuntime` trait, not on Lima/nerdctl/WSL2 directly

### Rule of Three

Don't abstract until you see the same pattern three times. One occurrence: inline it. Two: note it. Three: extract it.

---

## Technical Documentation

**Every feature, architectural change, and public API must be documented.** Documentation is not optional — it is a delivery requirement, same as tests.

### Documentation Structure

```
docs/
├── README.md                  ← entry point, table of contents
├── getting-started/           ← quickstart, installation, configuration
├── guides/                    ← CLI, desktop, integrations, IDE bridge
├── architecture/              ← overview, security, containers, platform matrix
├── contributing/              ← dev setup, testing
└── adr/                       ← Architecture Decision Records
```

### Rules

- **New feature → update relevant guide.** If you add a CLI subcommand, update `docs/guides/cli.md`. If you add an integration, update `docs/guides/integrations.md`. If you change the security model, update `docs/architecture/security.md`.
- **Architectural decision → write an ADR.** Any decision that affects the system's structure, security model, or platform behavior requires a new ADR in `docs/adr/` following the `ADR-NNN-kebab-case-title.md` naming convention. Update `docs/adr/README.md` index table.
- **New docs section → link from `docs/README.md`.** Every new file must be reachable from the docs entry point.
- **No orphan docs.** Every Markdown file in `docs/` must be linked from at least one other file.
- **Keep skeletons honest.** Placeholder sections use `<!-- Content to be written: ... -->` HTML comments. When implementing a feature that fills a placeholder — replace it with real content in the same PR.

## ADR Writing Standards

Every factual claim in `docs/adr/` **must** have a footnote with a URL that confirms it. No exceptions.

- Technical specs, version numbers, license types, API behavior, platform requirements — all require a source link
- Use numbered footnotes `[^N]` at the end of each document
- If you cannot find a source, do not state the fact as certain — flag it as unverified
- The goal: anyone reading the ADR can independently verify every claim

## Git Workflow

```bash
git add <files>
git commit -m "..."
git push
```

**Pull requests always target `dev`** — never open a PR directly to `main`. The `main` branch is updated only via release merges from `dev`.

**When merging `dev` → `main`, always use squash merge** in the GitHub UI. The PR title must be a conventional commit (e.g. `feat(runtime): add logging and diagnostics`). Regular merge commits are invisible to release-please — it cannot parse conventional commits inside them. See [RELEASING.md](RELEASING.md#why-squash-merge-matters) for details.

### Critical Rules

#### Git Hooks

**NEVER bypass git hooks.** This includes ALL of the following techniques — they are ALL equally forbidden:

- `--no-verify` flag on commit or push
- `core.hooksPath=/dev/null` or pointing `core.hooksPath` to an empty/fake directory
- `HUSKY=0` or any environment variable that disables hooks
- Temporarily renaming, moving, or deleting `.husky/` or `.git/hooks/`
- Any other creative workaround that results in hooks not executing

Git hooks exist to catch problems early. If a hook fails, **fix the underlying issue** (e.g. missing tool in PATH, failing test, lint error). If you cannot fix it, **stop and ask the user** — never silently bypass the hook. There are zero exceptions to this rule.

#### Tests

**Every piece of code must be covered by tests.** All functions, methods, branches, and error paths must have corresponding test cases. When writing or modifying code, always write or update tests in the same commit. Never leave code untested — if it's worth writing, it's worth testing.

**NEVER skip tests to work around failures.**

- Do not use `.skip`, `xit`, `xdescribe`, or rename files to `.skip`
- Do not remove or move test files to bypass failing tests
- If a test fails — fix the code or fix the test, never skip it
- Skipping tests masks real problems and leads to regressions
- If a test is for an unimplemented feature — implement the feature or remove the test (no skip!)

#### Boy Scout Rule

**Always leave the code in a better state than you found it.**

- If you encounter a bug, typo, inconsistency, or problem in code — fix it immediately
- This applies to: logic errors, wrong types, missing validations, inconsistent names, dead code
- Small fixes "along the way" prevent accumulation of technical debt
- If the fix is too large for the current scope — report it to the user, but never ignore it

#### Branch Protection & CI

**NEVER bypass branch protection or CI requirements.** This includes ALL of the following — they are ALL equally forbidden:

- `gh pr merge --admin` to bypass failing status checks
- Merging with `--admin` flag for any reason
- Disabling or weakening branch protection rules to unblock a merge
- Marking failing checks as "expected to fail" without fixing them
- Any other creative workaround that results in unverified code reaching `main`

If CI fails — **fix the CI**, even if the failure is pre-existing or unrelated to your PR. If you cannot fix it, **stop and ask the user**. There are zero exceptions to this rule.

#### General

- Never leave `@deprecated` comments in code — rewrite the code instead of adding comments
- Never leave `TODO`, `FIXME`, `HACK`, `XXX`, or similar marker comments in code — either implement the fix now or report it to the user. Marker comments rot and become invisible tech debt.
- Link commits to GitHub issues when they exist

## Implementation Phases

1. **ContainerRuntime trait** — `crates/speedwave-runtime/`
2. **IDE Bridge** — `desktop/src-tauri/src/ide_bridge.rs`
3. **Chat UI** — `claude -p` subprocess + Angular streaming component
4. **CLI thin client** — `crates/speedwave-cli/`
5. **Native OS CLI + mcp-os worker** — `native/macos/`, `mcp-servers/os/`, hub integration
6. **Installer** — platform installers (.dmg, .exe, .deb)

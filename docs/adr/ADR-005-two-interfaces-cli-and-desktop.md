# ADR-005: Two Interfaces — CLI and Desktop

## Decision

Speedwave ships two separate interfaces that share a single `speedwave-runtime` library.

## Rationale

**CLI** — for developers:

```bash
cd ~/projects/acme-corp
speedwave  # → Lima VM + containers + Claude Code in terminal
```

Project context = working directory. Zero configuration. Identical UX to today.

**Desktop (Speedwave.app)** — for everyone:

- Chat UI (like vibe-kanban[^16]) via `claude -p --output-format=stream-json`[^17]
- Setup wizard for tokens and project configuration
- Project switcher (list of projects in `~/.speedwave/config.json`)
- Native OS integrations (Reminders, Calendar, Mail, Notes)

## SSOT — Zero Duplication

```
crates/
├── speedwave-runtime/  ← SSOT: all Lima/nerdctl/WSL2 logic
└── speedwave-cli/      ← CLI client
desktop/
└── src-tauri/          ← Tauri app (Rust backend)
```

Both clients import `speedwave-runtime` as a Cargo dependency. No logic is duplicated.

## CLI = Thin Client (Bundled in Desktop)

The CLI (`speedwave`) is a thin client that **requires a running Desktop application with completed setup**. The CLI does not bundle runtime dependencies (Lima, nerdctl, WSL2) — it connects to the already-provisioned environment managed by the Desktop app. The Desktop's Setup Wizard handles all first-time provisioning (VM creation, image building, token configuration). See ADR-021 for the full rationale.

The CLI binary is bundled inside the Desktop app and copied to the user's PATH on every startup. This guarantees version alignment between CLI and Desktop — a Desktop update automatically distributes the matching CLI version. See ADR-016 for cross-platform PATH details.

## CLI Scope

The CLI binary (`speedwave`) is a lightweight client — all container orchestration logic lives in `speedwave-runtime`. The CLI itself handles argument parsing, project resolution, self-update via GitHub Releases, addon installation, and the security pre-flight check. Core logic is ~340 lines of Rust (plus ~200 lines of tests).

Subcommands:

| Command                         | Description                           |
| ------------------------------- | ------------------------------------- |
| `speedwave`                     | Start containers + interactive Claude |
| `speedwave check`               | Validate security invariants          |
| `speedwave update`              | Rebuild images + recreate containers  |
| `speedwave self-update`         | Download latest CLI from GitHub       |
| `speedwave addon install <zip>` | Install an addon package              |

## ContainerRuntime Trait

All container operations go through a single trait (no Tauri coupling — runtime crate is pure Rust):

```rust
pub trait ContainerRuntime: Send + Sync {
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

---

[^16]: [vibe-kanban - Claude Code GUI integration](https://github.com/BloopAI/vibe-kanban)

[^17]: [Claude Code CLI reference - --output-format](https://code.claude.com/docs/en/cli-reference)

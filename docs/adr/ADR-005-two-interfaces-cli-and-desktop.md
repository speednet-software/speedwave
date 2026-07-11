# ADR-005: Two Interfaces — CLI and Desktop

> **Status:** Accepted
> **Context:** Speedwave needs to serve both terminal-first developers and chat-first users without duplicating any container-orchestration logic.

## Decision

Speedwave ships two separate front-ends — a terminal CLI (`speedwave`) and a Desktop chat app (`Speedwave.app`) — that both depend on the single `speedwave-runtime` library crate. All Lima/WSL2/nerdctl orchestration lives in the runtime; neither front-end reimplements it.

## Why

- One SSOT for orchestration: the runtime crate is pure Rust with no Tauri coupling, so both clients link it as a Cargo dependency and share identical behaviour (see CLAUDE.md "Key Architecture").
- CLI suits developers who want to launch containers and Claude Code from a terminal for the active project; Desktop gives everyone a chat UI, a setup wizard, a project switcher, and native OS integrations.
- The CLI is a thin client: it requires a Desktop install that has completed setup (VM creation, image building, token configuration). It does not bundle Lima/WSL2/nerdctl. See ADR-021 for the zero-install rationale.
- The CLI binary is bundled inside the Desktop app and copied to the user's PATH on each startup, guaranteeing CLI/Desktop version alignment. See ADR-016 for cross-platform PATH handling.

## How project context is resolved

The CLI bare-run form (and `update`/`login`/`logout`) targets the active project recorded in `~/.speedwave/config.json` (the Desktop project switcher's `active_project`), overridable with `--project <name>`. The working directory is not consulted. The precedence rules live in the CLI guide's [Project Resolution](../guides/cli.md#project-resolution) section.

## CLI scope and subcommands

The CLI handles argument parsing, project resolution, self-update via GitHub Releases, the plugin sub-surface, and the security pre-flight check — everything else is delegated to the runtime. The subcommand surface (see `CliAction` / `parse_action` in `crates/speedwave-cli/src/main.rs`) is: bare run (start containers + interactive Claude), `check`, `init`, `login`, `logout`, `update`, `self-update`, and the `plugin` group (`install`, `list`, `remove`, `enable`, `disable`). The file is sizeable — production and test code are each on the order of several hundred lines, so do not rely on a fixed line count here.

## Where it lives in code

- CLI client and subcommand parser — `crates/speedwave-cli/src/main.rs` (`CliAction`, `parse_action`)
- Orchestration SSOT — `crates/speedwave-runtime/`
- Desktop Tauri backend — `desktop/src-tauri/`
- Public runtime façade `LockedRuntime` and the `detect_runtime()` entry point — `crates/speedwave-runtime/src/runtime/locked.rs` and `crates/speedwave-runtime/src/runtime/mod.rs`

## ContainerRuntime trait (crate-internal)

All container operations go through the `ContainerRuntime` trait in `crates/speedwave-runtime/src/runtime/mod.rs`. The trait is `pub(crate)`, not public: no code outside `speedwave-runtime` may name or implement it. The public handle is `LockedRuntime`, which enforces the per-project compose transaction lock (see ADR-066). The trait has roughly two dozen methods — including `compose_up`, `compose_down`, `compose_ps`, `compose_validate`, `compose_up_recreate`, `container_exec`, `container_exec_piped` (which returns `anyhow::Result<Command>` so the impl can check preconditions such as the Lima VM running before building the command), `is_available`, `is_installed`, `ensure_ready`, `build_image`, `prepare_build_context`, `image_exists`, `container_logs`, `compose_logs`, the prune family (`system_prune`, `remove_images`, `prune_buildkit_cache`, `prune_unused_images`), `restart_container_engine`, `stop_vm`, `reset_vm`, and `vm_exec`. The two production implementations are `LimaRuntime` (macOS) and `WslRuntime` (Windows); Linux as a host platform was dropped (ADR-059).

## Rejected alternatives

- A single combined binary doing both CLI and chat: rejected because the Desktop app needs Tauri/GUI dependencies the terminal client should stay free of, and the split keeps the runtime crate Tauri-agnostic.
- Letting either front-end reimplement orchestration: rejected as a DRY violation — the runtime crate is the single source of truth.

---

The Desktop chat UI follows the same approach as the vibe-kanban Claude Code GUI integration[^1], driving Claude Code via `claude -p --output-format=stream-json`[^2].

[^1]: https://github.com/BloopAI/vibe-kanban - kanban-board tool that drives Claude Code (and other coding agents) in isolated workspaces.

[^2]: https://code.claude.com/docs/en/cli-reference - documents `--print`/`-p` (print mode) and `--output-format` with the `stream-json` option.

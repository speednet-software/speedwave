# Architecture

System map: which module owns what. Paths here are pointers to the SSOT — when this file disagrees with the code, trust the code and fix this file.

## Core layout

- **`crates/speedwave-runtime/`** — SSOT for all Lima/WSL2/nerdctl logic; CLI (`crates/speedwave-cli/`) and Desktop (`desktop/src-tauri/`) import it as a Cargo dependency. Pure Rust — no Tauri coupling. Same logic needed in two places = extract here (Rust) or to `mcp-servers/shared/` (MCP TypeScript).
- **Runtime handle:** `detect_runtime() -> LockedRuntime` is the only public entry point; it wraps the crate-internal `trait ContainerRuntime` (`LimaRuntime`/`WslRuntime`) and enforces a per-project compose transaction lock — wrap multi-step compose sequences in `rt.transaction(project, |rt| {...})`. Tests mock via `runtime::mock_runtime::MockRuntimeBuilder` (`test-support` feature). Encapsulation is test-guarded (`tests/ssot_enforcement.rs`).
- **Compose:** `containers/compose.template.yml` (container-definitions SSOT) is rendered by `compose/mod.rs::render_compose()` into per-project files — never hand-edit generated compose, never put resource/image literals in the template. Renderer modules: `compose/{mod, addressing, llm, plugins, proxy, quoting, security_check, tokens, workers}`. Every rendered compose passes `SecurityCheck::run()` before `up` on every start path (CLI, Desktop, update, rollback) — see security rules.
- **MCP Hub** (`mcp-hub:4000`) — the only MCP server Claude sees. Zero external service credentials (render-time gate); it mounts only Speedwave-internal bridge bearer tokens (`/secrets/<service>-auth-token:ro`) used to call host-side bridges.
- **Proxy** (`proxy:4000`) — per-project LLM forwarder; Claude routes `/v1/messages` to it via `ANTHROPIC_BASE_URL`. Relays native Anthropic verbatim, holds no Anthropic credential; provider keys mount `/tokens:ro`; sole appender of the usage JSONL (host code only rotates it). Source `containers/proxy/` is its own Cargo workspace: bump its `Cargo.toml` + `Cargo.lock` together, build `--locked`, test with `make test-proxy`.
- **Workers:** one container per integration on the isolated per-project network `speedwave_<project>_network`; each mounts only its own credentials `~/.speedwave/tokens/<project>/<service>/` at `/tokens:ro` (slack and sharepoint additionally mount `/workspace:rw` — the sanctioned file-exchange profile, see security rules). Native OS integrations (mail/calendar/reminders/notes) run through the host-side `mcp-os` worker.
- **Host-side worker processes** (oauth, mcp-os, plugin bridges) have exactly one supervisor: the Desktop app. The CLI never spawns, respawns, or kills them — it reads their lock/token state from disk. Details: host-workers rules.
- **Config merge:** defaults → repo `.speedwave.json` → user `~/.speedwave/config.json` (highest priority). Repo config is a restricted subset: it must never gain `provider`/`base_url`-class fields or the beta flag — a malicious cloned repo must not redirect traffic or widen surface (deny-predicate test-guarded).

## Claude Code in the container

- The binary is baked into the claude image at build time (`Containerfile.claude` runs the official installer with the `CLAUDE_VERSION` build-arg, SHA256-verified against a version-pinned manifest); `entrypoint.sh` installs at container start only as a fallback when the binary is missing, and otherwise warns on image↔pin version skew (fix = image rebuild, not auto-repair). It cannot be bundled into the .dmg/.exe (Anthropic All Rights Reserved) — the image builds on the user's machine.
- Version pin SSOT: `defaults.rs::CLAUDE_VERSION` (concrete semver, never `latest`). Bumping Claude Code = editing that one const; build args are hashed into the image tag, so the bump retags and rebuilds.
- Stopping a chat session must kill the in-container claude process, not just the host `nerdctl exec` wrapper (SIGKILL does not propagate into the container): every spawn is tagged `SPW_SESSION_INSTANCE_ID` (`session/instance.rs`) and reaped via /proc-environ match. Never bypass the marker kill — leaked processes share stdin and corrupt resumed sessions.
- Pasted images are never sent inline (base64 OOM-killed the in-container parser): bytes land in `<project>/.speedwave/pastes/` and are referenced as `@…` text. That dir has two writers — Desktop chat and the CLI clipboard `paste_watcher` — change the contract in both.

## Updates & rollback (`update.rs`)

`save_snapshot` pins per-project compose + plugin manifests before an update. The update path always re-renders compose from the current config — never reuse a stale snapshot (a pre-proxy snapshot strands users off the Anthropic path). Failures past `compose_down` carry `ContainersTornDown` and trigger `rollback_containers`, which forward-fixes via `choose_rollback_compose` when the snapshot fails a SecurityCheck invariant added after it was saved (fresh render wins; a dirty fresh render still hard-aborts). Adding a render-time invariant or renaming a compose service = think about snapshots rendered by older app versions.

## Transcription

Host-side Whisper STT in `crates/speedwave-runtime/src/transcription/`, behind the `audio-transcription` cargo feature (Desktop enables it; the CLI never does). One model, auto-selected from compile-time backends (`accel.rs`) — no user model picker. No speaker diarization — deliberately removed as inherently unreliable; do not reintroduce it or swap in another diarization engine.

## Other surfaces

- **Plugins** live in the sibling repo `speedwave-plugins`; everything they touch in this repo is a public contract — read plugins rules before changing any contract surface.
- **IDE Bridge:** host `~/.speedwave/ide-bridge/<port>.lock` ↔ container `~/.claude/ide/:ro`.
- **Per-integration claude-resources:** `containers/claude-resources/<type>/integrations/<config_key>/` (skills/commands/agents/hooks) symlinked by `entrypoint.sh` only when the key is enabled; links tracked in `~/.claude/.speedwave-managed-links`. Adding a resource for an existing integration = creating the directory only — no Rust/compose change (dir-name↔`config_key` match is test-guarded). Resources sync-copy to the data dir at start — editing a skill in the repo does not reach a running container without sync/restart.

# Speedwave

Security-first AI platform connecting Claude Code with external services (Slack, SharePoint, GitLab, GitHub, Atlassian, Redmine, Context7 docs, Playwright browser; native Mail, Calendar, Reminders, Notes) plus a built-in Office documents worker (Word/Excel/PowerPoint/PDF) and host-side meeting transcription (Whisper). Claude runs in a hardened, token-free container — every service credential is isolated in its own worker. VM-level isolation: Lima on macOS, WSL2 on Windows — the only supported host platforms (Linux hosts were deliberately dropped; do not re-add). Ships as a single installable app (.dmg, .exe) without Docker Desktop. Two interfaces: CLI (terminal) and Desktop (Tauri chat UI).

Every change must work on **both macOS and Windows** — see `.claude/rules/cross-platform.md` for the pitfall list.

## Architecture

- **`crates/speedwave-runtime/`** — SSOT for all Lima/WSL2/nerdctl logic; CLI and Desktop import it as a Cargo dependency. Same logic in two places = extract it here (or to `mcp-servers/shared/` for MCP TypeScript).
- **Runtime handle:** `detect_runtime() -> LockedRuntime` is the only public entry point. It wraps the crate-internal `trait ContainerRuntime` (`LimaRuntime`/`WslRuntime`) and enforces a per-project compose transaction lock — wrap multi-step compose sequences in `rt.transaction(project, |rt| {...})`. Tests mock via `runtime::mock_runtime::MockRuntimeBuilder` (`test-support` feature).
- **Compose:** `containers/compose.template.yml` (container definitions SSOT) is rendered by `compose/mod.rs::render_compose()` into per-project files — never hand-edit generated compose, never put resource/image literals in the template. The renderer lives in the `compose/` module: `mod, addressing, llm, plugins, proxy, quoting, security_check, tokens, workers`.
- **MCP Hub** (`mcp-hub:4000`) — the only MCP server Claude sees. It holds zero external service credentials (render-time gate: `security_check::check_no_tokens_in_hub`); it mounts only Speedwave-internal bearer tokens (`/secrets/<service>-auth-token:ro`) used to call host-side bridges.
- **Proxy** (`proxy:4000`) — per-project LLM forwarder; Claude routes `/v1/messages` to it via `ANTHROPIC_BASE_URL`. Relays native Anthropic verbatim, holds no Anthropic credential (passthrough); provider keys mount `/tokens:ro`; sole writer of the usage JSONL. Source: `containers/proxy/` — its own Cargo workspace: bump its `Cargo.toml` + `Cargo.lock` together, build `--locked`, test with `make test-proxy`.
- **Workers:** one container per integration; each mounts only its own credentials `~/.speedwave/tokens/<project>/<service>/` at `/tokens:ro`; isolated per-project network `speedwave_<project>_network`. Native OS integrations (mail/calendar/reminders/notes) run through the host-side `mcp-os` worker.
- **Host-side worker processes (oauth, mcp-os, plugin bridges) have exactly one supervisor: the Desktop app.** The CLI never spawns, respawns, or kills them — it reads their lock/token state from disk. A second supervisor creates a mutual kill cycle surfacing as exit 137; and exit 137 ≠ OOM (`is_oom_exit` is signature-only — never assert OOM from 137 alone). Details: `.claude/rules/host-workers.md`.
- **Config merge:** defaults → repo `.speedwave.json` → user `~/.speedwave/config.json` (highest priority). Repo config is a restricted subset: it must never gain `provider`/`base_url`-class fields or the beta flag — a malicious cloned repo must not redirect traffic or widen surface.
- **Claude Code** is installed inside the container by `entrypoint.sh` at start (Anthropic All Rights Reserved — cannot be bundled). Version pin SSOT: `defaults.rs::CLAUDE_VERSION` (concrete semver, never `latest`); bumping Claude Code = editing that one const.
- **Transcription:** host-side Whisper STT in `crates/speedwave-runtime/src/transcription/`, behind the `audio-transcription` cargo feature (Desktop enables it; the CLI never does). No speaker diarization — it was deliberately removed as inherently unreliable; do not reintroduce it or swap in another diarization engine.
- **Plugins** live in the sibling repo `speedwave-plugins`; everything they touch in this repo is a public contract. Full contract + rules: `.claude/rules/plugins.md`. In-repo tests pin schema shape only, never real-plugin compatibility — check the sibling repo before changing any contract surface.
- **IDE Bridge:** host `~/.speedwave/ide-bridge/<port>.lock` ↔ container `~/.claude/ide/:ro`.
- **Per-integration claude-resources:** `containers/claude-resources/<type>/integrations/<config_key>/` (skills/commands/agents/hooks) symlinked by `entrypoint.sh` only when the key is in `ENABLED_SERVICES`; links tracked in `~/.claude/.speedwave-managed-links`. Adding a resource for an existing integration = creating the directory only — no Rust/compose change.

## SSOT registry — edit the SSOT, never a call-site copy

- `defaults.rs::ANTHROPIC_MODELS` — Anthropic model catalog (id, family, context window, latest flag); frontend reads it via `list_anthropic_models` + `AnthropicModelsService`. Never hard-code model strings.
- `resources.rs` — every container mem/CPU/tmpfs/shm number + Lima VM sizing (`host/2` clamped; macOS-only — WSL2 memory is deliberately unmanaged). Always-on containers: `CLAUDE_RESOURCES` (fixed 6 GiB) / `HUB_RESOURCES` / `PROXY_RESOURCES`; per-worker limits on `consts::McpServiceDescriptor.resources`; plugin envelope in `consts.rs` (`PLUGIN_*`). Limits are ceilings, not reservations — overcommit is OK.
- `usage.rs` + `usage_cost.rs` — final tokens + cost for the dashboard (`get_llm_usage`), chat footer (`get_usage_for_response`/`get_conversation_cost`), CLI statusline. Proxy usage JSONL + host-side cost sidecar keyed by `response_id`. Cost enrichment never rewrites the usage JSONL; unpriced stays `null`, never `0.0`; never sum Claude Code's `total_cost_usd` with proxy cost.
- `log_ts.rs::log_timestamp()` / mcp-shared `ts()` — the one log timestamp format (RFC 3339, millis, local offset with colon). Never `toISOString()` for a log-line prefix.
- `diagnostic_sources.rs::DIAGNOSTIC_SOURCES` — every diagnostic file shown in the /logs UI and packed into the diagnostics ZIP. New log file = new registry entry (non-`displayable` = ZIP-only), never a hand-wired path.
- `engine_path.rs` — all host→engine path handling (`to_engine_path`/`str_to_engine_path`/`vm_path_join`, `strip_extended_length_prefix`).
- `compose/addressing.rs` — `host_bind_address()`/`host_gateway_ip()`: every host TCP listener bind and every container→host gateway IP.
- `url_validation.rs` — the shared SSRF validator (+ `PrivatePolicy`); Desktop re-exports it. One validator — never a second regex or copied constants.
- `build.rs::IMAGES` + `ImageDef.hash_inputs` — image catalog and what rebuilds each image. Tags are content-addressed `name:<16-hex>`; a changed image must get a new tag (compose won't recreate a container under an unchanged tag). Every file a Containerfile COPYs must be in that image's `hash_inputs`; do NOT over-declare — that is not test-caught and forces spurious rebuilds. Images build lazily per enabled integration, never the full catalog. Details: `.claude/rules/images-builds.md`.
- `fs_perms.rs` — owner-only permissions (Unix chmod ↔ Windows DACL) and durable fsync-before-rename writes. `binary::system_command` — the only way to spawn system processes.
- `consts.rs` — ports, names, literals: `HOST_GATEWAY_ALIAS`, `DATA_DIR`, WSL distro name derivation, nerdctl pin, OAuth constants, `RESERVED_ENV_KEYS`, service descriptors (`TOGGLEABLE_MCP_SERVICES`/`TOGGLEABLE_OS_SERVICES`, `BUILT_IN_SERVICE_IDS`).

## Test-guarded alignments — the failing test names the fix; trust it, never bypass it

- Resource tables ↔ compose template placeholders — `compose::tests::resources_render_from_ssot`.
- `HOST_GATEWAY_ALIAS` ↔ `mcp-servers/shared/src/security.ts` ↔ template `extra_hosts` (static on `claude`, `proxy`, `mcp-playwright`) — `host_gateway_alias_matches_mcp_shared_ts`, `host_gateway_alias_appears_in_compose_template`, `compose_template_extra_hosts_contains_only_canonical_alias`.
- No hardcoded loopback binds — drift detector `tests/no_hardcoded_loopback_bind.rs`; no raw engine paths — `tests/no_raw_engine_path.rs` (escape hatch for both: `// SSOT-allow: <reason>`).
- `LockedRuntime` encapsulation (trait stays `pub(crate)`, no lock re-exports) — `tests/ssot_enforcement.rs`.
- `consts::SLACK_OAUTH_TOKEN_URL` ↔ oauth worker `providers/slack.ts` — `slack_token_url_matches_oauth_worker_provider_ts`.
- Plugin slug regex Rust ↔ oauth worker TS — `plugin_slug_pattern_matches_oauth_state_ts`; auth field types Rust ↔ TS — `allowed_auth_field_types_match_ts_union`.
- `build.rs::IMAGES` ↔ `scripts/bundle-build-context.{sh,ps1}` — `bundle_build_context_sh_covers_all_worker_images`, `bundle_scripts_service_lists_are_in_sync`; `${IMAGE_*}` placeholders ↔ catalog — `image_placeholders_align_with_catalogue_and_template`; COPY sources ↔ `hash_inputs` — `hash_inputs_cover_copy_sources`.
- `bundle.rs::HOST_BUILD_OUTPUT_DIRS` ↔ bundle scripts ↔ `containers/.dockerignore` — `host_build_output_dirs_align_with_bundle_scripts_and_dockerignore`.
- Windows production literals (`"Speedwave"` distro, `.speedwave`, `nodejs/`, `bin/`, `resources/`) across installer template, sweep.ps1, e2e-vm.sh, installation doc — `consts.rs` `*_appears_in_*` tests + `tauri_windows_resources_subdir_matches_desktop_layout`.
- Installer/sweep/firewall pipeline (generated `installer-hooks.nsh`, kill targets, firewall modes/engines, WiX sequencing) — the ~25 tests in `desktop/src-tauri/src/installer_hooks.rs`. Editing a `.ps1` requires `make generate-installer-nsh`.
- nerdctl pin (`.lima-version` ↔ `NERDCTL_FULL_VERSION` ↔ e2e-vm.sh URL) — `lima_version_and_nerdctl_full_version_are_aligned`, `nerdctl_version_appears_in_e2e_vm_script`.
- macOS signing: `sign-bundled-binaries.sh` `SIGN_TARGETS` ↔ `tauri.macos.conf.json` `bundle.resources` ↔ entitlements plists — `_tests/desktop/sign-bundled-binaries.bats`.
- Versioned files: `release-please-config.json` `extra-files` is the single list; `backmerge.yml` derives its resolve/exclude sets from it via jq — `_tests/desktop/backmerge-alignment.bats`, `_tests/desktop/version-consistency.bats`. New versioned artifact = add it to `extra-files`, nothing else.
- User-message wire envelope (Rust side) — snapshot `build_user_message_snapshot_wire_format`.
- Model catalog pricing completeness — `tests/anthropic_pricing_completeness.rs`; timeout budgets (MCP idle ≥ worker stall; Lima provision == Desktop reconcile wait) — `mcp_tool_idle_timeout_covers_worker_max`, `lima_provision_start_timeout_matches_desktop_reconcile_wait_budget`.
- `apt-get install` must set `DEBIAN_FRONTEND=noninteractive` in every Containerfile/Dockerfile — `tests/apt_noninteractive.rs`.
- Tests never touch production `~/.speedwave` — `tests/no_raw_data_dir_in_tests.rs`, `tests/prod_data_dir_untouched.rs`, `_tests/desktop/guard-prod-data-dir.bats`.
- Plugin signature is a runtime invariant (every plugin-tree read goes through `signing::verify_plugin_signature_cached`) — e2e tamper guard `_tests/e2e/plugin-tamper.bats`.
- Integration resource link/unlink on toggle — `_tests/entrypoint/entrypoint.bats`.

## Manual alignments — NO automated guard; update together in the same commit

- `docs/architecture/containers.md` Resource Limits + VM sizing sections hand-narrate `resources.rs` numbers.
- **`tzdata` in EVERY container image** (apk/apt, or a zoneinfo COPY for scratch images like the proxy) — the host TZ injected by `tz.rs::detect_host_timezone()` degrades to a numeric offset without it. New worker image = install tzdata in the same commit; nothing automated catches a miss.
- `windows-sys` version in `crates/speedwave-runtime/Cargo.toml` ↔ `desktop/src-tauri/Cargo.toml` (separate workspaces/lockfiles) — bump both + `cargo update -p windows-sys --precise` in both; a one-sided bump is invisible on a macOS host.
- `state_tree.rs::MessageBlock` (Rust tagged enum, `kind` snake_case) ↔ `models/state-tree.ts::MessageBlockState` ↔ renderer arm in `chat-state.service.ts::stateBlocksToMessageBlocks`. Order: Rust first, then TS mirror, then renderer arm — only the renderer's default arm (unknown kind → error block, at runtime, in front of the user) catches drift. `models/chat.ts::MessageBlock` is a separate UI view-model, NOT the mirror.
- `chat.rs::WireContentBlock` (user→stdin wire, **text-only**: single `Text` variant; image bytes go to `<project>/.speedwave/pastes/` and are referenced as `@…` text — never inline base64, it OOM-killed the in-container parser) ↔ TS mirror `models/chat.ts::WireContentBlock`. Rust side is snapshot-pinned; the TS half is hand-synced.
- `#wsl-native-workflow` heading in `docs/getting-started/installation.md` ↔ URL embedded in `consts::wsl_other_distro_msg` — renaming the heading 404s a user-facing error link.
- `SLACK_OAUTH_REDIRECT_PORT` ↔ the redirect URL registered on the Slack app itself (external).
- `NERDCTL_FULL_SHA256_*` values ← upstream nerdctl release `SHA256SUMS` (tests pin only the 64-hex shape).
- Fixture-mirrored Rust↔TS tests (`derive_worker_env` ↔ hub `worker-env.test.ts`, sanitizer rule count, `ts()` timestamp shape) — update both sides' tests together. For any NEW Rust↔TS mirrored constant, add an `include_str!` cross-read test (grep `_matches_ts` for the pattern).
- `containers/claude-resources/<type>/integrations/<dir>` name must equal a descriptor `config_key` — a typo'd directory silently never links.
- The plugin contract vs plugins in the `speedwave-plugins` sibling repo (cross-repo, untestable from here).

## Commands — always via Makefile, never cargo/npm directly

```bash
make setup-dev      # first-time: prerequisites + all dependencies
make test           # all tests (Rust + Angular + MCP + entrypoint + desktop)
make check          # lint + clippy + type-check + format  (run before every push)
make check-all      # check + test + coverage + audit
make dev            # desktop dev mode (Tauri + Angular hot reload)
make build          # build everything
make fmt / status / audit / coverage-html
```

Granular: `test-rust`, `test-cli`, `test-angular`, `test-mcp`, `test-os`, `test-swift`, `test-desktop`, `test-proxy`, `test-transcription`, `test-entrypoint`, `test-desktop-build`, `test-e2e`, `test-e2e-desktop`, `test-e2e-audio`, `test-e2e-plugin-tamper-release`, `test-e2e-all`, `test-mcp-office-py`, `test-mcp-os-bundle`, `test-release-gate`, `setup-e2e-vms` · `build-runtime`, `build-cli`, `build-cli-release`, `build-desktop`, `build-native-macos`, `build-os-cli`, `build-mcp`, `build-angular`, `build-tauri`, `bundle-native-assets`, `verify-bundled-assets` · `check-clippy`, `check-desktop-clippy`, `check-fmt`, `check-mcp`, `check-mcp-lint`, `check-angular`, `check-angular-lint` · `coverage-rust`, `coverage-mcp`, `coverage-angular` · `audit-rust`, `audit-mcp`, `audit-desktop` · `download-lima`, `download-nodejs`, `download-wsl-resources` (+ `clean-*`) · `generate-installer-nsh`, `lint`, `install-deps`, `install-hooks`, `clean`.

## Rules index (`.claude/rules/`)

Always loaded: `git-workflow.md` (branches, PR titles, merges, hooks, CI), `engineering-principles.md` (KISS/YAGNI/DRY/SOLID + code hygiene: comments, tests, dead code), `security.md` (non-negotiable security invariants).

Path-scoped (load when touching matching files — consult proactively when working in that area): `cross-platform.md` (macOS/Windows pitfalls), `plugins.md` (full plugin contract), `local-llm.md` (LLM providers/proxy invariants), `logging.md`, `mcp-servers.md` (worker policy + new-worker checklist), `images-builds.md` (image build/rebuild rules), `host-workers.md` (host-side worker/bridge rules), `desktop-ui.md` (Angular/Tauri UI rules), `documentation.md`, `rust-style.md`.

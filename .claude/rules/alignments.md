---
paths:
  - 'crates/**'
  - 'desktop/**'
  - 'mcp-servers/**'
  - 'containers/**'
  - 'scripts/**'
  - 'native/**'
  - '_tests/**'
  - '.github/**'
---

# Alignments — keep paired sources in sync

Two kinds: **test-guarded** (a failing test names the fix — trust it, never bypass it) and **manual** (no automated guard — update both sides in the same commit or it drifts silently). When in doubt about whether a pair is guarded, grep for the test name; if none exists, treat it as manual.

## Test-guarded alignments — the failing test names the fix

- Resource tables ↔ compose template placeholders — `compose::tests::resources_render_from_ssot`.
- Every rendered compose passes the full OWASP/zero-token gate — `test_rendered_compose_passes_security_check` + the `test_security_check_*` family (cap_drop/no-new-privileges/read_only/tmpfs/user, no tokens on claude or hub, localhost-only ports, external-LLM-key deny list, per-worker volume profiles, and the `ManagedSettingsMount` profile — `:ro` at the exact `/etc/claude-code/managed-settings.json` target from `<data_dir>/claude-managed/<project>/`). Adding a `SecurityRule` variant = bumping `SECURITY_RULE_COUNT` (guarded by `test_all_rules_covers_every_variant` / `test_security_rule_iter_first_and_last`).
- Compose template services ↔ `consts::BUILT_IN_SERVICES` — `test_internal_only_covers_all_template_services`.
- `HOST_GATEWAY_ALIAS` ↔ `mcp-servers/shared/src/security.ts` ↔ template `extra_hosts` (static on `claude`, `proxy`, `mcp-playwright`) — `host_gateway_alias_matches_mcp_shared_ts`, `host_gateway_alias_appears_in_compose_template`, `compose_template_extra_hosts_contains_only_canonical_alias`.
- No hardcoded loopback binds — drift detector `tests/no_hardcoded_loopback_bind.rs`; no raw engine paths — `tests/no_raw_engine_path.rs` (escape hatch for both: `// SSOT-allow: <reason>`).
- `LockedRuntime` encapsulation (trait stays `pub(crate)`, no lock re-exports) — `tests/ssot_enforcement.rs`.
- `consts::SLACK_OAUTH_TOKEN_URL` ↔ oauth worker `providers/slack.ts` — `slack_token_url_matches_oauth_worker_provider_ts`.
- Plugin slug regex Rust ↔ oauth worker TS — `plugin_slug_pattern_matches_oauth_state_ts`; auth field types Rust ↔ TS — `allowed_auth_field_types_match_ts_union`.
- `build.rs::IMAGES` ↔ `scripts/bundle-build-context.{sh,ps1}` — `bundle_build_context_sh_covers_all_worker_images`, `bundle_scripts_service_lists_are_in_sync`; `${IMAGE_*}` placeholders ↔ catalog — `image_placeholders_align_with_catalogue_and_template`; COPY sources ↔ `hash_inputs` — `hash_inputs_cover_copy_sources`. Bundle-script output tree also pinned by `_tests/desktop/bundle-build-context.bats`.
- `bundle.rs::HOST_BUILD_OUTPUT_DIRS` ↔ bundle scripts ↔ `containers/.dockerignore` — `host_build_output_dirs_align_with_bundle_scripts_and_dockerignore`.
- Windows production literals (`"Speedwave"` distro, `.speedwave`, `nodejs/`, `bin/`, `resources/`) across installer template, sweep.ps1, e2e-vm.sh, installation doc — `consts.rs` `*_appears_in_*` tests + `tauri_windows_resources_subdir_matches_desktop_layout`.
- Installer/sweep/firewall pipeline (generated `installer-hooks.nsh`, kill targets, firewall modes/engines, WiX sequencing) — the ~28 tests in `desktop/src-tauri/src/installer_hooks.rs`. Editing a `.ps1` requires `make generate-installer-nsh`.
- nerdctl pin (`.lima-version` ↔ `NERDCTL_FULL_VERSION` ↔ e2e-vm.sh URL) — `lima_version_and_nerdctl_full_version_are_aligned`, `nerdctl_version_appears_in_e2e_vm_script`. (macOS and Windows nerdctl versions are NOT string-equal — the lima→nerdctl table in `consts.rs` maps them.)
- macOS signing: `sign-bundled-binaries.sh` `SIGN_TARGETS` ↔ `tauri.macos.conf.json` `bundle.resources` ↔ entitlements plists — `_tests/desktop/sign-bundled-binaries.bats`. Native CLI Info.plists (version ↔ tauri.conf.json, sub-identifiers, TCC descriptions, single-key entitlements, audio-capture bundling) — `_tests/desktop/{native-cli-info-plist,info-plist,entitlements-*,transcription-bundle}.bats`.
- Versioned files: `release-please-config.json` `extra-files` is the single list; `backmerge.yml` derives its resolve/exclude sets from it via jq — `_tests/desktop/backmerge-alignment.bats`, `_tests/desktop/version-consistency.bats`. New versioned artifact = add it to `extra-files`, nothing else.
- Updater config (endpoint ↔ `updater.rs::STABLE_ENDPOINT`, minisign pubkey, v1Compatible artifacts) — `_tests/desktop/updater-config.bats`. Release pipeline signing + asset/sig/latest.json completeness — `_tests/desktop/{release-workflow-signing,verify-release-assets}.bats`.
- User-message wire envelope (Rust side) — snapshot `build_user_message_snapshot_wire_format`.
- Model catalog pricing completeness — `tests/anthropic_pricing_completeness.rs`; timeout budgets (MCP idle ≥ worker stall; Lima provision == Desktop reconcile wait) — `mcp_tool_idle_timeout_covers_worker_max`, `lima_provision_start_timeout_matches_desktop_reconcile_wait_budget`.
- `apt-get install` must set `DEBIAN_FRONTEND=noninteractive` in every Containerfile/Dockerfile — `tests/apt_noninteractive.rs`.
- Tests never touch production `~/.speedwave` — `tests/no_raw_data_dir_in_tests.rs`, `tests/prod_data_dir_untouched.rs`, `_tests/desktop/guard-prod-data-dir.bats`.
- Plugin signature is a runtime invariant (every plugin-tree read goes through `signing::verify_plugin_signature_cached`) — e2e tamper guard `_tests/e2e/plugin-tamper.bats`.
- Integration resource link/unlink on toggle — `_tests/entrypoint/entrypoint.bats`.
- claude-resources `integrations/<dir>` names ↔ descriptor `config_key`s — `integrations_directories_match_known_service_keys`.
- Service descriptors ↔ resolved-config fields / `BUILT_IN_SERVICE_IDS` / Desktop OS-config getter / native-CLI resolver — `*_covers_all_toggleable_services`, `*_matches_resolved_config_fields`, `resolve_native_cli_binary_covers_all_os_services`.
- Repo `.speedwave.json` env deny-predicate covers `RESERVED_ENV_KEYS` + Anthropic keys — `test_repo_env_key_is_denied_covers_ssot`.
- Displayable `DIAGNOSTIC_SOURCES` ↔ /logs merge parity — `logs_view_covers_all_displayable_registry_sources`.
- Desktop SharePoint required-scopes ↔ `consts::SHAREPOINT_OAUTH_SCOPES` — `sharepoint_required_scopes_matches_ssot_lowercased`.
- `.clipboard-bridge` filename Rust ↔ `containers/osc52-copy.sh` — `bridge_filename_matches_shell_wrapper_literal` + `_tests/entrypoint/osc52-copy.bats`.
- e2e-vm.sh rsync excludes ↔ bundled-asset dirs + `ps_squote` on every windows_ps env — `_tests/e2e/e2e-vm-excludes.bats`.
- Every Rust↔TS mirrored constant/union has an `include_str!` cross-read test — grep `_matches_ts` / `_matches_rust` (`host_gateway_alias`, `slack_token_url`, `plugin_slug`, `allowed_auth_field_types`, `llm_provider_kind`, `cost_source`, `max_expires_in`, `save_oauth_state_key_set`, `max_credential_bytes`, `discovery_err_contract`, `otlp_protocol` + `telemetry_locks_field_set` ↔ `models/telemetry.ts`, `mic_permission` ↔ `models/transcript.ts`). Add one for any NEW mirror.
- Smaller SSOT pins are unit-guarded (entrypoint MCP config path, `ANTHROPIC_DEFAULT_*` model env ↔ catalog latest flags, proxy recreate digest covers proxy.json, nerdctl runtime exact-pin, hub port ↔ `PORT_BASE`, field storage tier) — the failing test names the fix.
- CLI login-command path ↔ `consts::cli_install_path_for` — `login_command_path_matches_install_path` (auth_commands.rs) asserts the emitted command references the SSOT for macOS (`~/.local/bin`) and Windows (`<data_dir>\bin\…exe`), over default AND custom `data_dir`.
- Installer dest ↔ `consts::cli_install_path_for` (**Unix only**) — `link_cli_from_copies_binary_and_sets_permissions` (setup_wizard.rs, `#[cfg(unix)]`) asserts the installed binary path equals the SSOT. The Windows installer producer stays manually synced with the SSOT (the test is Unix-gated because it exercises Unix chmod); do not claim both-platform coverage.
- Bundled skills (`containers/claude-resources/skills/` — the single source; no repo-level dev copy) — `tests/bundled_skills_guards.rs`: no `model:` in any SKILL.md frontmatter (skills inherit the session model), `.claude/skills`/`.claude/scripts` must not exist, orchestrator `## Worker Skills` list ↔ `code-review-*` directories, shared Review Scope/Project Conventions/Output Contract blocks byte-identical across workers.
- CLI filename leaf ↔ bundle manifest + Tauri config — `windows_bundle_cli_asset_matches_filename_ssot` and `macos_bundle_cli_asset_matches_filename_ssot` (bundle.rs) assert `{WINDOWS,MACOS}_BUNDLED_ASSETS` and `tauri.{windows,macos}.conf.json` carry `cli/<cli_binary_filename(is_windows)>`. The filename SSOT is `consts::cli_binary_filename`, single-sourced from `CLI_BINARY`; `cli_install_path_for` and the `installer_hooks.rs` sweep guard both derive from it.

## Manual alignments — NO automated guard; update together in the same commit

- `docs/architecture/containers.md` Resource Limits + VM sizing sections hand-narrate `resources.rs` numbers.
- **`tzdata` in EVERY container image** (apk/apt, or a zoneinfo COPY for scratch images like the proxy) — the host TZ injected by `tz.rs::detect_host_timezone()` degrades to a numeric offset without it. `apt_noninteractive.rs` catches the debconf-prompt hang, NOT a missing tzdata. New worker image = install tzdata in the same commit.
- `windows-sys` version in `crates/speedwave-runtime/Cargo.toml` ↔ `desktop/src-tauri/Cargo.toml` (separate workspaces/lockfiles) — bump both + `cargo update -p windows-sys --precise` in both; a one-sided bump is invisible on a macOS host.
- `state_tree.rs::MessageBlock` (Rust tagged enum, `kind` snake_case) ↔ `models/state-tree.ts::MessageBlockState` ↔ renderer arm in `chat-state.service.ts::stateBlocksToMessageBlocks`. Order: Rust first, then TS mirror, then renderer arm — only the renderer's default arm (unknown kind → error block, at runtime, in front of the user) catches drift. `models/chat.ts::MessageBlock` is a separate UI view-model (discriminates on a snake_case `type` field, extra `permission_prompt` variant with no Rust counterpart), NOT the mirror. Ignore the stale in-code doc comments in `state_tree.rs` that name `models/chat.ts` as the mirror.
- `chat.rs::WireContentBlock` (user→stdin wire, **text-only**: single `Text` variant, `type` tag snake_case; image bytes go to `<project>/.speedwave/pastes/` and are referenced as `@…` text — never inline base64) ↔ TS mirror `models/chat.ts::WireContentBlock`. Rust side is snapshot-pinned; the TS half is hand-synced.
- `#wsl-native-workflow` heading in `docs/getting-started/installation.md` ↔ URL embedded in `consts::wsl_other_distro_msg` — renaming the heading 404s a user-facing error link.
- `SLACK_OAUTH_REDIRECT_PORT` ↔ the redirect URL registered on the Slack app itself (external).
- `NERDCTL_FULL_SHA256_*` values ← upstream nerdctl release `SHA256SUMS` (tests pin only the 64-hex shape — a wrong-but-well-formed hash passes tests, fails at provision).
- Fixture-mirrored Rust↔TS tests (`derive_worker_env` ↔ hub `worker-env.test.ts`, sanitizer rule count, `ts()` timestamp shape) — each side self-tests against a hardcoded expectation; neither fails on the other's change, so update both sides' tests in the same commit. For any NEW Rust↔TS mirrored constant, add an `include_str!` cross-read test instead (grep `_matches_ts`).
- `containers/claude-resources/<type>/integrations/<dir>` name must equal a descriptor `config_key` — actually test-guarded (`integrations_directories_match_known_service_keys`), so a typo fails `make test`; listed here only as a reminder that adding the dir is the whole change.
- The plugin contract vs plugins in the `speedwave-plugins` sibling repo (cross-repo, untestable from here) — in-repo tests pin schema shape only; check the sibling repo before changing any contract surface.

# Speedwave

Security-first AI platform connecting Claude Code with external services (Slack, SharePoint, GitLab, GitHub, Atlassian, Redmine, Mail, Calendar) plus a built-in Office documents worker (Word/Excel/PowerPoint/PDF read·write·convert·charts). Claude runs in a hardened, token-free container — all service credentials are isolated per-worker. VM-level isolation on macOS (Lima) and Windows (WSL2). Ships as a single installable app (.dmg, .exe) without Docker Desktop. Two interfaces: CLI (terminal) and Desktop (chat UI). Linux as a host platform was dropped (ADR-059).

## Key Architecture

- **SSOT: `crates/speedwave-runtime/`** — all Lima/WSL2/nerdctl logic. CLI and Desktop both import it as a Cargo dependency
- **SSOT: `mcp-servers/shared/`** — MCP protocol utilities shared by all servers
- **SSOT: `containers/compose.template.yml`** — container definitions. `render_compose()` generates per-project files
- **SSOT: `crates/speedwave-runtime/src/defaults.rs::ANTHROPIC_MODELS`** — Anthropic model catalog (id, family, context window, latest flag). Frontend reads it via the `list_anthropic_models` Tauri command and `AnthropicModelsService`. Bumping a model = editing one const; do NOT hard-code model strings in Angular.
- **SSOT: `crates/speedwave-runtime/src/log_ts.rs::log_timestamp()`** — the one timestamp format for all Speedwave logs: RFC 3339, millis, **local time with a colon offset** (`2026-05-12T14:34:02.814+02:00`). TS counterpart `@speedwave/mcp-shared`'s `ts()` does the same (local offset, never bare `Z` — it reads the container's `TZ`, injected from the host by `tz::detect_host_timezone`). Adding a new logger = using one of these, never a hand-rolled format, never `toISOString()` for a log-line prefix. `crates/speedwave-runtime/src/log_file.rs` (the chmod-600 append/timestamped-line/rotation helpers) lives here too, shared by Desktop's claude-session log + the mcp-os drain + the host_exec drain.
- **SSOT alignment:** `scripts/bundle-build-context.sh` IMAGES list must stay aligned with `crates/speedwave-runtime/src/build.rs` IMAGES constant
- **SSOT alignment:** `scripts/sign-bundled-binaries.sh` SIGN_TARGETS must stay aligned with `desktop/src-tauri/tauri.macos.conf.json` bundle.resources — every bundled Mach-O must be signed, and binaries using restricted platform APIs need entitlements plists in `desktop/src-tauri/entitlements/`
- **SSOT alignment:** WSL distro name is derived from `data_dir()` basename by `crates/speedwave-runtime/src/consts.rs::derive_wsl_distro_name_from` (parallel to `lima_vm_name` on macOS) — production `~/.speedwave` → `"Speedwave"`, dev `~/.speedwave-dev` → `"Speedwave-dev"`, custom basename `foo` → `"Speedwave-foo"`. The production literal `"Speedwave"` must stay aligned across (a) `desktop/src-tauri/windows/installer-hooks-template.nsh` (hand-edited source; the committed `installer-hooks.nsh` is generated from it), (b) `scripts/e2e-vm.sh`, (c) `docs/getting-started/installation.md` — all three are production-only paths (installer, E2E provisioning, install docs) and use the literal name. Renaming the production distro = updating all four locations (consts.rs default + the three files above) in the same commit. Dev distro names are derived dynamically and require no manual sync. Runtime consumers (`runtime/wsl.rs::WslUncInfo::is_runtime_distro`, `runtime/wsl.rs::windows_to_wsl_path`, `consts::wsl_other_distro_msg`, `project.rs::add_project_with_data_dir`, `desktop/src-tauri/src/setup_wizard.rs`) all call `consts::wsl_distro_name()` so they automatically pick the right name per data_dir.
- **SSOT alignment:** The `#wsl-native-workflow` anchor in `docs/getting-started/installation.md` is referenced from (a) `crates/speedwave-runtime/src/consts.rs::wsl_other_distro_msg` (the URL embedded in the user-facing cross-distro error), (b) `docs/adr/ADR-064-canonicalize-bypass-for-wsl-unc.md` (the architectural rationale). Renaming the heading = updating both references in the same commit.
- **SSOT alignment:** `crates/speedwave-runtime/src/consts.rs::DATA_DIR` (`.speedwave`) must stay aligned with the literal `".speedwave"` in `desktop/src-tauri/windows/installer-hooks-template.nsh` (hand-edited source; `RMDir /r "$PROFILE\.speedwave"`). Renaming the data dir = updating both in the same commit.
- **SSOT alignment:** `crates/speedwave-runtime/src/stream/state_tree.rs::MessageBlock` (Rust tagged enum, `kind` snake_case — the patch-stream variant union per ADR-042) is mirrored by `desktop/src/src/app/models/chat.ts::MessageBlock` (TS tagged union, `type` field, kebab-cased variant strings). Adding a variant = editing Rust FIRST, then mirroring in TS; reversing the order silently breaks deserialization on the first patch carrying the new `kind`. For image attachments specifically, the variant is `Image { media_type, alt }` — metadata only, no bytes (see ADR-065 for the lifecycle rationale).
- **SSOT alignment:** `desktop/src-tauri/src/chat.rs::WireContentBlock` (user→stdin wire format) is mirrored by `desktop/src/src/app/models/chat.ts::WireContentBlock`. Both use `media_type` (snake_case, Anthropic Messages schema — NOT `mimeType` which is the MCP protocol). The snapshot test `build_user_message_snapshot_wire_format` pins the serialized envelope; flipping `media_type` to `mimeType` or reintroducing a `parent_tool_use_id` field on the user-input envelope will trip it. See ADR-065.
- **SSOT alignment:** `crates/speedwave-runtime/src/tz.rs::detect_host_timezone()` (host TZ → `TZ` env injected into every service by `compose::inject_host_timezone`) must stay aligned with the `tzdata` package install in every container image: (a) `containers/Containerfile.claude` (apt), (b) `containers/mcp-servers/Containerfile.mcp-base` (apk), (c) `mcp-servers/hub/Containerfile` (apk), (d) every `mcp-servers/<service>/Dockerfile` (apk — `slack`, `sharepoint`, `redmine`, `gitlab`, `github`, `atlassian`; apt — `office`, which is Debian-based for LibreOffice). Adding a new worker image = installing `tzdata` in the same commit; otherwise `TZ` resolves to a numeric offset and Claude Code limit timestamps stay wrong.
- **SSOT alignment:** `crates/speedwave-runtime/src/consts.rs::RESERVED_ENV_KEYS` is the single list of env names plugins cannot inject via `extra_env` (`PORT` reserved by Speedwave + dynamic-linker / language-runtime / shell-environment hijack vectors — `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `PATH`, `HOME`, `IFS`, `BASH_ENV`, …). It is consumed by `plugin::validate_manifest` and documented in `docs/architecture/security.md`. Adding a new vector = editing `consts.rs` only; do not duplicate the list in `validate_manifest`.
- **SSOT alignment:** `crates/speedwave-runtime/src/consts.rs::HOST_GATEWAY_ALIAS` (`host.docker.internal`) is the single hostname used everywhere a container reaches the host. It must stay aligned with: (a) `mcp-servers/shared/src/security.ts` `export const HOST_GATEWAY_ALIAS` (mirror — Rust regex test `host_gateway_alias_matches_mcp_shared_ts` enforces equality), (b) `containers/compose.template.yml` `extra_hosts` literal (statically declared for `claude` and `mcp-playwright` — ADR-062; test `host_gateway_alias_appears_in_compose_template` enforces line match, `mcp_playwright_section_has_extra_hosts_in_template` enforces the `mcp-playwright` entry). Per-service distribution to `mcp-hub` and OAuth-consumer containers is dynamic via `compose::ensure_host_gateway_extra_host()`. Per-platform divergence is in the IP resolved per `host.docker.internal` — macOS: `consts::LIMA_VZ_HOST_IP` (192.168.5.2, Lima vzNAT static); Windows: detected at runtime by `compose::host_addressing` from `wsl.exe -d <distro> -- sh -c 'ip -4 route show default'`, cached in a `RwLock<Option<HostAddressing>>` that `render_compose` invalidates on entry. Do not reintroduce per-platform aliases (`host.lima.internal`, `host.speedwave.internal`, `host.containers.internal`).
- **SSOT alignment:** `compose::host_gateway_ip()` and `compose::host_bind_address()` are the two halves of `compose::host_addressing`, mandatorily equal on Windows (container's `host.docker.internal` resolves to the same IP host process must bind on — WSL2 mirrored mode breaks 127.0.0.1 loopback, microsoft/WSL#11312). macOS splits them (gateway 192.168.5.2, bind 127.0.0.1; Lima vzNAT translates). Every production TCP listener that needs container-side reach goes through `host_bind_address()`: (a) `desktop/src-tauri/src/bridges/host_bridge.rs::bind_with_retry` (IDE bridge + every plugin bridge), (b) `crates/speedwave-runtime/src/host_mcp_process/process.rs::spawn_with_spec` injects `MCP_LISTEN_HOST` into Node, mirrored at `mcp-servers/shared/src/server.ts::createMCPServer` (default `process.env.MCP_LISTEN_HOST ?? '127.0.0.1'`). Drift detector at `crates/speedwave-runtime/tests/no_hardcoded_loopback_bind.rs` walks production source for hardcoded loopback bind/connect literals and fails the build on new occurrences — bypass with `// SSOT-allow: <reason>` next to the literal or by adding the file to its allowlist.
- **SSOT alignment:** Plugin Ed25519 signature is a **runtime invariant**, not just an install gate (see [ADR-051](docs/adr/ADR-051-plugin-signature-runtime-verification.md)). Every read of a plugin tree goes through `signing::verify_plugin_signature_cached`; mutable per-plugin state (currently `image_pending`) lives at `<data_dir>/plugin-state/<slug>/`, never inside the signed tree. Adding a new mutable per-plugin file = adding it under `plugin-state/`, not under `plugins/<slug>/`; otherwise it invalidates the digest of every freshly-installed plugin.
- **SSOT alignment:** `.sherpa-onnx-version` is the single source of the sherpa-onnx version used by the Windows CRT-alignment prefetch (see [ADR-061](docs/adr/ADR-061-windows-crt-runtime-alignment.md)). It must stay aligned with: (a) `crates/speedwave-runtime/Cargo.toml` (the `sherpa-onnx = "=X.Y.Z"` exact pin), (b) the resolved version in **both** `Cargo.lock` files (root + `desktop/src-tauri/Cargo.lock` — checksums must match), (c) `scripts/lib/fetch-sherpa-onnx-md.sh` (computes the archive filename from the version file), (d) `.github/actions/download-sherpa-onnx/action.yml` (CI consumer), (e) `scripts/e2e-vm.sh` Step 4 (E2E consumer via `wsl bash`). Bumping sherpa = edit `.sherpa-onnx-version`, edit the `Cargo.toml` `=` pin, run `cargo update -p sherpa-onnx --precise <new>` in both workspaces, verify the MD-Release archive still exists upstream — all in one commit.
- **SSOT alignment:** `crates/speedwave-runtime/src/consts.rs::NODEJS_SUBDIR` (`nodejs`) must stay aligned with the literal `nodejs` in (a) the sweep script `desktop/src-tauri/windows/sweep.ps1` (filters on `$instDir\nodejs\`), (b) `crates/speedwave-runtime/src/bundle.rs` `BundledAssetSpec` paths (`nodejs/bin/node`, `nodejs/node.exe`). Renaming the bundled-Node subdir = updating all three locations in the same commit. Pinned by `nodejs_subdir_appears_in_sweep_script` test in `consts.rs`. See ADR-048 §"PRE-INSTALL orphan worker sweep".
- **SSOT alignment:** `crates/speedwave-runtime/src/consts.rs::CLI_BIN_SUBDIR` (`bin`) must stay aligned with the literal `bin` in (a) `desktop/src-tauri/windows/sweep.ps1` (sweep target `$dataDir\bin\speedwave.exe` so a running CLI in the data dir cannot survive an upgrade and silently keep an outdated binary after `link_cli`), (b) `desktop/src-tauri/src/setup_wizard.rs::link_cli_from` (writes the binary to `data_dir/bin/`), (c) `desktop/src-tauri/src/auth_commands.rs` (the pinned-CLI launch path). Pinned by the `sweep_ps1_kills_all_three_target_categories` test in `installer_hooks.rs`.
- **SSOT alignment:** `desktop/src-tauri/windows/sweep.ps1` (UTF-8 with BOM) is the single PowerShell implementation of the upgrade sweep (kill stale `Speedwave.exe` / `nodejs\*` / `bin\speedwave.exe`, then poll write access). Three call sites consume it: (a) NSIS PREINSTALL — `scripts/generate-installer-nsh.sh` embeds it via `FileWrite` literals into `installer-hooks.nsh`, materialising it to `$PLUGINSDIR\sweep.ps1` at install time; (b) MSI WiX CustomAction (`windows/sweep.wxs`) runs it after `InstallFiles` via `CAQuietExec64`; (c) Tauri Desktop runtime (`setup_wizard::run_pre_link_sweep`) invokes it at every startup as defense-in-depth. Inputs: `SPW_INSTDIR` + `SPW_DATA_DIR` env vars. Editing the `.ps1` requires `make generate-installer-nsh` to regenerate `installer-hooks.nsh`; drift is caught by `installer_hooks_nsh_matches_template_plus_generated_macros` in `installer_hooks.rs`. The hand-edited template lives at `windows/installer-hooks-template.nsh`.
- **SSOT alignment:** `desktop/src-tauri/windows/firewall.ps1` (UTF-8 with BOM) is the single PowerShell implementation of the Hyper-V firewall rule scoped to the WSL VMCreatorId `{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}` (so the host bridge bound on the WSL adapter IP is reachable from containers without surfacing a per-binary WDF prompt — ADR-067 SSOT host bind). The `install` mode also removes stale WDF Block rules left by users who clicked Anuluj on prior prompts. Consumed by: (a) NSIS POSTINSTALL + POSTUNINSTALL via the materialise pattern in `installer-hooks.nsh`; (b) MSI WiX CustomActions in `windows/firewall.wxs` (install after `InstallFiles`, uninstall before `RemoveFiles`). Idempotent + fail-open: every code path exits `0` so a policy-locked machine cannot brick install. Pinned by the `firewall_ps1_*` and `firewall_wxs_*` tests in `installer_hooks.rs`.
- **SSOT alignment:** `windows-sys` version must stay aligned between `crates/speedwave-runtime/Cargo.toml` and `desktop/src-tauri/Cargo.toml` (`[target.'cfg(windows)'.dependencies]` blocks). They live in separate Cargo workspaces with separate `Cargo.lock` files, so `[workspace.dependencies]` cannot be used. Both Cargo.toml files carry an inline comment cross-referencing the other. Bumping the version = editing both files + running `cargo update -p windows-sys --precise <new>` in both workspaces in the same commit.
- **SSOT alignment:** `release-please-config.json` `extra-files` list (the files release-please version-bumps on every release) must stay a **subset** of BOTH `.github/workflows/backmerge.yml` `AUTO_RESOLVE_FILES` **and** `VERSION_EXCLUDES` (the pre-merge guard that decides whether dev has genuinely new content vs. version-only divergence). Reason: squash-merging `dev → main` and the release PR rewrites these files on `main` with new SHAs; the automatic backmerge `main → dev` then hits `add/add` conflicts on every file release-please bumped, and the auto-resolver can only fix files it knows about; the pre-guard cannot distinguish version-only divergence from real content. Asymmetric edits silently break the backmerge workflow — when you add a new worker or native helper to `release-please-config.json`, add the same path to BOTH `AUTO_RESOLVE_FILES` and `VERSION_EXCLUDES` in the same commit. v0.11.0 release hit this with `mcp-servers/office/package.json` + 4 `native/macos/*/Resources/Info.plist` (added in v0.11.0 but missing from the auto-resolver list); v0.12.0 release surfaced further gaps — `package.json` (root), `desktop/src-tauri/oauth/shared/package.json`, `mcp-servers/{context7,oauth,playwright}/package.json`, `native/macos/audio-capture/Resources/Info.plist` — all added in v0.11.0 but missing from extra-files and the auto-resolver. Both required manual backmerge PRs to fix.
- **SSOT alignment:** Per-integration claude-resources live under `containers/claude-resources/<type>/integrations/<config_key>/` (skills/commands/agents/hooks). The directory name MUST match `config_key` from `crates/speedwave-runtime/src/consts.rs::TOGGLEABLE_MCP_SERVICES` — that key is what `compose::apply_integrations_filter` puts into `ENABLED_SERVICES` for both the `claude` and `mcp-hub` containers. `containers/entrypoint.sh` symlinks each `integrations/<svc>/` entry into `~/.claude/<type>/<svc>` only when `<svc>` ∈ `ENABLED_SERVICES`, and tracks every link it owns in `~/.claude/.speedwave-managed-links` so toggling an integration off removes the link. Top-level entries in `<type>/` (e.g. `code-review-*`) are core resources and always linked. Adding a per-integration resource = creating the directory under `integrations/<config_key>/` — no Rust or compose change needed; adding a per-integration BATS test for the on/off transition is required (see `_tests/entrypoint/entrypoint.bats`).
- **Per-project isolation:** `~/.speedwave/tokens/<project>/<service>/` (read-only mount), `speedwave_<project>_network` (isolated network)
- **LockedRuntime (SSOT public runtime handle):** `detect_runtime() -> LockedRuntime` is the only public entry point. `LockedRuntime` wraps an internal `pub(crate) trait ContainerRuntime` (`LimaRuntime` on macOS, `WslRuntime` on Windows) and enforces a per-project compose transaction lock — every compose-touching op goes through it, every multi-step sequence wraps in `rt.transaction(project, |rt| {...})`. Tests build mocks via `runtime::mock_runtime::MockRuntimeBuilder` (gated `test-support` feature). No code outside `speedwave-runtime` may name or implement `ContainerRuntime`.
- **MCP Hub:** port 4000, the ONLY MCP server Claude sees. Hub has zero tokens.
- **IDE Bridge:** writes `~/.speedwave/ide-bridge/<port>.lock` on host, mounted as `~/.claude/ide/` in container
- **Config merge:** defaults -> repo `.speedwave.json` -> user `~/.speedwave/config.json` (highest priority). See ADR-011
- **Claude Code:** installed inside container by `entrypoint.sh` at start (Anthropic All Rights Reserved — cannot be bundled)
- If same logic appears in two places — extract it to `speedwave-runtime`

## Commands

**Use `Makefile` for all build/test/check operations.** Do not call cargo/npm directly.

```bash
make setup-dev      # first-time: check prerequisites + install all dependencies
make test           # run all tests (Rust + Angular + MCP + entrypoint + desktop)
make check          # lint + clippy + type-check + format
make check-all      # full quality gate: check + test + coverage + audit
make coverage-html  # generate HTML coverage reports and open in browser
make audit          # check dependencies for known vulnerabilities
make dev            # start desktop in dev mode (Tauri + Angular hot reload)
make build          # build everything
make fmt            # format all code
make status         # quick health check
```

Granular targets:

- **Test:** `test-rust`, `test-cli`, `test-angular`, `test-mcp`, `test-os`, `test-swift`, `test-desktop`, `test-e2e`, `test-e2e-plugin-tamper-release`, `test-entrypoint`, `test-desktop-build`, `test-e2e-desktop`, `test-e2e-all`, `setup-e2e-vms`
- **Build:** `build-runtime`, `build-cli`, `build-cli-release`, `build-desktop`, `build-native-macos`, `build-os-cli`, `build-mcp`, `build-angular`, `build-tauri`
- **Check:** `check-clippy`, `check-desktop-clippy`, `check-fmt`, `check-mcp`, `check-mcp-lint`, `check-angular`, `check-angular-lint`
- **Coverage:** `coverage-rust`, `coverage-mcp`, `coverage-angular`
- **Audit:** `audit-rust`, `audit-mcp`, `audit-desktop`
- **Download:** `download-lima`, `download-nodejs`, `download-wsl-resources` (+ `clean-*` variants)
- **Other:** `lint`, `install-deps`, `install-hooks`, `clean`

## Git Workflow

```bash
git add <files>
git commit -m "..."
git push
```

- **PRs always target `dev`** — never open a PR directly to `main`
- **`dev` -> `main`:** always squash merge in GitHub UI. PR title must be a conventional commit (e.g. `feat(runtime): add logging`). See [RELEASING.md](RELEASING.md#why-squash-merge-matters)
- **`chore(...)` is NOT allowed as a PR title to `main`** — release-please ignores `chore` commits, so a `chore` squash merge would collapse all bundled `feat`/`fix` commits into an invisible release (no version bump). Allowed types for `dev → main`: `feat, fix, perf, refactor, docs, ci, test, build, style, revert`. `chore` remains valid for PRs to `dev`.
- **Backmerge (`main` -> `dev`):** automated via `backmerge.yml` on release publish. Resets dev to main (force-push) to prevent ghost commit accumulation. Falls back to regular merge PR if dev has new commits since the release
- **`merge-strategy-check.yml`** enforces conventional commit PR titles on PRs to `main` (release-please and backmerge PRs are exempt)
- Link commits to GitHub issues when they exist

### Merge strategy table

| PR direction                  | Strategy            | Enforced by                         |
| ----------------------------- | ------------------- | ----------------------------------- |
| `feature/*` / `fix/*` → `dev` | Squash merge        | Convention                          |
| `dev` → `main`                | Squash merge        | `merge-strategy-check.yml`          |
| `main` → `dev` (backmerge)    | Force-push dev=main | `backmerge.yml` (automated)         |
| release-please PR on `main`   | Squash merge        | `merge-strategy-check.yml` (exempt) |

## Plugins

Plugins live in a **separate repository** (`speedwave-plugins`, sibling to this repo). Any change to the plugin contract in this repo **must stay compatible** with existing plugins, and vice versa. The contract surface is:

### Contract between Speedwave and plugins

| Contract element                   | SSOT location (this repo)                                                                                                                                                                                                                         | Consumer (plugins repo)                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **`plugin.json` manifest schema**  | `crates/speedwave-runtime/src/plugin.rs` → `PluginManifest` struct                                                                                                                                                                                | Every plugin's `plugin.json`                                                                                             |
| **Slug validation**                | `plugin.rs` → `validate_manifest()` regex `^[a-z][a-z0-9-]{0,63}$`                                                                                                                                                                                | Plugin slug values                                                                                                       |
| **Ed25519 signature**              | `crates/speedwave-runtime/src/signing.rs` → `verify_plugin_signature()`                                                                                                                                                                           | `SIGNATURE` file in each plugin ZIP                                                                                      |
| **Built-in service ID blocklist**  | `crates/speedwave-runtime/src/consts.rs` → `BUILT_IN_SERVICE_IDS`                                                                                                                                                                                 | Plugins must not use these slugs                                                                                         |
| **Compose injection**              | `crates/speedwave-runtime/src/compose.rs` → `apply_plugins()`, `generate_plugin_service()`                                                                                                                                                        | Plugin `Containerfile`, `port`, `extra_env`, `mem_limit`, `token_mount`                                                  |
| **Hub env var convention**         | `compose.rs` injects `WORKER_<SLUG_UPPER>_URL`; hyphens in slug normalize to underscores (e.g. `my-plugin` → `WORKER_MY_PLUGIN_URL`). Rust SSOT: `plugin::derive_worker_env`. TS SSOT: `mcp-servers/hub/src/worker-env.ts::deriveWorkerEnv`       | Hub discovers plugin workers by this env var                                                                             |
| **Token mount path**               | `compose.rs` → mounts `~/.speedwave/tokens/<project>/<service_id>/` as `/tokens`                                                                                                                                                                  | Plugin reads credentials from `/tokens/<key>`                                                                            |
| **Workspace mount path**           | `compose.rs` → mounts `{project_dir}` as `/workspace:rw`                                                                                                                                                                                          | Plugin reads/writes files at `/workspace/`                                                                               |
| **Claude-resources directory**     | `entrypoint.sh` → symlinks `claude-resources/{skills,commands,agents,hooks}`                                                                                                                                                                      | Plugin ships `claude-resources/` with skills/commands                                                                    |
| **`SPEEDWAVE_PLUGINS` env var**    | `compose.rs` → comma-separated enabled slugs in claude container                                                                                                                                                                                  | `entrypoint.sh` iterates this list                                                                                       |
| **Settings schema (JSON Schema)**  | `plugin.rs` → `settings_schema` field, `plugin_cmd.rs` → `plugin_save_settings`/`plugin_load_settings`                                                                                                                                            | Plugin defines `settings_schema` in manifest                                                                             |
| **`auth_fields[].description`**    | `plugin.rs` → `AuthFieldDef::description` (`Option<String>`) — optional help text rendered under each field's label in the Desktop credentials form                                                                                               | Plugin manifest may set `description` per `auth_fields[]` entry                                                          |
| **`auth_fields[].validation`**     | `plugin.rs` → `AuthFieldValidation { pattern, message? }` + `compile_anchored_pattern()` single gate (anchored full-match, RE2 subset). Capped by `consts::PLUGIN_AUTH_FIELD_PATTERN_MAX_LEN` (512 B). UI also enforces via `<input pattern>`     | Plugin manifest may set `validation` per `auth_fields[]` entry; ECMA-262 vs RE2 flavour difference documented in ADR-015 |
| **`auth_fields[].field_type`**     | `plugin.rs` → `ALLOWED_AUTH_FIELD_TYPES` (`text`, `password`, `textarea`); TS mirror `PluginAuthFieldType` in `plugin.ts` — test-enforced via `allowed_auth_field_types_match_ts_union`                                                           | Plugin manifest's `auth_fields[].field_type` must be one of these literals                                               |
| **`instructions`**                 | `plugin.rs` → `PluginManifest::instructions` (`Option<String>`, ≤ `consts::PLUGIN_INSTRUCTIONS_MAX_BYTES` = 16 KiB). `plugin_cmd.rs::instructions_for_ui` gates on `verified` + re-checks cap. Frontend renders via `marked` + Angular sanitizer  | Plugin manifest may ship a long-form Markdown setup/usage guide                                                          |
| **Container security constraints** | `compose.rs` → `cap_drop: ALL`, `no-new-privileges`, `read_only`, resource limits                                                                                                                                                                 | Plugins must work within these constraints                                                                               |
| **Tauri commands (Desktop UI)**    | `desktop/src-tauri/src/plugin_cmd.rs` → 10 commands (incl. `delete_plugin_credential_field` for per-field credential clearing); `desktop/src-tauri/src/main.rs` → `plugin_bridge_get_status`, `plugin_bridge_get_credentials`                     | Frontend models in `desktop/src/src/app/models/plugin.ts`                                                                |
| **Frontend models**                | `desktop/src/src/app/models/plugin.ts` → `PluginStatusEntry`, `PluginAuthField`, `PluginAuthFieldValidation`, `PluginAuthFieldType`, `PluginSaveCredentialsEvent`, `MAX_PLUGIN_CREDENTIAL_BYTES`, `PluginBridgeStatus`, `PluginBridgeCredentials` | Must match Tauri command return types; `PluginAuthFieldType` ↔ `plugin.rs::ALLOWED_AUTH_FIELD_TYPES` (test-enforced)     |
| **Line-ending policy**             | `.gitattributes` (root) — `* text=auto eol=lf`                                                                                                                                                                                                    | Plugin repos must enforce LF for `*.sh` shipped in `Containerfile`s                                                      |

### Breaking-change rule

Before changing any contract element above:

1. Check impact on plugins in the `speedwave-plugins` sibling repository
2. If breaking — coordinate: update plugins first, or add backward compat in this repo

### Plugin types

| Type                     | Has `service_id`? | Has `Containerfile`? | Provides                                             |
| ------------------------ | ----------------- | -------------------- | ---------------------------------------------------- |
| **MCP service plugin**   | Yes               | Yes (required)       | Containerized MCP worker + optional claude-resources |
| **Resource-only plugin** | No                | No                   | Skills, commands, agents, hooks only                 |

All plugins are toggled per-project via `integrations.plugins.<key>.enabled`, where `<key>` is `service_id` for MCP plugins or `slug` for plugins without `service_id`.

### Plugin lifecycle

- **Install:** `speedwave plugin install <path.zip>` → verify Ed25519 → validate manifest → extract to `~/.speedwave/plugins/<slug>/` → build image
- **Configure:** user fills `auth_fields` credentials → stored at `~/.speedwave/tokens/<project>/<service_id>/<key>` (perm `0o600`)
- **Enable/disable:** per-project toggle in config (`integrations.plugins.<slug>.enabled`)
- **Compose:** `apply_plugins()` generates plugin service in compose, injects `WORKER_<PLUGIN>_URL` into hub, mounts `/workspace:rw` and claude-resources
- **Hub discovery:** MCP Hub reads `ENABLED_SERVICES`, fetches tools from plugin workers via HTTP
- **Uninstall:** `plugin::remove_plugin()` removes `~/.speedwave/plugins/<slug>/`; Desktop `remove_plugin` command additionally cleans tokens and config entries

## Key Principles

- **KISS** — Speedwave is a thin orchestration layer. Prefer shelling out to existing tools over reimplementing. If >100 lines for something a CLI tool already does — stop.
- **YAGNI** — build only what's needed now. No speculative features or "future extensibility".
- **DRY** — `speedwave-runtime` = SSOT for container logic, `mcp-servers/shared/` = SSOT for MCP utilities. If same logic in two places — extract it.
- **SOLID** — `LockedRuntime` is the public façade wrapping `Box<dyn ContainerRuntime>` (`LimaRuntime`/`WslRuntime` are crate-internal). New platform = new impl of the internal trait, zero changes to public callers.
- **Boy Scout Rule** — leave code better than you found it. Fix bugs, typos, inconsistencies on sight.
- **Rule of Three** — don't abstract until you see the same pattern three times.

## Key Gotchas

- **NEVER run host `limactl`, `nerdctl`, or `docker` directly** — the host may have a separate Lima/nerdctl/Docker installation with unrelated VMs and containers. Always use Speedwave's own bundled binaries (resolved by `detect_runtime()`) or the `speedwave` CLI binary.
- **NEVER bypass git hooks** — no `--no-verify`, no `HUSKY=0`, no `core.hooksPath` tricks. Fix the issue or ask the user.
- **NEVER skip tests** — no `.skip`, `xit`, `xdescribe`. Fix the code or the test.
- **NEVER bypass branch protection or CI** — no `--admin`, no disabling checks. Fix CI.
- **NEVER leave TODO/FIXME/HACK/XXX markers** — fix now or report to user
- **NEVER leave @deprecated comments** — rewrite the code
- **NEVER use `#[allow(dead_code)]`** — dead code must be removed, not silenced. If a field/method is only used in tests, gate it behind `#[cfg(test)]`. If a struct field is required by serde but not read, prefix it with `_` and add `#[serde(rename = "original_name")]`.
- **NEVER use `#[allow(...)]` to suppress lint warnings** — fix the underlying issue instead. No `#[allow(missing_docs)]`, no `#[allow(clippy::unwrap_used)]`, no blanket `#![allow(...)]` at crate level. The only exception is `#[allow(clippy::unwrap_used, clippy::expect_used)]` on `#[cfg(test)] mod tests` blocks, where panicking on test failure is intentional.
- **Every code change must include tests** in the same commit — covering happy paths, edge cases, error paths, and state transitions (see `.claude/rules/git-workflow.md` for details)
- **Token isolation:** `/tokens` is `:ro` for all workers.
- **Container user:** runs as UID 1000:1000 on all supported platforms (macOS Lima, Windows WSL2). Linux as a host platform was dropped — see ADR-059.
- **Documentation is a delivery requirement** — same as tests. New feature -> update guide. Decision -> write ADR.

## References

- `docs/architecture/README.md` — system architecture overview
- `docs/architecture/security.md` — security model and threat analysis
- `docs/architecture/containers.md` — container topology and compose template
- `docs/architecture/platform-matrix.md` — macOS and Windows specifics
- `docs/contributing/development-setup.md` — dev environment and build targets
- `docs/contributing/testing.md` — test strategy, patterns, and coverage thresholds
- `docs/guides/cli.md` — CLI subcommands and usage
- `docs/guides/integrations.md` — MCP integrations and plugin system
- `docs/getting-started/configuration.md` — config schema and environment variables

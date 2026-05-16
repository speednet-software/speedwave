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
- **SSOT alignment:** `crates/speedwave-runtime/src/consts.rs::WSL_DISTRO_NAME` must stay aligned with the literal `"Speedwave"` in three other locations: (a) `desktop/src-tauri/windows/installer-hooks.nsh`, (b) `scripts/e2e-vm.sh`, (c) `docs/getting-started/installation.md`. Renaming the WSL distro = updating all four locations in the same commit.
- **SSOT alignment:** `crates/speedwave-runtime/src/consts.rs::DATA_DIR` (`.speedwave`) must stay aligned with the literal `".speedwave"` in `desktop/src-tauri/windows/installer-hooks.nsh` (`RMDir /r "$PROFILE\.speedwave"`). Renaming the data dir = updating both in the same commit.
- **SSOT alignment:** `crates/speedwave-runtime/src/tz.rs::detect_host_timezone()` (host TZ → `TZ` env injected into every service by `compose::inject_host_timezone`) must stay aligned with the `tzdata` package install in every container image: (a) `containers/Containerfile.claude` (apt), (b) `containers/mcp-servers/Containerfile.mcp-base` (apk), (c) `mcp-servers/hub/Containerfile` (apk), (d) every `mcp-servers/<service>/Dockerfile` (apk — `slack`, `sharepoint`, `redmine`, `gitlab`, `github`, `atlassian`; apt — `office`, which is Debian-based for LibreOffice). Adding a new worker image = installing `tzdata` in the same commit; otherwise `TZ` resolves to a numeric offset and Claude Code limit timestamps stay wrong.
- **SSOT alignment:** `crates/speedwave-runtime/src/consts.rs::RESERVED_ENV_KEYS` is the single list of env names plugins cannot inject via `extra_env` (`PORT` reserved by Speedwave + dynamic-linker / language-runtime / shell-environment hijack vectors — `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `PATH`, `HOME`, `IFS`, `BASH_ENV`, …). It is consumed by `plugin::validate_manifest` and documented in `docs/architecture/security.md`. Adding a new vector = editing `consts.rs` only; do not duplicate the list in `validate_manifest`.
- **SSOT alignment:** Plugin Ed25519 signature is a **runtime invariant**, not just an install gate (see [ADR-051](docs/adr/ADR-051-plugin-signature-runtime-verification.md)). Every read of a plugin tree goes through `signing::verify_plugin_signature_cached`; mutable per-plugin state (currently `image_pending`) lives at `<data_dir>/plugin-state/<slug>/`, never inside the signed tree. Adding a new mutable per-plugin file = adding it under `plugin-state/`, not under `plugins/<slug>/`; otherwise it invalidates the digest of every freshly-installed plugin.
- **Per-project isolation:** `~/.speedwave/tokens/<project>/<service>/` (read-only mount), `speedwave_<project>_network` (isolated network)
- **ContainerRuntime trait:** `Box<dyn ContainerRuntime>` — implementations: `LimaRuntime` (macOS), `WslRuntime` (Windows)
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

| Contract element                   | SSOT location (this repo)                                                                                                                                                                                                                   | Consumer (plugins repo)                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **`plugin.json` manifest schema**  | `crates/speedwave-runtime/src/plugin.rs` → `PluginManifest` struct                                                                                                                                                                          | Every plugin's `plugin.json`                                            |
| **Slug validation**                | `plugin.rs` → `validate_manifest()` regex `^[a-z][a-z0-9-]{0,63}$`                                                                                                                                                                          | Plugin slug values                                                      |
| **Ed25519 signature**              | `crates/speedwave-runtime/src/signing.rs` → `verify_plugin_signature()`                                                                                                                                                                     | `SIGNATURE` file in each plugin ZIP                                     |
| **Built-in service ID blocklist**  | `crates/speedwave-runtime/src/consts.rs` → `BUILT_IN_SERVICE_IDS`                                                                                                                                                                           | Plugins must not use these slugs                                        |
| **Compose injection**              | `crates/speedwave-runtime/src/compose.rs` → `apply_plugins()`, `generate_plugin_service()`                                                                                                                                                  | Plugin `Containerfile`, `port`, `extra_env`, `mem_limit`, `token_mount` |
| **Hub env var convention**         | `compose.rs` injects `WORKER_<SLUG_UPPER>_URL`; hyphens in slug normalize to underscores (e.g. `my-plugin` → `WORKER_MY_PLUGIN_URL`). Rust SSOT: `plugin::derive_worker_env`. TS SSOT: `mcp-servers/hub/src/worker-env.ts::deriveWorkerEnv` | Hub discovers plugin workers by this env var                            |
| **Token mount path**               | `compose.rs` → mounts `~/.speedwave/tokens/<project>/<service_id>/` as `/tokens`                                                                                                                                                            | Plugin reads credentials from `/tokens/<key>`                           |
| **Workspace mount path**           | `compose.rs` → mounts `{project_dir}` as `/workspace:rw`                                                                                                                                                                                    | Plugin reads/writes files at `/workspace/`                              |
| **Claude-resources directory**     | `entrypoint.sh` → symlinks `claude-resources/{skills,commands,agents,hooks}`                                                                                                                                                                | Plugin ships `claude-resources/` with skills/commands                   |
| **`SPEEDWAVE_PLUGINS` env var**    | `compose.rs` → comma-separated enabled slugs in claude container                                                                                                                                                                            | `entrypoint.sh` iterates this list                                      |
| **Settings schema (JSON Schema)**  | `plugin.rs` → `settings_schema` field, `plugin_cmd.rs` → `plugin_save_settings`/`plugin_load_settings`                                                                                                                                      | Plugin defines `settings_schema` in manifest                            |
| **Container security constraints** | `compose.rs` → `cap_drop: ALL`, `no-new-privileges`, `read_only`, resource limits                                                                                                                                                           | Plugins must work within these constraints                              |
| **Tauri commands (Desktop UI)**    | `desktop/src-tauri/src/plugin_cmd.rs` → 8 commands                                                                                                                                                                                          | Frontend models in `desktop/src/src/app/models/plugin.ts`               |
| **Frontend models**                | `desktop/src/src/app/models/plugin.ts` → `PluginStatusEntry`                                                                                                                                                                                | Must match Tauri command return types                                   |
| **Line-ending policy**             | `.gitattributes` (root) — `* text=auto eol=lf`                                                                                                                                                                                              | Plugin repos must enforce LF for `*.sh` shipped in `Containerfile`s     |

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
- **SOLID** — `Box<dyn ContainerRuntime>` with `LimaRuntime`/`WslRuntime`. New platform = new impl, zero changes to existing code.
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
- **SharePoint `:rw` token mount** — only exception to the `:ro` token mount rule (OAuth refresh, ADR-009). All MCP workers also mount `/workspace:rw` for file access
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

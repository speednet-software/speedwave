# Speedwave

Security-first AI platform connecting Claude Code with external services (Slack, SharePoint, GitLab, Redmine, Mail, Calendar). Claude runs in a hardened, token-free container — all service credentials are isolated per-worker. Additional VM-level isolation on macOS (Lima) and Windows (WSL2); rootless user namespaces on Linux. Ships as a single installable app (.dmg, .exe, .deb) without Docker Desktop. Two interfaces: CLI (terminal) and Desktop (chat UI).

## Key Architecture

- **SSOT: `crates/speedwave-runtime/`** — all Lima/WSL2/nerdctl logic. CLI and Desktop both import it as a Cargo dependency
- **SSOT: `mcp-servers/shared/`** — MCP protocol utilities shared by all servers
- **SSOT: `containers/compose.template.yml`** — container definitions. `render_compose()` generates per-project files
- **SSOT alignment:** `scripts/bundle-build-context.sh` IMAGES list must stay aligned with `crates/speedwave-runtime/src/build.rs` IMAGES constant
- **Per-project isolation:** `~/.speedwave/tokens/<project>/<service>/` (read-only mount), `speedwave_<project>_network` (isolated network)
- **ContainerRuntime trait:** `Box<dyn ContainerRuntime>` — implementations: `LimaRuntime`, `NerdctlRuntime`, `WslRuntime`
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

- **Test:** `test-rust`, `test-cli`, `test-angular`, `test-mcp`, `test-os`, `test-desktop`, `test-e2e`, `test-entrypoint`, `test-desktop-build`, `test-e2e-desktop`, `test-e2e-all`, `setup-e2e-vms`
- **Build:** `build-runtime`, `build-cli`, `build-desktop`, `build-native-macos`, `build-os-cli`, `build-mcp`, `build-angular`, `build-tauri`
- **Check:** `check-clippy`, `check-desktop-clippy`, `check-fmt`, `check-mcp`, `check-mcp-lint`, `check-angular`, `check-angular-lint`
- **Coverage:** `coverage-rust`, `coverage-mcp`, `coverage-angular`
- **Audit:** `audit-rust`, `audit-mcp`
- **Download:** `download-lima`, `download-nodejs`, `download-nerdctl-full`, `download-wsl-resources` (+ `clean-*` variants)
- **Other:** `lint`, `install-deps`, `install-hooks`, `clean`

## Git Workflow

```bash
git add <files>
git commit -m "..."
git push
```

- **PRs always target `dev`** — never open a PR directly to `main`
- **`dev` -> `main`:** always squash merge in GitHub UI. PR title must be a conventional commit (e.g. `feat(runtime): add logging`). See [RELEASING.md](RELEASING.md#why-squash-merge-matters)
- Link commits to GitHub issues when they exist

## Plugins

Plugins live in a **separate repository** (`speedwave-plugins`, sibling to this repo). Any change to the plugin contract in this repo **must stay compatible** with existing plugins, and vice versa. The contract surface is:

### Contract between Speedwave and plugins

| Contract element                   | SSOT location (this repo)                                                                              | Consumer (plugins repo)                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **`plugin.json` manifest schema**  | `crates/speedwave-runtime/src/plugin.rs` → `PluginManifest` struct                                     | Every plugin's `plugin.json`                                            |
| **Slug validation**                | `plugin.rs` → `validate_manifest()` regex `^[a-z][a-z0-9-]{0,63}$`                                     | Plugin slug values                                                      |
| **Ed25519 signature**              | `crates/speedwave-runtime/src/signing.rs` → `verify_plugin_signature()`                                | `SIGNATURE` file in each plugin ZIP                                     |
| **Built-in service ID blocklist**  | `crates/speedwave-runtime/src/consts.rs` → `BUILT_IN_SERVICE_IDS`                                      | Plugins must not use these slugs                                        |
| **Compose injection**              | `crates/speedwave-runtime/src/compose.rs` → `apply_plugins()`, `generate_plugin_service()`             | Plugin `Containerfile`, `port`, `extra_env`, `mem_limit`, `token_mount` |
| **Hub env var convention**         | `compose.rs` → `WORKER_<SLUG_UPPER>_URL` injection into hub                                            | Hub discovers plugin workers by this env var                            |
| **Token mount path**               | `compose.rs` → mounts `~/.speedwave/tokens/<project>/<service_id>/` as `/tokens`                       | Plugin reads credentials from `/tokens/<key>`                           |
| **Claude-resources directory**     | `entrypoint.sh` → symlinks `claude-resources/{skills,commands,agents,hooks}`                           | Plugin ships `claude-resources/` with skills/commands                   |
| **`SPEEDWAVE_PLUGINS` env var**    | `compose.rs` → comma-separated enabled slugs in claude container                                       | `entrypoint.sh` iterates this list                                      |
| **Settings schema (JSON Schema)**  | `plugin.rs` → `settings_schema` field, `plugin_cmd.rs` → `plugin_save_settings`/`plugin_load_settings` | Plugin defines `settings_schema` in manifest                            |
| **Container security constraints** | `compose.rs` → `cap_drop: ALL`, `no-new-privileges`, `read_only`, resource limits                      | Plugins must work within these constraints                              |
| **Tauri commands (Desktop UI)**    | `desktop/src-tauri/src/plugin_cmd.rs` → 8 commands                                                     | Frontend models in `desktop/src/src/app/models/plugin.ts`               |
| **Frontend models**                | `desktop/src/src/app/models/plugin.ts` → `PluginStatusEntry`                                           | Must match Tauri command return types                                   |

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
- **Compose:** `apply_plugins()` generates plugin service in compose, injects `WORKER_<PLUGIN>_URL` into hub, mounts claude-resources
- **Hub discovery:** MCP Hub reads `ENABLED_SERVICES`, fetches tools from plugin workers via HTTP
- **Uninstall:** `plugin::remove_plugin()` removes `~/.speedwave/plugins/<slug>/`; Desktop `remove_plugin` command additionally cleans tokens and config entries

## Key Principles

- **KISS** — Speedwave is a thin orchestration layer. Prefer shelling out to existing tools over reimplementing. If >100 lines for something a CLI tool already does — stop.
- **YAGNI** — build only what's needed now. No speculative features or "future extensibility".
- **DRY** — `speedwave-runtime` = SSOT for container logic, `mcp-servers/shared/` = SSOT for MCP utilities. If same logic in two places — extract it.
- **SOLID** — `Box<dyn ContainerRuntime>` with `LimaRuntime`/`NerdctlRuntime`/`WslRuntime`. New platform = new impl, zero changes to existing code.
- **Boy Scout Rule** — leave code better than you found it. Fix bugs, typos, inconsistencies on sight.
- **Rule of Three** — don't abstract until you see the same pattern three times.

## Key Gotchas

- **NEVER bypass git hooks** — no `--no-verify`, no `HUSKY=0`, no `core.hooksPath` tricks. Fix the issue or ask the user.
- **NEVER skip tests** — no `.skip`, `xit`, `xdescribe`. Fix the code or the test.
- **NEVER bypass branch protection or CI** — no `--admin`, no disabling checks. Fix CI.
- **NEVER leave TODO/FIXME/HACK/XXX markers** — fix now or report to user
- **NEVER leave @deprecated comments** — rewrite the code
- **Every code change must include tests** in the same commit
- **SharePoint `:rw` mount** — only exception to the `:ro` token mount rule (OAuth refresh, ADR-009)
- **Linux rootless:** container runs as UID 0 in user namespace (ADR-026)
- **Documentation is a delivery requirement** — same as tests. New feature -> update guide. Decision -> write ADR.

## References

- `docs/architecture/README.md` — system architecture overview
- `docs/architecture/security.md` — security model and threat analysis
- `docs/architecture/containers.md` — container topology and compose template
- `docs/architecture/platform-matrix.md` — macOS, Linux, Windows specifics
- `docs/contributing/development-setup.md` — dev environment and build targets
- `docs/contributing/testing.md` — test strategy, patterns, and coverage thresholds
- `docs/guides/cli.md` — CLI subcommands and usage
- `docs/guides/integrations.md` — MCP integrations and plugin system
- `docs/getting-started/configuration.md` — config schema and environment variables

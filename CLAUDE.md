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

## Addons

- `speedwave addon install <path.zip>` -> extracts to `~/.speedwave/addons/<name>/`
- Each addon: `addon.json` manifest + optional `compose.addon.yml`
- `compose.rs` merges addon compose fragments into the main compose document
- Addon services get injected `WORKER_<ADDON>_URL` in the hub environment

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
- `docs/guides/integrations.md` — MCP integrations and addon system
- `docs/getting-started/configuration.md` — config schema and environment variables

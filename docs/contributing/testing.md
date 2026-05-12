# Testing

Speedwave's test strategy covers Rust crates, MCP servers, CLI, desktop, and end-to-end scenarios.

## Running Tests

| Command                               | What it runs                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make test`                           | All tests (Rust + Angular + MCP + entrypoint + config + desktop-build + desktop)                                                                                                                                                                                                                      |
| `make test-rust`                      | Rust unit/integration tests (`speedwave-runtime` + `speedwave-cli`)                                                                                                                                                                                                                                   |
| `make test-cli`                       | CLI-specific tests                                                                                                                                                                                                                                                                                    |
| `make test-mcp`                       | All MCP workspace tests (shared, hub, slack, gitlab, etc.)                                                                                                                                                                                                                                            |
| `make test-os`                        | OS MCP server tests only                                                                                                                                                                                                                                                                              |
| `make test-mcp-office-py`             | Office worker's Python support-scripts against the real libraries (builds a throwaway venv); the vitest suite mocks these subprocesses, so this is the only gate that runs `docx_build`/`xlsx_build`/`pptx_build`/`pdf_ops`/`render_chart`/`weasyprint_render` for real. Runs in CI (the `test` job). |
| `make test-angular`                   | Angular desktop UI tests (`vitest run`)                                                                                                                                                                                                                                                               |
| `make test-e2e`                       | End-to-end CLI tests against the debug CLI: `speedwave.bats`, `plugin-tamper.bats`, `host-exec.bats` (requires `bats-core`)                                                                                                                                                                           |
| `make test-e2e-plugin-tamper-release` | Plugin tamper / signature-bypass bats against the **release** CLI — verifies the `SPEEDWAVE_ALLOW_UNSIGNED` debug bypass is compiled out (requires `bats-core`)                                                                                                                                       |
| `make test-entrypoint`                | Container entrypoint script tests (requires `bats-core`)                                                                                                                                                                                                                                              |
| `make test-swift`                     | Swift tests for native macOS CLI packages (macOS only)                                                                                                                                                                                                                                                |
| `make test-desktop`                   | Desktop integration tests (builds CLI, Angular, MCP, OS CLI first)                                                                                                                                                                                                                                    |
| `make test-desktop-build`             | Verifies desktop Tauri build succeeds                                                                                                                                                                                                                                                                 |
| `make test-desktop-config`            | Fast static checks: updater config fields + version consistency (local + CI)                                                                                                                                                                                                                          |
| `make test-release-gate`              | Release asset verification using `gh` shim (CI-only, not in `make test`)                                                                                                                                                                                                                              |

## Coverage

| Command                 | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `make coverage`         | Run all coverage checks (Rust + MCP + Angular)             |
| `make coverage-rust`    | Rust coverage with `cargo-llvm-cov` (fail-under 70% lines) |
| `make coverage-mcp`     | MCP workspace coverage with per-workspace thresholds       |
| `make coverage-angular` | Angular desktop coverage                                   |
| `make coverage-html`    | Generate HTML reports and open in browser                  |

### Coverage Thresholds

| Area                                               | Lines | Functions | Branches | Statements |
| -------------------------------------------------- | ----- | --------- | -------- | ---------- |
| Rust (`speedwave-runtime`, `speedwave-cli`)        | 70%   | —         | —        | —          |
| MCP Hub                                            | 50%   | 50%       | 40%      | 50%        |
| MCP Shared, Slack, OS, GitLab, Redmine, SharePoint | 60%   | 60%       | 50%      | 60%        |
| MCP GitHub, Atlassian, Office                      | 100%  | 100%      | 90%      | 100%       |
| Angular Desktop                                    | 40%   | 40%       | 30%      | 40%        |

Thresholds are enforced locally via vitest `coverage.thresholds` in each workspace's `vitest.config.ts` (SSOT for all threshold values — MCP and Angular alike) and in CI via `make coverage-mcp` / `make coverage-angular` / `vitest run --coverage`.

> **Office worker:** the 100% above is vitest coverage of the TypeScript orchestration layer (path policy, DSL guards, argv construction, error handling) — the subprocesses (`pandoc`, `soffice`, `weasyprint`, the Python scripts) are mocked there. The document-producing code itself is exercised by `make test-mcp-office-py`, which builds a real venv and re-opens the output with the libraries; that runs in the CI `test` job, not under `make coverage-mcp`.

## CI Pipeline

The `.github/workflows/test.yml` workflow runs on every push to `main`/`dev` and every PR to `main`/`dev`. It has five jobs:

1. **lint** — Rust clippy + format, Prettier, MCP type-check (tsc), MCP ESLint
2. **test** — Rust tests, MCP tests with coverage enforcement, Office Python script tests (`test-mcp-office-py`), entrypoint tests (bats)
3. **desktop** — Desktop clippy, Angular ESLint, Angular tests with coverage enforcement, updater config + version-consistency bats (`test-desktop-config`), release-gate bats with `gh` shim (`test-release-gate`), desktop bats (`test-desktop-build`), Tauri build check
4. **audit** — npm audit + cargo audit for all workspaces
5. **swift** (PRs only) — Builds native macOS CLI binaries as universal binaries (`scripts/build-native-macos.sh`) and runs Swift tests on `macos-latest`. Catches xcbuild/`@main` attribute issues that `swift build` (llbuild) tolerates locally

## Test Patterns

### Bats tests (`_tests/desktop/*.bats`)

Each bats file in `_tests/desktop/` starts with a header comment describing the regression it prevents. Read the header to understand the file's purpose. Files added in issue #26: `updater-config.bats` (tauri.conf.json updater-plugin shape + version-consistency across release-please-managed files) and new `@test` blocks in `release-workflow-signing.bats` (anti-removal guards for `publish-release` asset verification).

### MCP Hub Tool Tests

Pattern: `mcp-servers/hub/src/tools/gitlab/delete_tag.test.ts`

- Import `metadata` + `execute` from the handler
- **Metadata tests**: name, service, description, keywords, inputSchema (type, properties, required), outputSchema, example, inputExamples, annotations
- **Execute success cases**: mock the service client method with `vi.fn()`, verify return value and mock calls
- **Parameter validation**: missing, empty, null, undefined, falsy values
- **Error handling**: Error objects, non-Error with message/description, plain strings, undefined
- **Edge cases**: special characters, nested paths, large numeric IDs

### Angular Desktop Tests

Pattern: `desktop/src/src/app/settings/settings-update.spec.ts`

- Use `MockTauriService` from `src/app/testing/mock-tauri.service.ts`
- Configure `invokeHandler` to return test data per command
- Use `TestBed.configureTestingModule` with `{ provide: TauriService, useValue: mockTauri }`
- For components using `@tauri-apps/api/core` directly, mock via `vi.mock('@tauri-apps/api/core')`

### Rust Tests

- Unit tests live in `#[cfg(test)] mod tests` at the bottom of each source file
- Integration tests in `crates/*/tests/`
- Run with `cargo test` or `make test-rust`

## Desktop E2E Testing

Desktop E2E tests use WebdriverIO against a Tauri release binary. The app embeds `tauri-plugin-webdriver` which serves W3C WebDriver on port 4445 — no external driver binary is needed on any platform. On Linux, `xvfb` provides a headless X11 display.

### Running Desktop E2E Tests

| Command                 | Description                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `make test-e2e-desktop` | Build release binary on the current machine and run WebdriverIO E2E tests                         |
| `make test-e2e-all`     | Run E2E on all 3 platforms (macOS, Linux, Windows) via SSH to dedicated test machines in parallel |

Desktop E2E tests are **not** included in the default `make test` target because they have a significantly longer execution time.

### Local E2E (`make test-e2e-desktop`)

Builds the Tauri release binary natively on the current machine, then runs the WebdriverIO test suite against it. The app embeds `tauri-plugin-webdriver` on port 4445 on all platforms — no external `tauri-driver` is needed. On Linux, the Makefile launches `xvfb` for headless display.

Prerequisites depend on the platform:

- **macOS:** Xcode command-line tools, Rust, Node.js
- **Linux:** Rust, Node.js, `webkit2gtk` dev libraries, `xvfb`
- **Windows:** Rust, Node.js, WebView2

### Cross-platform E2E (`make test-e2e-all`)

Runs Desktop E2E tests on all three platforms via SSH to dedicated test machines. The machines are configured via environment variables: `SPEEDWAVE_LINUX_HOST`, `SPEEDWAVE_WINDOWS_HOST`, `SPEEDWAVE_MACOS_HOST`.

The `scripts/e2e-vm.sh` script orchestrates the following three-phase flow for each platform (Ubuntu, Windows, macOS) **in parallel**:

**All platforms (three-phase):**

1. **Phase 1 — Build artifact:** Copy repo source via rsync/tar-over-SSH, build release artifact (.deb on Linux, NSIS installer on Windows, .dmg on macOS), copy artifact back to host
2. **Phase 2 — Test on clean system:** Clean previous state (uninstall app, remove user data, stop containers). Copy only the artifact + E2E test suite. Install the artifact like a real user would, launch it, and run WebdriverIO tests against it
3. **Phase 3 — Second fresh install:** Clean ALL state again (same as Phase 2), reinstall the artifact, and run the full E2E suite a second time. This catches issues with leftover system-level state (systemd units, Lima cache, WSL2 distros, registry entries) that survive user-data removal

This three-phase approach verifies the app works correctly on both a first and second fresh install.

#### Test machine requirements

Each test machine must have the following pre-installed:

| Dependency     | All platforms             | Notes                                              |
| -------------- | ------------------------- | -------------------------------------------------- |
| Rust toolchain | `rustup` + stable channel | Cargo, rustc, cargo-tauri                          |
| Node.js        | LTS (v20+)                | npm included                                       |
| Git            | Latest                    | For submodule/dependency operations                |
| make           | GNU Make                  | `make` on Linux/macOS, via MSYS2 or similar on Win |
| SSH server     | OpenSSH                   | Required for remote access from the CI host        |

Platform-specific dependencies:

- **Linux (Ubuntu):** `webkit2gtk-4.1` dev libraries, `xvfb`, `libappindicator3-dev`
- **Windows:** WebView2 runtime, Visual Studio Build Tools (C++ workload), Git for Windows, native OpenSSH server (port 22), WSL2 with Ubuntu distro
- **macOS:** Xcode command-line tools (includes WebKit framework), Homebrew

Default host addresses are defined in `scripts/e2e-vm.sh`. Override with `SPEEDWAVE_LINUX_HOST`, `SPEEDWAVE_WINDOWS_HOST`, `SPEEDWAVE_MACOS_HOST` environment variables. The host repo path defaults to the git root of the script's location (override with `SPEEDWAVE_REPO_DIR`).

To run a single platform: `scripts/e2e-vm.sh ubuntu`, `scripts/e2e-vm.sh windows`, or `scripts/e2e-vm.sh macos`.

### Test Structure

```
desktop/e2e/
├── package.json           # WebdriverIO deps
├── wdio.conf.ts           # WebdriverIO config (port 4445, 45 min default timeout; individual tests override)
├── tsconfig.json          # TypeScript config
└── specs/
    ├── 01-app-lifecycle.spec.ts       # Basic launch: title, Angular root, setup wizard shown
    ├── 02-setup-wizard.spec.ts        # Full flow: welcome → all 6 steps → project form → redirect
    ├── 03-container-health.spec.ts    # Verify all containers running and healthy via get_health
    ├── 04-navigation.spec.ts          # Shell nav: Chat, Integrations, Settings routing
    ├── 05-settings.spec.ts            # Settings page: project name, LLM, reset, updates
    ├── 06-project-management.spec.ts  # Add second project, switch projects, verify health after each
    └── 07-factory-reset.spec.ts       # Factory reset: confirm → wipe state → app restart (MUST be last)
```

Specs run in numeric order. `02-setup-wizard` drives the entire setup wizard to completion (including filling the project form with name `e2e-test` and directory `/tmp/speedwave-e2e-project`). `03-container-health` verifies all containers are running and healthy by calling the `get_health` Tauri command — the same data source the System Health UI uses. Subsequent specs (`04-*` through `06-*`) depend on setup being complete and fail explicitly if the shell is not present — no silent early returns. `06-project-management` also verifies container health after adding a project and after switching projects (covering both backend code paths). `07-factory-reset` MUST be last — it triggers factory reset (wipes `~/.speedwave/`), and confirms `app.restart()` fires by polling until the new process is listening on port 4445.

### Selectors Convention

All interactive elements use `data-testid` attributes. Convention: `data-testid="<component>-<element>"` (e.g., `setup-start-btn`, `chat-send`, `nav-settings`).

In E2E tests: `await $('[data-testid="setup-start-btn"]').click()`.

See [ADR-024](../adr/ADR-024-e2e-testing-strategy.md) for full architectural rationale.

## Updater Pipeline Coverage

Three BATS files guard the release pipeline against silent failures (Issue #26). `updater-config.bats` statically validates `tauri.conf.json` fields (`createUpdaterArtifacts`, `endpoints`, `pubkey`, and bundle targets) using intentionally broken fixtures in `_tests/desktop/fixtures/`. `version-consistency.bats` reads `release-please-config.json` dynamically and asserts every version-bearing file matches `.release-please-manifest.json`, catching version drift before a release ships. `verify-release-assets.bats` tests `scripts/verify-release-assets.sh` end-to-end by shimming `gh` — the script checks that all 20 expected assets (including 6 `.sig` companions and `latest.json`) are present and valid. Additional cases (16-25) validate that the script rejects missing or malformed `VERSION`, `REPO`, `TAG_NAME`, and `RID` inputs with structured `::error::` annotations. The split between `test-desktop-config` (in `make test`) and `test-release-gate` (CI-only) keeps the `gh` shim surface away from everyday development builds.

## Host Exec — manual smoke (live Claude)

`host_exec` (ADR-054) is exercised at four levels in CI:

- **Unit / integration (Rust + TS + Angular):** `host_exec::validate_host_exec_config` (in `crates/speedwave-runtime/src/host_exec.rs`), the per-project process manager (`crates/speedwave-runtime/src/host_exec_process.rs` — two-projects two-ports, env-allowlist, login-shell PATH recovery, the chmod-600 file bookkeeping, stale-PID kill), the compose wiring (`compose.rs` — `WORKER_HOST_EXEC_URL` per project, `ENABLED_SERVICES` membership, the security-test exception), the Tauri settings commands (`host_exec_cmd.rs`), the CLI worker spawn (`crates/speedwave-cli/src/main.rs`), the TypeScript worker (`mcp-servers/host_exec/` — vitest, 100% lines/funcs/statements, `c8` branch ≥ 90% — incl. the process-tree `SIGKILL` on Unix, the per-stream output cap, the audit-log redaction), and the Angular Integrations card (`host-exec-config.component.spec.ts` — the danger modal that is the consent, the recipe editor, the docker-lifecycle warning, every validation path).
- **CLI E2E (bats — `make test-e2e`):** `_tests/e2e/host-exec.bats` verifies the wire-format contract end-to-end through the real `speedwave` binary — a valid camelCase user config survives `speedwave check` unchanged; a `hostExec` block in repo `.speedwave.json` is silently ignored; a malformed user config does not panic the CLI.
- **Desktop E2E (WebdriverIO — `make test-e2e-desktop`):** `desktop/e2e/specs/08-host-exec.spec.ts` drives the running Tauri app — the gated toggle / danger modal, the recipe-whitelist validation (shell-launcher / meta-tool / reserved-env / `cwdSub` escape / duplicate-name rejection), the snake_case → camelCase round-trip through `host_exec_save_settings` / `host_exec_load_settings`, and the `host_exec_resolve_executable` `which`-style PATH probe.
- **Manual smoke (live Claude — see below):** the scenarios that require a real Anthropic API turn through the MCP hub and a live worker process.

### Live-Claude scenarios (not in CI)

These verify Claude's view of `host_exec` — what comes back in a tool result, that recipes run **without a prompt** (enabling Host Exec is the consent), and that two projects do not cross-talk. They are NOT in `make test-e2e` / `test-e2e-desktop` because they require a real Anthropic API key (cost + flakiness). The non-Claude invariants they would assert are already covered by the unit/integration suite above; running them is a release-gate smoke, not a CI gate. **Run them under both the Desktop app AND the `speedwave` CLI.**

```bash
# Prereqs:  SPEEDWAVE_DATA_DIR=~/.speedwave-smoke ;  Anthropic OAuth or API key
# already wired into Claude Code inside the container ;  Speedwave running
# (Desktop, and separately the `speedwave` CLI).  Two projects added (A and B),
# each a repo where Docker is available (or any toolchain).

# Scenario (a) — happy-path round-trip, NO prompt
#   In project A:  Integrations → Host Exec → enable (confirm the danger
#   modal) → add  { name: "docker_ps", exec: "docker", args: ["ps"] }.
#   Ask Claude:  "Show the running docker containers."  Expected:
#     - Claude does search_tools → execute_code({code:"return await
#       host_exec.dockerPs()"}) — NO confirmation dialog appears (correct;
#       there is no per-call confirmation).
#     - Claude reports a structured result with status="exited", exitCode 0,
#       the `docker ps` output in stdout, and durationMs.
#   Then run the SAME thing via the CLI:  `speedwave` in project A's dir, ask
#   Claude to run the docker_ps recipe — it works (the CLI spawned the worker
#   before compose_up; the hub got WORKER_HOST_EXEC_URL).

# Scenario (d) — exit ≠ 0 is a successful ToolResult, not a tool error
#   Add a recipe that intentionally fails:
#       { name: "fail_now", exec: "./gradlew", args: ["nonexistent-task"] }
#   Ask Claude to run it.  Expected:  Claude reports a *successful* tool
#   result with status="exited", exitCode=1, the error in stderr, and NO MCP
#   tool error.  Tool errors are reserved for unknown recipe, regex fail,
#   cwdSub escape, and spawn_error.

# Audit log:  every run is recorded — confirm there is one line per recipe
# call (recipe name, full argv, cwd, exitCode, status):
#       cat $SPEEDWAVE_DATA_DIR/host-exec/<project>/log

# Scenario (f) — two projects, two workers, no cross-talk
#   In both project A and project B:  enable Host Exec + add a recipe.
#   Confirm that
#       $SPEEDWAVE_DATA_DIR/host-exec/<A>/{port,pid,auth-token}
#       $SPEEDWAVE_DATA_DIR/host-exec/<B>/{port,pid,auth-token}
#   each contain DIFFERENT values (`cat` each file).  Switch to project A in
#   the Desktop UI, ask Claude to run the recipe — the spawn line in A's log
#   appears, NOT in B's.  Switch to B — symmetric.  Throughout,
#       ps aux | grep 'host_exec/dist/index.js' | grep -v grep
#   shows two distinct Node processes.
```

The "definition of done" for a Host Exec release: all four CI levels green, plus a clean run of the live-Claude scenarios above against the release build, under both Desktop and the CLI.

## See Also

- [Contributing](../../CONTRIBUTING.md)

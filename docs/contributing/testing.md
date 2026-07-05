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
| `make test-e2e`                       | End-to-end CLI tests against the debug CLI: `speedwave.bats`, `plugin-tamper.bats` (requires `bats-core`)                                                                                                                                                                                             |
| `make test-e2e-plugin-tamper-release` | Plugin tamper / signature-bypass bats against the **release** CLI — verifies the `SPEEDWAVE_ALLOW_UNSIGNED` debug bypass is compiled out (requires `bats-core`)                                                                                                                                       |
| `make test-entrypoint`                | Container entrypoint script tests (requires `bats-core`)                                                                                                                                                                                                                                              |
| `make test-swift`                     | Swift tests for native macOS CLI packages (macOS only)                                                                                                                                                                                                                                                |
| `make test-desktop`                   | Desktop integration tests (builds CLI, Angular, MCP, OS CLI first)                                                                                                                                                                                                                                    |
| `make test-desktop-build`             | Verifies desktop Tauri build succeeds                                                                                                                                                                                                                                                                 |
| `make test-desktop-config`            | Fast static checks: updater config fields + version consistency (local + CI)                                                                                                                                                                                                                          |
| `make test-release-gate`              | Release asset verification using `gh` shim (CI-only, not in `make test`)                                                                                                                                                                                                                              |
| `make check-fmt`                      | Format check only (Rust root + `desktop/src-tauri` + `containers/proxy`, plus Prettier). No builds, no tests. This is what the pre-push hook runs.                                                                                                                                                    |

## Local vs CI

Running the full test suite locally is **optional**. The required CI checks on every PR to `dev`/`main` run the whole suite across **both** macOS and Windows and are what gate a merge — a green local run on one OS cannot validate the other platform's paths. To keep pushes fast, the `pre-push` git hook runs only `make check-fmt` (a fast format check, no builds or tests); `pre-commit` still runs the gitleaks secret scan and `lint-staged`, and `commit-msg` still runs commitlint. Write tests alongside every change and run the targets you touched (e.g. `make test-rust`); reach for the full `make test` / `make check` only when you want a thorough local pass.

## Coverage

| Command                 | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `make coverage`         | Run all coverage checks (Rust + MCP + Angular)             |
| `make coverage-rust`    | Rust coverage with `cargo-llvm-cov` (fail-under 70% lines) |
| `make coverage-mcp`     | MCP workspace coverage with per-workspace thresholds       |
| `make coverage-angular` | Angular desktop coverage                                   |
| `make coverage-html`    | Generate HTML reports and open in browser                  |

### Coverage Thresholds

| Area                                                      | Lines | Functions | Branches | Statements |
| --------------------------------------------------------- | ----- | --------- | -------- | ---------- |
| Rust (`speedwave-runtime`, `speedwave-cli`)               | 70%   | —         | —        | —          |
| MCP Hub                                                   | 100%  | 100%      | 90%      | 100%       |
| MCP Shared                                                | 99%   | 96%       | 95%      | 99%        |
| MCP Slack, OS, GitLab, Redmine, GitHub, Atlassian, Office | 100%  | 100%      | 90%      | 100%       |
| MCP OAuth                                                 | 100%  | 100%      | 90%      | 100%       |
| MCP Context7 (vitest config lands in a follow-up wave)    | 100%  | 100%      | 90%      | 100%       |
| MCP SharePoint                                            | 98%   | 98%       | 90%      | 98%        |
| Angular Desktop                                           | —     | —         | —        | —          |

Thresholds are enforced locally via vitest `coverage.thresholds` in each workspace's `vitest.config.ts` (SSOT for all threshold values — MCP and Angular alike) and in CI via `make coverage-mcp` / `make coverage-angular` / `vitest run --coverage`.

> **Office worker:** the 100% above is vitest coverage of the TypeScript orchestration layer (path policy, DSL guards, argv construction, error handling) — the subprocesses (`pandoc`, `soffice`, `weasyprint`, the Python scripts) are mocked there. The document-producing code itself is exercised by `make test-mcp-office-py`, which builds a real venv and re-opens the output with the libraries; that runs in the CI `test` job, not under `make coverage-mcp`.

## CI Pipeline

The `.github/workflows/test.yml` workflow runs on every push to `main`/`dev` and every PR to `main`/`dev`. It has seven jobs:

1. **lint** — Rust clippy + format, Prettier, MCP type-check (tsc), MCP ESLint
2. **test** — Rust tests (`test-rust`, which also runs the audio-transcription feature tests), proxy tests (`test-proxy`), MCP tests with coverage enforcement, the mcp-os bundle upgrade-path test (`test-mcp-os-bundle`), Office Python script tests (`test-mcp-office-py`), entrypoint tests (bats), CI-workflow tests (`test-ci`, the PR-title validator matrix)
3. **desktop** — Desktop clippy, desktop unit tests (`test-desktop-run`), Angular ESLint, Angular tests with coverage enforcement, updater config + version-consistency bats (`test-desktop-config`), release-gate bats with `gh` shim (`test-release-gate`), desktop bats (`test-desktop-build`), Tauri build check
4. **audit** — npm audit + cargo audit for all workspaces
5. **swift** (PRs only) — Builds native macOS CLI binaries as universal binaries (`scripts/build-native-macos.sh`) and runs Swift tests on `macos-latest`. Catches xcbuild/`@main` attribute issues that `swift build` (llbuild) tolerates locally
6. **runtime-windows** — Runs `cargo test -p speedwave-runtime --lib` for the modules whose behaviour is Windows-specific (`runtime::lima`, `runtime::wsl`, `build`, `host_mcp_process::job_object` — kill-on-close, ADR-048 — and `binary`) plus `cargo test -p speedwave-cli --bins`, on `windows-latest`, then verifies `.gitattributes` keeps `containers/*.sh` LF-clean after a `core.autocrlf=true` checkout
7. **desktop-windows-check** — Runs `cargo check --all-targets` for `speedwave-desktop` on `windows-latest` with stubbed bundle resources (`scripts/create-desktop-stubs.sh`) to catch Windows-only compile errors, then executes the crate's `#[cfg(windows)]` unit tests by name (a bare `--bins` would pull in cross-platform tests whose fixtures assume POSIX paths and fail on Windows)

## Test Patterns

### Bats tests (`_tests/desktop/*.bats`)

Each bats file in `_tests/desktop/` starts with a header comment describing the regression it prevents. Read the header to understand the file's purpose. Files added in issue #26: `updater-config.bats` (tauri.conf.json updater-plugin shape + version-consistency across release-please-managed files) and new `@test` blocks in `release-workflow-signing.bats` (anti-removal guards for `publish-release` asset verification).

### MCP Hub Tool Tests

Pattern: `mcp-servers/gitlab/src/tools/release.test.ts`

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

Desktop E2E tests use WebdriverIO against a Tauri release binary. The app embeds `tauri-plugin-webdriver` which serves W3C WebDriver on port 4445 — no external driver binary is needed on any platform.

### Running Desktop E2E Tests

| Command                 | Description                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `make test-e2e-desktop` | Build release binary on the current machine and run WebdriverIO E2E tests                 |
| `make test-e2e-all`     | Run E2E on both platforms (macOS, Windows) via SSH to dedicated test machines in parallel |

Desktop E2E tests are **not** included in the default `make test` target because they have a significantly longer execution time.

### Local E2E (`make test-e2e-desktop`)

Builds the Tauri release binary natively on the current machine, then runs the WebdriverIO test suite against it. The app embeds `tauri-plugin-webdriver` on port 4445 on all platforms — no external `tauri-driver` is needed.

Prerequisites depend on the platform:

- **macOS:** Xcode command-line tools, Rust, Node.js
- **Windows:** Rust, Node.js, WebView2

### Cross-platform E2E (`make test-e2e-all`)

Runs Desktop E2E tests on both supported platforms via SSH to dedicated test machines. The machines are configured via environment variables: `SPEEDWAVE_WINDOWS_HOST`, `SPEEDWAVE_MACOS_HOST`.

The `scripts/e2e-vm.sh` script orchestrates the following three-phase flow for each platform (Windows, macOS) **in parallel**:

**All platforms (three-phase):**

1. **Phase 1 — Build artifact:** Copy repo source via rsync/tar-over-SSH, build release artifact (NSIS installer on Windows, .dmg on macOS), copy artifact back to host
2. **Phase 2 — Test on clean system:** Clean previous state (uninstall app, remove user data, stop containers). Copy only the artifact + E2E test suite. Install the artifact like a real user would, launch it, and run WebdriverIO tests against it
3. **Phase 3 — Second fresh install:** Clean ALL state again (same as Phase 2), reinstall the artifact, and run the full E2E suite a second time. This catches issues with leftover system-level state (Lima cache, WSL2 distros, registry entries) that survive user-data removal

This three-phase approach verifies the app works correctly on both a first and second fresh install.

#### Test machine requirements

Each test machine must have the following pre-installed:

| Dependency     | All platforms             | Notes                                        |
| -------------- | ------------------------- | -------------------------------------------- |
| Rust toolchain | `rustup` + stable channel | Cargo, rustc, cargo-tauri                    |
| Node.js        | LTS (v20+)                | npm included                                 |
| Git            | Latest                    | For submodule/dependency operations          |
| make           | GNU Make                  | `make` on macOS, via MSYS2 or similar on Win |
| SSH server     | OpenSSH                   | Required for remote access from the CI host  |

Platform-specific dependencies:

- **Windows:** WebView2 runtime, Visual Studio Build Tools (C++ workload), Git for Windows, native OpenSSH server (port 22), WSL2 with Ubuntu distro
- **macOS:** Xcode command-line tools (includes WebKit framework), Homebrew

Default host addresses are defined in `scripts/e2e-vm.sh`. Override with `SPEEDWAVE_WINDOWS_HOST`, `SPEEDWAVE_MACOS_HOST` environment variables. The host repo path defaults to the git root of the script's location (override with `SPEEDWAVE_REPO_DIR`).

To run a single platform: `scripts/e2e-vm.sh windows` or `scripts/e2e-vm.sh macos`.

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

Three BATS files guard the release pipeline against silent failures (Issue #26). `updater-config.bats` statically validates `tauri.conf.json` fields (`createUpdaterArtifacts`, `endpoints`, `pubkey`, and bundle targets) using intentionally broken fixtures in `_tests/desktop/fixtures/`. `version-consistency.bats` reads `release-please-config.json` dynamically and asserts every version-bearing file matches `.release-please-manifest.json`, catching version drift before a release ships. `verify-release-assets.bats` tests `scripts/verify-release-assets.sh` end-to-end by shimming `gh` — the script checks that all 18 expected assets (including 6 `.sig` companions and `latest.json`) are present and valid. Additional cases (16-25) validate that the script rejects missing or malformed `VERSION`, `REPO`, `TAG_NAME`, and `RID` inputs with structured `::error::` annotations. The split between `test-desktop-config` (in `make test`) and `test-release-gate` (CI-only) keeps the `gh` shim surface away from everyday development builds.

## See Also

- [Contributing](../../CONTRIBUTING.md)

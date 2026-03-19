# Testing

Speedwave's test strategy covers Rust crates, MCP servers, CLI, desktop, and end-to-end scenarios.

## Running Tests

| Command                   | What it runs                                                        |
| ------------------------- | ------------------------------------------------------------------- |
| `make test`               | All tests (Rust + MCP + entrypoint)                                 |
| `make test-rust`          | Rust unit/integration tests (`speedwave-runtime` + `speedwave-cli`) |
| `make test-cli`           | CLI-specific tests                                                  |
| `make test-mcp`           | All MCP workspace tests (shared, hub, slack, gitlab, etc.)          |
| `make test-os`            | OS MCP server tests only                                            |
| `make test-angular`       | Angular desktop UI tests (`vitest run`)                             |
| `make test-e2e`           | End-to-end CLI tests (requires `bats-core`)                         |
| `make test-entrypoint`    | Container entrypoint script tests (requires `bats-core`)            |
| `make test-swift`         | Swift tests for native macOS CLI packages (macOS only)              |
| `make test-desktop-build` | Verifies desktop Tauri build succeeds                               |

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
| Angular Desktop                                    | 40%   | 40%       | 30%      | 40%        |

Thresholds are enforced locally via vitest `coverage.thresholds` in each workspace's `vitest.config.ts` (SSOT for all threshold values — MCP and Angular alike) and in CI via `make coverage-mcp` / `make coverage-angular` / `vitest run --coverage`.

## CI Pipeline

The `.github/workflows/test.yml` workflow runs on every push to `main` and every PR to `main`/`dev`. It has five jobs:

1. **lint** — Rust clippy + format, Prettier, MCP type-check (tsc), MCP ESLint
2. **test** — Rust tests, MCP tests with coverage enforcement, entrypoint tests (bats)
3. **desktop** — Desktop clippy, Angular ESLint, Angular tests with coverage enforcement, Tauri build check
4. **audit** — npm audit + cargo audit for all workspaces
5. **swift** (PRs only) — Builds native macOS CLI binaries as universal binaries (`scripts/build-native-macos.sh`) and runs Swift tests on `macos-latest`. Catches xcbuild/`@main` attribute issues that `swift build` (llbuild) tolerates locally

## Test Patterns

### MCP Hub Tool Tests

Pattern: `mcp-servers/hub/src/tools/gitlab/delete_tag.test.ts`

- Import `metadata` + `execute` from the handler
- **Metadata tests**: name, category, service, description, keywords, inputSchema (type, properties, required), outputSchema, example, inputExamples, deferLoading
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

## See Also

- [Contributing](../../CONTRIBUTING.md)

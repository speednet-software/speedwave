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
| MCP Hub, Gemini                                    | 50%   | 50%       | 40%      | 50%        |
| MCP Shared, Slack, OS, GitLab, Redmine, SharePoint | 60%   | 60%       | 50%      | 60%        |
| Angular Desktop                                    | 40%   | 40%       | 30%      | 40%        |

Thresholds are enforced locally via vitest `coverage.thresholds` in each workspace's `vitest.config.ts` (SSOT for all threshold values — MCP and Angular alike) and in CI via `make coverage-mcp` / `make coverage-angular` / `vitest run --coverage`.

## CI Pipeline

The `.github/workflows/test.yml` workflow runs on every push to `main` and every PR to `main`/`dev`. It has four jobs:

1. **lint** — Rust clippy + format, Prettier, MCP type-check (tsc), MCP ESLint
2. **test** — Rust tests, MCP tests with coverage enforcement, entrypoint tests (bats)
3. **desktop** — Desktop clippy, Angular ESLint, Angular tests with coverage enforcement, Tauri build check
4. **audit** — npm audit + cargo audit for all workspaces

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

## See Also

- [Contributing](../../CONTRIBUTING.md)

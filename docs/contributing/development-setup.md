# Development Setup

How to set up the Speedwave development environment.

## Prerequisites

- **Rust** — stable toolchain via `rustup`
- **Node.js** — LTS (v20+) with npm
- **Platform tools** — Xcode CLI tools (macOS), `webkit2gtk` dev libraries (Linux), Visual Studio Build Tools (Windows)

Run `make setup-dev` to check prerequisites and install all dependencies automatically.

## Building

**Use `Makefile` for all build/test/check operations.** Do not call cargo/npm directly — the Makefile ensures correct working directories and consistent flags.

### Primary targets

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

### Granular targets

- **Test:** `test-rust`, `test-cli`, `test-angular`, `test-mcp`, `test-os`, `test-desktop`, `test-e2e`, `test-entrypoint`, `test-desktop-build`, `test-e2e-desktop`, `test-e2e-all`, `setup-e2e-vms`
- **Build:** `build-runtime`, `build-cli`, `build-desktop`, `build-native-macos`, `build-os-cli`, `build-mcp`, `build-angular`, `build-tauri`
- **Check:** `check-clippy`, `check-desktop-clippy`, `check-fmt`, `check-mcp`, `check-mcp-lint`, `check-angular`, `check-angular-lint`
- **Coverage:** `coverage-rust`, `coverage-mcp`, `coverage-angular`
- **Audit:** `audit-rust`, `audit-mcp`
- **Download:** `download-lima`, `download-nodejs`, `download-nerdctl-full`, `download-wsl-resources` (+ `clean-*` variants)
- **Other:** `lint`, `install-deps`, `install-hooks`, `clean`

Key build targets related to the CLI:

- `make build-cli` — builds the CLI binary (`target/debug/speedwave`)
- `make build-tauri` — builds the Tauri desktop app; depends on `build-cli` and copies the CLI binary into `desktop/src-tauri/cli/` for bundling
- `make build` — full build including CLI, MCP servers, Angular frontend

The `desktop/src-tauri/cli/` directory is in `.gitignore` — it is populated at build time only.

## Running in Dev Mode

`make dev` automatically builds the CLI first and copies it to `desktop/src-tauri/cli/` before starting Tauri dev mode. This ensures the "Open Terminal" feature works during development.

## See Also

- [Contributing](../../CONTRIBUTING.md)

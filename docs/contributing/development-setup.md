# Development Setup

How to set up the Speedwave development environment.

## Prerequisites

<!-- Content to be written: Rust, Node.js, platform-specific tools, make setup-dev -->

## Building

<!-- Content to be written: make build, granular targets, first-time setup -->

Key build targets related to the CLI:

- `make build-cli` — builds the CLI binary (`target/debug/speedwave`)
- `make build-tauri` — builds the Tauri desktop app; depends on `build-cli` and copies the CLI binary into `desktop/src-tauri/cli/` for bundling
- `make build` — full build including CLI, MCP servers, Angular frontend

The `desktop/src-tauri/cli/` directory is in `.gitignore` — it is populated at build time only.

## Running in Dev Mode

<!-- Content to be written: make dev, Tauri + Angular hot reload -->

`make dev` automatically builds the CLI first and copies it to `desktop/src-tauri/cli/` before starting Tauri dev mode. This ensures the "Open Terminal" feature works during development.

## See Also

- [Contributing](../../CONTRIBUTING.md)

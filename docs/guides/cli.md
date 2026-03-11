# CLI Usage

The `speedwave` CLI provides terminal-based access to Claude Code with all Speedwave integrations.

## Prerequisites

The CLI requires the Speedwave Desktop app to be installed and the setup wizard to have completed at least once. The Desktop app's setup wizard copies the bundled CLI binary to the user's PATH automatically:

- **macOS / Linux:** `~/.local/bin/speedwave`
- **Windows:** `%USERPROFILE%\.speedwave\bin\speedwave.exe`

The CLI is re-linked on every Desktop startup, so Desktop updates automatically distribute the matching CLI version.

## Basic Usage

The CLI uses the current working directory as project context:

```bash
cd ~/projects/acme && speedwave
```

This starts containers for the project, then launches an interactive Claude Code session inside the Claude container with all configured MCP integrations available.

## Subcommands

```
speedwave                      # default: compose_up + exec claude in container
speedwave check                # run security checks, exit 0/1
speedwave update               # rebuild images + recreate containers
speedwave self-update          # download latest CLI from GitHub Releases
speedwave addon install <path> # install addon from ZIP
```

- **`speedwave`** (no subcommand) — starts containers via `compose_up`, then exec's into the Claude container for an interactive session
- **`speedwave check`** — validates the environment (Lima/WSL2/nerdctl availability, container health), exits 0 on success or 1 on failure
- **`speedwave update`** — rebuilds container images and recreates containers with the latest configuration
- **`speedwave self-update`** — downloads the latest CLI binary from GitHub Releases and replaces the current binary
- **`speedwave addon install <path.zip>`** — extracts the addon to `~/.speedwave/addons/<name>/`, registers it, and merges its compose fragment

## See Also

- [ADR-005: Two Interfaces — CLI and Desktop](../adr/ADR-005-two-interfaces-cli-and-desktop.md)
- [ADR-016: Cross-Platform CLI PATH](../adr/ADR-016-cross-platform-cli-path.md)

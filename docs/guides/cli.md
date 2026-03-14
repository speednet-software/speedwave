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
speedwave init [name]          # register CWD as a project
speedwave check                # run security checks, exit 0/1
speedwave update               # rebuild images + recreate containers
speedwave self-update          # download latest CLI from GitHub Releases
speedwave plugin install <path.zip>  # install plugin from signed ZIP
speedwave plugin list                # list installed plugins with status
speedwave plugin remove <slug>       # uninstall a plugin
speedwave plugin enable <slug> --project <name>   # enable plugin for a project
speedwave plugin disable <slug> --project <name>  # disable plugin for a project
```

- **`speedwave`** (no subcommand) — starts containers via `compose_up`, then exec's into the Claude container for an interactive session
- **`speedwave init [name]`** — registers the current working directory as a Speedwave project. If `name` is omitted, the directory name is used. The project is set as active. Project names must be lowercase (`a-z`, `0-9`, `_`, `.`, `-`), start with a letter or digit, and be at most 63 characters. Example:
  ```bash
  cd ~/projects/acme && speedwave init        # registers as "acme"
  cd ~/projects/acme && speedwave init my-app # registers as "my-app"
  ```
  If the directory is already registered, prints the existing project name and exits.
- **`speedwave check`** — validates the environment (Lima/WSL2/nerdctl availability, container health), exits 0 on success or 1 on failure
- **`speedwave update`** — rebuilds container images and recreates containers with the latest configuration
- **`speedwave self-update`** — downloads the latest CLI binary from GitHub Releases and replaces the current binary
- **`speedwave plugin install <path.zip>`** — verifies the Ed25519 signature, extracts the plugin to `~/.speedwave/plugins/<slug>/`, and registers it
- **`speedwave plugin list`** — lists all installed plugins, showing name, version, and enabled/configured status per project
- **`speedwave plugin remove <slug>`** — removes the plugin directory from `~/.speedwave/plugins/<slug>/`. Note: credential files at `~/.speedwave/tokens/<project>/<slug>/` and config entries are **not** cleaned by the CLI — use the Desktop UI for full cleanup, or remove token directories manually
- **`speedwave plugin enable <slug> --project <name>`** — enables a plugin for a specific project in user config
- **`speedwave plugin disable <slug> --project <name>`** — disables a plugin for a specific project in user config

## Project Resolution

When running `speedwave` (no subcommand), the CLI resolves which project to use:

1. **Exact path match** — CWD matches a registered project directory
2. **Subdirectory match** — CWD is inside a registered project directory (longest prefix wins for nested projects)
3. **Fallback** — uses `active_project` from config (with a warning and hint to run `speedwave init`)

All path comparisons use canonicalized paths (symlinks resolved, trailing slashes normalized).

## See Also

- [ADR-005: Two Interfaces — CLI and Desktop](../adr/ADR-005-two-interfaces-cli-and-desktop.md)
- [ADR-016: Cross-Platform CLI PATH](../adr/ADR-016-cross-platform-cli-path.md)

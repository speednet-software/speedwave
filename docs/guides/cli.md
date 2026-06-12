# CLI Usage

The `speedwave` CLI provides terminal-based access to Claude Code with all Speedwave integrations.

## Prerequisites

The CLI requires the Speedwave Desktop app to be installed and the setup wizard to have completed at least once. The Desktop app's setup wizard copies the bundled CLI binary to the user's PATH automatically:

- **macOS:** `~/.local/bin/speedwave`
- **Windows:** `%USERPROFILE%\.speedwave\bin\speedwave.exe`

The CLI is re-linked on every Desktop startup, so Desktop updates automatically distribute the matching CLI version.

## Basic Usage

Bare `speedwave` runs the **active project** — the one selected in the Desktop project switcher (`active_project` in config). The working directory does not select the project; pass `--project <name>` to target a different one:

```bash
speedwave                      # run the active project (Desktop selector)
speedwave --project acme       # run a specific project from any directory
```

This renders compose for the current bundle, starts containers for the project, then launches an interactive Claude Code session inside the Claude container with all configured MCP integrations available.

## Subcommands

```
speedwave [--project <name>]   # default: compose_up + exec claude for the active project
speedwave init [name]          # register CWD as a project
speedwave login [--project <name>]   # OAuth login: opens claude TUI for /login
speedwave logout [--project <name>]  # delete Claude credentials for the project
speedwave check                # run OS prereq + security checks, exit 0/1
speedwave update [--project <name>]  # rebuild bundle images + recreate containers
speedwave self-update          # download latest CLI from GitHub Releases
speedwave plugin install <path.zip>  # install plugin from signed ZIP
speedwave plugin list                # list installed plugins with status
speedwave plugin remove <slug>       # uninstall a plugin
speedwave plugin enable <service_id> --project <name>   # enable plugin for a project
speedwave plugin disable <service_id> --project <name>  # disable plugin for a project
speedwave --help | -h | help   # print usage and exit (no runtime required)
```

- **`speedwave [--project <name>]`** (no subcommand) — starts containers via `compose_up`, then exec's into the Claude container for an interactive session. Targets the active project (the Desktop selector) by default; `--project <name>` overrides it from any directory.
- **`speedwave init [name]`** — registers the current working directory as a Speedwave project. If `name` is omitted, the directory name is used. The project is set as active. Project names must be lowercase (`a-z`, `0-9`, `_`, `.`, `-`), start with a letter or digit, and be at most 63 characters. Example:
  ```bash
  cd ~/projects/acme && speedwave init        # registers as "acme"
  cd ~/projects/acme && speedwave init my-app # registers as "my-app"
  ```
  If the directory is already registered, prints the existing project name and exits.
- **`speedwave login [--project <name>]`** — runs `compose_up`, then exec's into the Claude container and starts an interactive `claude` session. Type `/login` at Claude's prompt to walk through the Anthropic OAuth flow (browser sign-in, paste-back code if the localhost callback can't reach the host). Claude Code stores credentials inside the container at `~/.claude/.credentials.json`, persisted on the host via the per-project `CLAUDE_HOME` bind-mount. If `--project <name>` is omitted, uses the active project. See [ADR-052](../adr/ADR-052-anthropic-oauth-login-flow.md).
- **`speedwave logout [--project <name>]`** — deletes Claude Code's credential files (`.credentials.json`, `.claude.json`) from the project's `CLAUDE_HOME` mount. No runtime required. Idempotent — succeeds even when nothing is stored. If `--project <name>` is omitted, targets the active project.
- **`speedwave check`** — runs OS prerequisite checks (WSL2 on Windows; no host-level prerequisites on macOS) and compose security validation (cap_drop, token isolation, port binding, etc.), exits 0 on success or 1 on failure with detailed violation messages and remediation steps. Note: `check` is diagnostic-only — it reports permission violations but does NOT auto-fix them. All container start paths (`speedwave`, update, rollback) auto-fix file permissions before running SecurityCheck. `check` (and every other runtime command except `--help`, `self-update`, `init`, and the `plugin install`/`list`/`remove` recovery commands) first runs the **plugin signature audit**: if any plugin under `~/.speedwave/plugins/` no longer matches its signed contents, the command prints the affected plugins to stderr and exits `2` before doing anything else. Recover with `speedwave plugin remove <slug>` or by deleting the plugin directory.
- **`speedwave update [--project <name>]`** — rebuilds the built-in images whose build inputs changed (per-image hash tags, ADR-072), syncs claude-resources, and recreates containers with the current bundle manifest. Targets the active project by default; `--project <name>` overrides it.
- **`speedwave self-update`** — downloads the latest CLI binary from GitHub Releases, replaces the current binary, and automatically rebuilds container images if the version changed.

  > **Note:** If the rebuild fails (e.g., when run without Desktop running), start Desktop and run `speedwave update` again. `update` targets the active project; select a different project in the Desktop switcher to update it, or restart the Desktop app.

- **`speedwave plugin install <path.zip>`** — verifies the Ed25519 signature, extracts the plugin to `~/.speedwave/plugins/<slug>/`, and registers it.

  Two outcomes are possible:
  - **Installed:** the plugin is on disk and (for MCP plugins) the container image was built. Stdout: `"Plugin '<name>' (<slug>) installed successfully"`.
  - **Installed with deferred build:** the plugin is on disk but the container image build failed (network outage, broken Containerfile). Stderr: `"Plugin '<name>' (<slug>) installed; image build failed and will retry on next launch"`. A marker file at `~/.speedwave/plugin-state/<slug>/image_pending` (a sibling of `~/.speedwave/plugins/`, **outside** the signed plugin tree) remains and the build is retried automatically on the next Speedwave start (`ensure_plugin_images`).

  **Both cases exit 0** so existing `speedwave plugin install foo.zip && echo OK` scripts continue to work. To detect a deferred build, read stderr or check for `~/.speedwave/plugin-state/<slug>/image_pending`. See [ADR-047](../adr/ADR-047-plugin-install-progress-events.md) for the rationale.

- **`speedwave plugin list`** — lists all installed plugins, showing name, version, and a `[verified]` / `[UNVERIFIED: <reason>]` marker per plugin. This command does **not** run the startup audit (so it stays usable when an audit is failing) — it reports the per-plugin verification status instead.
- **`speedwave plugin remove <slug>`** — removes the plugin directory from `~/.speedwave/plugins/<slug>/` (and its `~/.speedwave/plugin-state/<slug>/` sibling). Works even when the plugin fails signature verification — this is the recovery command for a tampered plugin. Note: credential files at `~/.speedwave/tokens/<project>/<slug>/` and config entries are **not** cleaned by the CLI — use the Desktop UI for full cleanup, or remove token directories manually
- **`speedwave plugin enable <service_id> --project <name>`** — enables a plugin for a specific project in user config
- **`speedwave plugin disable <service_id> --project <name>`** — disables a plugin for a specific project in user config
- **`speedwave --help` / `-h` / `help`** — prints the subcommand list and exits 0. Unlike every other subcommand, `--help` does NOT require Speedwave Desktop to be running — useful for discovering commands during a broken setup or before the runtime is installed.

## Project Resolution

`speedwave`, `login`, `logout`, and `update` resolve which project to use as follows:

1. **`--project <name>`** (or `--project=<name>`) — explicit override on `speedwave`/`login`/`logout`/`update`, wins from any directory. The name must be a registered project; an unknown name is rejected with an error.
2. **Active project** — `active_project` from config, set by the Desktop project switcher (or by the last `speedwave init`)
3. **First project** — used when no project is active

The working directory is **not** consulted (except by `speedwave init`, which registers the current directory as a new project). The Desktop selector is the single source of truth.

Unknown subcommands and stray arguments are rejected, not silently ignored: `speedwave updatte` exits with `unknown command: 'updatte'`, and extra arguments after a subcommand (e.g. `speedwave check junk`) exit with a usage hint.

## Bundle Compatibility

Built-in images are versioned by the installed desktop bundle, not by a shared `:latest` tag.

- Compose rendering resolves built-in images as `speedwave-*:<per-image-hash>` — a 16-char hash of each image's declared build inputs (see [ADR-072](../adr/ADR-072-per-image-build-input-hash-tags.md))
- `speedwave` uses the compose file rendered for the current bundle
- `speedwave update` rebuilds and recreates containers for the current bundle
- Old local `:latest` images may remain in the cache, but they are not used by newly rendered compose files

This keeps CLI-driven container starts aligned with the desktop bundle that installed the CLI.

## Troubleshooting

If the `speedwave` command is not found after installation, run the diagnostic script from the source repository:

```bash
bash scripts/diagnose-cli.sh
```

It checks the binary location, PATH configuration, shell config files, and Speedwave data directory to identify the issue.

If you don't have the source repository cloned, you can download and run the script directly:

```bash
curl -fsSL https://raw.githubusercontent.com/speednet-software/speedwave/dev/scripts/diagnose-cli.sh | bash
```

## See Also

- [ADR-005: Two Interfaces — CLI and Desktop](../adr/ADR-005-two-interfaces-cli-and-desktop.md)
- [ADR-016: Cross-Platform CLI PATH](../adr/ADR-016-cross-platform-cli-path.md)

# ADR-052: Claude Code Login Surface + Clipboard Bridge

**Status:** Accepted

**Date:** 2026-05-06

> **Naming clarification:** an earlier draft called this "Speedwave-native OAuth login flow". That name is wrong and was deliberately dropped: Speedwave does **not** perform OAuth and does **not** handle Anthropic tokens — Claude Code's `/login` owns the entire credential lifecycle. A literally Speedwave-native flow (Speedwave opening `console.anthropic.com/oauth/authorize`, running its own loopback callback, capturing the token) would violate Anthropic's Consumer Terms, which reserve OAuth for Claude Code and Claude.ai (clarified Feb 2026 — see [^1]). This ADR is about a _launch surface_ + a _clipboard bridge_, nothing more.

## Context

After a fresh install, users could not conveniently complete the Anthropic login from inside the `claude` container:

1. **The "press `c` to copy URL" hint does not work in our container.** Claude Code's TUI prints the suggestion unconditionally whenever stdout is a TTY — but the runtime path that backs it (`pbcopy`/`xclip`/`wl-copy`/`clip.exe`, with OSC 52 as a final fallback) has no working channel from our container to the host clipboard. We mount no X11/Wayland sockets, drop all capabilities (`cap_drop: ALL`), and Apple Terminal strips OSC 52 by default.
2. **Manual mouse-select copies only the visible URL slice.** The OAuth URL is ~300 bytes; once it wraps in an 80-column terminal, dragging selects only the visible fragment plus newlines.
3. **The OAuth localhost callback never returns to the host browser.** `claude /login` opens a callback HTTP server on a random port _inside_ the container. The user's host browser cannot reach it because our compose template publishes no ports for the `claude` service. Claude Code falls back to printing the URL plus a "Paste code here if prompted" prompt.

We need a login surface reachable from both the CLI (`speedwave login`) and the Desktop UI, where the user does not have to manually copy URLs or paste tokens. Whatever credentials Claude Code stores must persist across container restarts.

## Decision

### Login flow: `claude /login` inside an interactive container

`speedwave login` opens an interactive `claude` session inside the project's container (`runtime.container_exec` with `-it`). The user types `/login` at Claude's prompt; Claude Code handles the OAuth flow (URL + paste-back code), and Claude Code itself writes the credentials to `/home/speedwave/.claude/.credentials.json`. Speedwave does not parse, intercept, or mirror the token — the path of least surprise and the path that survives Anthropic protocol changes.

`/home/speedwave` is the per-project `CLAUDE_HOME` bind-mount (`compose.rs:51`, `${CLAUDE_HOME}:/home/speedwave:rw`), so credentials persist on the host at `~/.speedwave/claude-home/<project>/.claude/.credentials.json`. The next `speedwave` start sees them as if they had always been there.

`entrypoint.sh` pre-creates `~/.claude.json` with `{ "hasCompletedOnboarding": true, "installMethod": "native" }` if absent. Without this, Claude Code treats every fresh container as a brand-new install and re-prompts for login even when `.credentials.json` is in place[^2].

`speedwave logout [--project <name>]` deletes both `.credentials.json` and `.claude.json` from the project's `CLAUDE_HOME` mount.

### Surface

- **CLI**: `speedwave login [--project <name>]` runs `compose up`, ensures the claude container is exec-healthy, then runs `nerdctl exec -it … claude <flags>`. The user types `/login` and follows Claude Code's prompts. `speedwave logout` mirrors this for credential removal.
- **Desktop**: a "Open terminal and log in" button in `auth-terminal.component.ts` invokes the Tauri command `start_oauth_login`, which spawns the host's terminal application running `speedwave login --project <name>`. On macOS, iTerm2 is preferred when installed (it honors OSC 52 — see Steps 9/10 below); otherwise Apple Terminal.app via `osascript`. On Windows: PowerShell via `cmd.exe /c start powershell.exe -NoExit -Command`. The existing `get_auth_status` poll detects when `claude auth status` inside the container starts succeeding.
- A secondary "Or run this command yourself" copy block (`get_auth_command`) renders the same `cd … && speedwave login --project '…'` for users whose preferred terminal is not auto-detected.

### Scope: no Speedwave-managed token storage

The `CLAUDE_CODE_OAUTH_TOKEN` env-var injection path was considered (an earlier draft of this ADR described it) but **rejected**: it requires Speedwave to capture the token from `claude setup-token` stdout, which is a brittle parser dependency on Anthropic's CLI output format. The `claude /login` path requires zero token handling on the Speedwave side — Anthropic owns the entire credential lifecycle. `SecurityCheck::check_no_tokens_in_claude` keeps `CLAUDE_CODE_OAUTH_TOKEN` on its env-var allowlist anyway: a user can still set it via shell environment for CI scenarios, and the allowlist guards against future regressions if we ever revisit injection.

The legacy API-key path (`ANTHROPIC_API_KEY` injected from `~/.speedwave/secrets/<project>/anthropic_api_key`) remains untouched for users who set their key via Settings → Authentication → API key.

## Alternatives Considered

### Capture token from `claude setup-token` stdout, store as `CLAUDE_CODE_OAUTH_TOKEN`

**Rejected.** Parsing terminal output of an upstream CLI is brittle: Anthropic can change the format (line wrapping, ANSI colors, surrounding text) at any minor version and silently break our flow. We tried this approach in early drafts of the PR; CodeQL flagged the regex-based extraction as cleartext logging risk, the parser missed split-across-lines tokens, and Anthropic explicitly documents that `setup-token` "does not save the token anywhere"[^1] — a hint that they consider the output user-visible, not machine-parseable.

### Embed xterm.js + node-pty in the Desktop UI

Render the login flow as an in-app pseudo-terminal panel. **Rejected** — adds two heavy frontend dependencies (~300 kB) plus per-OS PTY-spawn integration tests, all to host one interactive command. KISS: the OS terminal already exists and works.

### Sniff the URL from Claude stdout, rewrite `redirect_uri`, port-forward into the container

**Rejected** — pure hostility against future Anthropic changes. Any silent change to the login UI silently breaks our flow.

### Mount the host's `~/.claude/.credentials.json` into the container

**Rejected** — requires Claude Code to be installed on the host, which contradicts a core Speedwave value (the container is the only place Claude runs).

## Consequences

### Positive

- Speedwave never touches OAuth tokens. Anthropic owns the entire credential lifecycle; protocol changes are transparent to us.
- Credentials persist across container restarts via the existing `CLAUDE_HOME` bind-mount — no new directories, no new permissions.
- `speedwave logout` is a simple `rm` on two files; no validation, no parsing.
- Existing flows that relied on `ANTHROPIC_API_KEY` continue to work.

### Negative

- The user must type `/login` once at Claude's prompt — one extra keypress vs. a hypothetical "fully automatic" flow. Acceptable; the alternative was a brittle stdout parser.
- Per-project credentials (one `CLAUDE_HOME` per project) means logging into project A does not authenticate project B. A user with N projects logs in N times. Acceptable: tokens are valid one year[^1], and project isolation is a load-bearing security property.

### Addendum: clipboard bridge for the "press `c` to copy URL" hint

Claude Code's TUI prints "press `c` to copy URL" and, on `c`, probes for
`pbcopy` / `xclip` / `xsel` / `wl-copy` / `clip.exe` (OSC 52 as a last resort).
Our hardened container has none of those binaries and no path to the host
clipboard. The `claude` image therefore bakes five symlinks at
`/usr/local/bin/` (all the names above), all pointing at one `osc52-copy.sh`
which sends the URL down **two write-only channels**:

1. **File bridge (primary).** Atomically writes the URL to
   `~/.clipboard-bridge` inside the container (i.e. on the host at
   `<data_dir>/claude-home/<project>/.clipboard-bridge`). The Desktop process
   runs a watcher (`desktop/src-tauri/src/clipboard_bridge.rs`) that tails this
   directory, reads the file with a single size-limited read (≤ 64 KB; this
   collapses the check-then-act window a separate `stat`+`read` would leave),
   deduplicates by content, and copies it to the host clipboard. This channel
   works in **any** terminal — including Apple Terminal — but only when the
   Desktop app is running.
2. **OSC 52 (secondary).** Base64-encodes the URL and writes
   `ESC]52;c;<base64>BEL` to `/dev/tty`. Honored by most modern emulators
   (iTerm2 with the option on, Alacritty, WezTerm, Ghostty, Windows Terminal,
   konsole, VS Code)[^3]; ignored by Apple Terminal.app and default
   gnome-terminal. This channel is the only one available to **CLI-only** users
   (no Desktop app), at the cost of terminal support.

Both channels are **write-only by design**: OSC 52 paste/query would require a
terminal-side response handshake most emulators reject and would leak host
clipboard contents into the container. Out of scope. See
`docs/architecture/security.md` "Authentication Gate".

On macOS the Desktop spawn path additionally **prefers iTerm2** over
Terminal.app (`oauth_login_cmd::open_terminal_with_command` probes
`/Applications/iTerm.app` and `~/Applications/iTerm.app`), because iTerm2 honors
OSC 52 so `c`-to-copy works there even without the Desktop watcher running. If
iTerm2 is absent or its `osascript` invocation fails, it falls back to
Terminal.app.

Implementation: `containers/osc52-copy.sh`, `containers/Containerfile.claude`
(image-time `COPY` + symlinks), `desktop/src-tauri/src/clipboard_bridge.rs`,
`desktop/src-tauri/src/oauth_login_cmd.rs`, `_tests/entrypoint/osc52-copy.bats`.

## Implementation

- `crates/speedwave-cli/src/main.rs` — `CliAction::Login`/`CliAction::Logout` dispatch
- `crates/speedwave-runtime/src/claude_home.rs` — `claude_home_dir()` (compose mount + CLI) and `remove_claude_credentials()` (logout); SSOT for the per-project claude-home path layout
- `crates/speedwave-runtime/src/consts.rs` — `CLAUDE_HOME_SUBDIR` constant
- `containers/entrypoint.sh` — pre-creates `~/.claude.json`
- `containers/osc52-copy.sh` + `containers/Containerfile.claude` — clipboard wrapper symlinks
- `desktop/src-tauri/src/oauth_login_cmd.rs` — `start_oauth_login` Tauri command, per-OS terminal spawn, `$SHELL` sanitisation for the iTerm2 path
- `desktop/src-tauri/src/clipboard_bridge.rs` — host clipboard watcher (size-capped, deduplicated)
- `desktop/src-tauri/src/path_util.rs` — shared `which_in_path` helper
- `desktop/src-tauri/src/auth_commands.rs` (`get_auth_status`, `build_auth_command_for_platform`, `resolve_project_dirs`) — Desktop integration
- `desktop/src/src/app/settings/auth-terminal.component.ts` — primary "Open terminal" button + secondary copy fallback

## References

[^1]: Anthropic Claude Code authentication docs — token validity period and `setup-token` behavior. <https://code.claude.com/docs/en/authentication>

[^2]: GitHub issue tfvchow/field-notes-public#10 — both `.credentials.json` and `.claude.json` are required for Claude Code to skip onboarding in a devcontainer. <https://github.com/tfvchow/field-notes-public/issues/10>

[^3]: OSC 52 terminal-emulator support data — survey of which terminals honor the sequence by default and which require an opt-in setting. <https://github.com/ojroques/vim-oscyank#which-terminals-support-osc-52>

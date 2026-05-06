# ADR-051: Speedwave-Native Anthropic OAuth Login Flow

**Status:** Accepted

**Date:** 2026-05-06

## Context

After a fresh install, users could not complete the Anthropic OAuth login from inside the `claude` container:

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
- **Desktop**: a "Open terminal and log in" button in `auth-terminal.component.ts` invokes the Tauri command `start_oauth_login`, which spawns the host's terminal application running `speedwave login --project <name>`. On macOS, iTerm2 is preferred when installed (it honors OSC 52 — see Steps 9/10 below); otherwise Apple Terminal.app via `osascript`. On Windows: PowerShell via `cmd.exe /c start powershell.exe -NoExit -Command`. On Linux: gnome-terminal → konsole → xterm in order. The existing `get_auth_status` poll detects when `claude auth status` inside the container starts succeeding.
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

### Step 9 (post-decision): OSC 52 clipboard bridge

After the storage and login-flow design above shipped, a complementary shell-side fix landed for the original "press `c` to copy URL" problem. The `claude` image now bakes five clipboard-binary symlinks (`pbcopy`, `xclip`, `xsel`, `wl-copy`, `clip.exe`) at `/usr/local/bin/`, all pointing to one `osc52-copy.sh` that base64-encodes stdin and writes an OSC 52 escape sequence to `/dev/tty`. When Claude Code's TUI probes for any of these names, the wrapper handles the URL and the host terminal — if it supports OSC 52 — copies it to the system clipboard.

This is an **incremental improvement, not a complete fix**. OSC 52 is honored by the majority of modern terminal emulators[^3] (iTerm2 with the option enabled, Alacritty, WezTerm, Ghostty, Windows Terminal, konsole, VS Code) and ignored by Apple Terminal.app and gnome-terminal default. Users on unsupported terminals continue to mouse-select the URL or paste the auth code as before.

The wrapper is **write-only by design**: OSC 52 paste/query would require a terminal-side response handshake most emulators reject and would leak host clipboard contents into the container. Out of scope. See `docs/architecture/security.md` "Clipboard wrappers (OSC 52)".

Implementation: `containers/osc52-copy.sh`, `containers/Containerfile.claude` (image-time `COPY` + symlinks), `_tests/entrypoint/osc52-copy.bats` (15 host-side tests).

### Step 10 (post-decision): macOS prefers iTerm2 over Apple Terminal

Apple Terminal.app does not honor OSC 52 — running the Step 9 wrapper inside it copies nothing. To make `c`-to-copy work out of the box on macOS for users who have iTerm2 installed (the majority that cares), `oauth_login_cmd::open_terminal_with_command` now probes for iTerm2 in `/Applications/iTerm.app` or `~/Applications/iTerm.app` and spawns it via `osascript` (`tell application "iTerm" to create window with default profile command "<cmd>"`). If iTerm2 is missing or its `osascript` invocation fails, the function falls back to Apple Terminal.app — same behavior as before.

Implementation: `desktop/src-tauri/src/oauth_login_cmd.rs::open_terminal_with_command` (macOS branch refactored into `iterm2_installed`, `spawn_iterm2`, `spawn_apple_terminal`).

## Implementation

- `crates/speedwave-cli/src/main.rs` — `CliAction::Login`/`CliAction::Logout` dispatch
- `containers/entrypoint.sh` — pre-creates `~/.claude.json`
- `desktop/src-tauri/src/oauth_login_cmd.rs` — `start_oauth_login` Tauri command + per-OS terminal spawn
- `desktop/src-tauri/src/clipboard_bridge.rs` — host clipboard watcher
- `desktop/src-tauri/src/auth_commands.rs` (`get_auth_status`, `build_auth_command_for_platform`) — Desktop integration
- `desktop/src/src/app/settings/auth-terminal.component.ts` — primary "Open terminal" button + secondary copy fallback

## References

[^1]: Anthropic Claude Code authentication docs — token validity period and `setup-token` behavior. <https://code.claude.com/docs/en/authentication>

[^2]: GitHub issue tfvchow/field-notes-public#10 — both `.credentials.json` and `.claude.json` are required for Claude Code to skip onboarding in a devcontainer. <https://github.com/tfvchow/field-notes-public/issues/10>

[^3]: OSC 52 terminal-emulator support data — survey of which terminals honor the sequence by default and which require an opt-in setting. <https://github.com/ojroques/vim-oscyank#which-terminals-support-osc-52>

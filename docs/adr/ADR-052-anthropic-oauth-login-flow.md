# ADR-052: Claude Code Login Surface + Clipboard Bridge

**Status:** Accepted

**Date:** 2026-05-06

> **Update (2026-06-30):** `speedwave login` now execs `claude auth login --claudeai`
> directly instead of dropping the user at an interactive prompt to type `/login`.
> The subcommand starts OAuth at once (prints the URL + paste-back prompt, the same
> fallback the localhost callback already required), so the "one extra keypress"
> noted under Negative is gone — without the brittle stdout parser that alternative
> implied. The login exec also unsets non-Anthropic provider env first (the
> anthropic-login-env-unset change) so OAuth runs against Anthropic regardless of
> the active provider. The credential-lifecycle and clipboard-bridge decisions below
> are unchanged.

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

### Windows: the `metadata` automount requirement

On Windows the `CLAUDE_HOME` bind-mount resolves to a path under `C:\` (`~/.speedwave/claude-home/<project>`), exposed inside the WSL2 distro via the drvfs/9p automount of `/mnt/c`. By default that mount is `uid=0;gid=0` and **rejects `chmod`** (`Operation not permitted`). Claude Code writes `.credentials.json` and then `chmod 0600`s it; on a non-`metadata` mount that chmod fails and the login does not persist — the TUI may report "Login successful" yet the next session shows "Not logged in". The container itself is fine (verified: uid 1000, `HOME=/home/speedwave`); only the chmod-on-9p step fails.

Fix — two parts, because the mount ownership cannot be set by the automount option alone:

1. **`metadata` automount** — `setup_wizard::ensure_wsl_distro_metadata(TerminateOnChange)` sets `[automount].options = "metadata,uid=1000,gid=1000,umask=022"` in `/etc/wsl.conf` (uid/gid derived from the `consts::CONTAINER_USER_UNPRIVILEGED` SSOT via `container_uid_gid()`). `metadata` makes drvfs honor Linux mode bits so `chmod 0600` works. The `uid=`/`gid=` part is **best-effort, not load-bearing**: the imported distro has no `[user]` default → WSL prepends the default-user uid (root → 0) ahead of our option, and the prepended uid wins, so the mount stays uid 0. The actual EACCES fix is the per-project `chown` in `ensure_claude_home_owner`.

   The edit reads `/etc/wsl.conf` (via `wsl.exe … cat`), mutates it with a pure-Rust INI transform (`merge_wsl_conf_automount` — section-aware, CRLF-aware, dedups duplicate `[automount]` sections, anchored key match, fully unit-tested on real bytes; mirrors `merge_wslconfig_vpn_keys` for `.wslconfig`), then writes it back (via `tee`). **Write verification:** the file is re-read and the `[automount].options` line is parsed; if `uid=` is not present as a whole token, the function returns `Err` — a silently-failed write (e.g. a read-only `wsl.conf`) is surfaced, not assumed successful. Because the verification parses the options line (not a substring grep), `uid=10000` and a commented `# uid=1000` never produce a false success.

   The `TerminateOnChange` argument gates the post-write `wsl --terminate`: `Yes` right after `wsl --import`, `IfIdle` on the startup migration for existing distros. `IfIdle` probes running containers (`nerdctl ps -q`) **only after** a real change is written, and treats a containerd-daemon-down probe as _idle_ (nothing can be running) — so on a cold post-update boot the distro is terminated and the mount applies before the first container start; it defers only when containers are genuinely live (avoiding a mid-start kill). If `wsl --terminate` itself fails, the change still applies on the next natural WSL restart (logged as a warning, not a false success).

   **Import-path failure is intentional:** because the metadata write is verified, a fresh `wsl --import` whose `/etc/wsl.conf` cannot be written (read-only fs) now fails setup via `?` rather than silently proceeding to a broken `/login`. On the next launch the half-imported distro passes `verify_wsl_distro_origin` (its vhdx exists) and the startup `IfIdle` migration retries the write; if it keeps failing, the failure is logged and the user is directed to make `/etc/wsl.conf` writable.

2. **Per-project `chown` after compose up (load-bearing)** — `setup_wizard::ensure_claude_home_owner(project)` runs `chown -R <uid>:<gid>` (same SSOT) on the project's `claude-home` tree. With `metadata` on, drvfs honors per-file ownership for access, so a 1000-owned tree is writable by the uid-1000 container regardless of the mount's default uid. **Ordering is critical:** it must run **after** `compose_up_recreate`, because `compose up` auto-creates the `/home/speedwave/.claude` bind mount-point (for the read-only ide-bridge mount) as **root** — a chown done before compose is silently undone. The container's first entrypoint still exits(1) on `mkdir .claude/skills` EACCES; `ensure_exec_healthy` then detects the stopped container and recreates it, and the recreated entrypoint runs against the now-1000-owned tree and succeeds. Verified end-to-end on the live distro.

This is distro-internal config — distinct from the host `%USERPROFILE%\.wslconfig` managed by `ensure_wslconfig_vpn_compat` (ADR-067). macOS (Lima VirtioFS) is unaffected; it honors chmod and uid natively.

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

- ~~The user must type `/login` once at Claude's prompt — one extra keypress vs. a hypothetical "fully automatic" flow. Acceptable; the alternative was a brittle stdout parser.~~ Resolved by the 2026-06-30 update: `claude auth login` starts OAuth automatically, with no stdout parser.
- Per-project credentials (one `CLAUDE_HOME` per project) means logging into project A does not authenticate project B. A user with N projects logs in N times. Acceptable: tokens are valid one year[^1], and project isolation is a load-bearing security property.

### Addendum: clipboard bridge for the "press `c` to copy URL" hint

Claude Code's TUI prints "press `c` to copy URL" and, on `c`, routes the copy
by detected platform (Claude Code ≥ 2.1.161[^4]): on `linux` it probes for
`wl-copy` — only when `WAYLAND_DISPLAY` is set — then `xclip`/`xsel` (only when
`DISPLAY` is set), with OSC 52 as a last resort; on Windows hosts the container
self-identifies as platform `wsl` (via `/proc/version`) and execs
`powershell.exe … Set-Clipboard` instead. Our hardened container has none of
those binaries and no path to the host clipboard. The `claude` image therefore
bakes six symlinks at `/usr/local/bin/` (`pbcopy` / `xclip` / `xsel` /
`wl-copy` / `clip.exe` / `powershell.exe`), all pointing at one
`osc52-copy.sh`, and `defaults.rs::base_env()` injects a dummy
`WAYLAND_DISPLAY` so the probe finds the `wl-copy` shim (no Wayland socket
exists or is needed — the shim never talks to a display server). The shim
treats a `Set-Clipboard` PowerShell command as a copy and fails read-style
commands (`Get-Clipboard`, `ContainsImage`) with exit 1 so paste keeps using
the `xclip` image path below. The copy sends the URL down **two write-only
channels**:

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

[^4]: Claude Code CHANGELOG 2.1.160/2.1.161 — copy-on-select moved to PowerShell interop on WSL and the fullscreen clipboard probe gained `wl-copy`/`xclip`/`xsel` with PRIMARY-selection writes; verified against the published 2.1.154 vs 2.1.173 `linux-x64` binaries (the linux probe is gated on `WAYLAND_DISPLAY`/`DISPLAY`; platform `wsl` execs `powershell.exe … Set-Clipboard`). <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>

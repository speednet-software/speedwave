# ADR-016: Cross-Platform CLI PATH

> **Status:** Accepted
> **Context:** The `speedwave` CLI binary must end up on the user's PATH on both supported platforms without ever asking for admin/sudo/UAC.

## Decision

The CLI binary is placed on PATH using **user-scope mechanisms only** — no privilege escalation on macOS or Windows. The setup wizard owns this for all platforms via `setup_wizard::link_cli`, which copies the bundled binary into a user-owned directory and updates the user's shell config (Unix) or per-user registry PATH (Windows).

## Why

- Requiring admin/sudo to install a single-user CLI tool violates least privilege[^1]; user-scope paths avoid it entirely.
- Copying (rather than symlinking) keeps the CLI working even if the Desktop app bundle is moved or renamed.
- The Desktop re-links the CLI on every startup, so the binary stays in sync after an app update with no separate CLI-update step.

## How it works

- **macOS** — the binary is copied to `~/.local/bin/speedwave` (the XDG standard location for user executables[^2], not on the default macOS PATH built by `/usr/libexec/path_helper`). `detect_shell` reads `$SHELL`, and an `export PATH="$HOME/.local/bin:$PATH"` line is appended to the right shell config file. The append is idempotent — files already containing `.local/bin` are skipped.
- **Windows** — the binary is copied to `~/.speedwave/bin/speedwave.exe`, that directory is added to `HKCU\Environment\Path` via PowerShell's `[Environment]::SetEnvironmentVariable('Path', …, 'User')` (per-user registry, no UAC)[^4], and a `WM_SETTINGCHANGE`[^5] broadcast (via `SendMessageTimeoutW` with `HWND_BROADCAST`[^6]) tells running shells to pick up the new PATH without a restart.

### Shell config file selection (Unix)

`detect_shell` maps `$SHELL` to a `UserShell` enum (`Zsh`, `Bash`, `Unknown`), and `shell_config_targets` picks the file:

| Shell variant              | Target file(s)                                                                                        | Rationale                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Zsh`                      | `.zshrc`                                                                                              | Sourced for both login and interactive zsh sessions.                             |
| `Bash`                     | first existing of `.bash_profile` > `.bash_login` > `.profile`; creates `.bash_profile` if none exist | macOS terminals open login shells; bash reads the first existing file and stops. |
| `Unknown` (e.g. fish, ksh) | `.profile`                                                                                            | POSIX-portable fallback for any unrecognized `$SHELL`.                           |

When `$SHELL` is _empty_ (common when the Desktop app launches from Dock/Finder under launchd, which may not propagate `$SHELL`), detection falls back to `Zsh` on macOS — zsh has been the macOS default since Catalina[^3].

**`$SHELL` limitation:** `$SHELL` reflects the login shell from `/etc/passwd`, not necessarily the interactively-used shell. This is the convention shared by Homebrew, rustup, and nvm; a user whose login shell is bash but who launches fish in their terminal profile won't get fish config updated — a known, ecosystem-wide trade-off.

## Where it lives in code

- Link entry point + re-link-on-startup — `desktop/src-tauri/src/setup_wizard.rs::link_cli` (filesystem work in `link_cli_from`).
- Shell detection / parsing — `setup_wizard.rs::detect_shell` and `parse_shell_env`.
- Shell config file selection — `setup_wizard.rs::shell_config_targets`; idempotent PATH append in `ensure_local_bin_on_path` / `ensure_local_bin_on_path_for_shell`.
- Windows CLI subdir (`bin`) — `crates/speedwave-runtime/src/consts.rs::CLI_BIN_SUBDIR` (SSOT; see CLAUDE.md alignment with `sweep.ps1` and the pinned-CLI launch path).
- Cleanup — `setup_wizard.rs::factory_reset` removes the Unix CLI binary at `~/.local/bin/speedwave`; on Windows the CLI lives inside the data dir (`~/.speedwave/bin/`) and is removed by the data-dir wipe. The shell `export` line is intentionally left in place to avoid destructively editing user dotfiles.

## Rejected alternatives

- **`/usr/local/bin/` on macOS** — although `/usr/local/` is exempt from System Integrity Protection[^7], writing to it requires `sudo`. Using `~/.local/bin/` avoids privilege escalation entirely and keeps the binary per-user under the home directory, aligned with XDG conventions.
- **Symlink instead of copy** — a symlink into the app bundle breaks if the bundle is moved or renamed; the copy-based approach survives that and is refreshed on every Desktop startup.

---

[^1]: [OWASP — Principle of Least Privilege](https://owasp.org/www-community/controls/Least_Privilege_Principle)

[^2]: [XDG Base Directory Specification — `~/.local/bin` for user executables](https://specifications.freedesktop.org/basedir/latest/)

[^3]: [Apple Support — Use zsh as the default shell on your Mac (since Catalina)](https://support.apple.com/en-us/102360)

[^4]: [.NET `Environment.SetEnvironmentVariable` — user-scope registry](https://learn.microsoft.com/en-us/dotnet/api/system.environment.setenvironmentvariable)

[^5]: [Win32 `WM_SETTINGCHANGE` — broadcast environment changes](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange)

[^6]: [Win32 `SendMessageTimeoutW` — `HWND_BROADCAST`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)

[^7]: [Apple — SIP file system protections (`/usr/local` exempt)](https://developer.apple.com/library/archive/documentation/Security/Conceptual/System_Integrity_Protection_Guide/FileSystemProtections/FileSystemProtections.html)

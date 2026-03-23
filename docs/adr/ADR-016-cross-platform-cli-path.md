# ADR-016: Cross-Platform CLI PATH

## Decision

The `speedwave` CLI binary is placed on the user's PATH using **user-scope mechanisms only** — zero privilege escalation on any platform. The setup wizard (`setup_wizard::link_cli()`) handles all platforms.

## Rationale

Requiring admin/sudo to install a single-user CLI tool violates the principle of least privilege.[^1] Speedwave uses user-scope paths on all platforms:

| Platform      | Location                 | Mechanism                                                                                                                              | Privileges           |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| macOS + Linux | `~/.local/bin/speedwave` | Copied from app bundle resources; shell config file updated based on detected shell (see Shell Detection below)                        | User scope — no sudo |
| Windows       | `~/.speedwave/bin/`      | Copied from app bundle resources; directory added to `HKCU\Environment\Path` via PowerShell[^4]; `WM_SETTINGCHANGE` broadcast[^5] [^6] | User scope — no UAC  |

## Unix Details (macOS + Linux)

`~/.local/bin/` is the XDG standard location for user-installed binaries.[^2] Both macOS and Linux use the same `#[cfg(unix)]` code path in `setup_wizard::link_cli()`:

1. Copy: the CLI binary bundled in app resources is copied to `~/.local/bin/speedwave` (with executable permission set)
2. Shell detection: `detect_shell()` reads `$SHELL` to determine the user's default shell, then writes `export PATH="$HOME/.local/bin:$PATH"` to the correct config file for that shell (see table below). If the target file doesn't exist, it is created.

This copy-based approach (replacing the previous symlink) ensures that the CLI remains functional even if the Desktop app bundle is moved or renamed. The Desktop re-links the CLI on every startup, so the binary is automatically kept in sync after updates.

### Shell Detection

`detect_shell()` maps the `$SHELL` environment variable to a `UserShell` enum and selects the correct config file(s) per platform:

| Shell   | Platform    | Target file(s)                                                    | Rationale                                                                                              |
| ------- | ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| zsh     | macOS/Linux | `.zshrc`                                                          | Sourced for both login and interactive zsh sessions                                                    |
| bash    | macOS       | First of `.bash_profile` > `.bash_login` > `.profile`             | macOS terminals open login shells; bash reads the first existing file and stops                        |
| bash    | Linux       | `.bashrc` + first of `.bash_profile` > `.bash_login` > `.profile` | Terminal emulators open interactive shells (`.bashrc`); SSH/tty open login shells                      |
| unknown | macOS       | `.zshrc`                                                          | `$SHELL` may be unset in launchd context (Dock/Finder launch); zsh is the macOS default since Catalina |
| unknown | Linux       | `.profile`                                                        | POSIX portable fallback                                                                                |

**`$SHELL` limitation:** `$SHELL` reflects the user's login shell (set in `/etc/passwd`), not necessarily the shell they use interactively. This is the standard convention used by all major tools (Homebrew, rustup, nvm) and covers the vast majority of users. A user whose login shell is bash but who launches fish in their terminal profile won't get fish config updated — this is a known trade-off shared with the wider ecosystem.

**macOS note:** `~/.local/bin` is not in the default macOS PATH (which is constructed by `/usr/libexec/path_helper` from `/etc/paths`[^3]). The shell config file modification in step 2 is therefore required on macOS, not just Linux.

**Why not `/usr/local/bin/`:** Although `/usr/local/` is exempt from SIP[^7], writing to it requires `sudo`. Using `~/.local/bin/` avoids privilege escalation entirely and keeps the binary in the user's home directory — consistent across macOS and Linux, aligned with XDG conventions, and isolated per-user.

## Windows Details

`setup_wizard::link_cli()` copies the bundled CLI binary to `~/.speedwave/bin/speedwave.exe` and adds this directory to `HKCU\Environment\Path` via PowerShell's `[Environment]::SetEnvironmentVariable('Path', ..., 'User')`[^4] — user-level registry, no UAC required. After modifying the registry, `SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment")` broadcasts the change so running shells pick up the new PATH immediately without restart.[^5] [^6]

## Re-link on Startup

The Desktop app calls `link_cli()` on every startup (after verifying that setup is complete). This ensures the CLI binary is updated whenever the Desktop app is updated — no separate CLI update step required.

## Cleanup

`setup_wizard::factory_reset()` removes the CLI binary on Unix (`~/.local/bin/speedwave`) but does not remove the shell profile line — this is intentional to avoid modifying user dotfiles destructively.

---

[^1]: [OWASP — Principle of Least Privilege](https://owasp.org/www-community/controls/Least_Privilege_Principle)

[^2]: [XDG Base Directory Specification — `~/.local/bin` for user executables](https://specifications.freedesktop.org/basedir/latest/)

[^3]: [Apple Support — Use zsh as the default shell on your Mac (since Catalina)](https://support.apple.com/en-us/102360)

[^4]: [.NET `Environment.SetEnvironmentVariable` — user-scope registry](https://learn.microsoft.com/en-us/dotnet/api/system.environment.setenvironmentvariable)

[^5]: [Win32 `WM_SETTINGCHANGE` — broadcast environment changes](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange)

[^6]: [Win32 `SendMessageTimeoutW` — `HWND_BROADCAST`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)

[^7]: [Apple — SIP file system protections (`/usr/local` exempt)](https://developer.apple.com/library/archive/documentation/Security/Conceptual/System_Integrity_Protection_Guide/FileSystemProtections/FileSystemProtections.html)

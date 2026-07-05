# Managed (MDM/org) Policy Config

Speedwave supports organization-forced policy that a user cannot bypass. Today this drives OTLP telemetry; the mechanism is general — reuse it for any future org policy rather than inventing a second channel.

## Where the policy lives

An admin/MDM writes a system-level `managed-config.json` at an admin-only location:

- macOS: `/Library/Application Support/Speedwave/managed-config.json`
- Windows: `<ProgramData>\Speedwave\managed-config.json` — resolve ProgramData via `SHGetKnownFolderPath(FOLDERID_ProgramData)`, never the `%ProgramData%` env var (a user process can spoof it to hide the policy) and never a hardcoded `C:\ProgramData`.

Path literals (`Speedwave`, `managed-config.json`) are consts in `consts.rs` (`MANAGED_CONFIG_VENDOR_DIR`, `MANAGED_CONFIG_FILE`); the loader is `managed_config::load_managed_config`. Reading is **fail-closed**: absent file → `None` (zero behavior change), malformed file OR an unresolvable ProgramData path → hard error. An org policy must never silently vanish on an admin typo or a spoofed env var.

## Presence is the lock

There is no separate `locked` flag. Any field the MDM file sets is authoritative and the user cannot override it; to leave a field user-editable, the MDM omits it. This is because the merge always gives MDM precedence — a `locked:false` "editable default" would let the UI show an edit the runtime ignores. The merge order for a lockable value is: compiled default → user config → MDM (highest). Only MDM-set keys are re-forced over the user layer.

## Enforcement is two layers, one of them load-bearing

1. **Native Claude Code `managed-settings.json` (the hard control).** When MDM locks anything, generate `/etc/claude-code/managed-settings.json` (host source under `<data_dir>/claude-managed/<project>/`, mounted `:ro`). Claude Code reads it at the highest precedence — above process env AND user `settings.json` — in every version. Because the container is `read_only` + `no-new-privileges` + `cap_drop: ALL` running as UID 1000, a `:ro` mount of a host-owned file cannot be edited, remounted, or out-precedenced from inside. This is the boundary. A `SecurityCheck` rule (`ManagedSettingsMount`) enforces `:ro`, the exact target path, and the exact host source — a `:rw` mount or a source outside `claude-managed/` hard-fails at start.
2. **The process-env layer is defense-in-depth only.** MDM-locked keys are re-forced after the user merge layer (stripped from the user layer, then re-inserted) so `claude.env` cannot weaken them, and the master switch is a locked key whenever MDM sets the enable flag. Do NOT rely on process-env-beats-`settings.json`: that precedence is version-dependent in Claude Code and the in-container `~/.claude/settings.json` is a user-writable host mount.

## Non-negotiables when extending this

- **Integrity is regenerate-on-render, not tamper-proof storage.** The host `managed-settings.json` under `<data_dir>/claude-managed/` is user-writable between renders; every start path re-renders and overwrites it from the current policy, and `fs_security::collect_security_paths` enforces `0o700`/`0o600` on it. State this plainly — never claim the on-disk file is unmodifiable.
- **One writer for `/etc/claude-code/managed-settings.json`.** If a second feature needs that file (e.g. plugin policy), merge into a single generator producing one file and one mount — never two writers or two mounts.
- **Secrets never reach the frontend.** A secret carried in a policy value (e.g. an OTLP auth header) is masked in the UI, returned only as a `has_*` boolean over IPC, and redacted by a `log_sanitizer` rule. A locked field is rejected server-side on update, not merely greyed in the UI.
- **Every host→engine path goes through `engine_path::to_engine_path`** (drift-tested); never hand-build the mount source path.

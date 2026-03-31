# ADR-033: Permission Auto-Fix on Startup

## Status

Accepted

## Context

Commit `84e6dbb` introduced `SecurityCheck::check_file_security()` which validates that security-sensitive files and directories under `~/.speedwave/` have correct Unix permissions (`0o700` for directories, `0o600` for files). However, the code that creates these paths uses `std::fs::create_dir_all()` which applies umask defaults (typically `0o755` for directories) and `std::fs::write()` which creates files with `0o644`[^1]. This means every existing user would be blocked from starting containers after upgrading.

The affected paths include token directories (`tokens/<project>/<service>/`), the top-level `secrets/`, `snapshots/`, `tokens/` directories, `ide-bridge/`, and `bundle-state.json`.

Three approaches were considered:

1. **Reject and require manual fix** — Show error messages with `chmod` remediation instructions. Blocked every existing user on upgrade with no automatic recovery.
2. **Auto-fix before SecurityCheck** — Transparently correct mode bits at startup, then run SecurityCheck as defense-in-depth.
3. **Remove SecurityCheck for mode bits** — Rely only on creation-time fixes. Would not fix existing installations.

## Decision

We implement approach 2 (auto-fix) combined with creation-time fixes:

### Auto-fix (`ensure_data_dir_permissions`)

A new `fs_security` module in `speedwave-runtime` provides `ensure_data_dir_permissions()` which is called before `SecurityCheck::run()` on all container start paths (CLI, Desktop, update, rollback). It:

- Enumerates the same set of security-sensitive paths as `SecurityCheck` via a shared `collect_security_paths()` function (single source of truth)
- For each existing path: if mode bits differ from expected (`0o700` dirs, `0o600` files), calls `set_permissions()` to fix them
- Logs each fix at `warn!` level (degraded condition that was auto-remediated)
- Skips missing paths and symlinks (same safety logic as SecurityCheck)
- Propagates errors — if `set_permissions()` fails (e.g., file owned by another user), startup fails with a clear error

### Diagnostic-only for `speedwave check`

The `speedwave check` subcommand does NOT call autofix. It reports violations for diagnostic purposes, giving users visibility into permission state without modifying it.

### Ownership (UID) not auto-fixed

Auto-fix corrects only mode bits (chmod). Ownership mismatches (UID) are not auto-fixed because `chown` requires root privileges[^2]. SecurityCheck reports UID mismatches with remediation instructions (`chown $(id -u)`).

### Security risk analysis

Auto-applying `chmod 0o600`/`0o700` without explicit user consent is safe because:

- It only **tightens** permissions (never loosens) — the target modes are strictly more restrictive than umask defaults
- The affected paths are exclusively within `~/.speedwave/`, a directory owned by the current user
- The operation is idempotent — re-running on already-correct paths is a no-op
- Symlinks are skipped via `symlink_metadata()` to prevent traversal attacks[^3]
- Errors are propagated, not swallowed — a failed `chmod` blocks startup with an actionable message

## Consequences

### Positive

- Existing users upgrade seamlessly — no manual permission fixes required
- SecurityCheck remains as defense-in-depth (catches issues autofix cannot handle, e.g., UID mismatches)
- `collect_security_paths()` eliminates path enumeration duplication between autofix and SecurityCheck
- Creation-time fixes prevent the problem from recurring on new installations

### Negative

- Auto-modifying filesystem state without user consent may surprise security-conscious users (mitigated by `warn!` logging)
- The autofix adds ~5ms of filesystem I/O to every container start (negligible compared to container startup time)

[^1]: https://doc.rust-lang.org/std/fs/fn.create_dir_all.html — `create_dir_all` creates directories with permissions modified by the process umask
[^2]: https://man7.org/linux/man-pages/man2/chown.2.html — `chown` requires `CAP_CHOWN` capability (root) to change file ownership
[^3]: https://man7.org/linux/man-pages/man2/lstat.2.html — `lstat` (used by Rust's `symlink_metadata`) does not follow symbolic links

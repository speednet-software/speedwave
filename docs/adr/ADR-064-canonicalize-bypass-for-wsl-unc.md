# ADR-064: Bypass `canonicalize()` for WSL UNC project paths on Windows

**Status:** Accepted

**Date:** 2026-05-21

## Context

Project registration in [`crates/speedwave-runtime/src/project.rs::add_project_with_data_dir`](https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/project.rs) normalises every user-supplied project directory by calling `std::fs::canonicalize`.[^1] This resolves `.`, `..`, symlinks, and returns an absolute path the rest of the registration pipeline can rely on (duplicate-path detection, compose render, on-disk metadata reads).

On Windows, `canonicalize` resolves UNC paths through the system's `GetFinalPathNameByHandle` family of APIs, which return an extended-length-prefixed form (`\\?\UNC\<server>\<share>\...`) for any network path.[^2] For `\\wsl.localhost\...` paths specifically, behaviour is **not stably documented across Windows releases**:[^3]

- The 9P redirector backing `\\wsl.localhost\` is implemented by `wslservice.exe` (a Windows service installed with WSL) and exposed via the `p9rdr.sys` Plan 9 redirector driver — it is not part of the Win32 path API contract.[^4]
- `canonicalize` may succeed and prepend `\\?\UNC\`, may fail outright on a non-running distro, or may return platform-dependent error codes depending on the user's WSL build and distro state.[^5]
- The user-visible error for a `canonicalize` failure is the underlying OS error string (e.g. "The system cannot find the path specified" — `ERROR_PATH_NOT_FOUND`, code 3), not the carefully crafted helpful message we want users to see when they pick a project from another WSL distro.[^6]

The user-facing impact (see issue tracker / Łukasz's screenshot of the "Create new project" modal) is that selecting `\\wsl.localhost\Ubuntu\home\<user>\<project>` would fail with an unhelpful OS-level error well before the WSL-distro-aware error path could explain the situation and offer remedial options.

## Decision

For paths classified as **WSL UNC** by [`runtime::wsl::is_wsl_unc_path`](https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/runtime/wsl.rs) (covers `\\wsl.localhost\<distro>\...`, `\\wsl$\<distro>\...`, and their `\\?\UNC\` canonicalized equivalents), `add_project_with_data_dir`:

1. **Skips `canonicalize`** entirely.
2. **Performs the cross-distro check first** — if `<distro>` is not Speedwave's own runtime distro, bails with `consts::wsl_other_distro_msg(...)` (helpful, lists copy/move/native options).
3. **Rejects bare-root paths** (`\\wsl.localhost\Speedwave\`) via `runtime::wsl::is_root_path` — preventing the entire distro root from being mounted as `/workspace`. The helper normalises `.`, `..`, and trailing separators by walking `std::path::Components`, so `/foo/..` is correctly treated as root.[^7]
4. **Verifies directory existence with `std::fs::metadata`** rather than `canonicalize` — `metadata` (which wraps `GetFileAttributesExW` on Windows) accepts UNC paths and returns a clean Err on missing paths without normalisation side-effects.[^8]
5. **Stores the raw UNC string** as the project's `dir` field. Downstream `compose::render_compose` calls `windows_to_wsl_path` which now natively translates WSL UNC into the corresponding intra-distro path (`/<rest>`).

Drive-letter and Unix paths are unchanged — they continue to flow through `canonicalize` as before.

## Consequences

### Positive

- The user-facing error for cross-distro selection is the carefully crafted `WSL_OTHER_DISTRO_MSG`, not a raw OS error from `canonicalize`.
- Project registration succeeds in the happy path (`\\wsl.localhost\Speedwave\projects\foo`) without depending on undocumented `canonicalize`-on-UNC behaviour.
- Bare-root paths are caught by an explicit, named helper (`is_root_path`), so a regression in `is_wsl_unc_path` trailing-slash normalization cannot silently re-open the "mount `/` as `/workspace`" hole.

### Negative

- The duplicate-path check (`config.projects.iter().find(|p| canonicalize(&p.dir) == canonical)`) still calls `canonicalize` on the _stored_ paths. For UNC-stored paths the canonicalize call returns Err (caught by `unwrap_or(false)`), so duplicate-path detection silently fails for two UNC projects. The duplicate-**name** check still catches the most common case (same project added twice with the same name). Documented as an accepted minor regression — the value of helpful UNC errors outweighs duplicate-path detection across UNC paths, which would require parallel UNC-aware comparison logic to fix and is out of scope for this fix.
- Symlinks inside `\\wsl.localhost\Speedwave\...` are not resolved at registration time. If a user creates `\\wsl.localhost\Speedwave\projects\foo` as a symlink to elsewhere in the distro, the compose mount source remains the UNC path; the symlink is resolved by Linux kernel mount logic at container start, not at registration. Acceptable — symlinks under the runtime distro are user-controlled and our isolation boundary is the distro itself.

### Neutral

- No change for drive-letter or Unix project paths. `make test` + `make check` cover regression.
- No new dependencies, no new container mounts, no security model changes.

## Alternatives considered

1. **Map `canonicalize` errors on WSL UNC to the helpful message.** Would require recognising specific OS error codes per Windows build — fragile and locale-sensitive. Rejected.
2. **Pre-canonicalize via PowerShell `Resolve-Path`.** Adds a process spawn per project registration; PowerShell's UNC resolution has its own quirks. Rejected.
3. **Implement a Rust-side UNC canonicalizer.** Re-implementing path normalization for WSL UNC is a maintenance burden the value does not justify. Rejected — `is_wsl_unc_path` parsing plus trusting the user's input string is sufficient.

## Verification

- Unit tests in [`runtime/wsl.rs::tests`](https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/runtime/wsl.rs) cover happy paths, mismatch errors, malformed WSL UNC, and the `is_root_path` helper.
- Unit tests in [`project.rs::tests`](https://github.com/speednet-software/speedwave/blob/dev/crates/speedwave-runtime/src/project.rs) cover Windows-only UNC branches (cross-distro reject, bare-root reject, nonexistent subdir reject) and the cross-platform end-to-end happy path via `add_project_with_validated_dir`.
- `make test` and `make check` both pass on macOS host (Windows verification is manual).

## References

[^1]: Rust standard library, [`std::fs::canonicalize`](https://doc.rust-lang.org/std/fs/fn.canonicalize.html). Returns the canonical, absolute form of a path with all intermediate components normalized and symbolic links resolved.

[^2]: Microsoft Win32 API, [`GetFinalPathNameByHandleW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew) and the `VOLUME_NAME_DOS` flag - produces the `\\?\` (Win32 namespace) or `\\?\UNC\` (UNC namespace) extended-length form for network paths. Rust's `std::fs::canonicalize` is built on top of this API on Windows.

[^3]: Microsoft has an [open documentation request from 2022](https://github.com/MicrosoftDocs/WSL/issues/1671) for `\\wsl.localhost\` API behaviour. No primary source documents `canonicalize` behaviour on WSL UNC paths; community reports show variation across builds.

[^4]: WSL technical documentation, [Plan 9 redirector](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/plan9.md) - the `p9rdr.sys` redirector driver registers both `\\wsl$\` and `\\wsl.localhost\`; accessing either invokes `wslservice.exe`, a Windows service installed with WSL, to resolve the distribution and establish the Plan 9 connection.

[^5]: Documented user-reported variations in [microsoft/WSL#9789](https://github.com/microsoft/WSL/issues/9789) ("wsl ubuntu path lost all mounts") and [microsoft/WSL#8301](https://github.com/microsoft/WSL/issues/8301) ("Mounted Disk disappears on restart") show that `\\wsl.localhost\` and `\\wsl$\` accessibility is not stable across WSL distro lifecycle events; mount enumeration, error codes, and `canonicalize` results vary.

[^6]: Microsoft [`System Error Codes (0-499)`](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-) lists `ERROR_PATH_NOT_FOUND` (3) - "The system cannot find the path specified" - which is the bare OS string Rust surfaces as the `io::Error` source when `canonicalize` fails on a missing UNC path.

[^7]: Rust standard library, [`std::path::Components`](https://doc.rust-lang.org/std/path/struct.Components.html) and [`Component`](https://doc.rust-lang.org/std/path/enum.Component.html) - iterator producing `RootDir`, `CurDir`, `ParentDir`, `Normal`, and `Prefix` variants. `is_root_path` walks these to collapse `.` (no-op), `..` (pop), and `Normal` (push), returning `true` when the resulting depth is zero.

[^8]: Rust standard library, [`std::fs::metadata`](https://doc.rust-lang.org/std/fs/fn.metadata.html) - on Windows calls [`GetFileAttributesExW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileattributesexw) which accepts UNC paths directly without invoking the path canonicalization pipeline that `canonicalize` uses internally.

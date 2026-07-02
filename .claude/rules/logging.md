---
paths:
  - 'crates/**/*.rs'
  - 'desktop/src-tauri/**/*.rs'
---

# Logging Rules

All Rust code uses the `log` crate facade for diagnostic output. **Never use `eprintln!` or `println!` for logging** — the only acceptable use of `eprintln!` is for direct user-facing CLI output (e.g., "speedwave check FAILED") and the panic hook's last-resort fallback.

## Architecture

| Binary                        | Backend                                      | Config                                              |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------- |
| Desktop (`speedwave-desktop`) | `tauri-plugin-log` v2 (file + stdout)        | Fixed at `Trace`; no runtime toggle, no UI setting. |
| CLI (`speedwave`)             | `env_logger` (stderr, respects `RUST_LOG`)   | Initialized at CLI `main()` start                   |
| Library (`speedwave-runtime`) | `log` crate facade only (no backend opinion) | Callers provide the backend                         |

- **SSOT for secret redaction:** `crates/speedwave-runtime/src/log_sanitizer.rs` — all log output passes through `sanitize()` via `.format()` callbacks in both Desktop and CLI loggers. Secrets never reach disk or stdout.
- **SSOT for diagnostics:** `crates/speedwave-runtime/src/diagnostic_sources.rs::DIAGNOSTIC_SOURCES` — every file surfaced in the /logs UI and packed into the diagnostics ZIP. New log file = new registry entry (non-`displayable` sources are ZIP-only); never hand-wire a path into one consumer.
- **File helpers:** timestamped chmod-600 append + rotation live in `log_file.rs` (used by the Desktop claude-session log and the host-worker drain `host_mcp_process/drain.rs`, shared by mcp-os AND oauth via the `WorkerSpec` trait); timestamps only via `log_ts::log_timestamp()` / mcp-shared `ts()`.
- **Claude Code `ANTHROPIC_LOG=debug` output** passes through `http_debug_collator.rs` (block grouping + per-transaction summarizing) before the session log — extend it rather than logging raw multi-line debug blocks.
- **Poll loops log on state change only** — never one line per iteration (follow the IDE Bridge pattern).
- **Desktop log files:** `~/Library/Logs/<bundle-id>/` (macOS), `%LOCALAPPDATA%/<bundle-id>/logs` (Windows) — must match `tauri-plugin-log v2 TargetKind::LogDir`. Bundle id is `pl.speedwave.desktop` in release, `pl.speedwave.desktop.dev` under `make dev`; resolved at runtime in `desktop_log_dir()`. Rotation: 50 MB per file, `KeepSome(10)` — tauri-plugin-log prunes on every rotation; no separate cleanup timer.
- **CLI:** `RUST_LOG=debug speedwave check` enables debug output on stderr.

## Rules for writing log statements

- **Level selection:** `error!` for failures preventing operation, `warn!` for degraded/fallback conditions, `info!` for significant lifecycle events, `debug!` for diagnostic details, `trace!` for verbose internals.
- **No prefixes in log messages** — the log format `[{level}][{target}]` already provides context. Do not add `"[tauri] update:"` or `"IDE Bridge:"` prefixes. Exception: when logging from a module that handles multiple subsystems (e.g., `main.rs` tray handlers), a short prefix like `"tray:"` is acceptable for disambiguation.
- **Never log secrets.** Do not log tokens, passwords, API keys, HTTP Authorization headers, request/response bodies, or PEM keys. The `log_sanitizer` is a safety net, not a license to log secrets. When logging errors that might contain credentials, redact explicitly.
- **Structs containing secrets must not derive `Debug`** — implement a manual `Debug` that redacts sensitive fields, or wrap secret fields in a newtype with a redacting `Debug` impl.
- **Container/external logs** returned to the frontend (e.g., `get_all_logs`) must pass through `sanitize()` before being sent to the webview.

## Adding new sanitizer rules

When adding a new secret pattern to `log_sanitizer.rs`:

1. Add the regex + replacement to the `RULES` `LazyLock` initialization
2. Add at least one positive test (secret is redacted) and one false-positive test (normal text is unchanged)
3. Run `make test` — all sanitizer tests are in `crates/speedwave-runtime/src/log_sanitizer.rs`

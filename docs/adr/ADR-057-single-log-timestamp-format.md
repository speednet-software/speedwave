# ADR-057: Single Log Timestamp Format

**Status:** Accepted

**Date:** 2026-05-12

## Context

The unified `/logs` view (Desktop "System health") merges every host-side log source — the tauri-plugin-log file, `mcp-os.log`, the per-project `host-exec/<project>/log`, `claude-session.log` — with the compose-container stream and parses each line into `{ time, source, level, message }`. Six distinct timestamp formats were bleeding into it:

| Producer                                                                        | Format                    | Example                        |
| ------------------------------------------------------------------------------- | ------------------------- | ------------------------------ |
| tauri-plugin-log callback (`main.rs`) + CLI `env_logger`                        | `%Y-%m-%dT%H:%M:%S%.3f%z` | `2026-05-06T19:58:38.724+0200` |
| Desktop `log_file::format_timestamp` (drain prefix for mcp-os + claude-session) | `[DD-MM-YYYY HH:MM:SS]`   | `[25-12-2026 09:05:03]`        |
| `@speedwave/mcp-shared`'s `ts()` (every MCP worker + the hub)                   | `[HH:MM:SS]`              | `[14:34:02]`                   |
| `host_exec/audit.ts`, `hub/executor.ts` JSON `ts`/`timestamp` fields            | `toISOString()`           | `2026-05-12T14:34:02.814Z`     |
| `host_exec_process.rs` drain                                                    | none                      | `STDOUT: …`                    |
| nerdctl `--timestamps`                                                          | RFC 3339                  | `2026-04-28T12:34:56.123456Z`  |

The frontend parser only recognised bracketed `[HH:MM:SS]` and ISO timestamps, so the time column was **empty** for `mcp-os`, `host-exec`, `claude` and every MCP-worker source — the `DD-MM-YYYY` drain prefix matched nothing, and the host_exec drain emitted no timestamp at all. Each producer also had its own hand-rolled formatting code — five places to keep in sync.

## Decision

**One ISO 8601 timestamp format for every Speedwave-emitted log line, behind a single SSOT per language.**

- **Rust SSOT** — `crates/speedwave-runtime/src/log_ts.rs`. `log_timestamp()` renders `chrono::Local::now()` as RFC 3339 with millisecond precision and a colon-separated offset (`2026-05-12T14:34:02.814+02:00`; UTC renders as `+00:00`, not `Z`). `format_log_timestamp(&dt)` is the testable core. Consumed by the tauri-plugin-log format callback (`desktop/src-tauri/src/main.rs`), the CLI's `env_logger` format closure (`crates/speedwave-cli/src/main.rs`), and `log_file::write_log_line`.
- **TS SSOT** — `@speedwave/mcp-shared`'s `ts()` (`mcp-servers/shared/src/logger.ts`) returns `[<ISO 8601, UTC>]` (`[2026-05-12T14:34:02.814Z]`) via `new Date().toISOString()`. Every MCP worker, the hub, and plugins use it for log-line prefixes.
- **`log_file.rs` moves to `speedwave-runtime`.** It was Desktop-only (`log_file::open_log_file`/`write_log_line`/`truncate_if_oversized`) with a slimmed-down _duplicate_ inside `host_exec_process.rs`. The duplicate is deleted; the shared module is used by Desktop's claude-session log writer, the mcp-os drain, and the host_exec drain. `write_log_line` writes `<ISO> {prefix}: {line}` (or `<ISO> {line}` when the prefix is empty) — the ISO timestamp is **not** bracketed, so the frontend's `ISO_TIME_RE` matches it directly after the `<source> | ` prefix is stripped.
- **Structured JSON `ts`/`timestamp` fields are left alone.** `host_exec/audit.ts` and `hub/executor.ts` already use `toISOString()`, which is correct for a JSON value (not a log-line prefix).
- **nerdctl's `--timestamps` output is left alone** — Speedwave doesn't control it; the frontend already parses its RFC 3339 form.
- **Frontend parser** — `BRACKETED_TIME_RE` is extended to accept an ISO timestamp inside the brackets (workers now emit `[<ISO Z>]`); after timestamp extraction a leading `STDOUT: `/`STDERR: ` drain marker is stripped from the message (semantic claude-session prefixes — `SESSION:`/`TOOL:`/`RATE_LIMIT:`/`SYSTEM:` — are kept). `formatTime` already shortens ISO → `YYYY-MM-DD HH:MM:SS`; the raw value stays in the `[title]` tooltip.

Local time on the host (with offset) vs UTC `Z` in containers is deliberate: the worker `ts()` line sits inside the message body after the drain's host-side `<ISO>`, so the time **column** reflects "when the host saw the line" while the worker's own clock is still recoverable in the message text. A worker line that goes through the drain therefore carries two timestamps; that is acceptable.

## Consequences

**Positive**

- The `/logs` time column is populated for every source.
- Five hand-rolled timestamp formats collapse to two SSOTs; `host_exec_process.rs`'s duplicated log helpers are gone.
- Drain lines (including the worker's raw `════`-separator banners that have no `ts()` of their own) now carry a timestamp the frontend can show.

**Negative / neutral**

- Plugins' log lines change cosmetically (`[HH:MM:SS]` → `[<ISO Z>]`). Backward-compatible at the API level — `ts()` still returns a `string` used as a prefix; no plugin parses its own output.
- The `DD-MM-YYYY` drain-prefix form is gone; anything that scraped it (nothing in-tree) would break.
- A worker line that passes through the host_exec/mcp-os drain now shows two timestamps (drain-time + the worker's own `[<ISO Z>]` in the message). Intentional.

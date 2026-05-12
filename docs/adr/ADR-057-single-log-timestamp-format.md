# ADR-057: Single Log Timestamp Format

**Status:** Accepted

**Date:** 2026-05-12

## Context

The unified `/logs` view (Desktop "System health") merges every host-side log source — the tauri-plugin-log file, `mcp-os.log`, the per-project `host-exec/<project>/log`, `claude-session.log` — with the compose-container stream and parses each line into `{ time, source, level, message }`. Six distinct timestamp formats were bleeding into it:

| Producer                                                                        | Format                    | Example                        |
| ------------------------------------------------------------------------------- | ------------------------- | ------------------------------ |
| tauri-plugin-log callback (`main.rs`) + CLI `env_logger`                        | `%Y-%m-%dT%H:%M:%S%.3f%z` | `2026-05-06T19:58:38.724+0200` |
| Desktop `log_file::format_timestamp` (drain prefix for mcp-os + claude-session) | `[DD-MM-YYYY HH:MM:SS]`   | `[25-12-2026 09:05:03]`        |
| `@speedwave/mcp-shared`'s `ts()` (every MCP worker + the hub)                   | `[HH:MM:SS]`              | `[14:34:02]` (no date, no TZ)  |
| `host_exec/audit.ts`, `hub/executor.ts` JSON `ts`/`timestamp` fields            | `toISOString()`           | `2026-05-12T14:34:02.814Z`     |
| `host_exec_process.rs` drain                                                    | none                      | `STDOUT: …`                    |
| nerdctl `--timestamps`                                                          | RFC 3339                  | `2026-04-28T12:34:56.123456Z`  |

The frontend parser only recognised bracketed `[HH:MM:SS]` and ISO timestamps, so the time column was **empty** for `mcp-os`, `host-exec`, `claude` and every MCP-worker source — the `DD-MM-YYYY` drain prefix matched nothing, and the host_exec drain emitted no timestamp at all. Each producer also had its own hand-rolled formatting code — five places to keep in sync.

## Decision

**One ISO 8601 timestamp format for every Speedwave-emitted log line, behind a single SSOT per language.**

- **Rust SSOT** — `crates/speedwave-runtime/src/log_ts.rs`. `log_timestamp()` renders `chrono::Local::now()` as RFC 3339 with millisecond precision and a colon-separated offset (`2026-05-12T14:34:02.814+02:00`; UTC renders as `+00:00`, not `Z`). `format_log_timestamp(&dt)` is the testable core. Consumed by the tauri-plugin-log format callback (`desktop/src-tauri/src/main.rs`), the CLI's `env_logger` format closure (`crates/speedwave-cli/src/main.rs`), and `log_file::write_log_line`.
- **TS SSOT** — `@speedwave/mcp-shared`'s `ts()` (`mcp-servers/shared/src/logger.ts`) returns `[<ISO 8601 with local offset>]` (`[2026-05-12T14:34:02.814+02:00]`) — **local time**, i.e. the container's `TZ`, which `speedwave-runtime`'s `tz::detect_host_timezone` injects from the host into every compose service. So a worker's log clock matches the host's, and matches the Rust SSOT's offset form. Every MCP worker, the hub, and plugins use it for log-line prefixes. (`toISOString()` was rejected — it's always UTC `Z` regardless of `TZ`, which produced timestamps two hours off the host clock.)
- **`log_file.rs` moves to `speedwave-runtime`.** It was Desktop-only (`log_file::open_log_file`/`write_log_line`/`truncate_if_oversized`) with a slimmed-down _duplicate_ inside `host_exec_process.rs`. The duplicate is deleted; the shared module is used by Desktop's claude-session log writer, the mcp-os drain, and the host_exec drain. `write_log_line` writes `<ISO> {prefix}: {line}` (or `<ISO> {line}` when the prefix is empty) — the ISO timestamp is **not** bracketed, so the frontend's `ISO_TIME_RE` matches it directly after the `<source> | ` prefix is stripped.
- **Structured JSON `ts`/`timestamp` fields are left alone.** `host_exec/audit.ts` and `hub/executor.ts` use `toISOString()` (UTC `Z`), which is correct for a JSON value (not a log-line prefix).
- **nerdctl's `--timestamps` output is left alone** — Speedwave doesn't control it; it's UTC `Z`, which the frontend already parses.
- **Frontend parser** — `BRACKETED_TIME_RE` is extended to accept an ISO timestamp inside the brackets (workers emit `[<ISO>]` via `ts()`); after timestamp extraction a leading `STDOUT: `/`STDERR: ` drain marker is stripped from the message (semantic claude-session prefixes — `SESSION:`/`TOOL:`/`RATE_LIMIT:`/`SYSTEM:` — are kept). `formatTime` already shortens ISO → `YYYY-MM-DD HH:MM:SS`; the raw value stays in the `[title]` tooltip.

Both SSOTs render **local time with an explicit offset** (host TZ, propagated into containers via the `TZ` env). A worker line that passes through the host_exec/mcp-os drain therefore carries two same-instant timestamps (the drain's host-side `<ISO>` + the worker's own `[<ISO>]` in the message text); they agree, and the redundancy is acceptable.

## Consequences

**Positive**

- The `/logs` time column is populated for every source.
- Five hand-rolled timestamp formats collapse to two SSOTs; `host_exec_process.rs`'s duplicated log helpers are gone.
- Drain lines (including the worker's raw `════`-separator banners that have no `ts()` of their own) now carry a timestamp the frontend can show.

**Negative / neutral**

- Plugins' log lines change cosmetically (`[HH:MM:SS]` → `[<ISO with offset>]`). Backward-compatible at the API level — `ts()` still returns a `string` used as a prefix; no plugin parses its own output.
- The `DD-MM-YYYY` drain-prefix form is gone; anything that scraped it (nothing in-tree) would break.
- A worker line that passes through the host_exec/mcp-os drain shows two timestamps (drain-time + the worker's own `[<ISO>]` in the message). They agree (same instant, same offset); the redundancy is intentional.
- `ts()`'s offset is unit-tested against a mocked `getTimezoneOffset()` (covering CEST/IST/EDT/UTC), and `log_ts::format_log_timestamp` against `FixedOffset` fixtures. The full runtime chain (host TZ → `inject_host_timezone` → the container's `TZ` actually shifting `Date`/`chrono`) rests on the existing `inject_host_timezone` unit tests plus the `tzdata`-in-every-image SSOT alignment (CLAUDE.md); an end-to-end "container with a non-UTC `TZ` logs that zone" smoke is left to the `e2e-vm.sh` tier (not in CI — needs a live VM).

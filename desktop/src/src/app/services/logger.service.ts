import { Injectable } from '@angular/core';
import {
  debug as pluginLogDebug,
  error as pluginLogError,
  info as pluginLogInfo,
  warn as pluginLogWarn,
} from '@tauri-apps/plugin-log';

/**
 * Thin wrapper around `@tauri-apps/plugin-log` for Angular dependency injection.
 *
 * Components inject this service rather than calling the plugin import directly so
 * tests can `useValue: { info, warn, error, debug: vi.fn() }` instead of trying
 * to mock the underlying ESM module — `vi.mock` hoisting is unreliable under
 * `@angular/build:unit-test`.
 *
 * All four levels forward to the same tauri-plugin-log pipeline configured in
 * `desktop/src-tauri/src/main.rs` (file + stdout + webview targets), so logs
 * written via this service show up in:
 *   - the Logs view inside the running app (webview target),
 *   - the rotated log file under `~/Library/Logs/pl.speedwave.desktop/` (file target),
 *   - the dev-mode terminal (stdout target).
 *
 * That makes a user-supplied logs ZIP a single source of truth when triaging
 * support tickets — UI events, Tauri command boundaries, and Swift CLI traces
 * all converge into one timeline.
 */
@Injectable({ providedIn: 'root' })
export class LoggerService {
  /**
   * Forwards an error-level message to the Rust log pipeline. Logging failure
   * must never crash the UI — the underlying promise rejection is swallowed.
   * @param message - The message to log.
   */
  error(message: string): void {
    pluginLogError(message).catch(() => {});
  }

  /**
   * Forwards a warn-level message — used for non-fatal anomalies the user
   * (or future support reader) needs to see, e.g. an integration auto-disabled
   * because TCC denied permission.
   * @param message - The message to log.
   */
  warn(message: string): void {
    pluginLogWarn(message).catch(() => {});
  }

  /**
   * Forwards an info-level message — used for normal lifecycle events the
   * support reader needs to reconstruct what the user did, e.g. a toggle
   * click that succeeded.
   * @param message - The message to log.
   */
  info(message: string): void {
    pluginLogInfo(message).catch(() => {});
  }

  /**
   * Forwards a debug-level message — used for verbose diagnostic context that
   * is too chatty for `info` but still helpful in a logs ZIP. The Rust log
   * level filter (Trace by default — see `main.rs`) decides whether these
   * land in the file.
   * @param message - The message to log.
   */
  debug(message: string): void {
    pluginLogDebug(message).catch(() => {});
  }
}

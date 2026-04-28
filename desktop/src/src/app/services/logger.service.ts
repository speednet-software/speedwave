import { Injectable } from '@angular/core';
import { error as pluginLogError } from '@tauri-apps/plugin-log';

/**
 * Thin wrapper around `@tauri-apps/plugin-log` for Angular dependency injection.
 *
 * Components inject this service rather than calling the plugin import directly so
 * tests can `useValue: { error: vi.fn() }` instead of trying to mock the underlying
 * ESM module — `vi.mock` hoisting is unreliable under `@angular/build:unit-test`.
 */
@Injectable({ providedIn: 'root' })
export class LoggerService {
  /**
   * Forwards an error message to the Rust log pipeline. Errors during logging
   * are swallowed because logging failure must never crash the UI.
   * @param message - The error message to log.
   */
  error(message: string): void {
    pluginLogError(message).catch(() => {});
  }
}

import { Injectable } from '@angular/core';
import {
  debug as pluginLogDebug,
  error as pluginLogError,
  info as pluginLogInfo,
  warn as pluginLogWarn,
} from '@tauri-apps/plugin-log';

/**
 * Thin wrapper around `@tauri-apps/plugin-log` for Angular dependency injection.
 */
@Injectable({ providedIn: 'root' })
export class LoggerService {
  /**
   * Forwards an error-level message to the Rust log pipeline.
   * @param message - The message to log.
   */
  error(message: string): void {
    pluginLogError(message).catch(() => {});
  }

  /**
   * Forwards a warn-level message to the Rust log pipeline.
   * @param message - The message to log.
   */
  warn(message: string): void {
    pluginLogWarn(message).catch(() => {});
  }

  /**
   * Forwards an info-level message to the Rust log pipeline.
   * @param message - The message to log.
   */
  info(message: string): void {
    pluginLogInfo(message).catch(() => {});
  }

  /**
   * Forwards a debug-level message to the Rust log pipeline.
   * @param message - The message to log.
   */
  debug(message: string): void {
    pluginLogDebug(message).catch(() => {});
  }
}

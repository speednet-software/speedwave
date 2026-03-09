import { ErrorHandler, Injectable } from '@angular/core';

/**
 * Global error handler that forwards uncaught Angular errors to the Rust
 * log pipeline via @tauri-apps/plugin-log. Falls back to console.error
 * when running outside Tauri (e.g. during tests or ng serve).
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private logError: ((message: string) => Promise<void>) | null = null;
  private initPromise: Promise<void>;

  /** Initializes the Tauri log plugin bridge. */
  constructor() {
    this.initPromise = this.init();
  }

  /** Loads the Tauri log plugin dynamically. */
  private async init(): Promise<void> {
    try {
      const { error } = await import('@tauri-apps/plugin-log');
      this.logError = error;
    } catch {
      // Not running inside Tauri — plugin unavailable
    }
  }

  /**
   * Forwards uncaught errors to the Rust log pipeline.
   * @param error - The uncaught error or rejection value.
   */
  handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const full = stack ? `${message}\n${stack}` : message;

    // Always log to console as fallback
    console.error(error);

    // Forward to Rust log pipeline if available
    this.initPromise
      .then(() => {
        if (this.logError) {
          this.logError(`[Angular] ${full}`).catch(() => {});
        }
      })
      .catch(() => {});
  }
}

/**
 * Serialization queue for LibreOffice (`soffice`) invocations.
 * `soffice --headless` is not reentrant — two concurrent conversions on the same
 * machine corrupt each other's output even with separate `-env:UserInstallation`
 * profiles in practice — so every conversion goes through this single-slot queue.
 * @module mcp-office/lo-queue
 */

/** Serial queue: `run(fn)` resolves with `fn`'s result; `fn` starts only after all earlier `run` calls have settled. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Enqueue `fn`; it executes after every previously-enqueued task has settled (resolved or rejected).
   * @param fn - The async task to run exclusively.
   * @returns A promise for `fn`'s resolved value (or its rejection).
   * @template T
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive regardless of this task's outcome; swallow here so an
    // unhandled rejection on `tail` is impossible (the caller still sees it via `result`).
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** The process-wide LibreOffice queue. Import and use `libreOfficeQueue.run(...)` for any `soffice` call. */
export const libreOfficeQueue = new SerialQueue();

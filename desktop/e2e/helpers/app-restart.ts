/** SPEED-545: restarts the app (Tauri `AppHandle::restart` via the e2e-only
 *  `e2e_restart_app` command) with NO data wipe, unlike 07-factory-reset's restart. */

/** How long to wait for the relaunched process to answer WebDriver again. */
const DEFAULT_RESTART_TIMEOUT_MS = 180_000;

/** Triggers the restart; the invoke() call itself never resolves normally (the
 *  process exits before it can reply), so the connection drop is expected. */
async function triggerRestart(): Promise<void> {
  try {
    await browser.executeAsync((done: (ok: boolean) => void) => {
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke('e2e_restart_app')
        .then(() => done(true))
        .catch(() => done(false));
    });
  } catch {
    // Expected: app.restart() tears the WebDriver connection down mid-call.
  }
}

/** Restarts the app, reconnects wdio's `browser` via `reloadSession()` until the session lands on
 *  the relaunched process (not the dying one still bound to the port), and waits for remount. */
export async function restartAppAndReconnect(timeoutMs = DEFAULT_RESTART_TIMEOUT_MS): Promise<void> {
  const restartRequestedAt = Date.now();
  await triggerRestart();
  // Let the dying process release the WebDriver port before the first reconnect attempt.
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let lastError: unknown;
    try {
      await browser.reloadSession();
      // The dying instance keeps serving sessions through its exit cleanup (spec 07), so only
      // a page loaded after the restart request proves the session reached the new process.
      const pageLoadedAt = await browser.execute(() => performance.timeOrigin);
      if (pageLoadedAt >= restartRequestedAt) break;
      lastError = new Error('session landed on the pre-restart instance');
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const msg = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`app never rebound the WebDriver port after restart: ${msg}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  await $('[data-testid="project-pill"]').waitForExist({
    timeout: timeoutMs,
    timeoutMsg: 'shell never remounted after the app restart',
  });
}

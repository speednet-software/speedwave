
const DEFAULT_RESTART_TIMEOUT_MS = 180_000;

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
  }
}

export async function restartAppAndReconnect(timeoutMs = DEFAULT_RESTART_TIMEOUT_MS): Promise<void> {
  const restartRequestedAt = Date.now();
  await triggerRestart();
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let lastError: unknown;
    try {
      await browser.reloadSession();
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

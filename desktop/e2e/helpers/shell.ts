/** Helpers for synchronising with the shell's `projectState` lifecycle. */

/**
 * Waits until the shell's blocking overlay disappears (projectState ready).
 * @param timeoutMs - How long to wait for the overlay to clear.
 */
export async function waitForShellReady(timeoutMs = 60_000): Promise<void> {
  const overlay = await $('[data-testid="blocking-overlay"]');
  if (!(await overlay.isExisting())) return;
  await overlay.waitForExist({
    timeout: timeoutMs,
    reverse: true,
    timeoutMsg: `blocking-overlay still visible after ${timeoutMs}ms — projectState did not return to ready`,
  });
}

/**
 * Confirms the restart-required overlay and waits for the container restart; a failed
 * restart throws the inline `restart-error` text instead of waiting out the timeout.
 * @param timeoutMs - How long to wait for the restart to complete.
 */
export async function confirmRestartAndWait(timeoutMs = 180_000): Promise<void> {
  const btn = await $('[data-testid="restart-now-btn"]');
  await btn.waitForExist({
    timeout: 60_000,
    timeoutMsg: 'restart-now-btn never appeared — provider change did not request a restart',
  });
  await btn.click();
  let restartError = '';
  await browser.waitUntil(
    async () => {
      const error = await $('[data-testid="restart-error"]');
      if (await error.isExisting()) {
        restartError = await error.getText();
        return true;
      }
      return !(await $('[data-testid="restart-overlay"]').isExisting());
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `restart-overlay still visible after ${timeoutMs}ms — restart did not complete`,
    }
  );
  if (restartError) throw new Error(`restart failed: ${restartError}`);
}

/**
 * Requests a backend container restart via the command-palette action and
 * waits for it to complete. An independent entry point into requestRestart()
 * that does not depend on a pending config change.
 * @param timeoutMs - How long to wait for the restart to complete.
 */
export async function requestBackendRestart(timeoutMs = 180_000): Promise<void> {
  await (await $('[data-testid="nav-rail-palette"]')).click();
  await $('[data-testid="command-palette"]').waitForExist({ timeout: 10_000 });
  await (await $('[data-testid="palette-item-action-restart-containers"]')).click();
  await confirmRestartAndWait(timeoutMs);
}

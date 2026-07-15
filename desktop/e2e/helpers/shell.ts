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
 * Confirms the restart-required overlay (provider/integration change) and
 * waits for the container restart to finish. requestRestart() only sets
 * needsRestart — the user must click restart-now-btn to actually restart.
 * @param timeoutMs - How long to wait for the restart to complete.
 */
export async function confirmRestartAndWait(timeoutMs = 180_000): Promise<void> {
  const btn = await $('[data-testid="restart-now-btn"]');
  await btn.waitForExist({
    timeout: 60_000,
    timeoutMsg: 'restart-now-btn never appeared — provider change did not request a restart',
  });
  await btn.click();
  const overlay = await $('[data-testid="restart-overlay"]');
  await overlay.waitForExist({
    timeout: timeoutMs,
    reverse: true,
    timeoutMsg: `restart-overlay still visible after ${timeoutMs}ms — restart did not complete`,
  });
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

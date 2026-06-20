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

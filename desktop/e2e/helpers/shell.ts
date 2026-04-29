/**
 * Helpers for synchronising with the shell's `projectState` lifecycle.
 *
 * The shell renders a full-screen `blocking-overlay` whenever projectState is
 * not `ready` (loading / starting / switching / check_failed / error). The
 * overlay covers the chat header — including the project pill — so any test
 * that clicks the pill or the nav rail must first wait for the overlay to
 * clear, otherwise the click lands on the overlay and the assertion times
 * out with a misleading "element still not existing" error.
 */

/**
 * Waits until the shell's blocking overlay disappears (projectState ready).
 * If the overlay was never present, returns immediately. Throws after the
 * timeout if the overlay is still up — the caller usually treats that as a
 * test failure with a clear message.
 *
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

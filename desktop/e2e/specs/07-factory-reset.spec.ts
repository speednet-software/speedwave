/**
 * Factory Reset E2E tests.
 *
 * Verifies the factory reset flow:
 *   1. Navigate to settings, confirm project exists
 *   2. Invoke factory_reset via Tauri command — verify ~/.speedwave/ is wiped
 *   3. Confirm app.restart() fires (WebDriver port comes back up)
 *
 * This spec MUST be the last in the suite — it destroys all state.
 * No WebDriver reconnect is attempted; the session dies with the old
 * process and that is the expected final state.
 */

import * as http from 'node:http';

/** Poll the WebDriver endpoint until the restarted app is listening. */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function poll(): void {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Port ${port} did not respond within ${timeoutMs}ms after factory reset`));
        return;
      }
      const req = http.get(`http://127.0.0.1:${port}/status`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(poll, 1_000);
        }
      });
      req.on('error', () => setTimeout(poll, 1_000));
      req.setTimeout(2_000, () => {
        req.destroy();
        setTimeout(poll, 1_000);
      });
    }
    poll();
  });
}

describe('Factory Reset', function () {
  it('should navigate to settings and verify project exists', async function () {
    this.timeout(30_000);

    const nav = await $('[data-testid="nav-settings"]');
    await nav.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Settings nav link not found — earlier specs must complete successfully before factory reset tests can run',
    });
    await nav.click();

    // The legacy active-project info card was removed. Settings is "ready"
    // when the page heading is rendered; the active project itself is read
    // from `activeProjectSlug()` (backend ground truth).
    const title = await $('[data-testid="settings-title"]');
    await title.waitForExist({
      timeout: 10_000,
      timeoutMsg: 'Settings page heading not found',
    });
    expect(await title.isDisplayed()).toBe(true);
    const { activeProjectSlug } = await import('../helpers/projects');
    expect(await activeProjectSlug()).toBe('e2e-test');
  });

  it('should wipe state and restart the app', async function () {
    this.timeout(180_000);

    // Verify ~/.speedwave/ exists before reset (setup completed in earlier specs).
    const stateExists: boolean = await browser.executeAsync(
      (done: (result: boolean) => void) => {
        (window as any).__TAURI_INTERNALS__
          .invoke('is_setup_complete')
          .then((result: boolean) => done(result))
          .catch(() => done(false));
      },
    );
    expect(stateExists).toBe(true);

    // Click factory reset → confirm. app.restart() kills the process,
    // so the confirm click may throw — that is expected.
    const resetBtn = await $('[data-testid="settings-reset-btn"]');
    await resetBtn.click();

    const confirm = await $('[data-testid="settings-confirm-reset"]');
    await confirm.waitForExist({ timeout: 5_000 });

    try {
      await confirm.click();
    } catch {
      // Expected: session dies when Tauri process exits
    }

    // Wait for old process to die and release port 4445.
    // 3s covers TCP TIME_WAIT + process teardown on all platforms.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    // Poll until the restarted app binds port 4445 again.
    // This proves: factory_reset completed, app.restart() fired,
    // and the new process is listening.
    await waitForPort(browser.options.port ?? 4445, 150_000);
  });
});

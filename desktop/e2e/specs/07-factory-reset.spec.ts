/**
 * Factory Reset E2E tests.
 *
 * Verifies the factory reset flow:
 *   1. Pin e2e-test as the active project (specs 10-15 run earlier and may
 *      leave e2e-second active), navigate to settings, assert the exact slug
 *   2. Invoke factory_reset via Tauri command — verify ~/.speedwave/ is wiped
 *   3. Confirm app.restart() fires (WebDriver port comes back up)
 *
 * This spec MUST be the last in the suite — it destroys all state.
 */

import * as http from 'node:http';

import { switchToProject, activeProjectSlug } from '../helpers/projects';

const E2E_PROJECT_NAME = 'e2e-test';

/**
 * Minimal raw WebDriver call against the restarted app: the wdio `browser`
 * object holds the DEAD pre-reset session (reloadSession does not survive the
 * embedded tauri-plugin-webdriver restart), so drive HTTP directly.
 */
function wdRequest(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`WebDriver ${method} ${path} → ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve((JSON.parse(data) as { value: unknown }).value);
          } catch {
            reject(new Error(`unparseable WebDriver response: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error(`WebDriver ${method} ${path} timed out`));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

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
  before(async function () {
    this.timeout(180_000);
    // Earlier specs (10-15) switch projects; pin e2e-test so the
    // active-project assertion below stays an exact, deterministic match.
    if ((await activeProjectSlug()) !== E2E_PROJECT_NAME) {
      await switchToProject(E2E_PROJECT_NAME);
    }
  });

  it('should navigate to settings and verify the e2e-test project is active', async function () {
    this.timeout(30_000);

    const nav = await $('[data-testid="nav-settings"]');
    await nav.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Settings nav link not found — earlier specs must complete successfully before factory reset tests can run',
    });
    await nav.click();

    // Settings is ready when the page heading is rendered; active project from activeProjectSlug().
    const title = await $('[data-testid="settings-title"]');
    await title.waitForExist({
      timeout: 10_000,
      timeoutMsg: 'Settings page heading not found',
    });
    expect(await title.isDisplayed()).toBe(true);
    // The before hook pinned e2e-test — assert the exact slug, not just presence.
    expect(await activeProjectSlug()).toBe(E2E_PROJECT_NAME);
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

    // Click factory reset → confirm; app.restart() kills the process so the click may throw.
    const resetBtn = await $('[data-testid="settings-reset-btn"]');
    await resetBtn.click();

    const confirm = await $('[data-testid="settings-confirm-reset"]');
    await confirm.waitForExist({ timeout: 5_000 });

    try {
      await confirm.click();
    } catch {
      // Expected: session dies when Tauri process exits
    }

    // Wait for old process to die and release port 4445 (TCP TIME_WAIT + teardown).
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    // Poll until the restarted app binds port 4445 again.
    await waitForPort(browser.options.port ?? 4445, 150_000);
  });

  it('should land on the setup wizard with all state wiped', async function () {
    this.timeout(300_000);
    const port = browser.options.port ?? 4445;
    // waitForPort may have latched onto the DYING pre-reset listener; give the
    // cold post-wipe boot its own generous window before declaring death.
    await waitForPort(port, 120_000);
    const deadline = Date.now() + 240_000;

    // The dying pre-restart instance keeps the port bound through its exit
    // cleanup, so requests are split between BOTH instances and sessions
    // evaporate mid-use. Every call recreates the session on invalid-session
    // and retries; once the old process exits, calls stabilize on the new one.
    let sessionId: string | null = null;
    const exec = async (endpoint: 'sync' | 'async', script: string): Promise<unknown> => {
      let lastErr: unknown = null;
      while (Date.now() < deadline) {
        try {
          if (!sessionId) {
            const created = (await wdRequest(port, 'POST', '/session', {
              capabilities: { alwaysMatch: {} },
            })) as { sessionId?: string };
            sessionId = created.sessionId ?? null;
            if (!sessionId) throw new Error('WebDriver session response had no sessionId');
          }
          return await wdRequest(port, 'POST', `/session/${sessionId}/execute/${endpoint}`, {
            script,
            args: [],
          });
        } catch (err) {
          lastErr = err;
          if (String(err).includes('invalid session id') || String(err).includes('not found')) {
            sessionId = null; // stale instance answered — recreate and retry
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
      throw lastErr ?? new Error('post-reset WebDriver calls never stabilized');
    };

    try {
      // A reset that restarts but fails to wipe ~/.speedwave skips the wizard.
      let wizardVisible = false;
      while (Date.now() < deadline && !wizardVisible) {
        wizardVisible =
          (await exec(
            'sync',
            'return document.querySelector(\'[data-testid="setup-wizard"]\') !== null;'
          )) === true;
        if (!wizardVisible) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      expect(wizardVisible).toBe(true);

      const setupComplete = (await exec(
        'async',
        'const done = arguments[arguments.length - 1];' +
          'window.__TAURI_INTERNALS__.invoke("is_setup_complete")' +
          '.then((r) => done(r)).catch(() => done(true));'
      )) as boolean;
      expect(setupComplete).toBe(false);
    } finally {
      if (sessionId) {
        // Hand the LIVE session to wdio: its end-of-run endSession() would
        // otherwise DELETE the dead pre-reset session and crash the runner.
        (browser as unknown as { sessionId: string }).sessionId = sessionId;
      }
    }
  });
});

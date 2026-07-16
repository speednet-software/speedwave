/**
 * Restart Deferral E2E test.
 *
 * Covers the "later" path of the restart-required modal: an integration
 * toggle saves config, the user defers the restart, the app stays usable on
 * the OLD container config, and the pending change applies on the next
 * confirmed restart (requested here via the command palette action — a
 * second, independent entry point into requestRestart()).
 *
 * Runs after spec 15 (context7 is disabled on e2e-test when it ends) and
 * before spec 07. Leaves the suite state unchanged: context7 disabled,
 * e2e-test containers running.
 */

import { switchToProject, activeProjectSlug, containersRunning } from '../helpers/projects';
import { confirmRestartAndWait, requestBackendRestart } from '../helpers/shell';
import { openIntegrations, toggleIntegration, rowStatus } from '../helpers/llm';

const LLM_PROJECT = 'e2e-test';
const SERVICE = 'context7';

describe('Restart Deferral', function () {
  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== LLM_PROJECT) {
      await switchToProject(LLM_PROJECT);
    }
    await openIntegrations();
  });

  it('defers the restart with Later and keeps containers running', async function () {
    this.timeout(90_000);
    await toggleIntegration(SERVICE);

    const later = await $('[data-testid="restart-later-btn"]');
    await later.waitForExist({
      timeout: 30_000,
      timeoutMsg: 'restart modal never appeared after the integration toggle',
    });
    await later.click();

    // Modal dismissed, no restart happens, containers keep the old config.
    await $('[data-testid="restart-now-btn"]').waitForExist({ timeout: 10_000, reverse: true });
    for (let i = 0; i < 5; i++) {
      expect(await $('[data-testid="restart-overlay"]').isExisting()).toBe(false);
      await browser.pause(1_000);
    }
    expect(await containersRunning(LLM_PROJECT)).toBe(true);

    // The config change was saved: the row no longer reads disabled.
    expect(await rowStatus(SERVICE)).not.toBe('disabled');
  });

  it('applies the deferred change on a palette-requested restart', async function () {
    this.timeout(300_000);
    // requestRestart() re-surfaces the modal; confirming applies the change.
    await requestBackendRestart();

    await openIntegrations();
    await browser.waitUntil(async () => (await rowStatus(SERVICE)) === 'running', {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: `${SERVICE} row did not reach running after the deferred restart`,
    });
  });

  it('cleans up: disables the integration again', async function () {
    this.timeout(300_000);
    await toggleIntegration(SERVICE);
    await confirmRestartAndWait();
    await openIntegrations();
    await browser.waitUntil(async () => (await rowStatus(SERVICE)) === 'disabled', {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: `${SERVICE} row did not return to disabled during cleanup`,
    });
  });
});

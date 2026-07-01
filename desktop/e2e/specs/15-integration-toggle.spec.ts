/**
 * Integration Toggle E2E test.
 *
 * Covers enabling/disabling a built-in MCP integration (context7 — its api_key
 * is optional, so it toggles without credentials) across the project/LLM
 * matrix. Behavior confirmed against the backend:
 *   - no-provider project (e2e-second): the row reflects the new toggle state,
 *     but containers STAY DOWN (setup_wizard::start_containers guards on
 *     no-provider and defers) and NO restart overlay appears — the fix routes
 *     requestRestart through ensureContainersRunning, which no-ops via the same
 *     guard. This asserts the deferred, no-op-start behavior is intact.
 *   - provider-configured project (e2e-test): toggling shows the restart
 *     overlay; confirming it recreates containers and the row settles on
 *     running (enable) / disabled (disable).
 *
 * Runs after spec 14 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import { switchToProject, activeProjectSlug, containersRunning } from '../helpers/projects';
import { confirmRestartAndWait } from '../helpers/shell';
import { openIntegrations, toggleIntegration, rowStatus } from '../helpers/llm';

const NO_LLM_PROJECT = 'e2e-second';
const LLM_PROJECT = 'e2e-test';
const SERVICE = 'context7';

describe('Integration Toggle', function () {
  describe('no-provider project defers (no containers, no overlay)', function () {
    before(async function () {
      this.timeout(180_000);
      if ((await activeProjectSlug()) !== NO_LLM_PROJECT) {
        await switchToProject(NO_LLM_PROJECT);
      }
      await openIntegrations();
    });

    it('enables the integration but does not start containers', async function () {
      this.timeout(60_000);
      await toggleIntegration(SERVICE);
      // Row reflects the enable optimistically.
      await browser.waitUntil(async () => (await rowStatus(SERVICE)) !== 'disabled', {
        timeout: 15_000,
        timeoutMsg: `${SERVICE} row never left disabled after enable`,
      });
      // requestRestart routes no_provider through ensureContainersRunning, which
      // runs a brief system_check/checking cycle then defers. No restart overlay
      // ever renders and containers stay down — assert it holds, not just once.
      for (let i = 0; i < 6; i++) {
        expect(await $('[data-testid="restart-now-btn"]').isExisting()).toBe(false);
        expect(await containersRunning(NO_LLM_PROJECT)).toBe(false);
        await browser.pause(2_000);
      }
    });

    it('disables the integration again (still no containers)', async function () {
      this.timeout(60_000);
      await toggleIntegration(SERVICE);
      await browser.waitUntil(async () => (await rowStatus(SERVICE)) === 'disabled', {
        timeout: 15_000,
        timeoutMsg: `${SERVICE} row did not return to disabled`,
      });
      expect(await containersRunning(NO_LLM_PROJECT)).toBe(false);
    });
  });

  describe('provider project restarts on toggle', function () {
    before(async function () {
      this.timeout(180_000);
      await switchToProject(LLM_PROJECT);
      expect(await activeProjectSlug()).toBe(LLM_PROJECT);
      await openIntegrations();
    });

    it('enables an integration and restarts to running', async function () {
      this.timeout(240_000);
      await toggleIntegration(SERVICE);
      await confirmRestartAndWait();
      await openIntegrations();
      await browser.waitUntil(async () => (await rowStatus(SERVICE)) === 'running', {
        timeout: 120_000,
        interval: 3_000,
        timeoutMsg: `${SERVICE} row did not reach running after enable`,
      });
    });

    it('disables the integration and restarts', async function () {
      this.timeout(240_000);
      await toggleIntegration(SERVICE);
      await confirmRestartAndWait();
      await openIntegrations();
      await browser.waitUntil(async () => (await rowStatus(SERVICE)) === 'disabled', {
        timeout: 120_000,
        interval: 3_000,
        timeoutMsg: `${SERVICE} row did not reach disabled after disable`,
      });
    });
  });
});

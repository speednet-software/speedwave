/**
 * Logs & Diagnostics E2E test.
 *
 * Covers the /logs view end to end: navigation via the command palette
 * (palette nav item coverage), the health status bar (get_health surface),
 * log line rendering with level filtering, and the diagnostics ZIP export
 * (get_all_logs aggregation → log_sanitizer → export_diagnostics → success
 * modal with a copyable path).
 *
 * Runs after spec 16 on e2e-test (containers running) and before spec 07.
 */

import { switchToProject, activeProjectSlug } from '../helpers/projects';

const LLM_PROJECT = 'e2e-test';

describe('Logs & Diagnostics', function () {
  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== LLM_PROJECT) {
      await switchToProject(LLM_PROJECT);
    }
  });

  it('opens the logs view via the command palette', async function () {
    this.timeout(30_000);
    await (await $('[data-testid="nav-rail-palette"]')).click();
    await $('[data-testid="command-palette"]').waitForExist({ timeout: 10_000 });

    await (await $('[data-testid="palette-item-nav-logs"]')).click();
    await $('[data-testid="logs-header"]').waitForExist({ timeout: 15_000 });
    expect(await $('[data-testid="logs-status-bar"]').isExisting()).toBe(true);
  });

  it('shows the health status bar after the first health fetch', async function () {
    this.timeout(60_000);
    await $('[data-testid="health-overall"]').waitForExist({ timeout: 30_000 });
    expect(await $('[data-testid="health-vm"]').isExisting()).toBe(true);
    expect(await $('[data-testid="health-containers"]').isExisting()).toBe(true);
  });

  it('renders log lines and filters by level', async function () {
    this.timeout(60_000);
    await browser.waitUntil(
      async () => (await $$('[data-testid="logs-line"]').getElements()).length > 0,
      { timeout: 30_000, timeoutMsg: 'no log lines rendered on the logs view' }
    );

    // Level chips are mutually exclusive; filtering must never error the view.
    await (await $('[data-testid="logs-level-error"]')).click();
    await browser.waitUntil(
      async () => {
        if (await $('[data-testid="logs-empty"]').isExisting()) return true;
        const levels = await $$('[data-testid="logs-level"]').getElements();
        if (levels.length === 0) return false;
        for (const lvl of levels) {
          if ((await lvl.getText()).trim() !== 'error') return false;
        }
        return true;
      },
      { timeout: 15_000, timeoutMsg: 'error-level filter left non-error lines visible' }
    );

    await (await $('[data-testid="logs-level-all"]')).click();
    await browser.waitUntil(
      async () => (await $$('[data-testid="logs-line"]').getElements()).length > 0,
      { timeout: 15_000, timeoutMsg: 'log lines did not return after resetting the level filter' }
    );
    expect(await $('[data-testid="logs-error"]').isExisting()).toBe(false);
  });

  it('exports the diagnostics ZIP and surfaces the path', async function () {
    this.timeout(180_000);
    await (await $('[data-testid="logs-export"]')).click();

    // Aggregation + sanitization + ZIP can take a while on a loaded system.
    await $('[data-testid="export-diagnostics-overlay"]').waitForExist({
      timeout: 120_000,
      timeoutMsg: 'diagnostics export never completed (no success modal)',
    });
    expect(await $('[data-testid="export-diagnostics-copy"]').isExisting()).toBe(true);

    await (await $('[data-testid="export-diagnostics-close"]')).click();
    await $('[data-testid="export-diagnostics-overlay"]').waitForExist({
      timeout: 10_000,
      reverse: true,
    });
    expect(await $('[data-testid="logs-error"]').isExisting()).toBe(false);
  });
});

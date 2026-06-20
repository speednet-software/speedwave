/**
 * Settings E2E tests: verify the settings page loads with project data from setup.
 */

import { activeProjectSlug } from '../helpers/projects';

describe('Settings', function () {
  before(async function () {
    this.timeout(30_000);

    const nav = await $('[data-testid="nav-settings"]');
    await nav.waitForExist({
      timeout: 15_000,
      timeoutMsg:
        'Settings nav link not found — spec 02 (setup wizard) must complete successfully before settings tests can run',
    });
    await nav.click();

    // Settings ready signal: wait for the page heading.
    const title = await $('[data-testid="settings-title"]');
    await title.waitForExist({ timeout: 10_000 });
  });

  it('should expose the active project surface bound to the e2e-test slug', async function () {
    this.timeout(15_000);
    expect(await activeProjectSlug()).toBe('e2e-test');
  });

  it('should expose the factory-reset button', async function () {
    this.timeout(15_000);
    const resetBtn = await $('[data-testid="settings-reset-btn"]');
    expect(await resetBtn.isDisplayed()).toBe(true);
  });

  it('should show the confirm dialog on reset click and allow cancel', async function () {
    this.timeout(15_000);

    const resetBtn = await $('[data-testid="settings-reset-btn"]');
    await resetBtn.click();

    const confirm = await $('[data-testid="settings-confirm-reset"]');
    await confirm.waitForExist({ timeout: 3_000 });
    expect(await confirm.isDisplayed()).toBe(true);

    const cancel = await $('[data-testid="settings-cancel-reset"]');
    expect(await cancel.isExisting()).toBe(true);
    await cancel.click();

    await confirm.waitForExist({ timeout: 3_000, reverse: true });
    expect(await $('[data-testid="settings-confirm-reset"]').isExisting()).toBe(false);
  });

  it('should expose the check-for-updates button', async function () {
    this.timeout(15_000);
    const updateBtn = await $('[data-testid="settings-check-update"]');
    expect(await updateBtn.isDisplayed()).toBe(true);
  });

  it('should not duplicate the export-diagnostics control (moved to /logs)', async function () {
    this.timeout(15_000);
    // Diagnostics export relocated to /logs; assert absence here.
    const exportBtn = await $('[data-testid="settings-export-diagnostics"]');
    expect(await exportBtn.isExisting()).toBe(false);
  });
});

/**
 * Settings E2E tests.
 *
 * Verifies the settings page loads correctly with project data from setup.
 * The `before()` hook navigates to settings and fails if the page does not
 * load — no silent early returns. All assertions use `data-testid` only.
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

    // Settings ready signal — the legacy "active project" info card was
    // replaced by an info-glyph tooltip on the shared project-pill, so we
    // wait for the page heading instead. Active-project verification still
    // happens through `activeProjectSlug()` (backend ground truth).
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
    // Diagnostics export was relocated to System health (/logs). The settings
    // page must no longer render its own copy — assert absence so a future
    // accidental re-introduction trips the suite immediately.
    const exportBtn = await $('[data-testid="settings-export-diagnostics"]');
    expect(await exportBtn.isExisting()).toBe(false);
  });
});

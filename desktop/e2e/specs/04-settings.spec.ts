/**
 * Settings E2E tests.
 *
 * Verifies the settings page loads correctly with project data from setup.
 * The before() hook navigates to settings and fails if the page does not
 * load — no silent early returns.
 */

describe('Settings', function () {
  before(async function () {
    this.timeout(30_000);

    const nav = await $('[data-testid="nav-settings"]');
    await nav.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Settings nav link not found — spec 02 (setup wizard) must complete successfully before settings tests can run',
    });
    await nav.click();

    const project = await $('[data-testid="settings-active-project"]');
    await project.waitForExist({ timeout: 10_000 });
  });

  it('should display the active project name', async function () {
    this.timeout(15_000);
    const activeProject = await $('[data-testid="settings-active-project"]');
    expect(await activeProject.isDisplayed()).toBe(true);
    const text = (await activeProject.getText()).trim();
    expect(text).toContain('e2e-test');
  });

  it('should display factory reset button', async function () {
    this.timeout(15_000);
    const resetBtn = await $('[data-testid="settings-reset-btn"]');
    expect(await resetBtn.isDisplayed()).toBe(true);
    const text = (await resetBtn.getText()).trim().toLowerCase();
    expect(text).toContain('reset');
  });

  it('should show confirmation dialog on reset click and allow cancel', async function () {
    this.timeout(15_000);

    const resetBtn = await $('[data-testid="settings-reset-btn"]');
    await resetBtn.click();

    const confirm = await $('[data-testid="settings-confirm-reset"]');
    await confirm.waitForExist({ timeout: 3_000 });
    expect(await confirm.isDisplayed()).toBe(true);
    expect((await confirm.getText()).trim()).toBe('Confirm Reset');

    // Cancel to avoid actual reset
    const cancel = await $('[data-testid="settings-cancel-reset"]');
    expect(await cancel.isExisting()).toBe(true);
    await cancel.click();

    // Confirm dialog should disappear
    await confirm.waitForExist({ timeout: 3_000, reverse: true });
  });

  it('should display check for updates button', async function () {
    this.timeout(15_000);
    const updateBtn = await $('[data-testid="settings-check-update"]');
    expect(await updateBtn.isDisplayed()).toBe(true);
  });

  it('should display log level selector', async function () {
    this.timeout(15_000);
    const logLevel = await $('[data-testid="settings-log-level"]');
    expect(await logLevel.isDisplayed()).toBe(true);
  });

  it('should display export diagnostics button', async function () {
    this.timeout(15_000);
    const exportBtn = await $('[data-testid="settings-export-diagnostics"]');
    expect(await exportBtn.isDisplayed()).toBe(true);
  });
});

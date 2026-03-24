/**
 * Navigation E2E tests.
 *
 * Verifies the shell header, nav links, routing, and project switcher
 * after setup has completed. The before() hook fails if the shell is
 * not present — no silent early returns.
 */

describe('Navigation', function () {
  before(async function () {
    this.timeout(30_000);
    const shellTitle = await $('[data-testid="shell-title"]');
    await shellTitle.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Shell not found — spec 02 (setup wizard) must complete successfully before navigation tests can run',
    });
  });

  it('should display Speedwave title in the shell header', async function () {
    this.timeout(15_000);
    const title = await $('[data-testid="shell-title"]');
    expect((await title.getText()).trim()).toBe('Speedwave');
  });

  it('should have Integrations and Settings nav links (Chat conditional on auth)', async function () {
    this.timeout(15_000);

    // Chat link visibility depends on auth state — may or may not be present
    // after fresh setup (Windows WSL2 may retain auth from previous runs).
    // We only verify it's a valid link if present.
    const chat = await $('[data-testid="nav-chat"]');
    if (await chat.isExisting()) {
      expect((await chat.getText()).trim()).toBe('Chat');
    }

    const integrations = await $('[data-testid="nav-integrations"]');
    expect(await integrations.isExisting()).toBe(true);
    expect((await integrations.getText()).trim()).toBe('Integrations');

    const settings = await $('[data-testid="nav-settings"]');
    expect(await settings.isExisting()).toBe(true);
    expect((await settings.getText()).trim()).toBe('Settings');
  });

  it('should navigate to Integrations when clicking Integrations link', async function () {
    this.timeout(15_000);
    const integrations = await $('[data-testid="nav-integrations"]');
    await integrations.click();

    const section = await $('[data-testid="integrations-services"]');
    await section.waitForExist({ timeout: 10_000, timeoutMsg: 'Integrations services section did not appear after clicking Integrations link' });
    expect(await section.isDisplayed()).toBe(true);
  });

  it('should navigate to Settings when clicking Settings link', async function () {
    this.timeout(15_000);
    const settings = await $('[data-testid="nav-settings"]');
    await settings.click();

    const activeProject = await $('[data-testid="settings-active-project"]');
    await activeProject.waitForExist({ timeout: 10_000, timeoutMsg: 'Settings active project did not appear after clicking Settings link' });
    expect(await activeProject.isDisplayed()).toBe(true);
  });

  it('should show project switcher with e2e-test project', async function () {
    this.timeout(15_000);
    const switcher = await $('[data-testid="project-switcher-btn"]');
    await switcher.waitForExist({ timeout: 5_000, timeoutMsg: 'Project switcher button not found — expected e2e-test project to be active' });
    const text = await switcher.getText();
    expect(text).toContain('e2e-test');
  });
});

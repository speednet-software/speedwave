/**
 * Navigation E2E tests.
 *
 * Verifies the shell header, nav links, routing, and project switcher
 * after setup has completed. The before() hook fails if the shell is
 * not present — no silent early returns.
 */

describe('Navigation', function () {
  before(async function () {
    this.timeout(65_000);
    // Wait for shell title (always in DOM once shell component mounts)
    const shellTitle = await $('[data-testid="shell-title"]');
    await shellTitle.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Shell not found — spec 02 (setup wizard) must complete successfully before navigation tests can run',
    });
    // Fail fast if project is in error state — gives a clear message instead
    // of letting every navigation test individually time out.
    const errorBanner = await $('[data-testid="blocking-error"]');
    if (await errorBanner.isExisting()) {
      const msg = await errorBanner.$('span').getText();
      throw new Error(`Project is in error state — cannot test navigation: ${msg}`);
    }
    // If blocking overlay is visible, wait for it to disappear (status → ready).
    // After spec 03 (container-health) passes, this should resolve quickly.
    const overlay = await $('[data-testid="blocking-overlay"]');
    if (await overlay.isExisting()) {
      await overlay.waitForExist({
        timeout: 45_000,
        reverse: true,
        timeoutMsg: 'Blocking overlay still visible — projectState did not reach ready',
      });
    }
  });

  it('should display Speedwave title in the shell header', async function () {
    this.timeout(15_000);
    const title = await $('[data-testid="shell-title"]');
    expect((await title.getText()).trim()).toBe('Speedwave');
  });

  it('should have Chat, Integrations, and Settings nav links', async function () {
    this.timeout(15_000);

    const chat = await $('[data-testid="nav-chat"]');
    expect(await chat.isExisting()).toBe(true);
    expect((await chat.getText()).trim()).toBe('Chat');

    const integrations = await $('[data-testid="nav-integrations"]');
    expect(await integrations.isExisting()).toBe(true);
    expect((await integrations.getText()).trim()).toBe('Integrations');

    const settings = await $('[data-testid="nav-settings"]');
    expect(await settings.isExisting()).toBe(true);
    expect((await settings.getText()).trim()).toBe('Settings');
  });

  it('should navigate to Chat when clicking Chat link', async function () {
    this.timeout(30_000);
    const chat = await $('[data-testid="nav-chat"]');
    await chat.click();
    const messages = await $('[data-testid="chat-messages"]');
    await messages.waitForExist({
      timeout: 20_000,
      timeoutMsg: 'Chat messages container did not render',
    });
  });

  it('should navigate to Integrations when clicking Integrations link', async function () {
    this.timeout(15_000);
    const integrations = await $('[data-testid="nav-integrations"]');
    await integrations.click();

    const section = await $('[data-testid="integrations-services"]');
    await section.waitForExist({ timeout: 10_000 });
    expect(await section.isDisplayed()).toBe(true);
  });

  it('should navigate to Settings when clicking Settings link', async function () {
    this.timeout(15_000);
    const settings = await $('[data-testid="nav-settings"]');
    await settings.click();

    const activeProject = await $('[data-testid="settings-active-project"]');
    await activeProject.waitForExist({ timeout: 10_000 });
    expect(await activeProject.isDisplayed()).toBe(true);
  });

  it('should show project switcher with e2e-test project', async function () {
    this.timeout(15_000);
    const switcher = await $('[data-testid="project-switcher-btn"]');
    await switcher.waitForExist({ timeout: 5_000 });
    const text = await switcher.getText();
    expect(text).toContain('e2e-test');
  });
});

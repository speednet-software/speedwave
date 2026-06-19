/**
 * Navigation E2E tests: shell header, nav links, routing, project switcher.
 * Uses data-testid only; fails fast if setup incomplete.
 */

import { activeProjectSlug } from '../helpers/projects';

describe('Navigation', function () {
  before(async function () {
    this.timeout(65_000);

    // Project pill = ready signal (setupCompleteGuard resolved).
    const pill = await $('[data-testid="project-pill"]');
    await pill.waitForExist({
      timeout: 15_000,
      timeoutMsg:
        'Shell not found — spec 02 (setup wizard) must complete successfully before navigation tests can run',
    });

    // Fail fast if project is in error state.
    const errorBanner = await $('[data-testid="blocking-error"]');
    if (await errorBanner.isExisting()) {
      throw new Error('Project is in error state — cannot test navigation');
    }

    // Wait for blocking overlay to clear (status → ready).
    const overlay = await $('[data-testid="blocking-overlay"]');
    if (await overlay.isExisting()) {
      await overlay.waitForExist({
        timeout: 45_000,
        reverse: true,
        timeoutMsg: 'Blocking overlay still visible — projectState did not reach ready',
      });
    }
  });

  it('should expose the project pill in the shell header', async function () {
    this.timeout(15_000);
    const pill = await $('[data-testid="project-pill"]');
    expect(await pill.isExisting()).toBe(true);
  });

  it('should expose Integrations and Settings nav links (Chat conditional on auth)', async function () {
    this.timeout(15_000);

    // Chat link presence depends on auth state; verify only.
    const integrations = await $('[data-testid="nav-integrations"]');
    expect(await integrations.isExisting()).toBe(true);

    const settings = await $('[data-testid="nav-settings"]');
    expect(await settings.isExisting()).toBe(true);
  });

  it('should navigate to Chat when clicking Chat link (if authenticated)', async function () {
    this.timeout(30_000);
    const chat = await $('[data-testid="nav-chat"]');
    if (await chat.isExisting()) {
      await chat.click();
      // Chat route mounted if chat-view OR chat-view-blocked exists.
      await browser.waitUntil(
        async () => {
          return (
            (await $('[data-testid="chat-view"]').isExisting()) ||
            (await $('[data-testid="chat-view-blocked"]').isExisting())
          );
        },
        { timeout: 20_000, timeoutMsg: 'Chat route did not mount any of the expected surfaces' },
      );
    }
  });

  it('should navigate to Integrations when clicking Integrations link', async function () {
    this.timeout(15_000);
    const integrations = await $('[data-testid="nav-integrations"]');
    await integrations.click();

    // Integrations route anchored by body container.
    const body = await $('[data-testid="integrations-body"]');
    await body.waitForExist({ timeout: 10_000 });
    expect(await body.isDisplayed()).toBe(true);
  });

  it('should navigate to Settings when clicking Settings link', async function () {
    this.timeout(15_000);
    const settings = await $('[data-testid="nav-settings"]');
    await settings.click();

    // Settings ready signal: page heading (project card removed).
    const title = await $('[data-testid="settings-title"]');
    await title.waitForExist({ timeout: 10_000 });
    expect(await title.isDisplayed()).toBe(true);
  });

  it('should expose the project pill bound to the active project slug', async function () {
    this.timeout(15_000);
    const pill = await $('[data-testid="project-pill"]');
    await pill.waitForExist({ timeout: 5_000 });
    expect(await activeProjectSlug()).toBe('e2e-test');
  });
});

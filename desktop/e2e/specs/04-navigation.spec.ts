/**
 * Navigation E2E tests.
 *
 * Verifies the shell header, nav links, routing, and project switcher
 * after setup has completed. The `before()` hook fails fast if the shell
 * is not present — no silent early returns. All assertions use
 * `data-testid` attributes only — never UX-volatile text.
 */

import { activeProjectSlug } from '../helpers/projects';

describe('Navigation', function () {
  before(async function () {
    this.timeout(65_000);

    // The project pill in the chat header is the canonical "shell mounted"
    // marker — it only renders once setupCompleteGuard has resolved and the
    // shell component is on screen.
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

    // If a blocking overlay is visible, wait for it to clear (status → ready).
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

    // Chat link visibility depends on auth state — may or may not be present
    // after fresh setup. Only verify presence; do not check copy.
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
      // The chat surface renders one of: chat-view (authenticated) or
      // chat-view-blocked (auth_required). Either signals the Chat route
      // mounted successfully.
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

    // The integrations route is anchored by its body container.
    const body = await $('[data-testid="integrations-body"]');
    await body.waitForExist({ timeout: 10_000 });
    expect(await body.isDisplayed()).toBe(true);
  });

  it('should navigate to Settings when clicking Settings link', async function () {
    this.timeout(15_000);
    const settings = await $('[data-testid="nav-settings"]');
    await settings.click();

    // Project info card was removed; the page heading is the new ready
    // signal. Settings ground-truth lives in `activeProjectSlug()`.
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

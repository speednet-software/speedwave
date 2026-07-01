/**
 * No-LLM Chat Gating E2E test.
 *
 * The e2e-second project (created by spec 06 with no LLM provider) must block
 * chat access: navigating to /chat renders the choose-a-provider surface
 * (chat-view-no-provider) instead of the composer. This is the positive
 * assertion of the product rule "chat is only available once an LLM provider
 * is configured".
 *
 * Runs after spec 09 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import { switchToProject, activeProjectSlug } from '../helpers/projects';

const SECOND_PROJECT_NAME = 'e2e-second';

describe('No-LLM Chat Gating (second project)', function () {
  before(async function () {
    this.timeout(180_000);
    await switchToProject(SECOND_PROJECT_NAME);
    expect(await activeProjectSlug()).toBe(SECOND_PROJECT_NAME);
  });

  it('blocks /chat with the choose-a-provider surface', async function () {
    this.timeout(60_000);
    await (await $('[data-testid="nav-chat"]')).click();

    const blocked = await $('[data-testid="chat-view-no-provider"]');
    await blocked.waitForExist({ timeout: 30_000 });
  });

  it('renders no composer / chat input for a no-provider project', async function () {
    this.timeout(15_000);
    expect(await $('[data-testid="chat-input"]').isExisting()).toBe(false);
    expect(await $('[data-testid="chat-view"]').isExisting()).toBe(false);
  });

  it('offers a settings link out of the blocked state', async function () {
    this.timeout(15_000);
    const link = await $('[data-testid="chat-view-no-provider"] a');
    expect(await link.getAttribute('href')).toContain('/settings');
  });

  it('shows the block on a direct /chat navigation too', async function () {
    this.timeout(30_000);
    await browser.execute(() => (window.location.href = '/chat'));
    const blocked = await $('[data-testid="chat-view-no-provider"]');
    await blocked.waitForExist({ timeout: 30_000 });
  });

  it('navigates to settings from the block link', async function () {
    this.timeout(30_000);
    await (await $('[data-testid="chat-view-no-provider"] a')).click();
    await $('[data-testid="settings-title"]').waitForExist({ timeout: 15_000 });
  });
});

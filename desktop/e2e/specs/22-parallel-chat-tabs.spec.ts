/**
 * Parallel Chat Tabs E2E test (SPEED-388).
 *
 * Tabs are beta-gated (`ui.beta_enabled`): the before hook flips the flag directly
 * in config.json (the same file `get_beta_enabled` reads) and restarts the whole
 * app via `restartAppAndReconnect()` so the fresh boot picks it up — a live app
 * only refetches the flag on the `beta-changed` event, which a direct file edit
 * never fires. The after hook restores the prior value and restarts again, even
 * if an `it` above fails.
 *
 * Covers: opening a second tab, both tabs streaming independently with no
 * cross-tab content bleed, stopping one tab's stream leaving the other running,
 * and resuming an already-open conversation from history activating the
 * existing tab instead of duplicating it.
 *
 * Runs on e2e-test, after spec 21 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { restartAppAndReconnect } from '../helpers/app-restart';
import { readBetaEnabled, setBetaEnabled } from '../helpers/host-files';
import {
  openChat,
  sendMessageNoWait,
  waitForTurnStart,
  waitForTurnComplete,
  conversationText,
  startNewConversation,
  openHistory,
} from '../helpers/llm';
import { LONG_STREAM_PROMPT } from '../helpers/memory-fact';

const E2E_PROJECT_NAME = 'e2e-test';
const TAB_A_SENTINEL = 'E2E-TABS-A';
const TAB_B_SENTINEL = 'E2E-TABS-B';
const TAB_A_PROMPT = `[${TAB_A_SENTINEL}] ${LONG_STREAM_PROMPT}`;
const TAB_B_PROMPT = `[${TAB_B_SENTINEL}] ${LONG_STREAM_PROMPT}`;

async function chatTabRows() {
  return $$('[data-testid="chat-tab"]').getElements();
}

async function isTabActive(index: number): Promise<boolean> {
  const rows = await chatTabRows();
  return (await rows[index].getAttribute('data-active')) === 'true';
}

async function activateTab(index: number): Promise<void> {
  const rows = await chatTabRows();
  await (await rows[index].$('[data-testid="chat-tab-activate"]')).click();
  await browser.waitUntil(async () => await isTabActive(index), {
    timeout: 10_000,
    timeoutMsg: `tab ${index} never became active after clicking chat-tab-activate`,
  });
}

async function streamingTabCount(): Promise<number> {
  return (await $$('[data-testid="chat-tab-streaming"]').getElements()).length;
}

async function resumeConversationMatching(sentinel: string): Promise<void> {
  await openHistory();
  const search = await $('input[name="conversations-search"]');
  await search.setValue(sentinel);
  await browser.waitUntil(
    async () => (await $$('[data-testid="conversations-sidebar-row"]').getElements()).length === 1,
    {
      timeout: 10_000,
      timeoutMsg: `history search for "${sentinel}" did not narrow to exactly one row`,
    }
  );
  const row = (await $$('[data-testid="conversations-sidebar-row"]').getElements())[0];
  await (await row.$('[data-testid^="conversation-resume-"]')).click();
}

describe('Parallel Chat Tabs (SPEED-388)', function () {
  let priorBetaEnabled = false;

  before(async function () {
    this.timeout(240_000);
    priorBetaEnabled = readBetaEnabled();
    setBetaEnabled(true);
    await restartAppAndReconnect();

    if ((await activeProjectSlug()) !== E2E_PROJECT_NAME) {
      await switchToProject(E2E_PROJECT_NAME);
    }
    expect(await activeProjectSlug()).toBe(E2E_PROJECT_NAME);

    await openChat();
    await $('[data-testid="chat-tabs"]').waitForExist({
      timeout: 30_000,
      timeoutMsg: 'chat tab bar never appeared after enabling beta features',
    });
    await startNewConversation();
    expect((await chatTabRows()).length).toBe(1);
  });

  after(async function () {
    this.timeout(240_000);
    setBetaEnabled(priorBetaEnabled);
    await restartAppAndReconnect();
  });

  it('opens a second tab that starts with its own empty conversation', async function () {
    this.timeout(30_000);
    const newTabBtn = await $('[data-testid="chat-tabs-new"]');
    await browser.waitUntil(async () => await newTabBtn.isEnabled(), {
      timeout: 10_000,
      timeoutMsg: 'chat-tabs-new never became enabled',
    });
    await newTabBtn.click();

    await browser.waitUntil(async () => (await chatTabRows()).length === 2, {
      timeout: 15_000,
      timeoutMsg: 'opening a tab did not add a second chat-tab row',
    });
    expect(await isTabActive(1)).toBe(true);
    expect((await $$('[data-testid="chat-message"]').getElements()).length).toBe(0);
  });

  it('streams in both tabs independently, with no cross-tab content bleed', async function () {
    this.timeout(240_000);
    expect(await isTabActive(1)).toBe(true);
    await sendMessageNoWait(TAB_B_PROMPT);
    await waitForTurnStart();

    await activateTab(0);
    expect((await $$('[data-testid="chat-message"]').getElements()).length).toBe(0);
    await sendMessageNoWait(TAB_A_PROMPT);
    await waitForTurnStart();

    await browser.waitUntil(async () => (await streamingTabCount()) === 2, {
      timeout: 15_000,
      timeoutMsg: 'both tabs never showed the streaming indicator at the same time',
    });

    expect(await isTabActive(0)).toBe(true);
    await waitForTurnComplete(180_000);
    const tabAText = await conversationText();
    expect(tabAText).toContain(TAB_A_SENTINEL);
    expect(tabAText).not.toContain(TAB_B_SENTINEL);

    await activateTab(1);
    await waitForTurnComplete(180_000);
    const tabBText = await conversationText();
    expect(tabBText).toContain(TAB_B_SENTINEL);
    expect(tabBText).not.toContain(TAB_A_SENTINEL);
  });

  it("stopping one tab's stream leaves the other tab's stream running to completion", async function () {
    this.timeout(240_000);
    expect(await isTabActive(1)).toBe(true);
    await sendMessageNoWait(TAB_B_PROMPT);
    await waitForTurnStart();

    await activateTab(0);
    await sendMessageNoWait(TAB_A_PROMPT);
    await waitForTurnStart();

    await browser.waitUntil(async () => (await streamingTabCount()) === 2, {
      timeout: 15_000,
      timeoutMsg: 'both tabs never showed the streaming indicator at the same time',
    });

    expect(await isTabActive(0)).toBe(true);
    await (await $('[data-testid="chat-stop"]')).click();
    await waitForTurnComplete(30_000);
    expect(await $('[data-testid="chat-stop"]').isExisting()).toBe(false);
    expect(await streamingTabCount()).toBe(1);

    await activateTab(1);
    expect(await $('[data-testid="chat-stop"]').isExisting()).toBe(true);
    await waitForTurnComplete(180_000);
    expect(await conversationText()).toContain(TAB_B_SENTINEL);
  });

  it('resuming an already-open conversation from history activates the existing tab instead of duplicating', async function () {
    this.timeout(60_000);
    const tabCountBefore = (await chatTabRows()).length;
    expect(tabCountBefore).toBe(2);
    expect(await isTabActive(1)).toBe(true);

    await resumeConversationMatching(TAB_A_SENTINEL);

    await browser.waitUntil(async () => await isTabActive(0), {
      timeout: 10_000,
      timeoutMsg: 'resuming the already-open tab-A conversation did not activate tab A',
    });
    expect((await chatTabRows()).length).toBe(tabCountBefore);
    expect(await conversationText()).toContain(TAB_A_SENTINEL);
  });
});

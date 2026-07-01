/**
 * Chat Controls E2E tests.
 *
 * Covers the interactive chat controls on e2e-test (OpenRouter active after
 * spec 11): starting a fresh conversation, stopping a streaming turn,
 * queueing a message while streaming, and deleting a conversation from
 * history.
 *
 * Runs after spec 12 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import {
  openChat,
  sendMessageAndWait,
  sendMessageNoWait,
  waitForTurnStart,
  waitForTurnComplete,
  startNewConversation,
  openHistory,
} from '../helpers/llm';

describe('Chat Controls', function () {
  before(async function () {
    this.timeout(180_000);
    await openChat();
  });

  it('starts a fresh conversation', async function () {
    this.timeout(180_000);
    await startNewConversation();
    // A brand-new session accepts a message and streams a reply.
    await sendMessageAndWait('Say hello in one word.');
    const messages = await $$(
      '[data-testid="chat-message"][data-role="assistant"]'
    ).getElements();
    expect(messages.length).toBeGreaterThan(0);
  });

  it('stops a streaming turn', async function () {
    this.timeout(120_000);
    await sendMessageNoWait('Count slowly from 1 to 50, one number per line.');
    await waitForTurnStart();

    await (await $('[data-testid="chat-stop"]')).click();
    // After stop, the turn ends: send button returns, stop button gone.
    await waitForTurnComplete(30_000);
    expect(await $('[data-testid="chat-stop"]').isExisting()).toBe(false);
  });

  it('queues a message sent while streaming', async function () {
    this.timeout(180_000);
    await sendMessageNoWait('Count slowly from 1 to 50, one number per line.');
    await waitForTurnStart();

    // A second send while streaming queues instead of dispatching.
    await sendMessageNoWait('This one should be queued.');
    await $('[data-testid="composer-queued"]').waitForExist({ timeout: 10_000 });
    expect(await $('[data-testid="composer-queued-text"]').isExisting()).toBe(true);

    // Cancel the queued message, then let the active turn finish.
    await (await $('[data-testid="composer-queued-cancel"]')).click();
    await $('[data-testid="composer-queued"]').waitForExist({ timeout: 10_000, reverse: true });
    await waitForTurnComplete();
  });

  it('deletes a conversation from history', async function () {
    this.timeout(60_000);
    await openHistory();
    const rows = await $$('[data-testid="conversations-sidebar-row"]').getElements();
    const before = rows.length;
    expect(before).toBeGreaterThan(0);

    const del = await rows[0].$('[data-testid^="conversation-delete-"]');
    await del.click();
    const confirmYes = await $('[data-testid^="conversation-confirm-yes-"]');
    await confirmYes.waitForExist({ timeout: 10_000 });
    await confirmYes.click();

    await browser.waitUntil(
      async () =>
        (await $$('[data-testid="conversations-sidebar-row"]').getElements()).length < before,
      { timeout: 15_000, timeoutMsg: 'conversation row count did not drop after delete' }
    );
  });
});

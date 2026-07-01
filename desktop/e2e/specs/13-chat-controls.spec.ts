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
  queueMessageViaEnter,
  waitForTurnStart,
  waitForTurnComplete,
  startNewConversation,
  openHistory,
} from '../helpers/llm';
import { LONG_STREAM_PROMPT } from '../helpers/memory-fact';

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
    await sendMessageNoWait(LONG_STREAM_PROMPT);
    await waitForTurnStart();

    await (await $('[data-testid="chat-stop"]')).click();
    // After stop, the turn ends: send button returns, stop button gone.
    await waitForTurnComplete(30_000);
    expect(await $('[data-testid="chat-stop"]').isExisting()).toBe(false);
  });

  it('stops a streaming turn with the Escape key', async function () {
    this.timeout(120_000);
    // Esc goes through the document-level handler in chat.component, a
    // separate code path from the chat-stop button click.
    await sendMessageNoWait(LONG_STREAM_PROMPT);
    await waitForTurnStart();

    await browser.keys('Escape');
    await waitForTurnComplete(30_000);
    expect(await $('[data-testid="chat-stop"]').isExisting()).toBe(false);
  });

  it('queues a message sent while streaming', async function () {
    this.timeout(180_000);
    await sendMessageNoWait(LONG_STREAM_PROMPT);
    await waitForTurnStart();

    // While streaming, the send button is replaced by Stop — Enter is the only
    // submit path, and ADR-045 routes it to the queue instead of a new turn.
    await queueMessageViaEnter('This one should be queued.');
    await $('[data-testid="composer-queued"]').waitForExist({ timeout: 10_000 });
    expect(await $('[data-testid="composer-queued-text"]').isExisting()).toBe(true);

    // Cancel the queued message, then let the active turn finish.
    await (await $('[data-testid="composer-queued-cancel"]')).click();
    await $('[data-testid="composer-queued"]').waitForExist({ timeout: 10_000, reverse: true });
    await waitForTurnComplete();
  });

  it('dispatches the queued message as the next turn (ADR-045)', async function () {
    this.timeout(300_000);
    // Fresh conversation on purpose: a FIRST-turn queue needs the SystemInit
    // session-id seed (it used to be dropped until the first Result).
    await startNewConversation();
    await sendMessageNoWait(LONG_STREAM_PROMPT);
    await waitForTurnStart();

    await queueMessageViaEnter('Reply with exactly the single word ACK.');
    await $('[data-testid="composer-queued"]').waitForExist({ timeout: 10_000 });

    // Turn 1 ends → backend drains the slot to stdin with no user action:
    // the chip disappears and the queued text becomes the next user message.
    await $('[data-testid="composer-queued"]').waitForExist({
      timeout: 240_000,
      reverse: true,
      timeoutMsg: 'queued slot never drained after the streaming turn ended',
    });
    await waitForTurnComplete(120_000);

    const users = await $$('[data-testid="chat-message"][data-role="user"]').getElements();
    expect(users.length).toBeGreaterThanOrEqual(2);
    const lastUser = users[users.length - 1];
    expect(await lastUser.getText()).toContain('ACK');
    const assistants = await $$(
      '[data-testid="chat-message"][data-role="assistant"]'
    ).getElements();
    expect(assistants.length).toBeGreaterThanOrEqual(2);
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

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

  it('opens the slash menu on "/" and inserts the selected command', async function () {
    this.timeout(60_000);
    const input = await $('[data-testid="chat-input"]');
    await input.waitForExist({ timeout: 15_000 });
    await input.setValue('/');

    // Discovery is container-backed (list_slash_commands); core skills are
    // always linked, so at least one item must appear.
    await $('[data-testid="slash-menu"]').waitForExist({ timeout: 15_000 });
    await browser.waitUntil(
      async () => (await $$('[data-testid="slash-menu-item"]').getElements()).length > 0,
      { timeout: 15_000, timeoutMsg: 'slash menu never listed any commands' }
    );

    const items = await $$('[data-testid="slash-menu-item"]').getElements();
    await items[0].click();
    await $('[data-testid="slash-menu"]').waitForExist({ timeout: 10_000, reverse: true });

    // Selection replaces the token with "/<name> " (trailing space, caret after).
    const value = await input.getValue();
    expect(value).toMatch(/^\/\S+ $/);

    // Clear the composer so later tests start from an empty input.
    await browser.execute(() => {
      const ta = document.querySelector(
        '[data-testid="chat-input"]'
      ) as HTMLTextAreaElement | null;
      if (!ta) return;
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  it('attaches a pasted image and sends it (ADR-065)', async function () {
    this.timeout(240_000);
    const input = await $('[data-testid="chat-input"]');
    await input.waitForExist({ timeout: 15_000 });

    // WebDriver cannot drive the OS clipboard — dispatch a synthetic paste
    // event carrying a real PNG File, which reaches the same handler.
    await browser.execute(() => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      if (!ta) return;
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'e2e-paste.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      ta.dispatchEvent(ev);
    });

    await $('[data-testid="composer-attachment-strip"]').waitForExist({
      timeout: 20_000,
      timeoutMsg: 'attachment strip never appeared after the synthetic paste',
    });

    // The preview thumbnail is a blob: URL — a broken image here is the CSP
    // img-src regression this test exists to catch.
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const img = document.querySelector(
            '[data-testid="composer-attachment-strip"] img'
          ) as HTMLImageElement | null;
          return !!img && img.complete && img.naturalWidth > 0;
        }),
      { timeout: 20_000, timeoutMsg: 'attachment thumbnail never rendered (broken blob: image)' }
    );

    await sendMessageNoWait('Reply with the single word RECEIVED.');
    await $('[data-testid="user-message-image"]').waitForExist({
      timeout: 15_000,
      timeoutMsg: 'sent message did not render the image attachment pill',
    });
    await waitForTurnStart();
    await waitForTurnComplete(180_000);
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

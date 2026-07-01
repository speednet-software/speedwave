/**
 * Chat Conversation E2E test (OpenRouter).
 *
 * Continues the same conversation window opened by spec 08 (cost
 * reconciliation) on the e2e-test project, which uses the OpenRouter provider
 * configured in spec 02. It plants a memorable fact ("remember the number
 * 42") and confirms the model answers, so spec 11 can later verify the fact
 * survives a provider switch — both by continuing the open window and by
 * resuming from history.
 *
 * Runs after spec 08 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import { openChat, sendMessageAndWait, lastAssistantText } from '../helpers/llm';

/** The fact planted here and recalled in spec 11 — kept in sync across specs. */
export const MEMORY_FACT = 'The magic number is 42.';
/** Substring the model's recall answer must contain. */
export const MEMORY_ANSWER = '42';

describe('Chat Conversation (OpenRouter)', function () {
  before(async function () {
    this.timeout(180_000);
    await openChat();
  });

  it('plants a memorable fact and gets a response', async function () {
    this.timeout(180_000);
    await sendMessageAndWait(`Please remember this for later: ${MEMORY_FACT}`);

    const messages = await $$(
      '[data-testid="chat-message"][data-role="assistant"]'
    ).getElements();
    expect(messages.length).toBeGreaterThan(0);

    const meta = await $('[data-testid="message-metadata"]');
    await meta.waitForExist({ timeout: 15_000 });
  });

  it('recalls the fact within the same open window', async function () {
    this.timeout(180_000);
    await sendMessageAndWait('What number did I ask you to remember? Reply with just the number.');

    const answer = await lastAssistantText();
    expect(answer).toContain(MEMORY_ANSWER);
  });
});

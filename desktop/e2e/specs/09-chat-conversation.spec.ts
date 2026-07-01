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
import { MEMORY_FACT, MEMORY_ANSWER, MEMORY_RECALL_PROMPT } from '../helpers/memory-fact';

describe('Chat Conversation (OpenRouter)', function () {
  before(async function () {
    this.timeout(180_000);
    await openChat();
  });

  it('states a fact and gets a text response', async function () {
    this.timeout(180_000);
    await sendMessageAndWait(`${MEMORY_FACT} Just acknowledge in one short sentence.`);

    const messages = await $$(
      '[data-testid="chat-message"][data-role="assistant"]'
    ).getElements();
    expect(messages.length).toBeGreaterThan(0);

    const meta = await $('[data-testid="message-metadata"]');
    await meta.waitForExist({ timeout: 15_000 });
  });

  it('recalls the fact within the same open window', async function () {
    this.timeout(180_000);
    await sendMessageAndWait(MEMORY_RECALL_PROMPT);

    const answer = await lastAssistantText();
    expect(answer).toContain(MEMORY_ANSWER);
  });
});

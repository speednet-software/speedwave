/**
 * Local Provider + Conversation Resume E2E test.
 *
 * On e2e-test (which already holds the OpenRouter conversation from specs
 * 08-09), switches the LLM provider to a local OpenAI-compatible server and
 * verifies:
 *   - the chat conversation survives the provider switch two ways —
 *     (a) continuing the still-open window, and (b) resuming from history;
 *   - the local model recalls the fact planted under OpenRouter (context is
 *     replayed from the local transcript, provider-agnostic);
 *   - a local model is UNPRICED end to end — no per-message cost, "—" in the
 *     chat footer, and "—" on the usage dashboard (ADR-073 invariant 6:
 *     unpriced stays null, never 0.0).
 *
 * Runs after spec 10 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { confirmRestartAndWait } from '../helpers/shell';
import {
  openSettings,
  openChat,
  configureLocalProvider,
  configureOpenRouter,
  sendMessageAndWait,
  lastAssistantText,
  resumeNewestConversation,
  requireLocalLlm,
  requireOpenrouterKey,
  isUnpriced,
} from '../helpers/llm';
import { MEMORY_ANSWER } from './09-chat-conversation.spec';

const E2E_PROJECT_NAME = 'e2e-test';

describe('Local Provider + Resume', function () {
  before(async function () {
    this.timeout(180_000);
    // Spec 10 left e2e-second active — return to the project holding the chat.
    if ((await activeProjectSlug()) !== E2E_PROJECT_NAME) {
      await switchToProject(E2E_PROJECT_NAME);
    }
    expect(await activeProjectSlug()).toBe(E2E_PROJECT_NAME);
  });

  it('switches the provider to the local server (full restart)', async function () {
    this.timeout(240_000);
    const local = requireLocalLlm();
    await openSettings();
    await configureLocalProvider(local.baseUrl, local.apiKey, local.model);
    // Provider change requests a restart; confirm it and wait for completion.
    await confirmRestartAndWait();
  });

  it('recalls the fact by continuing the open window (a)', async function () {
    this.timeout(240_000);
    // Provider switch triggers a full container restart — wait for chat ready.
    await openChat();
    await sendMessageAndWait('What number did I ask you to remember? Reply with just the number.');
    expect(await lastAssistantText()).toContain(MEMORY_ANSWER);
  });

  it('recalls the fact by resuming from history (b)', async function () {
    this.timeout(240_000);
    // Only one conversation exists on e2e-test here (the continuous 08/09/11a
    // one), so the newest history row is it — resume it through the sidebar UI.
    await resumeNewestConversation();
    await sendMessageAndWait('Once more: what number should you remember? Reply with just the number.');
    expect(await lastAssistantText()).toContain(MEMORY_ANSWER);
  });

  it('does not price a local model in the chat footer', async function () {
    this.timeout(30_000);
    // Local is unpriced: session-stats shows "chat: —", no per-message cost.
    expect(await isUnpriced('[data-testid="session-stats"]')).toBe(true);
    expect(await $('[data-testid="meta-cost"]').isExisting()).toBe(false);
  });

  it('does not price a local model on the usage dashboard', async function () {
    this.timeout(30_000);
    await (await $('[data-testid="nav-usage"]')).click();
    await $('[data-testid="usage-title"]').waitForExist({ timeout: 10_000 });
    await $('[data-testid="llm-usage"]').waitForExist({ timeout: 10_000 });
    expect(await isUnpriced('[data-testid="llm-usage-card-cost"]')).toBe(true);
  });

  it('switches back to OpenRouter (provider change works both ways)', async function () {
    this.timeout(240_000);
    await openSettings();
    await configureOpenRouter(requireOpenrouterKey());
    await confirmRestartAndWait();
    await openChat();
    await sendMessageAndWait('Reply with the single word: ok.');
    expect((await lastAssistantText()).toLowerCase()).toContain('ok');
  });
});

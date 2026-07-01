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
  openUsage,
  configureLocalProvider,
  configureOpenRouter,
  sendMessageAndWait,
  lastAssistantText,
  conversationText,
  waitForConversationLoaded,
  resumeNewestConversation,
  startNewConversation,
  requireLocalLlm,
  requireOpenrouterKey,
  isUnpriced,
  modelRowsUnpriced,
} from '../helpers/llm';
import { MEMORY_ANSWER, MEMORY_RECALL_PROMPT } from '../helpers/memory-fact';

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
    // Continuity across a provider switch is only meaningful with a real open
    // conversation in the window. Spec 10's project round-trip cleared the live
    // session (a project switch never resumes the prior project), so re-open the
    // prior conversation first, assert its turns actually loaded, THEN continue
    // it with the now-local model — mirroring: open chat → prior chat visible →
    // keep chatting.
    await openChat();
    await resumeNewestConversation();
    await waitForConversationLoaded(2);
    expect(await conversationText()).toContain(MEMORY_ANSWER);

    await sendMessageAndWait(MEMORY_RECALL_PROMPT);
    expect(await lastAssistantText()).toContain(MEMORY_ANSWER);
  });

  it('recalls the fact by resuming from history (b)', async function () {
    this.timeout(240_000);
    // The same continuous conversation, re-entered fresh from the sidebar list.
    await startNewConversation();
    await resumeNewestConversation();
    await waitForConversationLoaded(2);
    await sendMessageAndWait(`Again: ${MEMORY_RECALL_PROMPT}`);
    expect(await lastAssistantText()).toContain(MEMORY_ANSWER);
  });

  it('does not price a local model in the chat footer', async function () {
    this.timeout(30_000);
    // Local is unpriced: session-stats shows "chat: —", no per-message cost.
    expect(await isUnpriced('[data-testid="session-stats"]')).toBe(true);
    expect(await $('[data-testid="meta-cost"]').isExisting()).toBe(false);
  });

  it('does not price the local model on the usage dashboard', async function () {
    this.timeout(30_000);
    // The project-wide card sums every provider (incl. the earlier priced
    // OpenRouter turns), so it is NOT the unpriced signal. The local model's own
    // per-model rows must show "—" — that is the ADR-073 invariant-6 assertion.
    await openUsage();
    expect(await modelRowsUnpriced(requireLocalLlm().model)).toBe(true);
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

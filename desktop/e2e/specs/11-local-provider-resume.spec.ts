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
import { localLlmUnreachable } from '../helpers/preflight';

const E2E_PROJECT_NAME = 'e2e-test';

describe('Local Provider + Resume', function () {
  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== E2E_PROJECT_NAME) {
      await switchToProject(E2E_PROJECT_NAME);
    }
    expect(await activeProjectSlug()).toBe(E2E_PROJECT_NAME);
    if (localLlmUnreachable()) this.skip();
  });

  it('switches the provider to the local server (full restart)', async function () {
    this.timeout(240_000);
    const local = requireLocalLlm();
    await openSettings();
    await configureLocalProvider(local.baseUrl, local.apiKey, local.model);
    await confirmRestartAndWait();
  });

  it('recalls the fact by continuing the open window (a)', async function () {
    this.timeout(240_000);
    await openChat();
    await resumeNewestConversation();
    await waitForConversationLoaded(2);
    expect(await conversationText()).toContain(MEMORY_ANSWER);

    await sendMessageAndWait(MEMORY_RECALL_PROMPT);
    expect(await lastAssistantText()).toContain(MEMORY_ANSWER);
  });

  it('recalls the fact by resuming from history (b)', async function () {
    this.timeout(240_000);
    await startNewConversation();
    await resumeNewestConversation();
    await waitForConversationLoaded(2);
    await sendMessageAndWait(`Again: ${MEMORY_RECALL_PROMPT}`);
    expect(await lastAssistantText()).toContain(MEMORY_ANSWER);
  });

  it('does not price a local model in the chat footer', async function () {
    this.timeout(30_000);
    expect(await isUnpriced('[data-testid="session-stats"]')).toBe(true);
    expect(await $('[data-testid="meta-cost"]').isExisting()).toBe(false);
  });

  it('does not price the local model on the usage dashboard', async function () {
    this.timeout(30_000);
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

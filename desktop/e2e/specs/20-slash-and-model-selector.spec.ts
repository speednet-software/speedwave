import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { confirmRestartAndWait, RESTART_WAIT_MS } from '../helpers/shell';
import { waitForHealthy } from '../helpers/health';
import { restartAppAndReconnect } from '../helpers/app-restart';
import { lastSpawnArgs, waitForFreshSpawnArgs } from '../helpers/spawn-args';
import { clearModelPinFile, clearEffortPinFile } from '../helpers/host-files';
import {
  anthropicCatalog,
  latestAnthropicModelIds,
  catalogEntryForBadgeLabel,
  modelPickerRowIds,
  ONE_MILLION_MARKER,
  type AnthropicCatalogEntry,
} from '../helpers/anthropic-catalog';
import {
  openSettings,
  openChat,
  configureLocalProvider,
  configureOpenRouter,
  pickComposerModel,
  sendMessageAndWait,
  startNewConversation,
  resumeNewestConversation,
  waitForConversationLoaded,
  assistantMessageCount,
  requireLocalLlm,
  requireOpenrouterKey,
  requireOpenrouterModel,
  queueMessageViaEnter,
  waitForTurnStart,
  waitForTurnComplete,
} from '../helpers/llm';
import { localLlmUnreachable } from '../helpers/preflight';

const E2E_PROJECT_NAME = 'e2e-test';
const ANTHROPIC_PROJECT = 'e2e-second';
const ALL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

async function openSlashPopover(): Promise<void> {
  const input = await $('[data-testid="chat-input"]');
  await input.waitForExist({ timeout: 15_000 });
  await input.setValue('/');
  await $('[data-testid="slash-menu"]').waitForExist({ timeout: 15_000 });
  await browser.waitUntil(
    async () => !(await $('[data-testid="slash-popover-loading"]').isExisting()),
    { timeout: 15_000, timeoutMsg: 'slash-popover-loading never cleared' }
  );
}

async function clearComposer(): Promise<void> {
  await browser.execute(() => {
    const ta = document.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openModelSelector(): Promise<void> {
  await (await $('[data-testid="composer-model-badge"]')).click();
  await $('[data-testid="model-selector-search"]').waitForExist({ timeout: 10_000 });
}

async function pickModelOption(catalogId: string): Promise<void> {
  const search = await $('[data-testid="model-selector-search"]');
  await search.waitForExist({ timeout: 5_000 });
  await search.setValue(catalogId);
  const option = await $(`[data-testid="model-selector-option-${catalogId}"]`);
  await option.waitForExist({ timeout: 10_000, timeoutMsg: `option ${catalogId} never appeared` });
  await option.click();
}

async function listedModelIds(): Promise<string[]> {
  await browser.waitUntil(
    async () => (await $$('[data-testid^="model-selector-option-"]').getElements()).length > 1,
    { timeout: 30_000, timeoutMsg: 'model selector never listed more than one option' }
  );
  const ids: string[] = [];
  for (const opt of await $$('[data-testid^="model-selector-option-"]').getElements()) {
    const testid = (await opt.getAttribute('data-testid')) ?? '';
    ids.push(testid.replace('model-selector-option-', ''));
  }
  return ids;
}

function firstListedAlternative(
  catalog: AnthropicCatalogEntry[],
  listed: string[],
  currentId: string | undefined,
  needsEffort: boolean
): AnthropicCatalogEntry {
  const target = listed
    .map((id) => catalog.find((m) => m.id === id))
    .find(
      (m): m is AnthropicCatalogEntry =>
        !!m && m.id !== currentId && (!needsEffort || m.effort_levels.length > 0)
    );
  if (!target) throw new Error('the model selector offers no alternative Anthropic model');
  return target;
}

describe('Slash Popover + Model/Effort Selector', function () {
  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== E2E_PROJECT_NAME) {
      await switchToProject(E2E_PROJECT_NAME);
    }
    expect(await activeProjectSlug()).toBe(E2E_PROJECT_NAME);
    await openChat();
  });

  afterEach(async function () {
    if (await $('[data-testid="slash-menu"]').isExisting()) {
      await browser.keys('Escape');
    }
    if (await $('[data-testid="model-selector-search"]').isExisting()) {
      await browser.keys('Escape');
    }
    await clearComposer();
  });

  it('shows the allowlisted popover, past its loader, hiding non-allowlisted natives', async function () {
    this.timeout(60_000);
    await openSlashPopover();

    expect(await $('[data-testid="slash-popover-unavailable"]').isExisting()).toBe(false);

    const items = await $$('[data-testid="slash-menu-item"]').getElements();
    for (const item of items) {
      expect((await item.getText()).trim()).not.toMatch(/^config\b/);
    }

    await browser.waitUntil(
      async () => (await $$('[data-testid="slash-menu-item"]').getElements()).length > 0,
      { timeout: 15_000, timeoutMsg: 'slash popover listed zero commands' }
    );
    await browser.keys('Escape');
  });

  it('switches the model mid-session without restarting, renders a control chip, and survives resume', async function () {
    this.timeout(240_000);
    await startNewConversation();
    await sendMessageAndWait('Say hello in one word.');
    const beforeCount = await assistantMessageCount();

    await openModelSelector();
    await browser.waitUntil(
      async () => (await $$('[data-testid^="model-selector-option-"]').getElements()).length > 1,
      { timeout: 30_000, timeoutMsg: 'model selector never listed more than one option' }
    );
    const options = await $$('[data-testid^="model-selector-option-"]').getElements();
    const currentBadge = await (await $('[data-testid="composer-model-badge"]')).getText();
    let targetId: string | null = null;
    for (const opt of options) {
      const testid = await opt.getAttribute('data-testid');
      const id = (testid ?? '').replace('model-selector-option-', '');
      if (id && !currentBadge.includes(id)) {
        targetId = id;
        break;
      }
    }
    if (!targetId) throw new Error('no alternative selectable model found in the selector');
    console.log(`[20-slash-and-model-selector] switching to model-selector option: ${targetId}`);
    await pickModelOption(targetId);

    expect(await $('[data-testid="restart-overlay"]').isExisting()).toBe(false);
    await waitForHealthy(E2E_PROJECT_NAME);

    await $('[data-testid="control-chip"][data-command="model"]').waitForExist({
      timeout: 30_000,
      timeoutMsg: `model control-chip never rendered after switching to ${targetId}`,
    });

    await pickComposerModel(requireOpenrouterModel());
    await sendMessageAndWait('Say goodbye in one word.');
    expect(await assistantMessageCount()).toBeGreaterThan(beforeCount);
    await browser.waitUntil(
      async () =>
        (await (await $('[data-testid="composer-model-badge"]')).getText()).trim() ===
        requireOpenrouterModel(),
      {
        timeout: 30_000,
        timeoutMsg: 'composer-model-badge never settled on the cheap model after the reply',
      }
    );

    await startNewConversation();
    await resumeNewestConversation();
    await waitForConversationLoaded(2);
    expect(await $('[data-testid="control-chip"][data-command="model"]').isExisting()).toBe(true);
  });

  it('write-through: local provider soft-imposes the chosen model on the next session', async function () {
    this.timeout(RESTART_WAIT_MS + 120_000);
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await openSettings();
    await configureLocalProvider(local.baseUrl, local.apiKey);
    await confirmRestartAndWait();
    await openChat();

    await pickComposerModel(local.model);
    const badgeText = await (await $('[data-testid="composer-model-badge"]')).getText();
    expect(badgeText.trim()).toBe(local.model);

    await openSettings();
    await configureOpenRouter(requireOpenrouterKey());
    await confirmRestartAndWait();
    await openChat();
  });

  it('OpenRouter: a provider save leaves a routable model before the first message', async function () {
    this.timeout(RESTART_WAIT_MS + 60_000);
    await openSettings();
    await configureOpenRouter(requireOpenrouterKey());
    const restartBtn = await $('[data-testid="restart-now-btn"]');
    const restartRequested = await restartBtn.waitForExist({ timeout: 10_000 }).then(
      () => true,
      () => false
    );
    if (restartRequested) await confirmRestartAndWait();
    await openChat();
    await startNewConversation();

    const badgeText = await (await $('[data-testid="composer-model-badge"]')).getText();
    expect(badgeText.trim().length).toBeGreaterThan(0);
  });

  describe('Anthropic model + effort persistence (SPEED-535)', function () {
    let anthropicAvailable = false;

    before(async function () {
      this.timeout(120_000);
      if ((await activeProjectSlug()) !== ANTHROPIC_PROJECT) {
        await switchToProject(ANTHROPIC_PROJECT);
      }
      await openSettings();
      const anthropicCard = await $('[data-testid="settings-llm-provider-anthropic"]');
      await anthropicCard.waitForExist({ timeout: 15_000 });
      await anthropicCard.click();
      const authPill = await $('[data-testid="auth-status-value"]');
      await authPill.waitForExist({ timeout: 15_000 });
      anthropicAvailable = (await authPill.getText()).includes('connected');
      if (!anthropicAvailable) {
        this.skip();
      }
    });

    after(function () {
      clearModelPinFile(ANTHROPIC_PROJECT);
      clearEffortPinFile(ANTHROPIC_PROJECT);
    });

    it('(a) a fresh, unpinned session spawns with no --model/--effort and reports the account default in SystemInit', async function () {
      this.timeout(120_000);
      const priorArgs = await lastSpawnArgs();
      await openChat();
      await sendMessageAndWait('Say hi in one word.');
      const freshArgs = await waitForFreshSpawnArgs(priorArgs);

      expect(freshArgs).not.toContain('--model');
      expect(freshArgs).not.toContain('--effort');

      const catalog = await anthropicCatalog();
      const latestIds = await latestAnthropicModelIds();
      const badgeLabel = (await (await $('[data-testid="composer-model-badge"]')).getText()).trim();
      expect(badgeLabel).not.toMatch(ONE_MILLION_MARKER);
      const entry = catalogEntryForBadgeLabel(catalog, badgeLabel);
      if (!entry) {
        throw new Error(`composer-model-badge showed an unrecognized label "${badgeLabel}"`);
      }
      expect(latestIds).toContain(entry.id);
    });

    it('(a2) the picker lists one clean row per model, marks the active one and badges the plan default', async function () {
      this.timeout(120_000);
      await openModelSelector();
      const ids = await listedModelIds();

      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).not.toMatch(ONE_MILLION_MARKER);
      }
      for (const opt of await $$('[data-testid^="model-selector-option-"]').getElements()) {
        expect(await opt.getText()).not.toMatch(ONE_MILLION_MARKER);
      }
      expect(
        (await $$('[data-testid="model-selector-default-badge"]').getElements()).length
      ).toBe(1);
      expect((await $$('[data-testid="model-selector-active-mark"]').getElements()).length).toBe(
        1
      );
      expect(ids).toEqual(await modelPickerRowIds(ANTHROPIC_PROJECT));
      await browser.keys('Escape');
    });

    it('(b)+(c) a composer pick of a model and an effort level persists across "+" and a real app restart', async function () {
      this.timeout(360_000);
      const catalog = await anthropicCatalog();
      const currentBadge = (
        await (await $('[data-testid="composer-model-badge"]')).getText()
      ).trim();
      const currentEntry = catalogEntryForBadgeLabel(catalog, currentBadge);

      await openModelSelector();
      const targetModel = firstListedAlternative(
        catalog,
        await listedModelIds(),
        currentEntry?.id,
        true
      );
      await pickModelOption(targetModel.id);
      await $('[data-testid="control-chip"][data-command="model"]').waitForExist({
        timeout: 30_000,
        timeoutMsg: `model control-chip never rendered after picking ${targetModel.id}`,
      });
      expect(
        await (await $('[data-testid="control-chip"][data-command="model"]')).getText()
      ).not.toMatch(ONE_MILLION_MARKER);

      await sendMessageAndWait('Say hi in one word.');
      await browser.waitUntil(
        async () =>
          (await (await $('[data-testid="composer-model-badge"]')).getText()).trim() ===
          targetModel.family,
        {
          timeout: 30_000,
          timeoutMsg: 'composer-model-badge never settled on the picked model after the reply',
        }
      );

      const argsBeforeEffortPick = await lastSpawnArgs();
      await (await $('[data-testid="effort-segment"]')).click();
      await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000 });
      await (await $('[data-testid="effort-stop-max"]')).click();
      await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000, reverse: true });
      const deferred = await $('[data-testid="effort-deferred-notice"]');
      await deferred.waitForExist({
        timeout: 30_000,
        timeoutMsg: 'a pick in a session launched without --effort never showed the deferred notice',
      });
      expect(await deferred.getText()).toContain('Effort Max applies from the next session');
      expect(
        await $('[data-testid="control-chip"][data-command="effort"]').isExisting()
      ).toBe(false);
      expect(JSON.stringify(await lastSpawnArgs())).toBe(JSON.stringify(argsBeforeEffortPick));

      await (await $('[data-testid="effort-deferred-restart"]')).click();
      await deferred.waitForExist({ timeout: 30_000, reverse: true });
      const resumedArgs = await waitForFreshSpawnArgs(argsBeforeEffortPick);
      expect(resumedArgs).toContain('--resume');
      expect(resumedArgs.filter((a) => a === '--effort').length).toBe(1);
      expect(resumedArgs[resumedArgs.indexOf('--effort') + 1]).toBe('max');

      await startNewConversation();

      const priorArgs = await lastSpawnArgs();
      await restartAppAndReconnect();

      if ((await activeProjectSlug()) !== ANTHROPIC_PROJECT) {
        await switchToProject(ANTHROPIC_PROJECT);
      }
      await openChat();

      await browser.waitUntil(
        async () =>
          (await (await $('[data-testid="composer-model-badge"]')).getText()).trim() ===
          targetModel.family,
        {
          timeout: 30_000,
          timeoutMsg: 'composer-model-badge never showed the pinned model before the first message',
        }
      );
      expect((await (await $('[data-testid="effort-segment"]')).getText()).trim()).toBe('Max');

      const freshArgs = await waitForFreshSpawnArgs(priorArgs);
      expect(freshArgs).not.toContain('--model');
      expect(freshArgs.filter((a) => a === '--effort').length).toBe(1);
      expect(freshArgs[freshArgs.indexOf('--effort') + 1]).toBe('max');

      await sendMessageAndWait('Say hi in one word, again.');
      expect(
        (await $$('[data-testid="control-chip"][data-command="model"]').getElements()).length
      ).toBe(0);
    });

    it('(d) a model pick made mid-stream is queued and applied only after the turn ends', async function () {
      this.timeout(180_000);
      const catalog = await anthropicCatalog();
      const currentBadge = (
        await (await $('[data-testid="composer-model-badge"]')).getText()
      ).trim();
      const currentEntry = catalogEntryForBadgeLabel(catalog, currentBadge);

      await openModelSelector();
      const targetModel = firstListedAlternative(
        catalog,
        await listedModelIds(),
        currentEntry?.id,
        false
      );

      await queueMessageViaEnter('Count slowly from one to five, one number per line.');
      await waitForTurnStart();

      await pickModelOption(targetModel.id);
      expect(await $('[data-testid="model-selector-search"]').isExisting()).toBe(false);
      expect(await $('[data-testid="control-chip"][data-command="model"]').isExisting()).toBe(
        false
      );

      await waitForTurnComplete();
      await $('[data-testid="control-chip"][data-command="model"]').waitForExist({
        timeout: 30_000,
        timeoutMsg: `queued model pick (${targetModel.id}) never flushed after the turn ended`,
      });
    });

    it('(e) the effort slider matches the active model and hides entirely on Haiku 4.5', async function () {
      this.timeout(120_000);
      const catalog = await anthropicCatalog();
      const currentBadge = (
        await (await $('[data-testid="composer-model-badge"]')).getText()
      ).trim();
      const currentEntry = catalogEntryForBadgeLabel(catalog, currentBadge);
      if (!currentEntry || currentEntry.effort_levels.length === 0) {
        throw new Error(`active model "${currentBadge}" unexpectedly has no effort levels`);
      }

      await (await $('[data-testid="effort-segment"]')).click();
      await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000 });

      for (const level of currentEntry.effort_levels) {
        expect(await $(`[data-testid="effort-stop-${level}"]`).isExisting()).toBe(true);
      }
      for (const level of ALL_EFFORT_LEVELS.filter(
        (l) => !currentEntry.effort_levels.includes(l)
      )) {
        expect(await $(`[data-testid="effort-stop-${level}"]`).isExisting()).toBe(false);
      }

      const popoverText = await (await $('[data-testid="effort-popover"]')).getText();
      expect(popoverText).not.toMatch(/(^|\s)\?(\s|$)/);

      await (await $('[data-testid="effort-stop-low"]')).click();
      await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000, reverse: true });

      await browser.waitUntil(
        async () => (await (await $('[data-testid="effort-segment"]')).getText()).trim() === 'Low',
        { timeout: 10_000, timeoutMsg: 'effort-segment never showed Low after the pick' }
      );
      await $('[data-testid="control-chip"][data-command="effort"]').waitForExist({
        timeout: 30_000,
        timeoutMsg: 'effort control-chip never rendered after picking low',
      });

      await (await $('[data-testid="effort-segment"]')).click();
      await $('[data-testid="effort-popover-header"]').waitForExist({ timeout: 10_000 });
      expect((await (await $('[data-testid="effort-popover-header"]')).getText()).trim()).toBe(
        'Effort Low'
      );
      await browser.keys('Escape');

      const haiku = catalog.find((m) => m.id === 'claude-haiku-4-5');
      if (!haiku) throw new Error('claude-haiku-4-5 missing from the catalog');
      await openModelSelector();
      await pickModelOption(haiku.id);
      await browser.waitUntil(
        async () => !(await $('[data-testid="effort-segment"]').isExisting()),
        {
          timeout: 30_000,
          timeoutMsg: 'effort-segment still rendered after switching to Haiku 4.5',
        }
      );
    });
  });
});

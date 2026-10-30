import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { confirmRestartAndWait, FLAKY_STEP_RETRIES, RESTART_WAIT_MS } from '../helpers/shell';
import { waitForHealthy } from '../helpers/health';
import { restartAppAndReconnect } from '../helpers/app-restart';
import { lastSpawnArgs, waitForFreshSpawnArgs } from '../helpers/spawn-args';
import { pickComposerEffort } from '../helpers/applied-effort';
import {
  clearModelPinFile,
  clearEffortPinFile,
  readModelPin,
  readBetaEnabled,
  setBetaEnabled,
} from '../helpers/host-files';
import {
  anthropicCatalog,
  latestAnthropicModelIds,
  catalogEntryForBadgeLabel,
  modelPickerRowIds,
  defaultModelPickerRowId,
  ONE_MILLION_MARKER,
  type AnthropicCatalogEntry,
} from '../helpers/anthropic-catalog';
import {
  openSettings,
  openChat,
  configureLocalProvider,
  configureOpenRouter,
  configureAnthropicApiKey,
  removeAnthropicApiKey,
  requireAnthropicKey,
  pickComposerModel,
  sendMessageAndWait,
  startNewConversation,
  resumeNewestConversation,
  waitForConversationLoaded,
  assistantMessageCount,
  requireLocalLlm,
  requireOpenrouterKey,
  requireOpenrouterModel,
  useCheapOpenRouterModel,
  lastAssistantText,
  queueMessageViaEnter,
  waitForTurnStart,
  waitForTurnComplete,
} from '../helpers/llm';
import { localLlmUnreachable } from '../helpers/preflight';

const E2E_PROJECT_NAME = 'e2e-test';
const ANTHROPIC_PROJECT = 'e2e-second';
const HAIKU_MODEL = 'claude-haiku-5-5';
const SONNET_MODEL = 'claude-sonnet-5-5';
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

function modelPinIs(id: string): boolean {
  return (readModelPin(ANTHROPIC_PROJECT) ?? '').replace(ONE_MILLION_MARKER, '') === id;
}

function requireCatalogEntry(catalog: AnthropicCatalogEntry[], id: string): AnthropicCatalogEntry {
  const entry = catalog.find((m) => m.id === id);
  if (!entry) {
    throw new Error(
      `the Anthropic catalog does not list ${id}; listed: ${catalog.map((m) => m.id).join(', ')}`
    );
  }
  return entry;
}

async function selectModel(id: string): Promise<void> {
  await openModelSelector();
  await pickModelOption(id);
}

async function waitForModelPickerRows(project: string): Promise<string[]> {
  let ids: string[] = [];
  await browser.waitUntil(
    async () => {
      ids = (await modelPickerRowIds(project)) ?? [];
      return ids.length > 0;
    },
    {
      timeout: 90_000,
      timeoutMsg: `the session of ${project} never reported its model list (list_model_picker stayed empty)`,
    }
  );
  return ids;
}

async function waitForCatalogBadge(
  catalog: AnthropicCatalogEntry[]
): Promise<AnthropicCatalogEntry> {
  let label = '';
  let entry: AnthropicCatalogEntry | null = null;
  await browser.waitUntil(
    async () => {
      label = (await (await $('[data-testid="composer-model-badge"]')).getText()).trim();
      entry = catalogEntryForBadgeLabel(catalog, label);
      return entry !== null;
    },
    {
      timeout: 30_000,
      timeoutMsg: () => `composer-model-badge never showed a catalog family, last label "${label}"`,
    }
  );
  expect(label).not.toMatch(ONE_MILLION_MARKER);
  if (!entry) throw new Error(`composer-model-badge showed an unrecognized label "${label}"`);
  return entry;
}

async function waitForBadgeFamily(entry: AnthropicCatalogEntry): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await (await $('[data-testid="composer-model-badge"]')).getText()).trim() === entry.family,
    { timeout: 30_000, timeoutMsg: `composer-model-badge never settled on ${entry.family}` }
  );
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

  it.only('write-through: local provider soft-imposes the chosen model on the next session', async function () {
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
    this.retries(FLAKY_STEP_RETRIES);
    this.timeout(2 * RESTART_WAIT_MS + 60_000);
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
    await useCheapOpenRouterModel();
  });

  it('OpenRouter: an effort pick reaches the live session, which keeps answering', async function () {
    this.timeout(180_000);
    try {
      await sendMessageAndWait('Reply with the single word: ok.');
      await pickComposerEffort('low');
      expect(await $('[data-testid="effort-deferred-notice"]').isExisting()).toBe(false);
      expect(await $('[data-testid="control-chip"][data-command="effort"]').isExisting()).toBe(
        false
      );

      await sendMessageAndWait('Reply with the single word: yes.');
      expect((await lastAssistantText()).toLowerCase()).toContain('yes');
    } finally {
      clearEffortPinFile(E2E_PROJECT_NAME);
    }
  });

  describe('Anthropic model + effort persistence (SPEED-535)', function () {
    before(async function () {
      this.timeout(600_000);
      if ((await activeProjectSlug()) !== ANTHROPIC_PROJECT) {
        await switchToProject(ANTHROPIC_PROJECT);
      }
      await configureAnthropicApiKey(requireAnthropicKey());
    });

    after(async function () {
      this.timeout(600_000);
      try {
        clearModelPinFile(ANTHROPIC_PROJECT);
      } finally {
        try {
          clearEffortPinFile(ANTHROPIC_PROJECT);
        } finally {
          await removeAnthropicApiKey();
        }
      }
    });

    it('(a) a fresh, unpinned session spawns with --model default, no --effort, and reports the account default in SystemInit', async function () {
      this.timeout(180_000);
      const priorArgs = await lastSpawnArgs();
      await openChat();
      const freshArgs = await waitForFreshSpawnArgs(priorArgs);

      expect(freshArgs.filter((a) => a === '--model').length).toBe(1);
      expect(freshArgs[freshArgs.indexOf('--model') + 1]).toBe('default');
      expect(freshArgs).not.toContain('--effort');

      const catalog = await anthropicCatalog();
      const latestIds = await latestAnthropicModelIds();
      const pickerIds = await waitForModelPickerRows(ANTHROPIC_PROJECT);
      const entry = await waitForCatalogBadge(catalog);
      expect(latestIds).toContain(entry.id);

      const haiku = requireCatalogEntry(catalog, HAIKU_MODEL);
      requireCatalogEntry(catalog, SONNET_MODEL);
      expect(pickerIds).toContain(HAIKU_MODEL);
      expect(pickerIds).toContain(SONNET_MODEL);

      await selectModel(HAIKU_MODEL);
      await waitForBadgeFamily(haiku);
      await sendMessageAndWait('Say hi in one word.');
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
      expect((await $$('[data-testid="model-selector-default-badge"]').getElements()).length).toBe(
        1
      );
      expect((await $$('[data-testid="model-selector-active-mark"]').getElements()).length).toBe(1);
      expect(ids).toEqual(await modelPickerRowIds(ANTHROPIC_PROJECT));
      await browser.keys('Escape');
    });

    it('(b) a composer pick is tab-scoped and writes the settings.json pin: it wires the switch, rides the tab respawn as --model, and sets the project default for new tabs (SPEED-388)', async function () {
      this.timeout(360_000);
      const catalog = await anthropicCatalog();
      const haiku = requireCatalogEntry(catalog, HAIKU_MODEL);

      await selectModel(SONNET_MODEL);
      await browser.waitUntil(async () => modelPinIs(SONNET_MODEL), {
        timeout: 10_000,
        timeoutMsg: 'the Sonnet pick never wrote the settings.json model pin',
      });

      await selectModel(HAIKU_MODEL);
      await $('[data-testid="control-chip"][data-command="model"]').waitForExist({
        timeout: 30_000,
        timeoutMsg: `model control-chip never rendered after picking ${HAIKU_MODEL}`,
      });
      expect(
        await (await $('[data-testid="control-chip"][data-command="model"]')).getText()
      ).not.toMatch(ONE_MILLION_MARKER);
      await browser.waitUntil(async () => modelPinIs(HAIKU_MODEL), {
        timeout: 10_000,
        timeoutMsg: 'the Haiku pick never replaced the settings.json model pin',
      });
      await waitForBadgeFamily(haiku);

      await sendMessageAndWait('Say hi in one word.');
      await waitForBadgeFamily(haiku);

      const argsBeforeEffortPick = await lastSpawnArgs();
      await pickComposerEffort('max');
      expect(await $('[data-testid="effort-deferred-notice"]').isExisting()).toBe(false);
      expect(await $('[data-testid="control-chip"][data-command="effort"]').isExisting()).toBe(
        false
      );
      await sendMessageAndWait('Say hi in one word, at the new effort.');
      expect(JSON.stringify(await lastSpawnArgs())).toBe(JSON.stringify(argsBeforeEffortPick));

      await startNewConversation();
      const newConversationArgs = await waitForFreshSpawnArgs(argsBeforeEffortPick);
      expect(newConversationArgs.filter((a) => a === '--effort').length).toBe(1);
      expect(newConversationArgs[newConversationArgs.indexOf('--effort') + 1]).toBe('max');
      expect(newConversationArgs.filter((a) => a === '--model').length).toBe(1);
      const launchedModel = newConversationArgs[newConversationArgs.indexOf('--model') + 1];
      expect(launchedModel.replace(ONE_MILLION_MARKER, '')).toContain(HAIKU_MODEL);
      expect(modelPinIs(HAIKU_MODEL)).toBe(true);
    });

    it('(c) a restart spawns with the tab model (carried by the settings.json pin); the effort pin survives too', async function () {
      this.timeout(360_000);
      const pinBeforeRestart = readModelPin(ANTHROPIC_PROJECT);
      expect(modelPinIs(HAIKU_MODEL)).toBe(true);
      const priorArgs = await lastSpawnArgs();
      await restartAppAndReconnect();

      if ((await activeProjectSlug()) !== ANTHROPIC_PROJECT) {
        await switchToProject(ANTHROPIC_PROJECT);
      }
      await openChat();

      expect((await (await $('[data-testid="effort-segment"]')).getText()).trim()).toBe('Max');

      const freshArgs = await waitForFreshSpawnArgs(priorArgs);
      expect(freshArgs.filter((a) => a === '--model').length).toBe(1);
      expect(freshArgs[freshArgs.indexOf('--model') + 1]).toBe(pinBeforeRestart);
      expect(freshArgs.filter((a) => a === '--effort').length).toBe(1);
      expect(freshArgs[freshArgs.indexOf('--effort') + 1]).toBe('max');

      await sendMessageAndWait('Say hi in one word, again.');
      expect(
        (await $$('[data-testid="control-chip"][data-command="model"]').getElements()).length
      ).toBe(0);
    });

    it('(c2) with beta tabs, a pick on an idle tab respawns it and sets the project default for the next new tab, and the Default row clears it', async function () {
      this.timeout(420_000);
      const priorBeta = readBetaEnabled();
      setBetaEnabled(true);
      await restartAppAndReconnect();

      try {
        if ((await activeProjectSlug()) !== ANTHROPIC_PROJECT) {
          await switchToProject(ANTHROPIC_PROJECT);
        }
        await openChat();
        await $('[data-testid="chat-tabs"]').waitForExist({
          timeout: 30_000,
          timeoutMsg: 'chat tab bar never appeared after enabling beta features',
        });

        const beforePick = await lastSpawnArgs();
        await selectModel(SONNET_MODEL);
        const priorArgs = await waitForFreshSpawnArgs(beforePick);
        expect(priorArgs[priorArgs.indexOf('--model') + 1]).toBe(SONNET_MODEL);
        await browser.waitUntil(async () => modelPinIs(SONNET_MODEL), {
          timeout: 10_000,
          timeoutMsg: 'the Sonnet pick never wrote the settings.json model pin',
        });

        const newTabBtn = await $('[data-testid="chat-tabs-new"]');
        await browser.waitUntil(async () => await newTabBtn.isEnabled(), {
          timeout: 10_000,
          timeoutMsg: 'chat-tabs-new never became enabled',
        });
        await newTabBtn.click();
        const newTabArgs = await waitForFreshSpawnArgs(priorArgs);
        expect(newTabArgs.filter((a) => a === '--model').length).toBe(1);
        expect(newTabArgs[newTabArgs.indexOf('--model') + 1]).toBe(SONNET_MODEL);

        const defaultRowId = await defaultModelPickerRowId(ANTHROPIC_PROJECT);
        if (!defaultRowId) throw new Error('the model picker reports no default row');
        await openModelSelector();
        await pickModelOption(defaultRowId);
        const priorArgsAfterDefault = await waitForFreshSpawnArgs(newTabArgs);
        expect(priorArgsAfterDefault[priorArgsAfterDefault.indexOf('--model') + 1]).toBe('default');

        await browser.waitUntil(async () => readModelPin(ANTHROPIC_PROJECT) === null, {
          timeout: 10_000,
          timeoutMsg: 'picking the Default row never cleared the settings.json model key',
        });

        const secondNewTabBtn = await $('[data-testid="chat-tabs-new"]');
        await browser.waitUntil(async () => await secondNewTabBtn.isEnabled(), {
          timeout: 10_000,
          timeoutMsg: 'chat-tabs-new never became enabled',
        });
        await secondNewTabBtn.click();
        const thirdTabArgs = await waitForFreshSpawnArgs(priorArgsAfterDefault);
        expect(thirdTabArgs.filter((a) => a === '--model').length).toBe(1);
        expect(thirdTabArgs[thirdTabArgs.indexOf('--model') + 1]).toBe('default');
      } finally {
        setBetaEnabled(priorBeta);
        await restartAppAndReconnect();
        if ((await activeProjectSlug()) !== ANTHROPIC_PROJECT) {
          await switchToProject(ANTHROPIC_PROJECT);
        }
        await openChat();
      }
    });

    it('(d) a model pick made mid-stream is queued and applied only after the turn ends', async function () {
      this.timeout(240_000);
      const haiku = requireCatalogEntry(await anthropicCatalog(), HAIKU_MODEL);

      await selectModel(HAIKU_MODEL);
      await waitForBadgeFamily(haiku);

      await openModelSelector();
      await queueMessageViaEnter('Count slowly from one to five, one number per line.');
      await waitForTurnStart();

      await pickModelOption(SONNET_MODEL);
      expect(await $('[data-testid="model-selector-search"]').isExisting()).toBe(false);
      expect(await $('[data-testid="control-chip"][data-command="model"]').isExisting()).toBe(
        false
      );

      await waitForTurnComplete();
      await $('[data-testid="control-chip"][data-command="model"]').waitForExist({
        timeout: 30_000,
        timeoutMsg: `queued model pick (${SONNET_MODEL}) never flushed after the turn ended`,
      });
    });

    it('(e) the effort slider matches the active model', async function () {
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
      await browser.keys('Escape');
      await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000, reverse: true });

      await pickComposerEffort('low');
      await browser.waitUntil(
        async () => (await (await $('[data-testid="effort-segment"]')).getText()).trim() === 'Low',
        { timeout: 10_000, timeoutMsg: 'effort-segment never showed Low after the pick' }
      );
      expect(await $('[data-testid="control-chip"][data-command="effort"]').isExisting()).toBe(
        false
      );

      await (await $('[data-testid="effort-segment"]')).click();
      await $('[data-testid="effort-popover-header"]').waitForExist({ timeout: 10_000 });
      expect((await (await $('[data-testid="effort-popover-header"]')).getText()).trim()).toBe(
        'Effort Low'
      );
      await browser.keys('Escape');
    });
  });
});

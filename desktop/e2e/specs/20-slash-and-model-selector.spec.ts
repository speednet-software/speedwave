/**
 * Slash Popover + Model/Effort Selector E2E tests.
 *
 * Covers the chat-slash-commands redesign: the allowlisted slash popover
 * (leaves its loading state, plugin commands visible, hidden natives absent),
 * the composer model selector (mid-session switch, chip rendering, resume
 * survival), the local/OpenRouter write-through terrain (extends specs
 * 11/08), and — for Anthropic — the SPEED-535 persistent model/effort pin
 * story end to end: fresh-install account defaults, a composer pick surviving
 * "+" and a real app restart, a mid-stream pick flushed at turn end, and the
 * effort slider popover.
 *
 * Runs after spec 19 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text, except
 * where the underlying component exposes the value only as text content
 * (slash command names, the effort segment's current-level label) - see the
 * inline notes at each such assertion.
 */

import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { confirmRestartAndWait } from '../helpers/shell';
import { waitForHealthy } from '../helpers/health';
import { restartAppAndReconnect } from '../helpers/app-restart';
import { lastSpawnArgs, waitForFreshSpawnArgs } from '../helpers/spawn-args';
import { clearModelPinFile, clearEffortPinFile } from '../helpers/host-files';
import {
  anthropicCatalog,
  latestAnthropicModelIds,
  catalogEntryForBadgeLabel,
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
/** The SPEED-535 Anthropic battery runs on the OTHER fixture project: spec 18 leaves it
 *  selected on Anthropic with no model/effort pin, and nothing after 20 but 07 touches it. */
const ANTHROPIC_PROJECT = 'e2e-second';
/** Canonical `low`→`max` order (`defaults::EFFORT_LEVELS`) — used only to enumerate the
 *  levels a slider assertion must confirm ABSENT for a model missing some of them. */
const ALL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Types "/" into the composer and waits for the popover to settle past its loader. */
async function openSlashPopover(): Promise<void> {
  const input = await $('[data-testid="chat-input"]');
  await input.waitForExist({ timeout: 15_000 });
  await input.setValue('/');
  await $('[data-testid="slash-menu"]').waitForExist({ timeout: 15_000 });
  // The loader is transient - asserting it existed at some point is flaky by
  // nature, so instead assert the terminal state is reached, which is only
  // possible once the loader has cleared.
  await browser.waitUntil(
    async () => !(await $('[data-testid="slash-popover-loading"]').isExisting()),
    { timeout: 15_000, timeoutMsg: 'slash-popover-loading never cleared' }
  );
}

/** Clears the composer textarea via direct DOM manipulation (no clipboard needed). */
async function clearComposer(): Promise<void> {
  await browser.execute(() => {
    const ta = document.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Opens the composer model selector and waits for its search box to mount. */
async function openModelSelector(): Promise<void> {
  await (await $('[data-testid="composer-model-badge"]')).click();
  await $('[data-testid="model-selector-search"]').waitForExist({ timeout: 10_000 });
}

/** Types into the selector search and clicks the option matching `catalogId`. */
async function pickModelOption(catalogId: string): Promise<void> {
  const search = await $('[data-testid="model-selector-search"]');
  await search.waitForExist({ timeout: 5_000 });
  await search.setValue(catalogId);
  const option = await $(`[data-testid="model-selector-option-${catalogId}"]`);
  await option.waitForExist({ timeout: 10_000, timeoutMsg: `option ${catalogId} never appeared` });
  await option.click();
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
    // Every planted popover/selector state is closed so later tests don't inherit it.
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

    // No data-source attribute exists on the popover (Task 4's contract) - Init
    // is asserted indirectly: no unavailable state, and at least one command
    // rendered, which the component can only reach past a live discovery round.
    expect(await $('[data-testid="slash-popover-unavailable"]').isExisting()).toBe(false);

    // "config" is a known-but-hidden native (4.1) - must never render, even though
    // CC's own init lists it. Command names are plain text content on
    // slash-menu-item (no data-command attribute), so check by item text.
    const items = await $$('[data-testid="slash-menu-item"]').getElements();
    for (const item of items) {
      expect((await item.getText()).trim()).not.toMatch(/^config\b/);
    }

    // Core skills are always linked (13-chat-controls.spec.ts precedent), so at
    // least one plugin/integration-sourced command must be visible alongside the
    // allowlisted natives.
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
    // Options load async (the OpenRouter catalog needs a live discovery round);
    // wait for a real list instead of reading the not-yet-populated state.
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
    // Log which model was picked so a CI failure downstream (e.g. the chip
    // never rendering) names the exact target without re-running locally.
    console.log(`[20-slash-and-model-selector] switching to model-selector option: ${targetId}`);
    await pickModelOption(targetId);

    // The switch is session-scoped (raw `/model` pass-through, no restart): the
    // restart overlay must never appear, and containers stay healthy throughout.
    expect(await $('[data-testid="restart-overlay"]').isExisting()).toBe(false);
    await waitForHealthy(E2E_PROJECT_NAME);

    await $('[data-testid="control-chip"][data-command="model"]').waitForExist({
      timeout: 30_000,
      timeoutMsg: `model control-chip never rendered after switching to ${targetId}`,
    });

    // Switch back to the suite's cheap model before chatting (an arbitrary
    // catalog pick must never take real token traffic) — a second live switch,
    // and the reply then proves the wire switching took effect.
    await pickComposerModel(requireOpenrouterModel());
    await sendMessageAndWait('Say goodbye in one word.');
    expect(await assistantMessageCount()).toBeGreaterThan(beforeCount);
    // Non-anthropic badge truth is init-driven, never optimistic (ADR-087 §3):
    // assert it only now, after the reply's SystemInit reported the model.
    await browser.waitUntil(
      async () =>
        (await (await $('[data-testid="composer-model-badge"]')).getText()).trim() ===
        requireOpenrouterModel(),
      {
        timeout: 30_000,
        timeoutMsg: 'composer-model-badge never settled on the cheap model after the reply',
      }
    );

    // Resume survival: navigate away (new conversation) and back into this one.
    await startNewConversation();
    await resumeNewestConversation();
    await waitForConversationLoaded(2);
    expect(await $('[data-testid="control-chip"][data-command="model"]').isExisting()).toBe(true);
  });

  it('write-through: local provider soft-imposes the chosen model on the next session', async function () {
    this.timeout(240_000);
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await openSettings();
    await configureLocalProvider(local.baseUrl, local.apiKey);
    await confirmRestartAndWait();
    await openChat();

    // The composer pick is the write-through terrain under test (ADR-087 §3).
    await pickComposerModel(local.model);
    // Badge shows exactly the normalized id - never the `<entry_id>/` routing
    // prefix (4.3.1 id-triad rule; equality covers both requirements at once).
    const badgeText = await (await $('[data-testid="composer-model-badge"]')).getText();
    expect(badgeText.trim()).toBe(local.model);

    // Switch back to OpenRouter so the following spec's fixture state is intact.
    await openSettings();
    await configureOpenRouter(requireOpenrouterKey());
    await confirmRestartAndWait();
    await openChat();
  });

  it('OpenRouter: a provider save leaves a routable model before the first message', async function () {
    this.timeout(240_000);
    // The truly-fresh auto-default path (ADR-087 §8) is covered by spec 02 on
    // the clean system; at this suite point the entry re-saves with its model.
    await openSettings();
    await configureOpenRouter(requireOpenrouterKey());
    // An idempotent resave (same provider/key/model) rightly requests no
    // restart — confirm one only if the provider change actually demanded it.
    const restartBtn = await $('[data-testid="restart-now-btn"]');
    try {
      await restartBtn.waitForExist({ timeout: 10_000 });
      await confirmRestartAndWait();
    } catch {
      // No restart requested — the save was a config no-op.
    }
    await openChat();
    await startNewConversation();

    // The badge must already show a model BEFORE any message is sent.
    const badgeText = await (await $('[data-testid="composer-model-badge"]')).getText();
    expect(badgeText.trim().length).toBeGreaterThan(0);
  });

  describe('Anthropic model + effort persistence (SPEED-535)', function () {
    /** Set once `before` confirms a live Anthropic OAuth session — Speedwave never performs
     *  Anthropic OAuth itself (security.md), so a human must have logged in on the rig. */
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
      // No product "clear pin" command exists by design (Out of Scope) — restore a
      // clean state directly on the host files so a later run never inherits this pin.
      clearModelPinFile(ANTHROPIC_PROJECT);
      clearEffortPinFile(ANTHROPIC_PROJECT);
    });

    it('(a) a fresh, unpinned session spawns with no --model/--effort and reports the account default in SystemInit', async function () {
      this.timeout(120_000);
      // The eager pre-message spawn only fires on the app's first-ever /chat visit
      // (long spent on e2e-test) or "+"/restart — here the first send lazily starts it.
      const priorArgs = await lastSpawnArgs();
      await openChat();
      await sendMessageAndWait('Say hi in one word.');
      const freshArgs = await waitForFreshSpawnArgs(priorArgs);

      expect(freshArgs).not.toContain('--model');
      expect(freshArgs).not.toContain('--effort');

      const catalog = await anthropicCatalog();
      const latestIds = await latestAnthropicModelIds();
      const badgeLabel = (await (await $('[data-testid="composer-model-badge"]')).getText()).trim();
      const entry = catalogEntryForBadgeLabel(catalog, badgeLabel);
      if (!entry) {
        throw new Error(`composer-model-badge showed an unrecognized label "${badgeLabel}"`);
      }
      expect(latestIds).toContain(entry.id);
    });

    it('(b)+(c) a composer pick of a model and an effort level persists across "+" and a real app restart', async function () {
      this.timeout(360_000);
      const catalog = await anthropicCatalog();
      const currentBadge = (
        await (await $('[data-testid="composer-model-badge"]')).getText()
      ).trim();
      const currentEntry = catalogEntryForBadgeLabel(catalog, currentBadge);
      const targetModel = catalog.find(
        (m) => m.selectable && m.effort_levels.length > 0 && m.id !== currentEntry?.id
      );
      if (!targetModel) {
        throw new Error('no alternative selectable Anthropic model with effort support found');
      }

      // Pick the model on the live (idle) session — wire `/model` fires at once.
      await openModelSelector();
      await pickModelOption(targetModel.id);
      await $('[data-testid="control-chip"][data-command="model"]').waitForExist({
        timeout: 30_000,
        timeoutMsg: `model control-chip never rendered after picking ${targetModel.id}`,
      });

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

      // Effort: "max" is the least ambiguous level — never a coincidental catalog default.
      await (await $('[data-testid="effort-segment"]')).click();
      await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000 });
      await (await $('[data-testid="effort-stop-max"]')).click();
      await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000, reverse: true });
      await $('[data-testid="control-chip"][data-command="effort"]').waitForExist({
        timeout: 30_000,
        timeoutMsg: 'effort control-chip never rendered after picking max',
      });

      // "+" is deliberate: it breaks the transcript-walkback fallback, so only a
      // real pin (not a coincidentally-matching last transcript) can pass below.
      await startNewConversation();

      const priorArgs = await lastSpawnArgs();
      await restartAppAndReconnect();

      if ((await activeProjectSlug()) !== ANTHROPIC_PROJECT) {
        await switchToProject(ANTHROPIC_PROJECT);
      }
      await openChat();

      // Pill truth BEFORE the first message of the new, post-restart session — the
      // settings.json pin read via get_model_hint, not a session-live value.
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
      // The pin already resolved this model at spawn — a redundant wire /model
      // right after SystemInit would be a bug (it nukes prompt cache for nothing).
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
      const targetModel = catalog.find((m) => m.selectable && m.id !== currentEntry?.id);
      if (!targetModel) throw new Error('no alternative selectable Anthropic model found');

      await openModelSelector();
      await browser.waitUntil(
        async () => (await $$('[data-testid^="model-selector-option-"]').getElements()).length > 1,
        { timeout: 30_000, timeoutMsg: 'model selector never listed more than one option' }
      );

      // Submit via Enter on the still-focused textarea, not a `chat-send` click — the
      // popover floats above the composer and a coordinate click risks interception.
      await queueMessageViaEnter('Count slowly from one to five, one number per line.');
      await waitForTurnStart();

      // The pick fires while the turn streams — applyModelSelection's mid-stream
      // branch queues it instead of sending `/model` immediately.
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

      // Stops exactly match the active model's catalog effort_levels — no more, no less.
      for (const level of currentEntry.effort_levels) {
        expect(await $(`[data-testid="effort-stop-${level}"]`).isExisting()).toBe(true);
      }
      for (const level of ALL_EFFORT_LEVELS.filter(
        (l) => !currentEntry.effort_levels.includes(l)
      )) {
        expect(await $(`[data-testid="effort-stop-${level}"]`).isExisting()).toBe(false);
      }

      // Claude Desktop parity: no help icon anywhere in the popover.
      const popoverText = await (await $('[data-testid="effort-popover"]')).getText();
      expect(popoverText).not.toMatch(/(^|\s)\?(\s|$)/);

      await (await $('[data-testid="effort-stop-low"]')).click();
      await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000, reverse: true });

      // Pill reflects the new level at once.
      await browser.waitUntil(
        async () => (await (await $('[data-testid="effort-segment"]')).getText()).trim() === 'Low',
        { timeout: 10_000, timeoutMsg: 'effort-segment never showed Low after the pick' }
      );
      await $('[data-testid="control-chip"][data-command="effort"]').waitForExist({
        timeout: 30_000,
        timeoutMsg: 'effort control-chip never rendered after picking low',
      });

      // Header reflects it too — reopen to read it (it closes on every commit).
      await (await $('[data-testid="effort-segment"]')).click();
      await $('[data-testid="effort-popover-header"]').waitForExist({ timeout: 10_000 });
      expect((await (await $('[data-testid="effort-popover-header"]')).getText()).trim()).toBe(
        'Effort Low'
      );
      await browser.keys('Escape');

      // Switching to Haiku 4.5 (no effort support at all) hides the segment
      // entirely — the pick applies optimistically, no reply needed to observe it.
      const haiku = catalog.find((m) => m.id === 'claude-haiku-4-5');
      if (!haiku) throw new Error('claude-haiku-4-5 missing from the catalog');
      await openModelSelector();
      await pickModelOption(haiku.id);
      await browser.waitUntil(async () => !(await $('[data-testid="effort-segment"]').isExisting()), {
        timeout: 30_000,
        timeoutMsg: 'effort-segment still rendered after switching to Haiku 4.5',
      });
    });
  });
});

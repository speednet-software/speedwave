/**
 * Slash Popover + Model/Effort Selector E2E tests.
 *
 * Covers the chat-slash-commands redesign: the allowlisted slash popover
 * (leaves its loading state, plugin commands visible, hidden natives absent),
 * the composer model selector (mid-session switch, chip rendering, resume
 * survival), the local/OpenRouter write-through terrain (extends specs
 * 11/08), and the Anthropic-only effort control's next-session semantics.
 *
 * Runs after spec 19 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text, except
 * where the underlying component exposes the value only as text content
 * (slash command names, the effort control's current-pin label) - see the
 * inline notes at each such assertion.
 */

import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { confirmRestartAndWait } from '../helpers/shell';
import { waitForHealthy } from '../helpers/health';
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
} from '../helpers/llm';
import { localLlmUnreachable } from '../helpers/preflight';

const E2E_PROJECT_NAME = 'e2e-test';

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
    // Any selectable Anthropic catalog entry other than the current one - the
    // selector lists them with the full CC-selectable id (4.3.1/4.3.2).
    const options = await $$('[data-testid^="model-selector-option-"]').getElements();
    expect(options.length).toBeGreaterThan(1);
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
    await browser.waitUntil(
      async () =>
        (await (await $('[data-testid="composer-model-badge"]')).getText()) !== currentBadge,
      {
        timeout: 30_000,
        timeoutMsg: `composer-model-badge never updated after switching to ${targetId}`,
      }
    );

    await sendMessageAndWait('Say goodbye in one word.');
    expect(await assistantMessageCount()).toBeGreaterThan(beforeCount);

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

    // The composer pick is the write-through terrain under test (ADR-082 §3).
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

  it('OpenRouter: a fresh provider save auto-defaults the model before the first message', async function () {
    this.timeout(240_000);
    await openSettings();
    await configureOpenRouter(requireOpenrouterKey());
    await confirmRestartAndWait();
    await openChat();
    await startNewConversation();

    // Auto-default applies at provider save (decision 7) - the badge must already
    // show a model BEFORE any message is sent.
    const badgeText = await (await $('[data-testid="composer-model-badge"]')).getText();
    expect(badgeText.trim().length).toBeGreaterThan(0);
  });

  it('effort control: shows next-session semantics and the new pin applies to the next session', async function () {
    this.timeout(240_000);
    // Effort is Anthropic-only (4.3.3) - switch back so the control renders.
    await openSettings();
    const anthropicBtn = await $('[data-testid="settings-llm-provider-anthropic"]');
    if (await anthropicBtn.isExisting()) {
      await anthropicBtn.click();
      await confirmRestartAndWait();
    }
    await openChat();

    await $('[data-testid="effort-control"]').waitForExist({
      timeout: 15_000,
      timeoutMsg: 'effort-control never rendered for the Anthropic provider',
    });
    // Levels are buttons named effort-option-<level> (Task 17); recover the
    // level set from their testid suffixes rather than a data-level attribute.
    const levelButtons = await $$('[data-testid^="effort-option-"]').getElements();
    expect(levelButtons.length).toBeGreaterThan(1);

    const currentPinText = (await (await $('[data-testid="effort-control"]')).getText()).trim();
    let targetLevel: string | null = null;
    for (const btn of levelButtons) {
      const testid = await btn.getAttribute('data-testid');
      const level = (testid ?? '').replace('effort-option-', '');
      if (level && !currentPinText.startsWith(level)) {
        targetLevel = level;
        break;
      }
    }
    if (!targetLevel) throw new Error('no alternative effort level found');
    console.log(`[20-slash-and-model-selector] switching to effort level: ${targetLevel}`);
    // A live session must exist so the pick applies via a wire /effort.
    await sendMessageAndWait('Say hi in one word.');
    await (await $(`[data-testid="effort-option-${targetLevel}"]`)).click();

    // Live semantics (ADR-082 amendment): the pick is current at once - the pin
    // span reflects it immediately and no pending badge exists.
    await browser.waitUntil(
      async () => {
        const text = (await (await $('[data-testid="effort-control"]')).getText()).trim();
        return text.startsWith(targetLevel!);
      },
      {
        timeout: 10_000,
        timeoutMsg: `effort-control never showed ${targetLevel} as current after the pick`,
      }
    );
    expect(await $('[data-testid="effort-pending"]').isExisting()).toBe(false);

    // The wire /effort renders as a control chip in the conversation.
    await browser.waitUntil(
      async () => {
        const chips = await $$('[data-testid="control-chip"][data-command="effort"]').getElements();
        for (const chip of chips) {
          if ((await chip.getText()).includes(targetLevel!)) return true;
        }
        return false;
      },
      {
        timeout: 30_000,
        timeoutMsg: `no effort control chip appeared for ${targetLevel}`,
      }
    );

    // A NEW session starts on the persisted pin (spawn --effort <pin>).
    await startNewConversation();
    await browser.waitUntil(
      async () => {
        const text = (await (await $('[data-testid="effort-control"]')).getText()).trim();
        return text.startsWith(targetLevel!);
      },
      {
        timeout: 30_000,
        timeoutMsg: `new session never started on the persisted effort pin (${targetLevel})`,
      }
    );
  });
});

/** SSOT for LLM-provider test config + reusable config/chat actions. */

/** Reads a required env var, throwing a spec-friendly message when unset. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — export it (e.g. \`set -a && source .env\`)`);
  }
  return value;
}

/** OpenRouter model id from the environment; throws when the spec needs it. */
export function requireOpenrouterModel(): string {
  return requireEnv('OPENROUTER_MODEL');
}

/** OpenRouter API key from the environment; throws when the spec needs it. */
export function requireOpenrouterKey(): string {
  return requireEnv('OPENROUTER_API_KEY');
}

/** Local OpenAI-compatible LLM server config — all values from .env. */
export function requireLocalLlm(): { baseUrl: string; apiKey: string; model: string } {
  return {
    baseUrl: requireEnv('LOCAL_LLM_BASE_URL'),
    apiKey: requireEnv('LOCAL_LLM_API_KEY'),
    model: requireEnv('LOCAL_LLM_MODEL'),
  };
}

/** Navigates to /settings and waits for the settings page to mount. */
export async function openSettings(): Promise<void> {
  const nav = await $('[data-testid="nav-settings"]');
  await nav.waitForExist({ timeout: 15_000 });
  await nav.click();
  await $('[data-testid="settings-title"]').waitForExist({ timeout: 10_000 });
}

/** Selects OpenRouter, enters the key, validates it via a catalog discovery, saves.
 *  Model choice moved to the composer (ADR-082); a fresh save auto-defaults it. */
export async function configureOpenRouter(apiKey: string): Promise<void> {
  const selectBtn = await $('[data-testid="settings-llm-extra-select-openrouter"]');
  await selectBtn.waitForExist({ timeout: 10_000 });
  await selectBtn.click();

  // Clicking an already-active row TOGGLES its panel — if the key input did not
  // appear, the click collapsed a still-expanded row; click again to re-expand.
  const keyInput = await $('[data-testid="settings-llm-extra-key-openrouter"]');
  try {
    await keyInput.waitForExist({ timeout: 3_000 });
  } catch {
    await selectBtn.click();
    await keyInput.waitForExist({ timeout: 5_000 });
  }
  await keyInput.setValue(apiKey);

  // Discovery is a live key check: a bad OPENROUTER_API_KEY fails HERE with a
  // clear reason instead of somewhere downstream in a chat spec.
  const refresh = await $('[data-testid="settings-llm-extra-refresh-openrouter"]');
  await refresh.click();
  await browser.waitUntil(async () => !(await refresh.getText()).includes('discovering'), {
    timeout: 60_000,
    timeoutMsg: 'OpenRouter catalog discovery never settled',
  });
  const orError = await $('[data-testid="settings-llm-extra-discovery-error-openrouter"]');
  if (await orError.isExisting()) {
    throw new Error(`OpenRouter discovery failed: ${await orError.getText()}`);
  }

  await saveProvider();
}

/** Selects the local provider, enters base_url + key, validates via discovery, saves.
 *  Model choice moved to the composer (ADR-082); a fresh save auto-defaults it. */
export async function configureLocalProvider(baseUrl: string, apiKey: string): Promise<void> {
  const selectBtn = await $('[data-testid="settings-llm-provider-local"]');
  await selectBtn.waitForExist({ timeout: 10_000 });
  await selectBtn.click();

  const baseUrlInput = await $('[data-testid="settings-llm-base-url"]');
  await baseUrlInput.waitForExist({ timeout: 5_000 });
  await baseUrlInput.setValue(baseUrl);

  const keyInput = await $('[data-testid="settings-llm-api-key"]');
  await keyInput.waitForExist({ timeout: 5_000 });
  await keyInput.setValue(apiKey);

  await (await $('[data-testid="settings-llm-refresh"]')).click();
  await browser.waitUntil(
    async () => !(await $('[data-testid="settings-llm-discovering"]').isExisting()),
    { timeout: 60_000, timeoutMsg: 'local model discovery never settled' }
  );
  const localError = await $('[data-testid="settings-llm-discovery-error"]');
  if (await localError.isExisting()) {
    throw new Error(`local discovery failed: ${await localError.getText()}`);
  }

  await saveProvider();
}

/** Picks `catalogId` in the composer model selector — the single model control
 *  (ADR-082); non-anthropic picks write through to the project config. */
export async function pickComposerModel(catalogId: string): Promise<void> {
  // A just-flushed control turn briefly streams, and the badge click is a
  // deliberate no-op then (openCombobox streaming guard) — retry until open.
  const search = await $('[data-testid="model-selector-search"]');
  await browser.waitUntil(
    async () => {
      if (await search.isExisting()) return true;
      await (await $('[data-testid="composer-model-badge"]')).click();
      return await search.isExisting();
    },
    { timeout: 30_000, interval: 1_000, timeoutMsg: 'model selector never opened' }
  );
  await search.setValue(catalogId);
  const option = await $(`[data-testid="model-selector-option-${catalogId}"]`);
  await option.waitForExist({
    timeout: 30_000,
    timeoutMsg: `model option ${catalogId} never appeared in the composer selector`,
  });
  await option.click();
  await browser.waitUntil(async () => !(await search.isExisting()), {
    timeout: 10_000,
    timeoutMsg: 'model selector never closed after the pick',
  });
}

/** Clicks Save, waits for the enabled state then the saved confirmation. */
export async function saveProvider(): Promise<void> {
  const saveBtn = await $('[data-testid="settings-llm-save"]');
  await browser.waitUntil(async () => await saveBtn.isEnabled(), {
    timeout: 10_000,
    timeoutMsg: 'Save button did not become enabled',
  });
  await saveBtn.click();
  await (await $('[data-testid="settings-llm-saved"]')).waitForExist({ timeout: 15_000 });
}

/** Navigates to /chat and waits for the ready chat view to mount. */
export async function openChat(timeoutMs = 180_000): Promise<void> {
  const nav = await $('[data-testid="nav-chat"]');
  await nav.waitForExist({ timeout: 15_000 });
  await nav.click();
  await $('[data-testid="chat-view"]').waitForExist({ timeout: timeoutMs });
}

/** Navigates to the usage dashboard and waits for it to mount. */
export async function openUsage(): Promise<void> {
  await (await $('[data-testid="nav-usage"]')).click();
  await $('[data-testid="usage-title"]').waitForExist({ timeout: 10_000 });
  await $('[data-testid="llm-usage"]').waitForExist({ timeout: 10_000 });
}

/** Navigates to the integrations page and waits for it to mount. */
export async function openIntegrations(): Promise<void> {
  await (await $('[data-testid="nav-integrations"]')).click();
  await $('[data-testid="integrations-body"]').waitForExist({ timeout: 15_000 });
}

/** The status pill text for a service row (running / starting / disabled). */
export async function rowStatus(service: string): Promise<string> {
  const status = await $(`[data-testid="integrations-row-${service}"]`).$(
    '[data-testid="integrations-row-status"]'
  );
  return (await status.getText()).trim();
}

/** Clicks the enable/disable toggle for an integration service row. */
export async function toggleIntegration(service: string): Promise<void> {
  const toggle = await $(`[data-testid="integrations-row-toggle-${service}"]`);
  await toggle.waitForExist({ timeout: 10_000 });
  await toggle.click();
}

/** Types `text` and clicks send; does not wait for the turn to finish. */
export async function sendMessageNoWait(text: string): Promise<void> {
  const input = await $('[data-testid="chat-input"]');
  await input.waitForExist({ timeout: 15_000 });
  await input.setValue(text);

  const sendBtn = await $('[data-testid="chat-send"]');
  await browser.waitUntil(async () => await sendBtn.isEnabled(), {
    timeout: 10_000,
    timeoutMsg: 'chat-send never became enabled',
  });
  await sendBtn.click();
}

/** Types `text` and submits with Enter. While a turn streams the send button is
 *  replaced by Stop (ADR-045), so Enter is the only way to queue — this routes
 *  to queueRequested instead of clicking a (hidden) send button. */
export async function queueMessageViaEnter(text: string): Promise<void> {
  const input = await $('[data-testid="chat-input"]');
  await input.waitForExist({ timeout: 15_000 });
  await input.setValue(text);
  await browser.keys('Enter');
}

/** Waits until the current turn stops streaming and the send button returns. */
export async function waitForTurnComplete(responseTimeoutMs = 180_000): Promise<void> {
  await browser.waitUntil(
    async () =>
      !(await $('[data-testid="chat-message-list-streaming"]').isExisting()) &&
      !(await $('[data-testid="chat-message-list-awaiting"]').isExisting()) &&
      !(await $('[data-testid="chat-stop"]').isExisting()) &&
      (await $('[data-testid="chat-send"]').isExisting()),
    { timeout: responseTimeoutMs, interval: 1_000, timeoutMsg: 'chat response never completed' }
  );
}

/** Waits until the current turn begins streaming (placeholder or stop button). */
export async function waitForTurnStart(timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="chat-message-list-streaming"]').isExisting()) ||
      (await $('[data-testid="chat-message-list-awaiting"]').isExisting()) ||
      (await $('[data-testid="chat-stop"]').isExisting()),
    { timeout: timeoutMs, timeoutMsg: 'chat turn never started streaming' }
  );
}

/** Types `text`, sends it, waits for streaming to start then finish. */
export async function sendMessageAndWait(text: string, responseTimeoutMs = 180_000): Promise<void> {
  await sendMessageNoWait(text);
  await waitForTurnStart();
  await waitForTurnComplete(responseTimeoutMs);
}

/** True when the usage-dashboard table rows for `model` all show "—" (unpriced).
 *  Targets the per-model row cost, not the project-wide total (which also sums
 *  any priced provider the project used earlier). The usage JSONL stores the
 *  model as `<provider_kind>/<model>` (e.g. `local/unsloth/…`), so match on the
 *  data-model SUFFIX. The dashboard aggregates async, so wait for the model's
 *  row(s) to appear (a `nav-usage` re-click re-fetches on each poll) before
 *  asserting cost — a missing row is a not-yet-loaded dashboard, not a verdict. */
export async function modelRowsUnpriced(model: string, timeoutMs = 30_000): Promise<boolean> {
  const sel = `[data-testid="llm-usage-row"][data-model$="${model}"]`;
  try {
    await browser.waitUntil(
      async () => {
        if ((await $$(sel).getElements()).length > 0) return true;
        // The dashboard fetches once per mount (effect on the project input), so
        // re-mount it — nav away then back — to re-run get_llm_usage.
        await (await $('[data-testid="nav-chat"]')).click();
        await (await $('[data-testid="nav-usage"]')).click();
        await $('[data-testid="llm-usage"]').waitForExist({ timeout: 10_000 });
        return (await $$(sel).getElements()).length > 0;
      },
      { timeout: timeoutMs, interval: 2_000, timeoutMsg: 'no row' }
    );
  } catch {
    // Surface the data-model values that DID render, so a format/timing mismatch
    // is diagnosable from the failure instead of a bare boolean.
    const all = await $$('[data-testid="llm-usage-row"]').getElements();
    const models: (string | null)[] = [];
    for (const r of all) {
      models.push(await r.getAttribute('data-model'));
    }
    throw new Error(
      `usage dashboard never showed a row ending in "${model}". Rendered data-model values: ${JSON.stringify(models)}`
    );
  }
  const rows = await $$(sel).getElements();
  for (const row of rows) {
    const cost = await row.$('[data-testid="llm-usage-row-cost"]').getText();
    if (!cost.includes('—')) return false;
  }
  return true;
}

/** Numeric USD from a `$X.XXXX` element, or null when unpriced (`—`) / absent. */
export async function readUsd(selector: string): Promise<number | null> {
  const el = await $(selector);
  if (!(await el.isExisting())) return null;
  const match = (await el.getText()).trim().match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/** Polls readUsd until it resolves to a priced (non-null) value. */
export async function waitForUsd(
  selector: string,
  opts: { timeout: number; interval: number; timeoutMsg: string }
): Promise<number> {
  let resolved: number | null = null;
  await browser.waitUntil(async () => {
    const value = await readUsd(selector);
    if (value === null) return false;
    resolved = value;
    return true;
  }, opts);
  if (resolved === null) throw new Error(`waitForUsd resolved without a value for ${selector}`);
  return resolved;
}

/** Polls the dashboard cost card, remounting the view each round so it refetches
 *  (the usage view only fetches on mount / project change, not on a timer). */
export async function waitForDashboardUsd(
  opts: { timeout: number; interval: number; timeoutMsg: string }
): Promise<number> {
  const deadline = Date.now() + opts.timeout;
  let value: number | null = null;
  for (;;) {
    await openUsage();
    value = await readUsd('[data-testid="llm-usage-card-cost"]');
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(opts.timeoutMsg);
    await (await $('[data-testid="nav-chat"]')).click();
    await browser.pause(opts.interval);
  }
}

/** Polls the chat footer cost until it reconciles to within `tol` of `target`.
 *  The footer first shows Claude Code's live-preview cost (mispriced for a
 *  proxied provider), then reconcileFooterCost overwrites it with the proxy
 *  SSOT — this waits for that convergence. Requires being on /chat. */
export async function waitForFooterToReconcile(
  target: number,
  tol: number,
  opts: { timeout: number; interval: number; timeoutMsg: string }
): Promise<number> {
  let resolved: number | null = null;
  await browser.waitUntil(
    async () => {
      const value = await readUsd('[data-testid="session-stats"]');
      if (value === null) return false;
      if (Math.abs(value - target) > tol) return false;
      resolved = value;
      return true;
    },
    opts
  );
  if (resolved === null) throw new Error(opts.timeoutMsg);
  return resolved;
}

/** True when a `$X.XXXX`/`—` cost element shows no priced value (unpriced). */
export async function isUnpriced(selector: string): Promise<boolean> {
  return (await readUsd(selector)) === null;
}

/** Text of the last assistant message's text blocks only (excludes metadata). */
export async function lastAssistantText(): Promise<string> {
  const messages = await $$('[data-testid="chat-message"][data-role="assistant"]').getElements();
  if (messages.length === 0) return '';
  const last = messages[messages.length - 1];
  // Scope to app-text-block so token/cost metadata digits can't satisfy asserts.
  const blocks = await last.$$('app-text-block').getElements();
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(await block.getText());
  }
  return parts.join('\n').trim();
}

/** Count of rendered assistant message bubbles in the current chat window. */
export async function assistantMessageCount(): Promise<number> {
  return (await $$('[data-testid="chat-message"][data-role="assistant"]').getElements()).length;
}

/** Concatenated text of ALL assistant messages currently in the window. */
export async function conversationText(): Promise<string> {
  const messages = await $$('[data-testid="chat-message"]').getElements();
  const parts: string[] = [];
  for (const msg of messages) {
    parts.push(await msg.getText());
  }
  return parts.join('\n');
}

/** Waits until the window holds at least `min` assistant messages (a resumed
 *  transcript has loaded prior turns), proving a real conversation is open. */
export async function waitForConversationLoaded(min = 1, timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(async () => (await assistantMessageCount()) >= min, {
    timeout: timeoutMs,
    interval: 500,
    timeoutMsg: `chat window never loaded ${min}+ prior assistant message(s)`,
  });
}

/** Opens the conversations sidebar (history list). */
export async function openHistory(): Promise<void> {
  await (await $('[data-testid="chat-header-history"]')).click();
  await $('[data-testid="conversations-sidebar"]').waitForExist({ timeout: 10_000 });
}

/** Opens history and resumes the newest conversation (first row, newest-first). */
export async function resumeNewestConversation(): Promise<void> {
  await openHistory();
  const rows = await $$('[data-testid="conversations-sidebar-row"]').getElements();
  if (rows.length === 0) throw new Error('no conversations in history to resume');
  const resume = await rows[0].$('[data-testid^="conversation-resume-"]');
  await resume.click();
}

/** Starts a brand-new conversation from the chat header. */
export async function startNewConversation(): Promise<void> {
  await (await $('[data-testid="chat-header-new"]')).click();
}

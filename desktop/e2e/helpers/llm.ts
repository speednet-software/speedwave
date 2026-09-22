function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — export it (e.g. \`set -a && source .env\`)`);
  }
  return value;
}

export function requireOpenrouterModel(): string {
  return requireEnv('OPENROUTER_MODEL');
}

export function requireOpenrouterKey(): string {
  return requireEnv('OPENROUTER_API_KEY');
}

export function requireLocalLlm(): { baseUrl: string; apiKey: string; model: string } {
  return {
    baseUrl: requireEnv('LOCAL_LLM_BASE_URL'),
    apiKey: requireEnv('LOCAL_LLM_API_KEY'),
    model: requireEnv('LOCAL_LLM_MODEL'),
  };
}

export async function openSettings(): Promise<void> {
  const nav = await $('[data-testid="nav-settings"]');
  await nav.waitForExist({ timeout: 15_000 });
  await nav.click();
  await $('[data-testid="settings-title"]').waitForExist({ timeout: 10_000 });
}

export async function configureOpenRouter(apiKey: string): Promise<void> {
  const selectBtn = await $('[data-testid="settings-llm-extra-select-openrouter"]');
  await selectBtn.waitForExist({ timeout: 10_000 });
  await selectBtn.click();

  const keyInput = await $('[data-testid="settings-llm-extra-key-openrouter"]');
  try {
    await keyInput.waitForExist({ timeout: 3_000 });
  } catch {
    await selectBtn.click();
    await keyInput.waitForExist({ timeout: 5_000 });
  }
  await keyInput.setValue(apiKey);

  await (await $('[data-testid="settings-llm-extra-refresh-openrouter"]')).click();
  const success = await $('[data-testid="settings-llm-extra-test-success-openrouter"]');
  const orError = await $('[data-testid="settings-llm-extra-discovery-error-openrouter"]');
  await browser.waitUntil(
    async () => (await success.isExisting()) || (await orError.isExisting()),
    { timeout: 60_000, timeoutMsg: 'OpenRouter connection test never settled' }
  );
  if (await orError.isExisting()) {
    throw new Error(`OpenRouter connection test failed: ${await orError.getText()}`);
  }

  await saveProvider();
}

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

export async function pickComposerModel(catalogId: string): Promise<void> {
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

export async function saveProvider(): Promise<void> {
  const saveBtn = await $('[data-testid="settings-llm-save"]');
  await browser.waitUntil(async () => await saveBtn.isEnabled(), {
    timeout: 10_000,
    timeoutMsg: 'Save button did not become enabled',
  });
  await saveBtn.click();
  await (await $('[data-testid="settings-llm-saved"]')).waitForExist({ timeout: 15_000 });
}

export async function openChat(timeoutMs = 180_000): Promise<void> {
  const nav = await $('[data-testid="nav-chat"]');
  await nav.waitForExist({ timeout: 15_000 });
  await nav.click();
  await $('[data-testid="chat-view"]').waitForExist({ timeout: timeoutMs });
}

export async function openUsage(): Promise<void> {
  await (await $('[data-testid="nav-usage"]')).click();
  await $('[data-testid="usage-title"]').waitForExist({ timeout: 10_000 });
  await $('[data-testid="llm-usage"]').waitForExist({ timeout: 10_000 });
}

export async function openIntegrations(): Promise<void> {
  await (await $('[data-testid="nav-integrations"]')).click();
  await $('[data-testid="integrations-body"]').waitForExist({ timeout: 15_000 });
}

export async function rowStatus(service: string): Promise<string> {
  const status = await $(`[data-testid="integrations-row-${service}"]`).$(
    '[data-testid="integrations-row-status"]'
  );
  return (await status.getText()).trim();
}

export async function toggleIntegration(service: string): Promise<void> {
  const toggle = await $(`[data-testid="integrations-row-toggle-${service}"]`);
  await toggle.waitForExist({ timeout: 10_000 });
  await toggle.click();
}

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

export async function queueMessageViaEnter(text: string): Promise<void> {
  const input = await $('[data-testid="chat-input"]');
  await input.waitForExist({ timeout: 15_000 });
  await input.setValue(text);
  await browser.keys('Enter');
}

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

export async function waitForTurnStart(timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="chat-message-list-streaming"]').isExisting()) ||
      (await $('[data-testid="chat-message-list-awaiting"]').isExisting()) ||
      (await $('[data-testid="chat-stop"]').isExisting()),
    { timeout: timeoutMs, timeoutMsg: 'chat turn never started streaming' }
  );
}

export async function sendMessageAndWait(text: string, responseTimeoutMs = 180_000): Promise<void> {
  await sendMessageNoWait(text);
  await waitForTurnStart();
  await waitForTurnComplete(responseTimeoutMs);
}

export async function modelRowsUnpriced(model: string, timeoutMs = 30_000): Promise<boolean> {
  const sel = `[data-testid="llm-usage-row"][data-model$="${model}"]`;
  try {
    await browser.waitUntil(
      async () => {
        if ((await $$(sel).getElements()).length > 0) return true;
        await (await $('[data-testid="nav-chat"]')).click();
        await (await $('[data-testid="nav-usage"]')).click();
        await $('[data-testid="llm-usage"]').waitForExist({ timeout: 10_000 });
        return (await $$(sel).getElements()).length > 0;
      },
      { timeout: timeoutMs, interval: 2_000, timeoutMsg: 'no row' }
    );
  } catch {
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

export async function readUsd(selector: string): Promise<number | null> {
  const el = await $(selector);
  if (!(await el.isExisting())) return null;
  const match = (await el.getText()).trim().match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? parseFloat(match[1]) : null;
}

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

export async function waitForDashboardUsd(opts: {
  timeout: number;
  interval: number;
  timeoutMsg: string;
}): Promise<number> {
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

export async function waitForFooterToReconcile(
  target: number,
  tol: number,
  opts: { timeout: number; interval: number; timeoutMsg: string }
): Promise<number> {
  let resolved: number | null = null;
  await browser.waitUntil(async () => {
    const value = await readUsd('[data-testid="session-stats"]');
    if (value === null) return false;
    if (Math.abs(value - target) > tol) return false;
    resolved = value;
    return true;
  }, opts);
  if (resolved === null) throw new Error(opts.timeoutMsg);
  return resolved;
}

export async function isUnpriced(selector: string): Promise<boolean> {
  return (await readUsd(selector)) === null;
}

export async function lastAssistantText(): Promise<string> {
  const messages = await $$('[data-testid="chat-message"][data-role="assistant"]').getElements();
  if (messages.length === 0) return '';
  const last = messages[messages.length - 1];
  const blocks = await last.$$('app-text-block').getElements();
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(await block.getText());
  }
  return parts.join('\n').trim();
}

export async function assistantMessageCount(): Promise<number> {
  return (await $$('[data-testid="chat-message"][data-role="assistant"]').getElements()).length;
}

export async function conversationText(): Promise<string> {
  const messages = await $$('[data-testid="chat-message"]').getElements();
  const parts: string[] = [];
  for (const msg of messages) {
    parts.push(await msg.getText());
  }
  return parts.join('\n');
}

export async function waitForConversationLoaded(min = 1, timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(async () => (await assistantMessageCount()) >= min, {
    timeout: timeoutMs,
    interval: 500,
    timeoutMsg: `chat window never loaded ${min}+ prior assistant message(s)`,
  });
}

export async function openHistory(): Promise<void> {
  await (await $('[data-testid="chat-header-history"]')).click();
  await $('[data-testid="conversations-sidebar"]').waitForExist({ timeout: 10_000 });
}

export async function resumeNewestConversation(): Promise<void> {
  await openHistory();
  const rows = await $$('[data-testid="conversations-sidebar-row"]').getElements();
  if (rows.length === 0) throw new Error('no conversations in history to resume');
  const resume = await rows[0].$('[data-testid^="conversation-resume-"]');
  await resume.click();
}

export async function startNewConversation(): Promise<void> {
  await (await $('[data-testid="chat-header-new"]')).click();
}

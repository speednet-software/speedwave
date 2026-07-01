/**
 * Chat Cost Reconciliation E2E test.
 *
 * Sends a single chat message against the OpenRouter provider configured by
 * spec 02 (setup wizard), waits for the assistant's response to finish
 * streaming, then reconciles two independent cost readings:
 *
 *   1. The chat footer / per-message cost, sourced from the
 *      `get_usage_for_response` / `get_conversation_cost` Tauri commands
 *      (ADR-073 invariant 6 — the proxy usage JSONL + host cost sidecar).
 *   2. The aggregate cost on the global LLM usage dashboard, sourced from
 *      `get_llm_usage`, which reads the same sidecar-enriched JSONL.
 *
 * OpenRouter cost is priced asynchronously (`cost_source: 'deferred'`) via a
 * host-side `/generation` lookup — see `reconcileFooterCost` in
 * `chat-state.service.ts`, which retries on a ~60s backoff schedule
 * (1s, 2s, 4s, 8s, 15s, 30s). This spec mirrors that patience: it polls the
 * footer cost testid rather than asserting immediately after the response
 * completes, and only then cross-checks the dashboard aggregate.
 *
 * Runs after spec 02 (setup + OpenRouter provider) and before spec 07
 * (factory reset, which destroys all state and must stay last).
 * All assertions are based on `data-testid` attributes — never on
 * UX-volatile text content.
 */

/** Extracts the numeric USD value from a `$X.XXXX`-formatted element, or null if unpriced (`—`). */
async function readUsd(selector: string): Promise<number | null> {
  const el = await $(selector);
  if (!(await el.isExisting())) return null;
  const text = (await el.getText()).trim();
  const match = text.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/** Polls `readUsd(selector)` until it resolves to a priced (non-null) value. */
async function waitForUsd(
  selector: string,
  opts: { timeout: number; interval: number; timeoutMsg: string },
): Promise<number> {
  let resolved: number | null = null;
  await browser.waitUntil(
    async () => {
      const value = await readUsd(selector);
      if (value === null) return false;
      resolved = value;
      return true;
    },
    opts,
  );
  if (resolved === null) {
    throw new Error(`waitForUsd resolved without a value for ${selector}`);
  }
  return resolved;
}

describe('Chat Cost Reconciliation', function () {
  before(async function () {
    this.timeout(30_000);

    const nav = await $('[data-testid="nav-chat"]');
    await nav.waitForExist({
      timeout: 15_000,
      timeoutMsg:
        'Chat nav link not found — spec 02 (setup wizard) must complete successfully before chat cost tests can run',
    });
    await nav.click();

    const view = await $('[data-testid="chat-view"]');
    await view.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Chat view did not mount — provider may not be configured (spec 02 step)',
    });
  });

  it('should send a message and wait for the response to complete', async function () {
    this.timeout(120_000);

    const input = await $('[data-testid="chat-input"]');
    await input.waitForExist({ timeout: 10_000 });
    await input.setValue('Reply with a single short sentence.');

    const sendBtn = await $('[data-testid="chat-send"]');
    await browser.waitUntil(async () => await sendBtn.isEnabled(), {
      timeout: 10_000,
      timeoutMsg: 'Send button did not become enabled',
    });
    await sendBtn.click();

    // Streaming placeholder mounts once the turn starts.
    await browser.waitUntil(
      async () => {
        return (
          (await $('[data-testid="chat-message-list-streaming"]').isExisting()) ||
          (await $('[data-testid="chat-message-list-awaiting"]').isExisting()) ||
          (await $('[data-testid="chat-stop"]').isExisting())
        );
      },
      { timeout: 30_000, timeoutMsg: 'Turn never started streaming' },
    );

    // Completion: streaming placeholder gone and Send button (not Stop) is back.
    await browser.waitUntil(
      async () => {
        const stillStreaming =
          (await $('[data-testid="chat-message-list-streaming"]').isExisting()) ||
          (await $('[data-testid="chat-message-list-awaiting"]').isExisting()) ||
          (await $('[data-testid="chat-stop"]').isExisting());
        return !stillStreaming && (await $('[data-testid="chat-send"]').isExisting());
      },
      { timeout: 90_000, timeoutMsg: 'Assistant response did not finish streaming' },
    );

    // At least one assistant message rendered with metadata (cost/tokens footer).
    const assistantMsg = await $('[data-testid="chat-message"][data-role="assistant"]');
    await assistantMsg.waitForExist({ timeout: 10_000 });
    const metadata = await assistantMsg.$('[data-testid="message-metadata"]');
    await metadata.waitForExist({ timeout: 10_000 });
  });

  it('should reconcile the footer cost against the usage dashboard aggregate', async function () {
    // OpenRouter cost is deferred and reconciled on a backoff spanning ~60s
    // (chat-state.service.ts DEFERRED_RECONCILE_BACKOFF_MS); allow headroom.
    this.timeout(120_000);

    // Poll the session-stats footer until the deferred OpenRouter cost resolves
    // to a priced (non-em-dash) value, mirroring reconcileFooterCost's patience.
    const footerCost = await waitForUsd('[data-testid="session-stats"]', {
      timeout: 90_000,
      interval: 3_000,
      timeoutMsg: 'Chat footer cost never resolved to a priced value (reconcileFooterCost)',
    });
    expect(footerCost).toBeGreaterThan(0);

    // Cross-check against the global usage dashboard's aggregate cost card,
    // which reads the same proxy usage JSONL + host cost sidecar (invariant 6).
    const nav = await $('[data-testid="nav-usage"]');
    await nav.waitForExist({ timeout: 10_000 });
    await nav.click();

    const title = await $('[data-testid="usage-title"]');
    await title.waitForExist({ timeout: 10_000 });

    const usageBody = await $('[data-testid="llm-usage"]');
    await usageBody.waitForExist({ timeout: 10_000 });

    const dashboardCost = await waitForUsd('[data-testid="llm-usage-card-cost"]', {
      timeout: 30_000,
      interval: 2_000,
      timeoutMsg: 'Usage dashboard cost card never resolved to a priced value',
    });

    // The dashboard aggregates every proxied request for the project (this
    // conversation is currently the only one in the fresh e2e-test project),
    // so it must be at least the footer's conversation-scoped total.
    expect(dashboardCost).toBeGreaterThanOrEqual(footerCost);

    // Both numbers come from the same sidecar-enriched source (ADR-073
    // invariant 6); for a single-conversation project they must match closely.
    expect(Math.abs(dashboardCost - footerCost)).toBeLessThan(0.01);
  });
});

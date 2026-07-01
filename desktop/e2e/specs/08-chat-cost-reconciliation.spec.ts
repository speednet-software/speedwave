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

import { openChat, openUsage, sendMessageAndWait, waitForUsd } from '../helpers/llm';

describe('Chat Cost Reconciliation', function () {
  before(async function () {
    this.timeout(180_000);
    await openChat();
  });

  it('should send a message and wait for the response to complete', async function () {
    this.timeout(120_000);
    await sendMessageAndWait('Reply with a single short sentence.');

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
    await openUsage();

    const dashboardCost = await waitForUsd('[data-testid="llm-usage-card-cost"]', {
      timeout: 30_000,
      interval: 2_000,
      timeoutMsg: 'Usage dashboard cost card never resolved to a priced value',
    });

    // get_conversation_cost (footer) sums only response_ids from turns loaded
    // in-memory in this conversation; get_llm_usage (dashboard) sums every
    // proxied request ever recorded for the whole project. This spec is the
    // first chat turn sent anywhere in the suite (specs 01-06 never invoke
    // chat), so for the fresh e2e-test project the two scopes coincide.
    expect(dashboardCost).toBeGreaterThanOrEqual(footerCost);

    // Both read the same sidecar-enriched cost_usd (ADR-073 invariant 6), but
    // at different display precision: the footer always shows 4 decimals,
    // the dashboard rounds to 2 once cost >= $0.10 (max +/-0.005 rounding
    // error). 0.015 gives headroom above that bound while still catching a
    // genuine reconciliation mismatch.
    expect(Math.abs(dashboardCost - footerCost)).toBeLessThan(0.015);
  });
});

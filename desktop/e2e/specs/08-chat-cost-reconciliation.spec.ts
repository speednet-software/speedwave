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

import {
  openChat,
  sendMessageAndWait,
  waitForDashboardUsd,
  waitForFooterToReconcile,
} from '../helpers/llm';

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
    this.timeout(180_000);

    // The usage dashboard reads the proxy SSOT cost (sidecar) and re-polls the
    // deferred enrichment itself — take it as the source of truth. Remount each
    // round so it refetches (it fetches on mount / project change only).
    const dashboardCost = await waitForDashboardUsd({
      timeout: 90_000,
      interval: 3_000,
      timeoutMsg: 'Usage dashboard cost card never resolved to a priced value',
    });
    expect(dashboardCost).toBeGreaterThan(0);

    // The footer first shows Claude Code's live-preview cost (priced with
    // Anthropic rates, wrong for a proxied provider), then reconcileFooterCost
    // overwrites it with the same proxy SSOT. Wait for the footer to converge
    // on the dashboard value rather than reading the transient live preview.
    await openChat();
    const footerCost = await waitForFooterToReconcile(dashboardCost, 0.015, {
      timeout: 90_000,
      interval: 3_000,
      timeoutMsg: 'Chat footer cost never reconciled to the proxy SSOT value',
    });
    expect(footerCost).toBeGreaterThan(0);
  });
});

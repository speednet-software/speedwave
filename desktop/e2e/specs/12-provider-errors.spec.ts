/**
 * LLM Provider Error-Path E2E tests.
 *
 * Exercises the discovery failure and validation paths of the local provider
 * form on e2e-test, without saving (so the active OpenRouter provider from
 * spec 11 is left intact):
 *   - a bad api key / unreachable base_url surfaces settings-llm-discovery-error;
 *   - an offline server times out into the same failure surface;
 *   - a routable base_url alone makes the card saveable (model auto-defaults
 *     at save, ADR-082 §8 — Settings has no model control).
 *
 * Runs after spec 11 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import { openSettings, requireLocalLlm } from '../helpers/llm';
import { localLlmUnreachable } from '../helpers/preflight';

/** A routable host with a port nothing listens on — forces a discovery timeout. */
const OFFLINE_BASE_URL = 'http://127.0.0.1:9';

describe('Provider Error Paths', function () {
  beforeEach(async function () {
    this.timeout(30_000);
    await openSettings();
    await (await $('[data-testid="settings-llm-provider-local"]')).click();
  });

  afterEach(async function () {
    this.timeout(30_000);
    // Leave without saving so the active provider is untouched.
    await (await $('[data-testid="nav-chat"]')).click();
  });

  it('surfaces a discovery error for a bad api key', async function () {
    this.timeout(60_000);
    // Needs a server that actively rejects the key; with no route the request would
    // time out and pass for the wrong reason.
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await (await $('[data-testid="settings-llm-base-url"]')).setValue(local.baseUrl);
    await (await $('[data-testid="settings-llm-api-key"]')).setValue('sk-definitely-invalid-key');
    await (await $('[data-testid="settings-llm-refresh"]')).click();

    await $('[data-testid="settings-llm-discovery-error"]').waitForExist({ timeout: 30_000 });
    // A failed discovery no longer blocks Save (ADR-082 §8): validation happens
    // at save time, where the backend auto-default probe fails with a clear error.
    expect(await $('[data-testid="settings-llm-save"]').isEnabled()).toBe(true);
  });

  it('surfaces a discovery error for an offline server', async function () {
    this.timeout(60_000);
    await (await $('[data-testid="settings-llm-base-url"]')).setValue(OFFLINE_BASE_URL);
    await (await $('[data-testid="settings-llm-refresh"]')).click();

    await $('[data-testid="settings-llm-discovery-error"]').waitForExist({ timeout: 40_000 });
  });

  it('a routable base_url alone makes the local card saveable (no model control)', async function () {
    this.timeout(60_000);
    // Needs a successful discovery against a live server.
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await (await $('[data-testid="settings-llm-base-url"]')).setValue(local.baseUrl);
    await (await $('[data-testid="settings-llm-api-key"]')).setValue(local.apiKey);
    await (await $('[data-testid="settings-llm-refresh"]')).click();

    await browser.waitUntil(
      async () => !(await $('[data-testid="settings-llm-discovering"]').isExisting()),
      { timeout: 40_000, timeoutMsg: 'discovery never settled' }
    );
    expect(await $('[data-testid="settings-llm-discovery-error"]').isExisting()).toBe(false);
    // Settings carries no model selector (ADR-082): the base_url + key form is
    // saveable as-is; the model auto-defaults at save via the discovery probe.
    await browser.waitUntil(async () => await $('[data-testid="settings-llm-save"]').isEnabled(), {
      timeout: 15_000,
      timeoutMsg: 'Save never enabled for a routable local card',
    });
  });
});

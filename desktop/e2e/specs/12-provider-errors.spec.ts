/**
 * LLM Provider Error-Path E2E tests.
 *
 * Exercises the connection-test failure and validation paths of the local
 * provider form on e2e-test, without saving (so the active OpenRouter
 * provider from spec 11 is left intact):
 *   - a bad api key / unreachable base_url surfaces settings-llm-discovery-error;
 *   - an offline server times out into the same failure surface;
 *   - a routable base_url alone makes the card saveable (model auto-defaults
 *     at save, ADR-087 section 8 — Settings has no model control);
 *   - a failed connection test (SPEED-555) blocks Save outright — clicking
 *     Save never persists the local provider as active.
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
    await (await $("[data-testid='settings-llm-provider-local']")).click();
  });

  afterEach(async function () {
    this.timeout(30_000);
    // Leave without saving so the active provider is untouched.
    await (await $("[data-testid='nav-chat']")).click();
  });

  it('surfaces a discovery error for a bad api key', async function () {
    this.timeout(60_000);
    // Needs a server that actively rejects the key; with no route the request would
    // time out and pass for the wrong reason.
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await (await $("[data-testid='settings-llm-base-url']")).setValue(local.baseUrl);
    await (await $("[data-testid='settings-llm-api-key']")).setValue('sk-definitely-invalid-key');
    await (await $("[data-testid='settings-llm-refresh']")).click();

    await $("[data-testid='settings-llm-discovery-error']").waitForExist({ timeout: 30_000 });
    // The Save button's own enablement is dirty-state only (SPEED-555): it stays
    // clickable after a failed test. What actually gates persistence is saveConfig
    // itself, covered by the dedicated "does not persist" test below.
    expect(await $("[data-testid='settings-llm-save']").isEnabled()).toBe(true);
  });

  it('surfaces a discovery error for an offline server', async function () {
    this.timeout(60_000);
    await (await $("[data-testid='settings-llm-base-url']")).setValue(OFFLINE_BASE_URL);
    await (await $("[data-testid='settings-llm-refresh']")).click();

    await $("[data-testid='settings-llm-discovery-error']").waitForExist({ timeout: 40_000 });
  });

  it('does not persist the local provider after a failed connection test (SPEED-555)', async function () {
    this.timeout(60_000);
    await (await $("[data-testid='settings-llm-base-url']")).setValue(OFFLINE_BASE_URL);
    await (await $("[data-testid='settings-llm-refresh']")).click();
    await $("[data-testid='settings-llm-discovery-error']").waitForExist({ timeout: 40_000 });

    const saveBtn = await $("[data-testid='settings-llm-save']");
    await saveBtn.click();
    // Save re-probes the still-failing connection before it would write anything
    // (needsConnectionProbe: the last test on these exact field values failed);
    // wait for that second attempt to settle back into a failure.
    await browser.waitUntil(
      async () => !(await $("[data-testid='settings-llm-discovering']").isExisting()),
      { timeout: 40_000, timeoutMsg: 'save-triggered probe never settled' }
    );
    expect(await $("[data-testid='settings-llm-saved']").isExisting()).toBe(false);

    // Reload Settings and confirm the persisted active provider is still not
    // local — a blocked save never reaches update_llm_config.
    await (await $("[data-testid='nav-chat']")).click();
    await openSettings();
    expect(
      await $("[data-testid='settings-llm-provider-local']").getAttribute('aria-checked')
    ).toBe('false');
  });

  it('a routable base_url alone makes the local card saveable (no model control)', async function () {
    this.timeout(60_000);
    // Needs a successful discovery against a live server.
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await (await $("[data-testid='settings-llm-base-url']")).setValue(local.baseUrl);
    await (await $("[data-testid='settings-llm-api-key']")).setValue(local.apiKey);
    await (await $("[data-testid='settings-llm-refresh']")).click();

    await browser.waitUntil(
      async () => !(await $("[data-testid='settings-llm-discovering']").isExisting()),
      { timeout: 40_000, timeoutMsg: 'discovery never settled' }
    );
    expect(await $("[data-testid='settings-llm-discovery-error']").isExisting()).toBe(false);
    // Settings carries no model selector (ADR-087): the base_url + key form is
    // saveable as-is; the model auto-defaults at save via the discovery probe.
    await browser.waitUntil(async () => await $("[data-testid='settings-llm-save']").isEnabled(), {
      timeout: 15_000,
      timeoutMsg: 'Save never enabled for a routable local card',
    });
  });
});

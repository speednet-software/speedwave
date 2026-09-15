
import { openSettings, requireLocalLlm } from '../helpers/llm';
import { localLlmUnreachable } from '../helpers/preflight';

const OFFLINE_BASE_URL = 'http://127.0.0.1:9';

describe('Provider Error Paths', function () {
  beforeEach(async function () {
    this.timeout(30_000);
    await openSettings();
    await (await $("[data-testid='settings-llm-provider-local']")).click();
  });

  afterEach(async function () {
    this.timeout(30_000);
    await (await $("[data-testid='nav-chat']")).click();
  });

  it('surfaces a discovery error for a bad api key', async function () {
    this.timeout(60_000);
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await (await $("[data-testid='settings-llm-base-url']")).setValue(local.baseUrl);
    await (await $("[data-testid='settings-llm-api-key']")).setValue('sk-definitely-invalid-key');
    await (await $("[data-testid='settings-llm-refresh']")).click();

    await $("[data-testid='settings-llm-discovery-error']").waitForExist({ timeout: 30_000 });
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
    await browser.waitUntil(
      async () => !(await $("[data-testid='settings-llm-discovering']").isExisting()),
      { timeout: 40_000, timeoutMsg: 'save-triggered probe never settled' }
    );
    expect(await $("[data-testid='settings-llm-saved']").isExisting()).toBe(false);

    await (await $("[data-testid='nav-chat']")).click();
    await openSettings();
    expect(
      await $("[data-testid='settings-llm-provider-local']").getAttribute('aria-checked')
    ).toBe('false');
  });

  it('a routable base_url alone makes the local card saveable (no model control)', async function () {
    this.timeout(60_000);
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
    await browser.waitUntil(async () => await $("[data-testid='settings-llm-save']").isEnabled(), {
      timeout: 15_000,
      timeoutMsg: 'Save never enabled for a routable local card',
    });
  });
});

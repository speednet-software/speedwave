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
    await (await $('[data-testid="nav-chat"]')).click();
  });

  it('surfaces a discovery error for a bad api key', async function () {
    this.timeout(60_000);
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await (await $('[data-testid="settings-llm-base-url"]')).setValue(local.baseUrl);
    await (await $('[data-testid="settings-llm-api-key"]')).setValue('sk-definitely-invalid-key');
    await (await $('[data-testid="settings-llm-refresh"]')).click();

    await $('[data-testid="settings-llm-discovery-error"]').waitForExist({ timeout: 30_000 });
    expect(await $('[data-testid="settings-llm-save"]').isEnabled()).toBe(false);
  });

  it('surfaces a discovery error for an offline server', async function () {
    this.timeout(60_000);
    await (await $('[data-testid="settings-llm-base-url"]')).setValue(OFFLINE_BASE_URL);
    await (await $('[data-testid="settings-llm-refresh"]')).click();

    await $('[data-testid="settings-llm-discovery-error"]').waitForExist({ timeout: 40_000 });
    expect(await $('[data-testid="settings-llm-model"]').isExisting()).toBe(false);
  });

  it('enables Save once discovery auto-selects the model', async function () {
    this.timeout(60_000);
    if (localLlmUnreachable()) this.skip();
    const local = requireLocalLlm();
    await (await $('[data-testid="settings-llm-base-url"]')).setValue(local.baseUrl);
    await (await $('[data-testid="settings-llm-api-key"]')).setValue(local.apiKey);
    await (await $('[data-testid="settings-llm-refresh"]')).click();

    const modelSelect = await $('[data-testid="settings-llm-model"]');
    await modelSelect.waitForExist({ timeout: 30_000 });
    await browser.waitUntil(async () => await $('[data-testid="settings-llm-save"]').isEnabled(), {
      timeout: 15_000,
      timeoutMsg: 'Save never enabled after the model auto-selected',
    });
  });
});

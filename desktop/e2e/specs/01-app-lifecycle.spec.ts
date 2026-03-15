/**
 * App Lifecycle E2E tests.
 *
 * Verifies the Tauri app launched correctly, Angular is rendering,
 * and the setup wizard is shown on a fresh install.
 *
 * These tests run first — if they fail, the app did not start properly.
 */

describe('App Lifecycle', function () {
  it('should launch with the Speedwave window title', async function () {
    this.timeout(30_000);
    const title = await browser.getTitle();
    expect(title).toBe('Speedwave');
  });

  it('should render the Angular app root', async function () {
    this.timeout(30_000);
    const root = await $('app-root');
    expect(await root.isExisting()).toBe(true);
  });

  it('should start on the setup wizard route for fresh install', async function () {
    this.timeout(30_000);
    const wizard = await $('[data-testid="setup-wizard"]');
    await wizard.waitForExist({ timeout: 10_000 });
    expect(await wizard.isDisplayed()).toBe(true);
  });
});

/**
 * Stubs the OS folder picker that backs `app-create-project-modal` browse
 * action. The component honours `window.__E2E_DIALOG_PATH__` as a test seam:
 * `string` resolves the picker, `null` simulates user cancel.
 *
 * The OS-native dialog cannot be driven by WebDriver — it spawns outside the
 * webview process. Earlier attempts to intercept the plugin-dialog IPC
 * channel via `__TAURI_INTERNALS__.invoke` did not survive across navigations
 * in production builds, so the seam lives in the component itself.
 */

/**
 * Plants the test override on `window`. Subsequent `browse()` calls in the
 * create-project modal short-circuit to `path` instead of opening the real
 * picker. Idempotent — re-call to change the value mid-flow.
 *
 * @param path - Absolute path the picker should "return", or `null` for cancel.
 */
export async function mockDialogOpen(path: string | null): Promise<void> {
  await browser.execute((nextPath: string | null) => {
    (window as unknown as { __E2E_DIALOG_PATH__: string | null }).__E2E_DIALOG_PATH__ = nextPath;
  }, path);
}

/**
 * Removes the dialog override. Call from an `afterEach` / `after` hook to
 * keep tests isolated.
 */
export async function clearDialogMock(): Promise<void> {
  await browser.execute(() => {
    delete (window as unknown as { __E2E_DIALOG_PATH__?: string | null }).__E2E_DIALOG_PATH__;
  });
}

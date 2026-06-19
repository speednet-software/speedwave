/**
 * Stubs the `app-create-project-modal` folder picker via the
 * `window.__E2E_DIALOG_PATH__` test seam: `string` resolves, `null` cancels.
 */

/**
 * Plants the dialog override on `window`. Idempotent.
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

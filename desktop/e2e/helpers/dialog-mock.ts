/**
 * Stubs `@tauri-apps/plugin-dialog` `open()` calls in the running webview by
 * intercepting `__TAURI_INTERNALS__.invoke('plugin:dialog|open', …)`.
 *
 * The dialog plugin can not be driven by WebDriver — it spawns a native OS
 * picker outside the webview process. For tests that exercise a UI flow built
 * on top of the picker (folder selection, file upload), install a mock that
 * resolves to a known path before the click that opens it, then optionally
 * uninstall when the test is done.
 */

/**
 * Installs a stub for `plugin:dialog|open` on the current page that returns
 * `path` (or `null` to simulate user cancel). All other `invoke()` calls keep
 * their original behaviour. Idempotent — re-installing replaces the stored
 * return value.
 *
 * The stub lives on `window.__E2E_DIALOG_MOCK_PATH__`; tests that need to
 * change the value mid-flow can call this again with a new path.
 *
 * @param path - Absolute path the picker should "return", or `null` for cancel.
 */
export async function mockDialogOpen(path: string | null): Promise<void> {
  await browser.execute((nextPath: string | null) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      __E2E_DIALOG_MOCK_PATH__?: string | null;
      __E2E_DIALOG_ORIGINAL_INVOKE__?: (cmd: string, args?: unknown) => Promise<unknown>;
    };
    w.__E2E_DIALOG_MOCK_PATH__ = nextPath;
    if (!w.__E2E_DIALOG_ORIGINAL_INVOKE__) {
      const original = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
      w.__E2E_DIALOG_ORIGINAL_INVOKE__ = original;
      w.__TAURI_INTERNALS__.invoke = (cmd: string, args?: unknown) => {
        if (cmd === 'plugin:dialog|open') {
          return Promise.resolve(w.__E2E_DIALOG_MOCK_PATH__ ?? null);
        }
        return original(cmd, args);
      };
    }
  }, path);
}

/**
 * Removes the dialog mock installed by {@link mockDialogOpen}. Call from an
 * `afterEach` / `after` hook to keep tests isolated.
 */
export async function clearDialogMock(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      __E2E_DIALOG_MOCK_PATH__?: string | null;
      __E2E_DIALOG_ORIGINAL_INVOKE__?: (cmd: string, args?: unknown) => Promise<unknown>;
    };
    if (w.__E2E_DIALOG_ORIGINAL_INVOKE__) {
      w.__TAURI_INTERNALS__.invoke = w.__E2E_DIALOG_ORIGINAL_INVOKE__;
      delete w.__E2E_DIALOG_ORIGINAL_INVOKE__;
    }
    delete w.__E2E_DIALOG_MOCK_PATH__;
  });
}

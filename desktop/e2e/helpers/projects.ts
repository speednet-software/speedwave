/**
 * Helpers for project state introspection inside the running webview.
 *
 * Tests prefer asking the Tauri backend for ground truth (`list_projects`,
 * `is_setup_complete`) over scraping rendered text — the slug is stable, the
 * UX copy is not.
 */

/** Returns the slug of the active project from `__TAURI_INTERNALS__`. */
export async function activeProjectSlug(): Promise<string | null> {
  return browser.executeAsync((done: (slug: string | null) => void) => {
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string) => Promise<{ active_project: string | null }>;
        };
      }
    ).__TAURI_INTERNALS__
      .invoke('list_projects')
      .then((r) => done(r.active_project))
      .catch(() => done(null));
  });
}

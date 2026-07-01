/**
 * Helpers for project state introspection inside the running webview.
 */

import { waitForShellReady } from './shell';

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

/** Opens the project switcher and switches to `slug`, waiting for the SSOT signal. */
export async function switchToProject(slug: string, timeoutMs = 180_000): Promise<void> {
  await waitForShellReady();
  const pill = await $('[data-testid="project-pill"]');
  const dropdown = await $('[data-testid="project-switcher-dropdown"]');
  await browser.waitUntil(
    async () => {
      if (await dropdown.isExisting()) return true;
      await pill.click();
      return await dropdown.isExisting();
    },
    { timeout: 30_000, interval: 500, timeoutMsg: 'project-switcher-dropdown never opened' }
  );
  await (await $(`[data-testid="project-switcher-item-${slug}"]`)).click();
  await browser.waitUntil(async () => (await activeProjectSlug()) === slug, {
    timeout: timeoutMs,
    timeoutMsg: `active_project did not become ${slug} — switch did not complete`,
  });
}

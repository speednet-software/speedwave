/**
 * Helpers for project state introspection inside the running webview.
 */

import { waitForShellReady } from './shell';
import { invokeOr } from './tauri-invoke';

/** Returns the slug of the active project from `__TAURI_INTERNALS__`. */
export async function activeProjectSlug(): Promise<string | null> {
  const projects = await invokeOr<{ active_project: string | null } | null>(null, 'list_projects');
  return projects?.active_project ?? null;
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
  await waitForShellReady(timeoutMs);
}

/** Reads whether a project's containers are running, via the Tauri command. */
export async function containersRunning(project: string): Promise<boolean> {
  return invokeOr<boolean>(false, 'check_containers_running', { project });
}

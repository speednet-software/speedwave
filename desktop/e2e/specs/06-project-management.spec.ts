/**
 * Project Management E2E tests.
 *
 * Verifies adding a second project via the project switcher and
 * switching between projects. Also verifies container health after
 * each operation (covering both add_project and switch_project
 * backend code paths). Runs after setup and navigation specs
 * have completed — the app is on the shell with 'e2e-test' active.
 *
 * The second project directory must exist before the test runs.
 * The e2e runner (Makefile / e2e-vm.sh) creates it. All assertions
 * use `data-testid` attributes — never UX-volatile text content.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { waitForHealthy } from '../helpers/health';
import { mockDialogOpen, clearDialogMock } from '../helpers/dialog-mock';
import { activeProjectSlug, containersRunning, switchToProject } from '../helpers/projects';
import { waitForShellReady } from '../helpers/shell';
import { invokeCommand } from '../helpers/tauri-invoke';

const SECOND_PROJECT_NAME = 'e2e-second';
const SECOND_PROJECT_DIR = process.env.E2E_SECOND_PROJECT_DIR || '/tmp/speedwave-e2e-project-2';
const THIRD_PROJECT_NAME = 'e2e-third';
const THIRD_PROJECT_DIR = path.join(os.tmpdir(), 'speedwave-e2e-project-3');

describe('Project Management', function () {
  before(async function () {
    this.timeout(30_000);

    const pill = await $('[data-testid="project-pill"]');
    await pill.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Project pill not found — earlier specs must complete successfully',
    });
  });

  describe('Add Project', function () {
    it('should open the project switcher dropdown', async function () {
      this.timeout(60_000);

      await waitForShellReady();

      const pill = await $('[data-testid="project-pill"]');
      await pill.click();

      const dropdown = await $('[data-testid="project-switcher-dropdown"]');
      await dropdown.waitForExist({ timeout: 5_000 });
      expect(await dropdown.isDisplayed()).toBe(true);
    });

    it('should show the existing e2e-test project in the list', async function () {
      this.timeout(15_000);

      const item = await $('[data-testid="project-switcher-item-e2e-test"]');
      expect(await item.isExisting()).toBe(true);
    });

    it('should open the create-project modal when clicking + Add Project', async function () {
      this.timeout(15_000);

      const addBtn = await $('[data-testid="add-project-btn"]');
      expect(await addBtn.isDisplayed()).toBe(true);
      await addBtn.click();

      const modal = await $('[data-testid="create-project-modal"]');
      await modal.waitForExist({ timeout: 5_000 });
      expect(await modal.isDisplayed()).toBe(true);
    });

    it('should fill the create-project modal and add the project', async function () {
      this.timeout(180_000);

      await mockDialogOpen(SECOND_PROJECT_DIR);

      const modal = await $('[data-testid="create-project-modal"]');
      await modal.waitForExist({ timeout: 5_000 });

      const browseBtn = await modal.$('[data-testid="create-project-browse"]');
      await browseBtn.click();

      const dirInput = await modal.$('[data-testid="create-project-dir"]');
      await browser.waitUntil(async () => (await dirInput.getValue()) === SECOND_PROJECT_DIR, {
        timeout: 10_000,
        timeoutMsg: 'Project directory was not populated by the dialog stub',
      });

      const nameInput = await modal.$('[data-testid="create-project-name"]');
      await nameInput.setValue(SECOND_PROJECT_NAME);

      const submitBtn = await modal.$('[data-testid="create-project-submit"]');
      await browser.waitUntil(async () => await submitBtn.isEnabled(), {
        timeout: 5_000,
        timeoutMsg: 'Create-project submit did not become enabled',
      });
      await submitBtn.click();

      await browser.waitUntil(
        async () => {
          const errorBanner = await modal.$('[data-testid="create-project-error"]');
          if (await errorBanner.isExisting()) {
            const errorText = await errorBanner.getText();
            throw new Error(`Add project failed with error: ${errorText}`);
          }
          return (await activeProjectSlug()) === SECOND_PROJECT_NAME;
        },
        {
          timeout: 150_000,
          timeoutMsg: `active_project did not become '${SECOND_PROJECT_NAME}' — add_project did not complete`,
        }
      );

      await clearDialogMock();
    });

    it('should list both projects in the dropdown', async function () {
      this.timeout(60_000);

      await waitForShellReady();

      const pill = await $('[data-testid="project-pill"]');
      await pill.click();

      const dropdown = await $('[data-testid="project-switcher-dropdown"]');
      await dropdown.waitForExist({ timeout: 5_000 });

      await browser.waitUntil(
        async () => {
          const a = await $('[data-testid="project-switcher-item-e2e-test"]').isExisting();
          const b = await $(
            `[data-testid="project-switcher-item-${SECOND_PROJECT_NAME}"]`
          ).isExisting();
          return a && b;
        },
        {
          timeout: 30_000,
          timeoutMsg: 'Switcher list did not stabilise with both e2e-test and e2e-second',
        }
      );

      await pill.click();
    });

    it('leaves the new no-provider project without running containers', async function () {
      this.timeout(30_000);
      expect(await activeProjectSlug()).toBe(SECOND_PROJECT_NAME);
      expect(await containersRunning(SECOND_PROJECT_NAME)).toBe(false);
    });
  });

  describe('Switch Project', function () {
    it('should switch back to e2e-test project', async function () {
      this.timeout(180_000);

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

      const firstProject = await $('[data-testid="project-switcher-item-e2e-test"]');
      await firstProject.click();

      await browser.waitUntil(async () => (await activeProjectSlug()) === 'e2e-test', {
        timeout: 150_000,
        timeoutMsg: 'active_project did not become e2e-test — switch_project did not complete',
      });
    });

    it('should reflect the switched project in settings', async function () {
      this.timeout(30_000);

      const nav = await $('[data-testid="nav-settings"]');
      await nav.click();

      const title = await $('[data-testid="settings-title"]');
      await title.waitForExist({ timeout: 10_000 });

      await browser.waitUntil(async () => (await activeProjectSlug()) === 'e2e-test', {
        timeout: 10_000,
        timeoutMsg: 'list_projects active_project did not stabilise on e2e-test',
      });
    });

    it('should report healthy containers after switching back', async function () {
      this.timeout(150_000);
      await waitForHealthy('e2e-test');
    });
  });

  describe('Command Palette Switch', function () {
    it('lists only non-active projects and switches via the palette', async function () {
      this.timeout(240_000);
      await waitForShellReady();
      await (await $('[data-testid="nav-rail-palette"]')).click();
      await $('[data-testid="command-palette"]').waitForExist({ timeout: 10_000 });

      const secondItem = await $(`[data-testid="palette-item-project-${SECOND_PROJECT_NAME}"]`);
      await secondItem.waitForExist({ timeout: 10_000 });
      expect(await $('[data-testid="palette-item-project-e2e-test"]').isExisting()).toBe(false);

      await secondItem.click();
      await browser.waitUntil(async () => (await activeProjectSlug()) === SECOND_PROJECT_NAME, {
        timeout: 150_000,
        timeoutMsg: 'palette project item did not switch the active project',
      });
      await waitForShellReady(180_000);
    });

    it('switches back to e2e-test for the remaining specs', async function () {
      this.timeout(240_000);
      await switchToProject('e2e-test');
      await waitForHealthy('e2e-test');
    });
  });

  describe('Remove Project', function () {
    it('guards the active project: no remove button, backend rejects direct removal', async function () {
      this.timeout(60_000);
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

      expect(await $('[data-testid="project-switcher-remove-e2e-test"]').isExisting()).toBe(false);
      expect(
        await $(`[data-testid="project-switcher-remove-${SECOND_PROJECT_NAME}"]`).isExisting()
      ).toBe(true);

      const removal = await invokeCommand<void>('remove_project', { name: 'e2e-test' });
      expect(removal.ok).toBe(false);

      expect(await activeProjectSlug()).toBe('e2e-test');
      await pill.click();
    });

    it('removes a disposable project and its switcher entry', async function () {
      this.timeout(240_000);
      fs.mkdirSync(THIRD_PROJECT_DIR, { recursive: true });
      await mockDialogOpen(THIRD_PROJECT_DIR);

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
      await (await $('[data-testid="add-project-btn"]')).click();
      const modal = await $('[data-testid="create-project-modal"]');
      await modal.waitForExist({ timeout: 5_000 });
      await (await modal.$('[data-testid="create-project-browse"]')).click();
      const dirInput = await modal.$('[data-testid="create-project-dir"]');
      await browser.waitUntil(async () => (await dirInput.getValue()) === THIRD_PROJECT_DIR, {
        timeout: 10_000,
        timeoutMsg: 'third project directory was not populated by the dialog stub',
      });
      await (await modal.$('[data-testid="create-project-name"]')).setValue(THIRD_PROJECT_NAME);
      await (await modal.$('[data-testid="create-project-submit"]')).click();
      await browser.waitUntil(async () => (await activeProjectSlug()) === THIRD_PROJECT_NAME, {
        timeout: 150_000,
        timeoutMsg: 'add_project for the disposable project did not complete',
      });
      await clearDialogMock();

      await switchToProject('e2e-test');

      const dropdown2 = await $('[data-testid="project-switcher-dropdown"]');
      await browser.waitUntil(
        async () => {
          if (await dropdown2.isExisting()) return true;
          await pill.click();
          return await dropdown2.isExisting();
        },
        { timeout: 30_000, interval: 500, timeoutMsg: 'project-switcher-dropdown never reopened' }
      );
      await (await $(`[data-testid="project-switcher-item-${THIRD_PROJECT_NAME}"]`)).moveTo();
      await (await $(`[data-testid="project-switcher-remove-${THIRD_PROJECT_NAME}"]`)).click();
      const confirmYes = await $(
        `[data-testid="project-switcher-confirm-yes-${THIRD_PROJECT_NAME}"]`
      );
      await confirmYes.waitForExist({ timeout: 10_000 });
      await confirmYes.click();

      await $(`[data-testid="project-switcher-item-${THIRD_PROJECT_NAME}"]`).waitForExist({
        timeout: 30_000,
        reverse: true,
        timeoutMsg: 'removed project still listed in the switcher',
      });
      const stillListed = await browser.executeAsync((name: string, done: (r: boolean) => void) => {
        (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (cmd: string) => Promise<{ projects: Array<{ name: string }> }>;
            };
          }
        ).__TAURI_INTERNALS__
          .invoke('list_projects')
          .then((r) => done(r.projects.some((p) => p.name === name)))
          .catch(() => done(true));
      }, THIRD_PROJECT_NAME);
      expect(stillListed).toBe(false);
      expect(await activeProjectSlug()).toBe('e2e-test');
      await pill.click();
      await waitForHealthy('e2e-test');
    });
  });
});

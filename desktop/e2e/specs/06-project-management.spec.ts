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

import { waitForHealthy } from '../helpers/health';
import { mockDialogOpen, clearDialogMock } from '../helpers/dialog-mock';
import { activeProjectSlug } from '../helpers/projects';
import { waitForShellReady } from '../helpers/shell';

const SECOND_PROJECT_NAME = 'e2e-second';
const SECOND_PROJECT_DIR = process.env.E2E_SECOND_PROJECT_DIR || '/tmp/speedwave-e2e-project-2';

describe('Project Management', function () {
  before(async function () {
    this.timeout(30_000);

    // The shell is identified by the project pill in the chat header.
    const pill = await $('[data-testid="project-pill"]');
    await pill.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Project pill not found — earlier specs must complete successfully',
    });
  });

  describe('Add Project', function () {
    it('should open the project switcher dropdown', async function () {
      this.timeout(60_000);

      // Setup wizard finalize → settings redirect can leave the shell briefly
      // in `auth_required` (blocking-overlay up) before settling to ready.
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

      // Stub the OS folder picker before clicking browse — the native dialog
      // cannot be driven by WebDriver.
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

      // Adding a project triggers the full switch lifecycle:
      //   project_switch_started → containers up → project_switch_succeeded
      // After project_switch_succeeded, list_projects returns the new active
      // project. Use the Tauri command as the SSOT — DOM updates lag behind
      // and the modal-error testid is the only DOM signal we trust.
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
        },
      );

      await clearDialogMock();
    });

    it('should list both projects in the dropdown', async function () {
      this.timeout(60_000);

      // After `add_project`, projectState transitions through
      // starting → ready (or auth_required), with the blocking-overlay up.
      // Wait for it to clear before clicking the pill.
      await waitForShellReady();

      const pill = await $('[data-testid="project-pill"]');
      await pill.click();

      const dropdown = await $('[data-testid="project-switcher-dropdown"]');
      await dropdown.waitForExist({ timeout: 5_000 });

      // The switcher refreshes its list on `onProjectSettled` — that callback
      // is async, so the dropdown can appear with the stale list before the
      // refresh fires. Poll until both items render rather than reading once.
      await browser.waitUntil(
        async () => {
          const a = await $('[data-testid="project-switcher-item-e2e-test"]').isExisting();
          const b = await $(
            `[data-testid="project-switcher-item-${SECOND_PROJECT_NAME}"]`,
          ).isExisting();
          return a && b;
        },
        {
          timeout: 30_000,
          timeoutMsg: 'Switcher list did not stabilise with both e2e-test and e2e-second',
        },
      );

      // Close dropdown
      await pill.click();
    });

    it('should report healthy containers for the new project', async function () {
      this.timeout(150_000);
      await waitForHealthy(SECOND_PROJECT_NAME);
    });
  });

  describe('Switch Project', function () {
    it('should switch back to e2e-test project', async function () {
      this.timeout(180_000);

      // Wait for the previous switch's blocking-overlay to clear before
      // attempting another pill click — the overlay covers the header.
      await waitForShellReady();

      // The previous test may have closed the switcher mid-animation; click
      // until the dropdown actually appears (defensive against pill toggling).
      const pill = await $('[data-testid="project-pill"]');
      const dropdown = await $('[data-testid="project-switcher-dropdown"]');
      await browser.waitUntil(
        async () => {
          if (await dropdown.isExisting()) return true;
          await pill.click();
          return await dropdown.isExisting();
        },
        { timeout: 30_000, interval: 500, timeoutMsg: 'project-switcher-dropdown never opened' },
      );

      const firstProject = await $('[data-testid="project-switcher-item-e2e-test"]');
      await firstProject.click();

      // Wait for switch_project to complete — list_projects active_project is
      // the definitive signal (updates after project_switch_succeeded).
      await browser.waitUntil(async () => (await activeProjectSlug()) === 'e2e-test', {
        timeout: 150_000,
        timeoutMsg: 'active_project did not become e2e-test — switch_project did not complete',
      });
    });

    it('should reflect the switched project in settings', async function () {
      this.timeout(30_000);

      const nav = await $('[data-testid="nav-settings"]');
      await nav.click();

      const activeProject = await $('[data-testid="settings-active-project"]');
      await activeProject.waitForExist({ timeout: 10_000 });

      // Defer to Tauri SSOT instead of comparing rendered text — the settings
      // copy embeds the slug in human-readable text that may change.
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
});

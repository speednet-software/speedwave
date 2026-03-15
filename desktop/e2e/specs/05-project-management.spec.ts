/**
 * Project Management E2E tests.
 *
 * Verifies adding a second project via the project switcher and
 * switching between projects. Runs after setup and navigation specs
 * have completed — the app is on the shell with 'e2e-test' active.
 *
 * The second project directory must exist before the test runs.
 * The e2e runner (Makefile / e2e-vm.sh) creates it.
 */

const SECOND_PROJECT_NAME = 'e2e-second';
const SECOND_PROJECT_DIR = process.env.E2E_SECOND_PROJECT_DIR || '/tmp/speedwave-e2e-project-2';

describe('Project Management', function () {
  before(async function () {
    this.timeout(30_000);

    // Ensure we are on the shell (setup completed in earlier specs)
    const switcher = await $('[data-testid="project-switcher-btn"]');
    await switcher.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Project switcher not found — earlier specs must complete successfully',
    });
  });

  describe('Add Project', function () {
    it('should open the project switcher dropdown', async function () {
      this.timeout(15_000);

      const btn = await $('[data-testid="project-switcher-btn"]');
      await btn.click();

      const dropdown = await $('[data-testid="project-switcher-dropdown"]');
      await dropdown.waitForExist({ timeout: 5_000 });
      expect(await dropdown.isDisplayed()).toBe(true);
    });

    it('should show the existing e2e-test project in the list', async function () {
      this.timeout(15_000);

      const item = await $('[data-testid="project-switcher-item-e2e-test"]');
      expect(await item.isExisting()).toBe(true);
      expect(await item.getText()).toContain('e2e-test');
    });

    it('should show add project form when clicking + Add Project', async function () {
      this.timeout(15_000);

      const addBtn = await $('[data-testid="add-project-btn"]');
      expect(await addBtn.isDisplayed()).toBe(true);
      await addBtn.click();

      const form = await $('[data-testid="add-project-form"]');
      await form.waitForExist({ timeout: 5_000 });
      expect(await form.isDisplayed()).toBe(true);
    });

    it('should fill the add project form and create the project', async function () {
      this.timeout(180_000);

      const nameInput = await $('[data-testid="add-project-name"]');
      await nameInput.setValue(SECOND_PROJECT_NAME);
      expect(await nameInput.getValue()).toBe(SECOND_PROJECT_NAME);

      const dirInput = await $('[data-testid="add-project-dir"]');
      await dirInput.setValue(SECOND_PROJECT_DIR);
      expect(await dirInput.getValue()).toBe(SECOND_PROJECT_DIR);

      const createBtn = await $('[data-testid="add-project-create"]');
      await createBtn.click();

      // Adding a project triggers the full switch lifecycle:
      //   project_switch_started → containers up → project_switch_succeeded
      // The switcher button updates to the new project name only after
      // project_switch_succeeded fires. Wait for that — it is the definitive
      // signal that the entire add+switch cycle completed successfully.
      // Checking overlay disappearance is unreliable (may not have appeared yet).
      const btn = await $('[data-testid="project-switcher-btn"]');
      await browser.waitUntil(
        async () => {
          // Fail fast if an error banner appeared
          const errorBanner = await $('[data-testid="project-switch-error"]');
          if (await errorBanner.isExisting()) {
            const errorText = await errorBanner.getText();
            throw new Error(`Add project failed with error: ${errorText}`);
          }
          return (await btn.getText()).includes(SECOND_PROJECT_NAME);
        },
        { timeout: 150_000, timeoutMsg: `Switcher did not update to '${SECOND_PROJECT_NAME}' — add_project did not complete` },
      );
    });

    it('should list both projects in the dropdown', async function () {
      this.timeout(15_000);

      const btn = await $('[data-testid="project-switcher-btn"]');
      await btn.click();

      const dropdown = await $('[data-testid="project-switcher-dropdown"]');
      await dropdown.waitForExist({ timeout: 5_000 });

      const firstProject = await $('[data-testid="project-switcher-item-e2e-test"]');
      expect(await firstProject.isExisting()).toBe(true);

      const secondProject = await $(`[data-testid="project-switcher-item-${SECOND_PROJECT_NAME}"]`);
      expect(await secondProject.isExisting()).toBe(true);

      // Close dropdown
      await btn.click();
    });
  });

  describe('Switch Project', function () {
    it('should switch back to e2e-test project', async function () {
      this.timeout(180_000);

      // Open dropdown
      const btn = await $('[data-testid="project-switcher-btn"]');
      await btn.click();

      const dropdown = await $('[data-testid="project-switcher-dropdown"]');
      await dropdown.waitForExist({ timeout: 5_000 });

      // Click the original project
      const firstProject = await $('[data-testid="project-switcher-item-e2e-test"]');
      await firstProject.click();

      // Wait for switch_project to complete — the switcher button text is the
      // definitive signal (updates after project_switch_succeeded).
      await browser.waitUntil(
        async () => {
          const errorBanner = await $('[data-testid="project-switch-error"]');
          if (await errorBanner.isExisting()) {
            const errorText = await errorBanner.getText();
            throw new Error(`Switch project failed with error: ${errorText}`);
          }
          return (await btn.getText()).includes('e2e-test');
        },
        { timeout: 150_000, timeoutMsg: 'Switcher did not update to e2e-test — switch_project did not complete' },
      );
    });

    it('should reflect the switched project in settings', async function () {
      this.timeout(30_000);

      // Navigate to settings to verify the active project
      const nav = await $('[data-testid="nav-settings"]');
      await nav.click();

      const activeProject = await $('[data-testid="settings-active-project"]');
      await activeProject.waitForExist({ timeout: 10_000 });

      await browser.waitUntil(
        async () => (await activeProject.getText()).includes('e2e-test'),
        { timeout: 10_000, timeoutMsg: 'Settings page does not show e2e-test as active project' },
      );
    });
  });
});

import { mockDialogOpen, clearDialogMock } from '../helpers/dialog-mock';
import {
  openSettings,
  openChat,
  configureOpenRouter,
  requireOpenrouterKey,
  useCheapOpenRouterModel,
} from '../helpers/llm';
import { waitForShellReady, RESTART_WAIT_MS } from '../helpers/shell';
import { invokeOr } from '../helpers/tauri-invoke';

const E2E_PROJECT_NAME = 'e2e-test';
const E2E_PROJECT_DIR = process.env.E2E_PROJECT_DIR || '/tmp/speedwave-e2e-project';

async function isSetupComplete(): Promise<boolean> {
  return invokeOr<boolean>(false, 'is_setup_complete');
}

async function waitForStepTerminal(index: number, timeout: number): Promise<string> {
  let status = '';
  try {
    await browser.waitUntil(
      async () => {
        const success = await $('[data-testid="setup-success"]');
        if (await success.isExisting()) {
          status = 'done';
          return true;
        }
        const steps = await $$('[data-testid="setup-step"]');
        if (index >= (await steps.length)) return false;
        const stepStatus = await steps[index].getAttribute('data-status');
        if (stepStatus === 'done' || stepStatus === 'error') {
          status = stepStatus;
          return true;
        }
        return false;
      },
      { timeout, timeoutMsg: `Step ${index} did not reach terminal state within ${timeout}ms` }
    );
  } catch (e) {
    const complete = await isSetupComplete();
    if (complete) {
      status = 'done';
    } else {
      throw e;
    }
  }
  return status;
}

async function assertStepDone(index: number, timeout: number): Promise<void> {
  const status = await waitForStepTerminal(index, timeout);
  if (status === 'error') {
    const errorBanner = await $('[data-testid="setup-error"]');
    const errorText = (await errorBanner.isExisting())
      ? await errorBanner.getText()
      : 'unknown error';
    throw new Error(`Step ${index} failed: ${errorText}`);
  }
  expect(status).toBe('done');
}

describe('Setup Wizard — Full Flow', function () {
  it('should display the welcome screen', async function () {
    this.timeout(30_000);

    const wizard = await $('[data-testid="setup-wizard"]');
    await wizard.waitForExist({ timeout: 10_000 });

    await wizard.$('[data-testid="setup-headline"]').waitForExist({ timeout: 5_000 });
    await wizard.$('[data-testid="setup-subtitle"]').waitForExist({ timeout: 5_000 });
    await wizard.$('[data-testid="setup-description"]').waitForExist({ timeout: 5_000 });

    const btn = await $('[data-testid="setup-start-btn"]');
    expect(await btn.isDisplayed()).toBe(true);
  });

  it('should show all 6 progress steps after clicking Start Setup', async function () {
    this.timeout(60_000);

    const btn = await $('[data-testid="setup-start-btn"]');
    await btn.click();

    await browser.waitUntil(async () => (await $$('[data-testid="setup-step"]').length) === 6, {
      timeout: 30_000,
      timeoutMsg: 'Expected 6 setup steps but not all rendered',
    });
    const stepElements = await $$('[data-testid="setup-step"]');
    expect(await stepElements.length).toBe(6);

    const firstStatus = await stepElements[0].getAttribute('data-status');
    expect(['active', 'done']).toContain(firstStatus);

    const firstTitle = await stepElements[0].$('[data-testid="step-title"]');
    await firstTitle.waitForExist({ timeout: 5_000 });
  });

  it('should complete check environment (step 0)', async function () {
    this.timeout(60_000);
    await assertStepDone(0, 30_000);
  });

  it('should complete start virtual machine (step 1)', async function () {
    this.timeout(300_000);
    await assertStepDone(1, 240_000);
  });

  it('should complete build images (step 2)', async function () {
    this.timeout(1_200_000);
    await assertStepDone(2, 1_100_000);
  });

  it('should pause at create your first project (step 3) and show the modal', async function () {
    this.timeout(30_000);

    const modal = await $('[data-testid="create-project-modal"]');
    await modal.waitForExist({ timeout: 10_000 });

    const browseBtn = await modal.$('[data-testid="create-project-browse"]');
    expect(await browseBtn.isExisting()).toBe(true);

    const submitBtn = await modal.$('[data-testid="create-project-submit"]');
    expect(await submitBtn.isExisting()).toBe(true);
    expect(await submitBtn.isEnabled()).toBe(false);

    const steps = await $$('[data-testid="setup-step"]');
    expect(await steps[3].getAttribute('data-status')).toBe('active');
  });

  it('should fill the project form via the picker stub and create the project', async function () {
    this.timeout(60_000);

    await mockDialogOpen(E2E_PROJECT_DIR);

    const modal = await $('[data-testid="create-project-modal"]');
    await modal.waitForExist({ timeout: 10_000 });

    const browseBtn = await modal.$('[data-testid="create-project-browse"]');
    await browseBtn.click();

    const dirInput = await modal.$('[data-testid="create-project-dir"]');
    await browser.waitUntil(async () => (await dirInput.getValue()) === E2E_PROJECT_DIR, {
      timeout: 10_000,
      timeoutMsg: 'Project directory was not populated by the dialog stub',
    });

    const nameInput = await modal.$('[data-testid="create-project-name"]');
    await nameInput.setValue(E2E_PROJECT_NAME);
    expect(await nameInput.getValue()).toBe(E2E_PROJECT_NAME);

    const submitBtn = await modal.$('[data-testid="create-project-submit"]');
    await browser.waitUntil(async () => await submitBtn.isEnabled(), {
      timeout: 5_000,
      timeoutMsg: 'Create-project submit did not become enabled',
    });
    await submitBtn.click();

    await assertStepDone(3, 30_000);
    await clearDialogMock();
  });

  it('should complete start containers (step 4)', async function () {
    this.timeout(360_000);
    await assertStepDone(4, 300_000);
  });

  it('should complete finalize (step 5)', async function () {
    this.timeout(120_000);
    await assertStepDone(5, 60_000);
  });

  it('should complete setup and redirect to settings', async function () {
    this.timeout(60_000);

    const complete = await isSetupComplete();
    expect(complete).toBe(true);

    await browser.execute(() => (window.location.href = '/settings'));

    const projectPill = await $('[data-testid="project-pill"]');
    await projectPill.waitForExist({ timeout: 15_000 });
  });

  it('should configure an OpenRouter provider so containers can start', async function () {
    this.timeout(RESTART_WAIT_MS + 180_000);
    await openSettings();
    await configureOpenRouter(requireOpenrouterKey());
    await waitForShellReady(150_000);
    await openChat();
    await useCheapOpenRouterModel();
  });
});

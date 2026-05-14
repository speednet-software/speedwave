/**
 * Host Exec E2E tests.
 *
 * Drives the **Host Exec** Integrations card end-to-end through the running
 * Tauri app: the gated toggle / danger modal, the recipe editor (add / edit /
 * delete / save), the off-whitelist rejection (client-side + backend
 * `host_exec_save_settings` validation), and the persistence boundary
 * (`host_exec_load_settings` round-trips through the on-disk user config
 * with camelCase fields). Together these cover the SPW-83 / ADR-054 plan
 * scenarios:
 *
 *   - **(b)** off-whitelist recipe rejected as a tool error / save error
 *     → covered here at the *configuration* boundary: invalid recipes never
 *     reach the worker because save is rejected before they're persisted.
 *   - **(e)** enabling the toggle without confirming the danger modal does
 *     NOT enable host_exec → covered as a UI-flow assertion.
 *
 * The other plan scenarios — **(a)** Claude calls a recipe and gets a
 * structured result, **(d)** exit≠0 is a successful ToolResult, **(f)** two
 * projects' workers do not cross-talk — require a live Anthropic API turn
 * through the MCP hub and the real per-project `host_exec` worker process.
 * Those live outside this E2E suite (no Anthropic key in CI) and ship as a
 * runnable manual-smoke recipe in `docs/contributing/testing.md`. The
 * non-Claude invariants they assert (worker spawn, process-tree kill, child
 * env allowlist, two-projects two-ports) ARE covered by the unit/integration
 * tests in `crates/speedwave-runtime/src/host_exec_process.rs::tests`,
 * `crates/speedwave-runtime/src/host_exec.rs::tests`,
 * `crates/speedwave-runtime/src/compose.rs` (the per-project compose
 * scenarios) and the `mcp-servers/host_exec/` worker suite. There is **no
 * per-call confirmation** (enabling host_exec is the consent — ADR-054).
 *
 * Runs after the project-management spec — the active project is
 * `e2e-test`, the shell is mounted.
 */

import { waitForShellReady } from '../helpers/shell';
import { activeProjectSlug } from '../helpers/projects';

interface HostExecRecipe {
  name: string;
  exec: string;
  args: string[];
  cwdSub?: string;
  params?: { name: string; pattern: string; maxLen?: number }[];
  env?: Record<string, string>;
}

interface HostExecStatus {
  enabled: boolean;
  commands: HostExecRecipe[];
}

/** Reads the `host_exec` status the backend returns for a project. */
async function getHostExec(project: string): Promise<HostExecStatus> {
  return browser.executeAsync(
    (proj: string, done: (status: HostExecStatus) => void) => {
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: Record<string, unknown>) => Promise<HostExecStatus>;
          };
        }
      ).__TAURI_INTERNALS__
        .invoke('get_host_exec', { project: proj })
        .then((r) => done(r))
        .catch(() => done({ enabled: false, commands: [] }));
    },
    project,
  );
}

/** Calls `host_exec_save_settings` with a candidate recipe list and returns
 * `null` on success or the readable error string on validation failure. */
async function saveHostExecSettings(
  project: string,
  commands: HostExecRecipe[],
): Promise<string | null> {
  return browser.executeAsync(
    (
      proj: string,
      cmds: HostExecRecipe[],
      done: (err: string | null) => void,
    ) => {
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: Record<string, unknown>) => Promise<void>;
          };
        }
      ).__TAURI_INTERNALS__
        .invoke('host_exec_save_settings', { project: proj, commands: cmds })
        .then(() => done(null))
        .catch((e: unknown) => done(e instanceof Error ? e.message : String(e)));
    },
    project,
    commands,
  );
}

/** Calls `host_exec_load_settings` and returns the persisted recipe list. */
async function loadHostExecSettings(project: string): Promise<HostExecRecipe[]> {
  return browser.executeAsync(
    (proj: string, done: (cmds: HostExecRecipe[]) => void) => {
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: Record<string, unknown>) => Promise<HostExecRecipe[]>;
          };
        }
      ).__TAURI_INTERNALS__
        .invoke('host_exec_load_settings', { project: proj })
        .then((r) => done(r))
        .catch(() => done([]));
    },
    project,
  );
}

/** Calls `set_host_exec_enabled` from the test (skipping the UI gate). Used
 * to clean up after a test that flipped the toggle. */
async function setHostExecEnabled(project: string, enabled: boolean): Promise<void> {
  await browser.executeAsync(
    (proj: string, en: boolean, done: () => void) => {
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: Record<string, unknown>) => Promise<void>;
          };
        }
      ).__TAURI_INTERNALS__
        .invoke('set_host_exec_enabled', { project: proj, enabled: en })
        .then(() => done())
        .catch(() => done());
    },
    project,
    enabled,
  );
}

const PROJECT = 'e2e-test';

describe('Host Exec', function () {
  before(async function () {
    this.timeout(65_000);

    // Wait for the shell to be ready and on the e2e-test project.
    await waitForShellReady();
    expect(await activeProjectSlug()).toBe(PROJECT);

    // Navigate to Integrations so the host-exec card is mounted in the DOM.
    const nav = await $('[data-testid="nav-integrations"]');
    await nav.waitForExist({
      timeout: 15_000,
      timeoutMsg: 'Integrations nav link missing — earlier specs must have completed',
    });
    await nav.click();

    const card = await $('[data-testid="host-exec-config"]');
    await card.waitForExist({
      timeout: 15_000,
      timeoutMsg:
        'host-exec card not found on /integrations — the IntegrationsComponent must render <app-host-exec-config>',
    });
  });

  // Best-effort cleanup so the rest of the suite (including 07-factory-reset)
  // doesn't see leftover Host Exec state from these tests. Idempotent.
  after(async function () {
    this.timeout(30_000);
    await setHostExecEnabled(PROJECT, false);
    await saveHostExecSettings(PROJECT, []);
  });

  // ----------------------------------------------------------------------
  // (e) — enabling the toggle without confirming the danger modal must NOT
  // enable host_exec.
  // ----------------------------------------------------------------------

  describe('Danger modal gates the toggle (plan scenario e)', function () {
    it('host_exec is disabled by default for a fresh project', async function () {
      this.timeout(15_000);
      const status = await getHostExec(PROJECT);
      expect(status.enabled).toBe(false);
    });

    it('clicking the toggle while disabled opens the danger modal but does NOT enable', async function () {
      this.timeout(15_000);
      const toggle = await $('[data-testid="host-exec-toggle"]');
      await toggle.waitForClickable({ timeout: 5_000 });
      await toggle.click();

      const modal = await $('[data-testid="host-exec-enable-danger"]');
      await modal.waitForExist({
        timeout: 5_000,
        timeoutMsg: 'Enable-danger modal did not appear',
      });
      expect(await modal.isDisplayed()).toBe(true);

      // The backend must NOT have been called yet.
      const status = await getHostExec(PROJECT);
      expect(status.enabled).toBe(false);
    });

    it('cancelling the danger modal leaves host_exec disabled', async function () {
      this.timeout(15_000);
      const cancel = await $('[data-testid="host-exec-enable-danger"]')
        .$('[data-testid="modal-secondary"]');
      await cancel.waitForClickable({ timeout: 5_000 });
      await cancel.click();

      // Modal should disappear; backend still disabled.
      await browser.waitUntil(
        async () => !(await $('[data-testid="host-exec-enable-danger"]').isDisplayed()),
        { timeout: 5_000, timeoutMsg: 'Enable-danger modal did not disappear after cancel' },
      );
      const status = await getHostExec(PROJECT);
      expect(status.enabled).toBe(false);
    });

    it('confirming the danger modal enables host_exec', async function () {
      this.timeout(60_000);
      const toggle = await $('[data-testid="host-exec-toggle"]');
      await toggle.waitForClickable({ timeout: 5_000 });
      await toggle.click();

      const modal = await $('[data-testid="host-exec-enable-danger"]');
      await modal.waitForExist({ timeout: 5_000 });

      const confirm = await modal.$('[data-testid="modal-primary"]');
      await confirm.waitForClickable({ timeout: 5_000 });
      await confirm.click();

      // Wait for the backend to flip — `set_host_exec_enabled` is async and
      // recreates the project's containers, which can take a few seconds.
      await browser.waitUntil(
        async () => (await getHostExec(PROJECT)).enabled,
        { timeout: 45_000, timeoutMsg: 'host_exec did not turn on after confirming the danger modal' },
      );

      // Recipe editor surface should now be visible.
      const recipes = await $('[data-testid="host-exec-recipes"]');
      await recipes.waitForExist({ timeout: 5_000 });
    });

    it('disabling later does NOT pop the danger modal', async function () {
      this.timeout(60_000);
      const toggle = await $('[data-testid="host-exec-toggle"]');
      await toggle.waitForClickable({ timeout: 5_000 });
      await toggle.click();
      // No modal should open — assert nothing for ~500ms then check.
      await browser.pause(500);
      const modal = await $('[data-testid="host-exec-enable-danger"]');
      expect(await modal.isDisplayed()).toBe(false);

      await browser.waitUntil(
        async () => !(await getHostExec(PROJECT)).enabled,
        { timeout: 45_000, timeoutMsg: 'host_exec did not turn off after the second toggle click' },
      );
    });
  });

  // ----------------------------------------------------------------------
  // (b) — off-whitelist recipes are rejected at the configuration boundary,
  // so they never reach the worker.
  // ----------------------------------------------------------------------

  describe('Recipe whitelist validation (plan scenario b)', function () {
    // Re-enable host_exec via the backend command directly (this part of the
    // suite is about the *whitelist* gate, not the danger-modal gate which
    // the previous describe already covered).
    before(async function () {
      this.timeout(60_000);
      await setHostExecEnabled(PROJECT, true);
      await browser.waitUntil(async () => (await getHostExec(PROJECT)).enabled, {
        timeout: 45_000,
        timeoutMsg: 'host_exec did not re-enable for the validation tests',
      });
    });

    it('rejects a recipe whose exec is a shell launcher (`bash`)', async function () {
      this.timeout(15_000);
      const err = await saveHostExecSettings(PROJECT, [
        { name: 'shell_evil', exec: 'bash', args: ['-c', 'id'] },
      ]);
      expect(err).not.toBeNull();
      // Validator must mention the offending tool by basename.
      expect(err!.toLowerCase()).toContain('bash');
      // And persisted state must be untouched.
      expect(await loadHostExecSettings(PROJECT)).toEqual([]);
    });

    it('rejects a recipe with a non-snake_case name', async function () {
      this.timeout(15_000);
      const err = await saveHostExecSettings(PROJECT, [
        { name: 'BadName-1', exec: './gradlew', args: ['test'] },
      ]);
      expect(err).not.toBeNull();
    });

    it("rejects a recipe with a `cwdSub` that escapes the project (`..`)", async function () {
      this.timeout(15_000);
      const err = await saveHostExecSettings(PROJECT, [
        { name: 'escape_cwd', exec: './gradlew', args: ['test'], cwdSub: '../sibling' },
      ]);
      expect(err).not.toBeNull();
    });

    it('rejects a duplicate recipe name in the same save', async function () {
      this.timeout(15_000);
      const err = await saveHostExecSettings(PROJECT, [
        { name: 'dup', exec: './a', args: [] },
        { name: 'dup', exec: './b', args: [] },
      ]);
      expect(err).not.toBeNull();
    });

    it('rejects a meta-tool exec with a bare `{param}` argument', async function () {
      this.timeout(15_000);
      const err = await saveHostExecSettings(PROJECT, [
        {
          name: 'npm_anything',
          exec: 'npm',
          args: ['run', '{script}'],
          params: [{ name: 'script', pattern: '^[a-z:-]+$' }],
        },
      ]);
      expect(err).not.toBeNull();
    });

    it('rejects a recipe whose env tries to set a reserved key (`PATH`)', async function () {
      this.timeout(15_000);
      const err = await saveHostExecSettings(PROJECT, [
        {
          name: 'path_hijack',
          exec: './gradlew',
          args: ['test'],
          env: { PATH: '/tmp/evil:/usr/bin' },
        },
      ]);
      expect(err).not.toBeNull();
    });

    it('accepts a valid recipe and round-trips it through user config (camelCase JSON)', async function () {
      this.timeout(15_000);
      const recipe: HostExecRecipe = {
        name: 'gradle_test',
        exec: './gradlew',
        args: ['test', '--tests={class}'],
        cwdSub: 'frontend',
        params: [{ name: 'class', pattern: '^[A-Za-z0-9_.]+$', maxLen: 200 }],
        env: { CI: 'true' },
      };
      const err = await saveHostExecSettings(PROJECT, [recipe]);
      expect(err).toBeNull();

      // Reload through the backend command — checks that the camelCase JSON
      // round-trips correctly through the on-disk user config (regression
      // guard for the SSOT camelCase fix).
      const persisted = await loadHostExecSettings(PROJECT);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].name).toBe('gradle_test');
      expect(persisted[0].cwdSub).toBe('frontend');
      expect(persisted[0].params?.[0].name).toBe('class');
      expect(persisted[0].params?.[0].maxLen).toBe(200);
      expect(persisted[0].env).toEqual({ CI: 'true' });

      // The card now lists it. Re-render the table and check the row appears.
      const row = await $(`[data-testid="host-exec-recipe-${recipe.name}"]`);
      await row.waitForExist({ timeout: 10_000 });
    });
  });

  // ----------------------------------------------------------------------
  // host_exec_resolve_executable: the "find on PATH" backend that drives
  // the dialog's "find on PATH" button. Smoke-tests the recovered host
  // PATH and the rejection of path-ish input.
  // ----------------------------------------------------------------------

  describe('host_exec_resolve_executable', function () {
    it('rejects a name containing path separators', async function () {
      this.timeout(10_000);
      const err: string | null = await browser.executeAsync(
        (done: (err: string | null) => void) => {
          (
            window as unknown as {
              __TAURI_INTERNALS__: {
                invoke: (
                  cmd: string,
                  args: Record<string, unknown>,
                ) => Promise<string | null>;
              };
            }
          ).__TAURI_INTERNALS__
            .invoke('host_exec_resolve_executable', { name: './gradlew' })
            .then(() => done(null))
            .catch((e: unknown) => done(e instanceof Error ? e.message : String(e)));
        },
      );
      expect(err).not.toBeNull();
    });

    it('returns null for a name that is not on the PATH', async function () {
      this.timeout(10_000);
      const result: string | null = await browser.executeAsync(
        (done: (resolved: string | null) => void) => {
          (
            window as unknown as {
              __TAURI_INTERNALS__: {
                invoke: (
                  cmd: string,
                  args: Record<string, unknown>,
                ) => Promise<string | null>;
              };
            }
          ).__TAURI_INTERNALS__
            .invoke('host_exec_resolve_executable', {
              name: 'definitely_not_on_path_ever_xyz123',
            })
            .then((r) => done(r))
            .catch(() => done(null));
        },
      );
      expect(result).toBeNull();
    });
  });
});

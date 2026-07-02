/**
 * Anthropic OAuth Login E2E test (the exit-137 incident flow).
 *
 * A no-provider project's FIRST-ever `compose up` used to come from the CLI
 * login guard, which raced root-created claude-home dirs and killed the
 * `claude auth login` exec with 137. This drives that exact ordering: the
 * auth-terminal card renders pre-Save on a no-provider project, then
 * `speedwave login` brings containers up and reaches the sign-in stage.
 *
 * Runs after spec 17 on e2e-second (still no-provider there) and before 07.
 * Leaves e2e-second with anthropic selected + containers up — only the
 * project-agnostic factory reset runs afterwards.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import { switchToProject, activeProjectSlug, containersRunning } from '../helpers/projects';
import { openSettings } from '../helpers/llm';

const NO_LLM_PROJECT = 'e2e-second';

/** Installed CLI path — link_cli writes it during the wizard (spec 02). */
function cliPath(): string {
  const bin = process.platform === 'win32' ? 'speedwave.exe' : 'speedwave';
  return path.join(os.homedir(), '.speedwave', 'bin', bin);
}

describe('Anthropic OAuth Login (no-provider first start)', function () {
  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== NO_LLM_PROJECT) {
      await switchToProject(NO_LLM_PROJECT);
    }
  });

  it('renders the OAuth terminal card before any provider is saved', async function () {
    this.timeout(60_000);
    await openSettings();

    const anthropicCard = await $('[data-testid="settings-llm-provider-anthropic"]');
    await anthropicCard.waitForExist({ timeout: 15_000 });
    await anthropicCard.click();

    // The incident path: both controls are reachable pre-Save on no-provider.
    await $('[data-testid="auth-open-terminal"]').waitForExist({ timeout: 15_000 });
    const command = await $('[data-testid="auth-command"]');
    await command.waitForExist({ timeout: 15_000 });
    expect((await command.getText()).trim().length).toBeGreaterThan(0);
  });

  it('speedwave login starts containers and reaches the sign-in stage', async function () {
    this.timeout(300_000);
    expect(await containersRunning(NO_LLM_PROJECT)).toBe(false);

    const child = spawn(cliPath(), ['login', '--project', NO_LLM_PROJECT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    let exited = false;
    child.on('exit', () => (exited = true));

    try {
      // The sign-in banner prints AFTER render_compose + first-ever compose up
      // + ensure_exec_healthy — everything the incident broke.
      await browser.waitUntil(
        async () => output.includes('Starting Anthropic sign-in'),
        {
          timeout: 240_000,
          interval: 2_000,
          timeoutMsg: `speedwave login never reached the sign-in stage; output:\n${output.slice(-2000)}`,
        }
      );
      expect(output).not.toContain('exit code 137');
      expect(output).not.toContain('Permission denied');
      await browser.waitUntil(async () => containersRunning(NO_LLM_PROJECT), {
        timeout: 30_000,
        timeoutMsg: 'containers not running after the CLI login guard started them',
      });
      // The claude exec must survive the first seconds (the incident died at once).
      await browser.pause(5_000);
      expect(output).not.toContain('exit code 137');
      expect(exited && output.includes('exit code')).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

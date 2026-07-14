/** Dirty-state self-heal: planted engine debris must not survive a backend restart.
 *  Runs after spec 18 (e2e-second active) and before 07; leaves context7 disabled. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  composePrefix,
  plantGhost,
  storeSnapshot,
  assertStoreHealed,
  assertLiveEntriesIntact,
} from '../helpers/engine';
import { waitForHealthy } from '../helpers/health';
import { openIntegrations, rowStatus, toggleIntegration } from '../helpers/llm';
import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { confirmRestartAndWait, requestBackendRestart } from '../helpers/shell';

const PROJECT = 'e2e-test';
const SERVICE = 'context7';
const HUB = `${composePrefix()}_${PROJECT}_mcp_hub`;
const CLAUDE = `${composePrefix()}_${PROJECT}_claude`;

// Rust SSOT for the token path: `<data_dir>/secrets/<project>/<service>-auth-token`
// (compose/tokens.rs:21 + compose/workers.rs:132-133); rendered only while enabled.
function serviceTokenPath(): string {
  const dataDir = process.env.SPEEDWAVE_DATA_DIR || join(homedir(), '.speedwave');
  return join(dataDir, 'secrets', PROJECT, `${SERVICE}-auth-token`);
}

// Absolute System32 path — a bare `powershell` PATH lookup is hijackable;
// mirror of binary.rs::system_powershell_path (binary.rs:177-185).
function systemPowershellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Drives the spec-15/16 toggle+restart UI flow until the context7 row shows `target`. */
async function setContext7(target: 'running' | 'disabled'): Promise<void> {
  await openIntegrations();
  const enabled = (await rowStatus(SERVICE)) !== 'disabled';
  if (enabled !== (target === 'running')) {
    await toggleIntegration(SERVICE);
    await confirmRestartAndWait();
    await openIntegrations();
  }
  await browser.waitUntil(async () => (await rowStatus(SERVICE)) === target, {
    timeout: 120_000,
    interval: 3_000,
    timeoutMsg: `${SERVICE} row did not reach ${target}`,
  });
}

describe('Dirty-state self-heal', function () {
  before(async function () {
    this.timeout(180_000);
    if ((await activeProjectSlug()) !== PROJECT) {
      await switchToProject(PROJECT);
    }
  });

  it('heals a planted name-store ghost and keeps every live entry', async function () {
    this.timeout(300_000);
    const before = storeSnapshot();
    plantGhost(HUB);
    await requestBackendRestart();
    await waitForHealthy(PROJECT);
    assertStoreHealed([HUB]);
    assertLiveEntriesIntact(before, [HUB]);
  });

  it('heals multiple ghosts in one pass', async function () {
    this.timeout(300_000);
    const before = storeSnapshot();
    plantGhost(HUB);
    plantGhost(CLAUDE);
    await requestBackendRestart();
    await waitForHealthy(PROJECT);
    assertStoreHealed([HUB, CLAUDE]);
    assertLiveEntriesIntact(before, [HUB, CLAUDE]);
  });

  it('heals an unreadable worker auth token (Windows empty-DACL corruption)', async function () {
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }
    // Three UI-confirmed restarts (enable, heal, cleanup-disable) at up to
    // ~180s each — the suite's usual 300s budget cannot fit them.
    this.timeout(600_000);

    // Own the precondition: the token renders only while context7 is enabled
    // (workers.rs:201-207 skips disabled services); spec 16 leaves it disabled.
    await setContext7('running');
    const token = serviceTokenPath();
    const before = readFileSync(token, 'utf8');
    try {
      // Rust mirror: fs_perms.rs::make_unreadable_for_test — protected DACL with
      // zero ACEs; the script exits non-zero if the plant did not take effect.
      const psToken = token.replace(/'/g, "''");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$acl = New-Object System.Security.AccessControl.FileSecurity',
        '$acl.SetAccessRuleProtection($true, $false)',
        `Set-Acl -Path '${psToken}' -AclObject $acl`,
        `$check = Get-Acl -Path '${psToken}'`,
        'if (-not $check.AreAccessRulesProtected -or $check.Access.Count -ne 0)' +
          " { throw 'plant no-op: DACL is not protected-empty' }",
      ].join('; ');
      execFileSync(systemPowershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
      });

      expect(() => readFileSync(token, 'utf8')).toThrow(/EPERM|EACCES/);

      await requestBackendRestart();
      await waitForHealthy(PROJECT);

      // A fresh Uuid::new_v4() replaces the unreadable token (ensure_worker_auth_token,
      // test-guarded by compose/mod.rs::test_worker_auth_token_regenerated_when_unreadable).
      const after = readFileSync(token, 'utf8');
      expect(after).not.toBe(before);
    } finally {
      // Restore the suite's documented end state even on failure (07 runs last).
      await setContext7('disabled');
    }
  });
});

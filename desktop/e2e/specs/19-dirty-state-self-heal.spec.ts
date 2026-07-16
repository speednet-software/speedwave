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
const PROJECT_PREFIX = `${composePrefix()}_${PROJECT}_`;

// The name store is shared across projects; spec 18 leaves e2e-second running and
// its async teardown races our snapshot. Scope the live-entry invariant to e2e-test.
function projectEntries(snapshot: Map<string, string>): Map<string, string> {
  return new Map([...snapshot].filter(([name]) => name.startsWith(PROJECT_PREFIX)));
}

// Rust SSOT for the token path: `<data_dir>/secrets/<project>/<service>-auth-token`
// (tokens::init_secrets_dir_in + workers::ensure_worker_auth_token); rendered only while enabled.
function serviceTokenPath(): string {
  const dataDir = process.env.SPEEDWAVE_DATA_DIR || join(homedir(), '.speedwave');
  return join(dataDir, 'secrets', PROJECT, `${SERVICE}-auth-token`);
}

// Absolute System32 path — a bare `powershell` PATH lookup is hijackable;
// mirror of binary::system_powershell_path.
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
    const before = projectEntries(storeSnapshot());
    plantGhost(HUB);
    await requestBackendRestart();
    await waitForHealthy(PROJECT);
    assertStoreHealed([HUB]);
    assertLiveEntriesIntact(before, [HUB]);
  });

  it('heals multiple ghosts in one pass', async function () {
    this.timeout(300_000);
    const before = projectEntries(storeSnapshot());
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
    }
    // Three UI-confirmed restarts (enable, heal, cleanup-disable) at up to
    // ~180s each — the suite's usual 300s budget cannot fit them.
    this.timeout(600_000);

    const token = serviceTokenPath();
    let before: string;
    try {
      // Own the precondition inside the try so cleanup runs even if enable throws:
      // the token renders only while context7 is enabled (workers::apply_worker_auth_tokens_with_dir).
      await setContext7('running');
      before = readFileSync(token, 'utf8');
      // Rust mirror: fs_perms.rs::set_windows_acl_empty_for_test — a present,
      // protected, zero-ACE DACL via SDDL D:P (never NULL, which grants everyone access).
      const psToken = token.replace(/'/g, "''");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$acl = Get-Acl -LiteralPath '${psToken}'`,
        "$acl.SetSecurityDescriptorSddlForm('D:P')",
        `Set-Acl -LiteralPath '${psToken}' -AclObject $acl`,
        `$sddl = (Get-Acl -LiteralPath '${psToken}').Sddl`,
        'if ($sddl -notmatch \'D:P(AI)?(?!\\()\') { throw "plant no-op: unexpected SDDL $sddl" }',
        // Expected path: an empty protected DACL denies all access, including the owner.
        'try {',
        `  [System.IO.File]::ReadAllText('${psToken}') | Out-Null`,
        "  throw 'plant no-op: read succeeded despite empty protected DACL'",
        '} catch [System.UnauthorizedAccessException] {}',
        // Trailing statement: powershell.exe exits 1 with empty stdout/stderr when a
        // successfully-caught empty catch{} is the script's last statement.
        'Write-Output PLANT_OK',
      ].join('; ');
      const plantOutput = execFileSync(
        systemPowershellPath(),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8' }
      );
      expect(plantOutput).toContain('PLANT_OK');

      // Node/libuv's FILE_FLAG_BACKUP_SEMANTICS + an elevated runner's SeBackupPrivilege
      // bypass the DACL, so the plant script's own .NET ReadAllText denial is the proof.

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

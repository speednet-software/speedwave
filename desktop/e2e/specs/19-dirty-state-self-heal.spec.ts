/** Dirty-state self-heal: planted engine debris must not survive a backend restart. */
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
import { requestBackendRestart } from '../helpers/shell';

const PROJECT = 'e2e-test';
const HUB = `${composePrefix()}_${PROJECT}_mcp_hub`;
const CLAUDE = `${composePrefix()}_${PROJECT}_claude`;

// Rust SSOT for the token path: `<data_dir>/secrets/<project>/<service>-auth-token`
// (crates/speedwave-runtime/src/compose/tokens.rs:21, workers.rs:132-133). context7 is
// the service spec 15/16 exercise, so its token file is guaranteed to exist by here.
function contextTokenPath(): string {
  const dataDir = process.env.SPEEDWAVE_DATA_DIR || join(homedir(), '.speedwave');
  return join(dataDir, 'secrets', PROJECT, 'context7-auth-token');
}

describe('Dirty-state self-heal', function () {
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
    this.timeout(300_000);
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }

    const token = contextTokenPath();
    const before = readFileSync(token, 'utf8');

    // Rust mirror: fs_perms.rs::make_unreadable_for_test (Set-Acl / SetAccessRuleProtection
    // is the PowerShell equivalent of SetNamedSecurityInfoW with an empty, protected DACL).
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$acl = New-Object System.Security.AccessControl.FileSecurity`,
      '$acl.SetAccessRuleProtection($true, $false)',
      `Set-Acl -Path '${token}' -AclObject $acl`,
    ].join('; ');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    });

    expect(() => readFileSync(token, 'utf8')).toThrow();

    await requestBackendRestart();
    await waitForHealthy(PROJECT);

    const after = readFileSync(token, 'utf8');
    expect(after).not.toBe(before);
  });
});

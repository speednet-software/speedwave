/**
 * Container Health E2E tests. Verifies VM and containers (claude, mcp_hub)
 * are running and healthy via get_health. Does not assert mcp_os/ide_bridge.
 */

import { execFileSync } from 'node:child_process';
import { getHealth, waitForHealthy } from '../helpers/health';

const E2E_PROJECT_NAME = 'e2e-test';

describe('Container Health', function () {
  it('should report all containers running and healthy', async function () {
    this.timeout(150_000);

    await waitForHealthy(E2E_PROJECT_NAME);

    // Stabilized — assert individual properties for clear failure messages.
    const report = await getHealth(E2E_PROJECT_NAME);
    if ('error' in report) {
      throw new Error(`get_health failed after stabilization: ${report.error}`);
    }
    expect(report.overall_healthy).toBe(true);
    expect(report.vm.running).toBe(true);
    expect(report.containers.length).toBeGreaterThanOrEqual(2);
    // Compose-prefix stripped server-side (PR #730).
    expect(report.containers.some((c) => c.name === 'claude')).toBe(true);
    expect(report.containers.some((c) => c.name === 'mcp_hub')).toBe(true);
    for (const container of report.containers) {
      expect(container.healthy).toBe(true);
    }
  });

  it('should have flock available in the WSL distro (name-store self-heal)', function () {
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }
    // Without flock the payload no-ops fail-closed and Windows never self-heals.
    const out = execFileSync('wsl.exe', ['-d', 'Speedwave', '--', 'command', '-v', 'flock'], {
      encoding: 'utf8',
      env: { ...process.env, WSL_UTF8: '1' },
    });
    expect(out.trim().endsWith('flock')).toBe(true);
  });
});

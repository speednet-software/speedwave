/**
 * Container Health E2E tests.
 *
 * After the setup wizard completes (spec 02), containers should be running
 * for the 'e2e-test' project. This spec calls the `get_health` Tauri command
 * (the same data source the System Health UI uses) and verifies that:
 *   - The VM is running
 *   - Both expected containers (claude, mcp_hub) are present and healthy
 *   - overall_healthy is true
 *
 * Does NOT assert mcp_os.running or ide_bridge.running — mcp-os depends on
 * timing/platform, and no IDE is present during E2E runs. Neither affects
 * overall_healthy in a fresh E2E run with clean project dirs.
 */

import { getHealth, HealthReport } from '../helpers/health';

const E2E_PROJECT_NAME = 'e2e-test';

describe('Container Health', function () {
  it('should report all containers running and healthy', async function () {
    this.timeout(150_000);

    let lastObservation = 'no response received';
    try {
      await browser.waitUntil(
        async () => {
          const result = await getHealth(E2E_PROJECT_NAME);
          if ('error' in result) {
            lastObservation = `Backend error: ${result.error}`;
            return false;
          }
          lastObservation = JSON.stringify(result);
          return (
            result.overall_healthy &&
            result.vm.running &&
            result.containers.length >= 2 &&
            result.containers.some((c) => c.name.endsWith('_claude')) &&
            result.containers.some((c) => c.name.endsWith('_mcp_hub')) &&
            result.containers.every((c) => c.healthy)
          );
        },
        { timeout: 120_000, interval: 5_000 },
      );
    } catch {
      throw new Error(`Containers not healthy within 120s. Last: ${lastObservation}`);
    }

    // Stabilized — assert individual properties for clear failure messages.
    const report = await getHealth(E2E_PROJECT_NAME);
    if ('error' in report) {
      throw new Error(`get_health failed after stabilization: ${report.error}`);
    }
    expect(report.overall_healthy).toBe(true);
    expect(report.vm.running).toBe(true);
    expect(report.containers.length).toBeGreaterThanOrEqual(2);
    expect(report.containers.some((c) => c.name.endsWith('_claude'))).toBe(true);
    expect(report.containers.some((c) => c.name.endsWith('_mcp_hub'))).toBe(true);
    for (const container of report.containers) {
      expect(container.healthy).toBe(true);
    }
  });
});

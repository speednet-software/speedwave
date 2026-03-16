export interface ContainerHealth {
  name: string;
  status: string;
  healthy: boolean;
}

export interface HealthReport {
  containers: ContainerHealth[];
  vm: { running: boolean; vm_type: string };
  mcp_os: { running: boolean };
  ide_bridge: { running: boolean; port: number | null; ws_url: string | null; detected_ides: unknown[] };
  overall_healthy: boolean;
}

export async function getHealth(project: string): Promise<HealthReport | { error: string }> {
  return browser.executeAsync(
    (proj: string, done: (r: any) => void) => {
      (window as any).__TAURI_INTERNALS__
        .invoke('get_health', { project: proj })
        .then((r: any) => done(r))
        .catch((e: any) => done({ error: String(e) }));
    },
    project,
  ) as Promise<HealthReport | { error: string }>;
}

export async function waitForHealthy(project: string): Promise<void> {
  let lastObservation = 'no response received';
  try {
    await browser.waitUntil(
      async () => {
        const result = await getHealth(project);
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
    throw new Error(`Containers for '${project}' not healthy within 120s. Last: ${lastObservation}`);
  }
}

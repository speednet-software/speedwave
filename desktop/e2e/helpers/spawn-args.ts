
export async function lastSpawnArgs(): Promise<string[]> {
  return browser.executeAsync((done: (args: string[]) => void) => {
    (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<string[]> };
      }
    ).__TAURI_INTERNALS__.invoke('e2e_last_spawn_args')
      .then((args) => done(args))
      .catch(() => done([]));
  });
}

export async function waitForFreshSpawnArgs(
  priorArgs: string[],
  timeoutMs = 30_000
): Promise<string[]> {
  let current: string[] = priorArgs;
  await browser.waitUntil(
    async () => {
      current = await lastSpawnArgs();
      return current.length > 0 && JSON.stringify(current) !== JSON.stringify(priorArgs);
    },
    {
      timeout: timeoutMs,
      timeoutMsg: 'no fresh Claude Code spawn observed (lastSpawnArgs unchanged)',
    }
  );
  return current;
}

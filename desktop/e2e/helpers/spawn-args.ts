/** e2e-only observation of the Claude Code spawn argv (SPEED-545). */

/** Reads the argv of the most recent Claude Code spawn (backend `e2e_support::last_spawn_args`,
 *  only registered behind the `e2e` Cargo feature -- never present in a shipped build). */
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

/** Polls until `lastSpawnArgs()` differs from `priorArgs`, proving a NEW spawn happened; the
 *  recorder is one process-global slot, so a stale earlier value would pass a non-empty check. */
export async function waitForFreshSpawnArgs(
  priorArgs: string[],
  timeoutMs = 30_000
): Promise<string[]> {
  let current: string[] = priorArgs;
  await browser.waitUntil(
    async () => {
      current = await lastSpawnArgs();
      return JSON.stringify(current) !== JSON.stringify(priorArgs);
    },
    {
      timeout: timeoutMs,
      timeoutMsg: 'no fresh Claude Code spawn observed (lastSpawnArgs unchanged)',
    }
  );
  return current;
}

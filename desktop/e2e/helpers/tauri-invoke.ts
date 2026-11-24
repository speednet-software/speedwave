export type InvokeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function invokeCommand<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<InvokeResult<T>> {
  return browser.execute(
    async (command: string, commandArgs: Record<string, unknown> | null) => {
      try {
        const value = await (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T>;
            };
          }
        ).__TAURI_INTERNALS__.invoke(command, commandArgs ?? undefined);
        return { ok: true, value } as InvokeResult<T>;
      } catch (e: unknown) {
        return { ok: false, reason: String(e) } as InvokeResult<T>;
      }
    },
    cmd,
    args ?? null
  );
}

export async function invokeOr<T>(
  fallback: T,
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  const result = await invokeCommand<T>(cmd, args);
  return result.ok ? result.value : fallback;
}

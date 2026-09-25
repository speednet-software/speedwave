export type InvokeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function invokeCommand<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<InvokeResult<T>> {
  return browser.executeAsync<InvokeResult<T>, [string, Record<string, unknown> | null]>(
    (command, commandArgs, done) => {
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T>;
          };
        }
      ).__TAURI_INTERNALS__
        .invoke(command, commandArgs ?? undefined)
        .then((value) => done({ ok: true, value }))
        .catch((e: unknown) => done({ ok: false, error: String(e) }));
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

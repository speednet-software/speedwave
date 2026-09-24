export async function lastAppliedEffort(): Promise<string | null> {
  return browser.executeAsync((done: (level: string | null) => void) => {
    (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<string | null> };
      }
    ).__TAURI_INTERNALS__
      .invoke('e2e_last_applied_effort')
      .then((level) => done(level))
      .catch(() => done(null));
  });
}

export async function waitForAppliedEffort(level: string, timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(async () => (await lastAppliedEffort()) === level, {
    timeout: timeoutMs,
    timeoutMsg: `the live session never took effort ${level} through apply_chat_effort`,
  });
}

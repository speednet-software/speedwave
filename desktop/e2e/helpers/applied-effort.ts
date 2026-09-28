import { invokeOr } from './tauri-invoke';

interface AppliedEffort {
  seq: number;
  level: string;
}

async function lastAppliedEffort(): Promise<AppliedEffort | null> {
  return invokeOr<AppliedEffort | null>(null, 'e2e_last_applied_effort');
}

export async function pickComposerEffort(level: string, timeoutMs = 30_000): Promise<void> {
  const prior = await lastAppliedEffort();
  await (await $('[data-testid="effort-segment"]')).click();
  await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000 });
  await (await $(`[data-testid="effort-stop-${level}"]`)).click();
  await $('[data-testid="effort-popover"]').waitForExist({ timeout: 10_000, reverse: true });
  await browser.waitUntil(
    async () => {
      const current = await lastAppliedEffort();
      return current !== null && current.seq > (prior?.seq ?? 0) && current.level === level;
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `the live session never took effort ${level} through apply_chat_effort`,
    }
  );
}

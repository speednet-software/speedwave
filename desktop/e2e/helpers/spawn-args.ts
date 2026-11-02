import { invokeOr } from './tauri-invoke';

export interface ChatSpawn {
  boot: string;
  seq: number;
  tab_id: string;
  args: string[];
  started: boolean;
  awaits_initialize: boolean;
  info: 'pending' | 'ready' | 'unavailable' | 'busy' | 'gone';
}

export async function lastSpawnArgs(): Promise<string[]> {
  return invokeOr<string[]>([], 'e2e_last_spawn_args');
}

export async function chatSpawn(): Promise<ChatSpawn | null> {
  return invokeOr<ChatSpawn | null>(null, 'e2e_chat_spawn');
}

function isNewerThan(spawn: ChatSpawn, after: ChatSpawn | null): boolean {
  return after === null || spawn.boot !== after.boot || spawn.seq > after.seq;
}

function isReady(spawn: ChatSpawn): boolean {
  return spawn.started && (!spawn.awaits_initialize || spawn.info === 'ready');
}

function describeSeen(seen: ChatSpawn | null): string {
  return seen === null
    ? 'no spawn recorded'
    : `seq ${seen.seq}, started ${seen.started}, info ${seen.info}`;
}

export async function waitForReadySession(
  after: ChatSpawn | null = null,
  timeoutMs = 90_000
): Promise<ChatSpawn> {
  const deadline = Date.now() + timeoutMs;
  let seen: ChatSpawn | null = null;
  while (Date.now() < deadline) {
    seen = await chatSpawn();
    if (seen !== null && isNewerThan(seen, after) && isReady(seen)) return seen;
    await browser.pause(250);
  }
  throw new Error(
    `no ready Claude Code session after the mark within ${timeoutMs} ms (last seen: ${describeSeen(seen)})`
  );
}

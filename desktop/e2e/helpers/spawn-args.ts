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

export async function activeTabId(): Promise<string | null> {
  const view = await $('[data-testid="chat-view"]');
  if (!(await view.isExisting())) return null;
  const id = await view.getAttribute('data-tab-id');
  return id === null || id === '' ? null : id;
}

export async function chatSpawn(tabId: string | null = null): Promise<ChatSpawn | null> {
  return invokeOr<ChatSpawn | null>(null, 'e2e_chat_spawn', { tabId });
}

function isNewerThan(spawn: ChatSpawn, after: ChatSpawn | null): boolean {
  return after === null || spawn.boot !== after.boot || spawn.seq > after.seq;
}

function isReady(spawn: ChatSpawn): boolean {
  return spawn.started && (!spawn.awaits_initialize || spawn.info === 'ready');
}

function describeSeen(seen: ChatSpawn | null, tabId: string | null): string {
  const spawn =
    seen === null
      ? 'no spawn recorded'
      : `seq ${seen.seq}, started ${seen.started}, info ${seen.info}`;
  return `tab ${tabId ?? 'none'}, ${spawn}`;
}

export async function waitForReadySession(
  after: ChatSpawn | null = null,
  timeoutMs = 90_000
): Promise<ChatSpawn> {
  const deadline = Date.now() + timeoutMs;
  let seen: ChatSpawn | null = null;
  let tabId: string | null = null;
  while (Date.now() < deadline) {
    tabId = await activeTabId();
    seen = tabId === null ? null : await chatSpawn(tabId);
    if (seen !== null && isNewerThan(seen, after) && isReady(seen)) return seen;
    await browser.pause(250);
  }
  throw new Error(
    `no ready Claude Code session of the active tab after the mark within ${timeoutMs} ms (last seen: ${describeSeen(seen, tabId)})`
  );
}

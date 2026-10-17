/**
 * Chat Controls E2E tests.
 *
 * Covers the interactive chat controls on e2e-test (OpenRouter active after
 * spec 11): starting a fresh conversation, stopping a streaming turn,
 * queueing a message while streaming, and deleting a conversation from
 * history.
 *
 * Runs after spec 12 and before spec 07 (factory reset, always last).
 * All assertions use data-testid attributes, never UX-volatile text.
 */

import {
  openChat,
  sendMessageAndWait,
  sendMessageNoWait,
  queueMessageViaEnter,
  waitForTurnStart,
  waitForTurnComplete,
  startNewConversation,
  openHistory,
} from '../helpers/llm';
import { LONG_STREAM_PROMPT } from '../helpers/memory-fact';
import { pastedFileNames, pastedFilePath } from '../helpers/host-files';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

const PROJECT = 'e2e-test';

const NOTE_TEXT = 'speedwave e2e file attachment\n';

const CHUNKED_SIZE = 9 * 1024 * 1024 + 123;

function chunkedBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function newPastes(before: ReadonlySet<string>): string[] {
  return pastedFileNames(PROJECT).filter((name) => !before.has(name));
}

async function waitForUploadToSettle(): Promise<void> {
  await $('[data-testid="composer-attachment-file"]').waitForExist({
    timeout: 20_000,
    timeoutMsg: 'file pill never appeared after the synthetic paste',
  });
  await browser.waitUntil(
    async () =>
      (await $$('[data-testid="composer-attachment-strip"] [role="status"]').getElements())
        .length === 0,
    { timeout: 60_000, timeoutMsg: 'file upload never finished (spinner stayed on)' }
  );
  await browser.waitUntil(
    async () => (await $$('[data-testid="composer-attachment-error"]').getElements()).length === 0,
    { timeout: 1_000, timeoutMsg: 'file upload reported an error' }
  );
}

describe('Chat Controls', function () {
  before(async function () {
    this.timeout(180_000);
    await openChat();
  });

  it('starts a fresh conversation', async function () {
    this.timeout(180_000);
    await startNewConversation();
    await sendMessageAndWait('Say hello in one word.');
    const messages = await $$('[data-testid="chat-message"][data-role="assistant"]').getElements();
    expect(messages.length).toBeGreaterThan(0);
  });

  it('stops a streaming turn', async function () {
    this.timeout(120_000);
    await sendMessageNoWait(LONG_STREAM_PROMPT);
    await waitForTurnStart();

    await (await $('[data-testid="chat-stop"]')).click();
    await waitForTurnComplete(30_000);
    expect(await $('[data-testid="chat-stop"]').isExisting()).toBe(false);
  });

  it('stops a streaming turn with the Escape key', async function () {
    this.timeout(120_000);
    await sendMessageNoWait(LONG_STREAM_PROMPT);
    await waitForTurnStart();

    await browser.keys('Escape');
    await waitForTurnComplete(30_000);
    expect(await $('[data-testid="chat-stop"]').isExisting()).toBe(false);
  });

  it('queues a message sent while streaming', async function () {
    this.timeout(180_000);
    await startNewConversation();
    await sendMessageNoWait(LONG_STREAM_PROMPT);
    await waitForTurnStart();

    await queueMessageViaEnter('This one should be queued.');
    await $('[data-testid="composer-queued"]').waitForExist({ timeout: 10_000 });
    expect(await $('[data-testid="composer-queued-text"]').isExisting()).toBe(true);

    await (await $('[data-testid="composer-queued-cancel"]')).click();
    await $('[data-testid="composer-queued"]').waitForExist({ timeout: 10_000, reverse: true });
    await waitForTurnComplete();
  });

  it('dispatches the queued message as the next turn (ADR-045)', async function () {
    this.timeout(300_000);
    await startNewConversation();
    await sendMessageNoWait(LONG_STREAM_PROMPT);
    await waitForTurnStart();

    await queueMessageViaEnter('Reply with exactly the single word ACK.');
    await $('[data-testid="composer-queued"]').waitForExist({ timeout: 10_000 });

    await $('[data-testid="composer-queued"]').waitForExist({
      timeout: 240_000,
      reverse: true,
      timeoutMsg: 'queued slot never drained after the streaming turn ended',
    });
    await waitForTurnComplete(120_000);

    const users = await $$('[data-testid="chat-message"][data-role="user"]').getElements();
    expect(users.length).toBeGreaterThanOrEqual(2);
    const lastUser = users[users.length - 1];
    expect(await lastUser.getText()).toContain('ACK');
    const assistants = await $$(
      '[data-testid="chat-message"][data-role="assistant"]'
    ).getElements();
    expect(assistants.length).toBeGreaterThanOrEqual(2);
  });

  it('opens the slash menu on "/" and inserts the selected command', async function () {
    this.timeout(60_000);
    const input = await $('[data-testid="chat-input"]');
    await input.waitForExist({ timeout: 15_000 });
    await input.setValue('/');

    await $('[data-testid="slash-menu"]').waitForExist({ timeout: 15_000 });
    await browser.waitUntil(
      async () => (await $$('[data-testid="slash-menu-item"]').getElements()).length > 0,
      { timeout: 15_000, timeoutMsg: 'slash menu never listed any commands' }
    );

    const items = await $$('[data-testid="slash-menu-item"]').getElements();
    await items[0].click();
    await $('[data-testid="slash-menu"]').waitForExist({ timeout: 10_000, reverse: true });

    const value = await input.getValue();
    expect(value).toMatch(/^\/\S+ $/);

    await browser.execute(() => {
      const ta = document.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement | null;
      if (!ta) return;
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  it('attaches a pasted image and sends it (ADR-065)', async function () {
    this.timeout(240_000);
    const input = await $('[data-testid="chat-input"]');
    await input.waitForExist({ timeout: 15_000 });

    await browser.execute(() => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      if (!ta) return;
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'e2e-paste.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      ta.dispatchEvent(ev);
    });

    await $('[data-testid="composer-attachment-strip"]').waitForExist({
      timeout: 20_000,
      timeoutMsg: 'attachment strip never appeared after the synthetic paste',
    });

    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const img = document.querySelector(
            '[data-testid="composer-attachment-strip"] img'
          ) as HTMLImageElement | null;
          return !!img && img.complete && img.naturalWidth > 0;
        }),
      { timeout: 20_000, timeoutMsg: 'attachment thumbnail never rendered (broken blob: image)' }
    );

    await sendMessageNoWait('Reply with the single word RECEIVED.');
    await $('[data-testid="user-message-image"]').waitForExist({
      timeout: 15_000,
      timeoutMsg: 'sent message did not render the image attachment pill',
    });
    await waitForTurnStart();
    await waitForTurnComplete(180_000);
  });

  it('streams a multi-chunk file to disk byte for byte and deletes it once its pill is removed (SPEED-801)', async function () {
    this.timeout(120_000);
    const input = await $('[data-testid="chat-input"]');
    await input.waitForExist({ timeout: 15_000 });
    const before = new Set(pastedFileNames(PROJECT));

    await browser.execute((size: number) => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      if (!ta) return;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'e2e-chunked.bin', { type: 'application/octet-stream' }));
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      ta.dispatchEvent(ev);
    }, CHUNKED_SIZE);
    await waitForUploadToSettle();

    const added = newPastes(before);
    const uploaded = added.find((name) => name.endsWith('-e2e-chunked.bin'));
    expect(uploaded).toBeDefined();
    expect(added.filter((name) => name.endsWith('.part'))).toEqual([]);
    const uploadedPath = pastedFilePath(PROJECT, uploaded as string);
    const onDisk = fs.readFileSync(uploadedPath);
    expect(onDisk.length).toBe(CHUNKED_SIZE);
    expect(sha256(onDisk)).toBe(sha256(chunkedBytes(CHUNKED_SIZE)));

    await $('[data-testid="composer-attachment-remove"]').click();
    await browser.waitUntil(async () => !fs.existsSync(uploadedPath), {
      timeout: 15_000,
      timeoutMsg: 'the removed attachment stayed in the pastes directory',
    });
  });

  it('attaches a pasted non-image file, streamed to disk, and sends it (SPEED-801)', async function () {
    this.timeout(240_000);
    const input = await $('[data-testid="chat-input"]');
    await input.waitForExist({ timeout: 15_000 });
    const before = new Set(pastedFileNames(PROJECT));

    await browser.execute((text: string) => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      if (!ta) return;
      const file = new File([text], 'e2e-note.txt', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      ta.dispatchEvent(ev);
    }, NOTE_TEXT);
    await waitForUploadToSettle();

    const note = newPastes(before).find((name) => name.endsWith('-e2e-note.txt'));
    expect(note).toBeDefined();
    expect(fs.readFileSync(pastedFilePath(PROJECT, note as string), 'utf8')).toBe(NOTE_TEXT);

    await sendMessageNoWait('Reply with the single word RECEIVED.');
    await $('[data-testid="user-message-file"]').waitForExist({
      timeout: 15_000,
      timeoutMsg: 'sent message did not render the file attachment pill',
    });
    await waitForTurnStart();
    await waitForTurnComplete(180_000);
  });

  it('deletes a conversation from history', async function () {
    this.timeout(60_000);
    await openHistory();
    const rows = await $$('[data-testid="conversations-sidebar-row"]').getElements();
    const before = rows.length;
    expect(before).toBeGreaterThan(0);

    const del = await rows[0].$('[data-testid^="conversation-delete-"]');
    await del.click();
    const confirmYes = await $('[data-testid^="conversation-confirm-yes-"]');
    await confirmYes.waitForExist({ timeout: 10_000 });
    await confirmYes.click();

    await browser.waitUntil(
      async () =>
        (await $$('[data-testid="conversations-sidebar-row"]').getElements()).length < before,
      { timeout: 15_000, timeoutMsg: 'conversation row count did not drop after delete' }
    );
  });
});

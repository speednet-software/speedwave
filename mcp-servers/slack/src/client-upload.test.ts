import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefreshLock } from '@speedwave/mcp-shared';
import type { WebClient } from '@slack/web-api';
import { uploadFile, MAX_UPLOAD_FILES, type SlackClients } from './client.js';

const VALID_TS = '1717000000.000100';

interface CapturedPost {
  url: string;
  init: RequestInit;
  received: string;
}

function uploadClients(): {
  clients: SlackClients;
  getUploadURLExternal: ReturnType<typeof vi.fn>;
  completeUploadExternal: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  const getUploadURLExternal = vi.fn().mockImplementation(async () => {
    n += 1;
    return { ok: true, upload_url: `https://files.slack.test/upload/${n}`, file_id: `F${n}` };
  });
  const completeUploadExternal = vi.fn().mockImplementation(async (args) => ({
    ok: true,
    files: args.files.map((f: { id: string; title: string }) => ({ id: f.id, title: f.title })),
  }));
  const list = vi.fn();
  const clients: SlackClients = {
    user: {
      token: 'xoxe.test',
      files: { getUploadURLExternal, completeUploadExternal },
      conversations: { list },
    } as unknown as WebClient,
    tokenState: { accessToken: 'xoxe.test' },
    lock: new RefreshLock(),
    _tokensStatus: 'present',
  };
  return { clients, getUploadURLExternal, completeUploadExternal, list };
}

async function drain(body: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  const stream = body as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString();
}

describe('uploadFile', () => {
  let base: string;
  let root: string;
  let previousWorkspace: string | undefined;
  let posts: CapturedPost[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'slack-upload-'));
    root = path.join(base, 'workspace');
    await fsp.mkdir(root);
    await fsp.writeFile(path.join(root, 'report.txt'), 'hello');
    await fsp.writeFile(path.join(root, 'second.txt'), 'world!!');
    await fsp.writeFile(path.join(base, 'secret.txt'), 'secret');
    previousWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = root;
    posts = [];
    fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      posts.push({ url, init, received: await drain(init.body) });
      return new Response('OK', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previousWorkspace;
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('streams one file to the upload URL and completes into a channel ID', async () => {
    const { clients, getUploadURLExternal, completeUploadExternal } = uploadClients();

    const result = await uploadFile(clients, {
      channel: 'C12345678',
      filePaths: ['report.txt'],
    });

    expect(getUploadURLExternal).toHaveBeenCalledWith({ filename: 'report.txt', length: 5 });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://files.slack.test/upload/1');
    expect(posts[0].init.method).toBe('POST');
    expect(posts[0].init.headers).toEqual({
      'Content-Type': 'application/octet-stream',
      'Content-Length': '5',
    });
    expect(posts[0].received).toBe('hello');
    expect(completeUploadExternal).toHaveBeenCalledTimes(1);
    const args = completeUploadExternal.mock.calls[0][0];
    expect(args).toEqual({ files: [{ id: 'F1', title: 'report.txt' }], channel_id: 'C12345678' });
    expect(args).not.toHaveProperty('thread_ts');
    expect(result).toEqual({
      ok: true,
      files: [{ id: 'F1', name: 'report.txt' }],
      channel: 'C12345678',
    });
  });

  it('passes a stream, not a Buffer, as the request body', async () => {
    const { clients } = uploadClients();

    await uploadFile(clients, { channel: 'C12345678', filePaths: ['report.txt'] });

    const init = fetchMock.mock.calls[0][1] as RequestInit & { duplex?: string };
    expect(Buffer.isBuffer(init.body)).toBe(false);
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.duplex).toBe('half');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('completes two files in one call and keeps their order', async () => {
    const { clients, completeUploadExternal } = uploadClients();

    const result = await uploadFile(clients, {
      channel: 'C12345678',
      filePaths: ['second.txt', 'report.txt'],
    });

    expect(posts.map((p) => p.received)).toEqual(['world!!', 'hello']);
    expect(completeUploadExternal).toHaveBeenCalledTimes(1);
    expect(completeUploadExternal.mock.calls[0][0].files).toEqual([
      { id: 'F1', title: 'second.txt' },
      { id: 'F2', title: 'report.txt' },
    ]);
    expect(result.files.map((f) => f.name)).toEqual(['second.txt', 'report.txt']);
  });

  it('uploads to a DM conversation ID', async () => {
    const { clients, completeUploadExternal } = uploadClients();

    await uploadFile(clients, { channel: 'D0123ABCD', filePaths: ['report.txt'] });

    expect(completeUploadExternal.mock.calls[0][0].channel_id).toBe('D0123ABCD');
  });

  it('resolves a #name through conversations.list', async () => {
    const { clients, completeUploadExternal, list } = uploadClients();
    list.mockResolvedValue({ ok: true, channels: [{ id: 'C777', name: 'general' }] });

    const result = await uploadFile(clients, { channel: '#general', filePaths: ['report.txt'] });

    expect(list).toHaveBeenCalledTimes(1);
    expect(completeUploadExternal.mock.calls[0][0].channel_id).toBe('C777');
    expect(result.channel).toBe('C777');
  });

  it('forwards thread_ts and initial_comment', async () => {
    const { clients, completeUploadExternal } = uploadClients();

    const result = await uploadFile(clients, {
      channel: 'C12345678',
      filePaths: ['report.txt'],
      thread_ts: VALID_TS,
      initial_comment: 'Weekly report',
    });

    const args = completeUploadExternal.mock.calls[0][0];
    expect(args.thread_ts).toBe(VALID_TS);
    expect(args.initial_comment).toBe('Weekly report');
    expect(result.thread_ts).toBe(VALID_TS);
  });

  describe('validation before any Slack or network call', () => {
    async function expectRejected(
      params: Parameters<typeof uploadFile>[1],
      message: RegExp | string
    ): Promise<void> {
      const { clients, getUploadURLExternal, completeUploadExternal, list } = uploadClients();
      await expect(uploadFile(clients, params)).rejects.toThrow(message);
      expect(getUploadURLExternal).not.toHaveBeenCalled();
      expect(completeUploadExternal).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }

    it('rejects an empty filePaths array', async () => {
      await expectRejected({ channel: 'C12345678', filePaths: [] }, /filePaths/);
    });

    it('rejects an empty path string', async () => {
      await expectRejected({ channel: 'C12345678', filePaths: [''] }, /filePaths/);
    });

    it('rejects more than MAX_UPLOAD_FILES files', async () => {
      const filePaths = Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => 'report.txt');
      await expectRejected({ channel: 'C12345678', filePaths }, new RegExp(`${MAX_UPLOAD_FILES}`));
    });

    it('rejects duplicate paths', async () => {
      await expectRejected(
        { channel: 'C12345678', filePaths: ['report.txt', 'report.txt'] },
        /report\.txt.*(twice|duplicate)/i
      );
    });

    it('rejects two spellings of the same file', async () => {
      await expectRejected(
        { channel: 'C12345678', filePaths: ['report.txt', path.join(root, 'report.txt')] },
        /(twice|duplicate)/i
      );
    });

    it('rejects a path outside the workspace', async () => {
      await expectRejected(
        { channel: '#general', filePaths: ['report.txt', '../secret.txt'] },
        'filePath must resolve to a location inside the workspace'
      );
    });

    it('rejects a malformed thread_ts', async () => {
      await expectRejected(
        { channel: 'C12345678', filePaths: ['report.txt'], thread_ts: '1717000000' },
        /does not look like a Slack timestamp/
      );
    });
  });

  it('names the file and says nothing was shared when the upload POST fails', async () => {
    const { clients, completeUploadExternal } = uploadClients();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      await drain(init.body);
      return new Response('boom', { status: 500 });
    });

    const failure = uploadFile(clients, {
      channel: 'C12345678',
      filePaths: ['report.txt', 'second.txt'],
    });

    await expect(failure).rejects.toThrow(/report\.txt.*500.*no file was shared/is);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(completeUploadExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['upload_url', { ok: true, file_id: 'F1' }],
    ['file_id', { ok: true, upload_url: 'https://files.slack.test/upload/1' }],
  ])('refuses to continue when Slack returns no %s', async (_missing, response) => {
    const { clients, getUploadURLExternal, completeUploadExternal } = uploadClients();
    getUploadURLExternal.mockResolvedValue(response);

    const failure = uploadFile(clients, { channel: 'C12345678', filePaths: ['report.txt'] });

    await expect(failure).rejects.toThrow(/report\.txt.*no file was shared/is);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(completeUploadExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('socket hang up'), 'socket hang up'],
    ['a non-Error value', 'connection reset', 'connection reset'],
  ])('names the file and the cause when fetch rejects with %s', async (_kind, rejection, cause) => {
    const { clients, completeUploadExternal } = uploadClients();
    fetchMock.mockRejectedValue(rejection);

    const failure = uploadFile(clients, { channel: 'C12345678', filePaths: ['report.txt'] });

    await expect(failure).rejects.toThrow(
      new RegExp(`report\\.txt.*${cause}.*no file was shared`, 'is')
    );
    expect(completeUploadExternal).not.toHaveBeenCalled();
  });

  it('propagates a Slack API error', async () => {
    const { clients, getUploadURLExternal } = uploadClients();
    getUploadURLExternal.mockRejectedValue({ data: { error: 'missing_scope' } });

    await expect(
      uploadFile(clients, { channel: 'C12345678', filePaths: ['report.txt'] })
    ).rejects.toMatchObject({ data: { error: 'missing_scope' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

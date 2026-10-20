import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefreshLock } from '@speedwave/mcp-shared';
import type { WebClient } from '@slack/web-api';
import { uploadFile, type SlackClients } from './client.js';

const VALID_TS = '1717000000.000100';

function uploadClients(): {
  clients: SlackClients;
  filesUploadV2: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  const filesUploadV2 = vi.fn().mockResolvedValue({
    ok: true,
    files: [{ ok: true, files: [{ id: 'F0UPLOAD1', title: 'report.txt' }] }],
  });
  const list = vi.fn();
  const clients: SlackClients = {
    user: {
      token: 'xoxe.test',
      filesUploadV2,
      conversations: { list },
    } as unknown as WebClient,
    tokenState: { accessToken: 'xoxe.test' },
    lock: new RefreshLock(),
    _tokensStatus: 'present',
  };
  return { clients, filesUploadV2, list };
}

describe('uploadFile', () => {
  let base: string;
  let root: string;
  let previousWorkspace: string | undefined;

  beforeEach(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'slack-upload-'));
    root = path.join(base, 'workspace');
    await fsp.mkdir(root);
    await fsp.writeFile(path.join(root, 'report.txt'), 'hello');
    await fsp.writeFile(path.join(base, 'secret.txt'), 'secret');
    previousWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = root;
  });

  afterEach(async () => {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previousWorkspace;
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('uploads to a channel by ID with default title and no thread', async () => {
    const { clients, filesUploadV2 } = uploadClients();

    const result = await uploadFile(clients, { channel: 'C12345678', filePath: 'report.txt' });

    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const args = filesUploadV2.mock.calls[0][0];
    expect(args.channel_id).toBe('C12345678');
    expect(Buffer.from(args.file).toString()).toBe('hello');
    expect(args.filename).toBe('report.txt');
    expect(args.title).toBe('report.txt');
    expect(args).not.toHaveProperty('thread_ts');
    expect(args).not.toHaveProperty('initial_comment');
    expect(result).toEqual({
      ok: true,
      file: { id: 'F0UPLOAD1', name: 'report.txt', title: 'report.txt' },
      channel: 'C12345678',
    });
  });

  it('uploads to a DM conversation ID', async () => {
    const { clients, filesUploadV2 } = uploadClients();

    await uploadFile(clients, { channel: 'D0123ABCD', filePath: 'report.txt' });

    expect(filesUploadV2.mock.calls[0][0].channel_id).toBe('D0123ABCD');
  });

  it('resolves a #name through conversations.list', async () => {
    const { clients, filesUploadV2, list } = uploadClients();
    list.mockResolvedValue({ ok: true, channels: [{ id: 'C777', name: 'general' }] });

    const result = await uploadFile(clients, { channel: '#general', filePath: 'report.txt' });

    expect(list).toHaveBeenCalledTimes(1);
    expect(filesUploadV2.mock.calls[0][0].channel_id).toBe('C777');
    expect(result.channel).toBe('C777');
  });

  it('forwards thread_ts, initial_comment and title', async () => {
    const { clients, filesUploadV2 } = uploadClients();

    const result = await uploadFile(clients, {
      channel: 'C12345678',
      filePath: 'report.txt',
      thread_ts: VALID_TS,
      initial_comment: 'Weekly report',
      title: 'Report W42',
    });

    const args = filesUploadV2.mock.calls[0][0];
    expect(args.thread_ts).toBe(VALID_TS);
    expect(args.initial_comment).toBe('Weekly report');
    expect(args.title).toBe('Report W42');
    expect(args.filename).toBe('report.txt');
    expect(result.thread_ts).toBe(VALID_TS);
  });

  it('rejects a malformed thread_ts without calling Slack', async () => {
    const { clients, filesUploadV2 } = uploadClients();

    await expect(
      uploadFile(clients, { channel: 'C12345678', filePath: 'report.txt', thread_ts: '1717000000' })
    ).rejects.toThrow(/does not look like a Slack timestamp/);
    expect(filesUploadV2).not.toHaveBeenCalled();
  });

  it('rejects a path outside the workspace without calling Slack', async () => {
    const { clients, filesUploadV2, list } = uploadClients();

    await expect(
      uploadFile(clients, { channel: '#general', filePath: '../secret.txt' })
    ).rejects.toThrow('filePath must resolve to a location inside the workspace');
    expect(filesUploadV2).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('propagates a Slack API error', async () => {
    const { clients, filesUploadV2 } = uploadClients();
    filesUploadV2.mockRejectedValue({ data: { error: 'missing_scope' } });

    await expect(
      uploadFile(clients, { channel: 'C12345678', filePath: 'report.txt' })
    ).rejects.toMatchObject({ data: { error: 'missing_scope' } });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefreshLock, type ToolsCallResult } from '@speedwave/mcp-shared';
import type { WebClient } from '@slack/web-api';
import { createToolDefinitions } from './index.js';
import { MAX_UPLOAD_FILES, type SlackClients } from '../client.js';

const VALID_TS = '1717000000.000100';
const EM_DASH = String.fromCharCode(0x2014);

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

interface Rejection {
  code: string;
  message: string;
}

const rejectionOf = (result: ToolsCallResult): Rejection => {
  expect(result.isError).toBe(true);
  return JSON.parse(textOf(result)) as Rejection;
};

function slackApi() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: VALID_TS, channel: 'C12345678' }),
    },
    conversations: {
      list: vi.fn().mockResolvedValue({ ok: true, channels: [] }),
      history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      replies: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      open: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'D1' } }),
    },
    files: {
      info: vi.fn().mockResolvedValue({ ok: true }),
      getUploadURLExternal: vi.fn().mockResolvedValue({ ok: true }),
      completeUploadExternal: vi.fn().mockResolvedValue({ ok: true }),
    },
    users: {
      lookupByEmail: vi.fn().mockRejectedValue({ data: { error: 'users_not_found' } }),
      info: vi.fn().mockResolvedValue({ ok: true }),
      list: vi.fn().mockResolvedValue({ ok: true, members: [] }),
    },
    auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U1' }) },
  };
}

function apiCallCount(api: ReturnType<typeof slackApi>): number {
  const spies = [
    ...Object.values(api.chat),
    ...Object.values(api.conversations),
    ...Object.values(api.files),
    ...Object.values(api.users),
    ...Object.values(api.auth),
  ];
  return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

function presentClients(api: ReturnType<typeof slackApi>): SlackClients {
  return {
    user: { token: 'xoxe.test', ...api } as unknown as WebClient,
    tokenState: { accessToken: 'xoxe.test' },
    lock: new RefreshLock(),
    _tokensStatus: 'present',
  };
}

describe('Slack tool parameter contract', () => {
  let api: ReturnType<typeof slackApi>;
  let call: (name: string, params: Record<string, unknown>) => Promise<ToolsCallResult>;
  let base: string;
  let previousWorkspace: string | undefined;

  beforeEach(async () => {
    api = slackApi();
    const definitions = createToolDefinitions(presentClients(api));
    call = (name, params) => definitions.find((d) => d.tool.name === name)!.handler(params);
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'slack-param-contract-'));
    const root = path.join(base, 'workspace');
    await fsp.mkdir(root);
    await fsp.writeFile(path.join(root, 'report.txt'), 'hello');
    previousWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = root;
  });

  afterEach(async () => {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previousWorkspace;
    await fsp.rm(base, { recursive: true, force: true });
  });

  describe.each(
    createToolDefinitions({ _tokensStatus: 'missing' } as SlackClients).map(
      (d) => [d.tool.name, d.tool] as const
    )
  )('declared-parameter guard on %s', (name, tool) => {
    it('rejects an undeclared argument before any Slack call', async () => {
      const result = await call(name, { not_a_declared_param: 1 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Invalid not_a_declared_param.');
      expect(textOf(result)).toContain(`${name} does not accept this parameter`);
      expect(apiCallCount(api)).toBe(0);
    });

    it.each(tool.inputSchema.required ?? [])(
      'rejects a call without the required %s before any Slack call',
      async () => {
        const result = await call(name, {});

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${name} requires`);
        expect(apiCallCount(api)).toBe(0);
      }
    );

    it('declares every argument its input examples use', () => {
      const declared = Object.keys(tool.inputSchema.properties);
      for (const example of tool.inputExamples ?? []) {
        expect(declared, example.description).toEqual(
          expect.arrayContaining(Object.keys(example.input))
        );
      }
    });
  });

  describe('thread_ts', () => {
    const badTs = '1717000000';

    it.each([
      ['sendChannel', { channel: 'C12345678', message: 'hi', thread_ts: badTs }],
      ['getThreadMessages', { channel: 'C12345678', thread_ts: badTs }],
      ['uploadFile', { channel: 'C12345678', filePaths: ['report.txt'], thread_ts: badTs }],
    ])('%s rejects a malformed thread_ts with a teaching error', async (name, params) => {
      const rejection = rejectionOf(await call(name, params));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toMatch(/^Invalid thread_ts \(received: "1717000000"\)\./);
      expect(rejection.message).toContain(
        'Get a valid value from getChannelMessages or getThreadMessages.'
      );
      expect(rejection.message).toContain('"1717000000.000100"');
      expect(rejection.message).not.toContain(EM_DASH);
      expect(apiCallCount(api)).toBe(0);
    });
  });

  describe('thread_ts as a number', () => {
    it('sendChannel rejects a numeric thread_ts that lost its trailing digits', async () => {
      const rejection = rejectionOf(
        await call('sendChannel', {
          channel: 'C12345678',
          message: 'hi',
          thread_ts: 1717000000.0001,
        })
      );

      expect(rejection.message).toMatch(/^Invalid thread_ts \(received: 1717000000\.0001\)\./);
      expect(apiCallCount(api)).toBe(0);
    });
  });

  describe('reply_broadcast', () => {
    it('rejects a non-boolean value and says why a string is dangerous', async () => {
      const rejection = rejectionOf(
        await call('sendChannel', {
          channel: 'C12345678',
          message: 'hi',
          thread_ts: VALID_TS,
          reply_broadcast: 'false',
        })
      );

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toMatch(/^Invalid reply_broadcast \(received: "false"\)\./);
      expect(rejection.message).toContain('Pass true or false');
      expect(rejection.message).toContain('would be read as true');
      expect(apiCallCount(api)).toBe(0);
    });

    it('rejects true without thread_ts and names where a thread_ts comes from', async () => {
      const rejection = rejectionOf(
        await call('sendChannel', { channel: 'C12345678', message: 'hi', reply_broadcast: true })
      );

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toMatch(/^Invalid reply_broadcast \(received: true\)\./);
      expect(rejection.message).toContain('thread_ts');
      expect(rejection.message).toContain('getChannelMessages');
      expect(apiCallCount(api)).toBe(0);
    });
  });

  describe('filePaths', () => {
    const upload = (filePaths: unknown) => call('uploadFile', { channel: 'C12345678', filePaths });

    it.each([
      ['an empty array', []],
      ['an empty path', ['']],
      ['a non-array', 'report.txt'],
      ['a non-string entry', [42]],
    ])('rejects %s with a teaching error', async (_label, filePaths) => {
      const rejection = rejectionOf(await upload(filePaths));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toContain('Invalid filePaths (received: ');
      expect(rejection.message).toContain('non-empty array of non-empty path strings');
      expect(apiCallCount(api)).toBe(0);
    });

    it('rejects more than MAX_UPLOAD_FILES entries and says to split the call', async () => {
      const filePaths = Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => 'report.txt');

      const rejection = rejectionOf(await upload(filePaths));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toContain(`${MAX_UPLOAD_FILES + 1} entries`);
      expect(rejection.message).toContain(`at most ${MAX_UPLOAD_FILES}`);
      expect(rejection.message).toContain('several calls');
      expect(apiCallCount(api)).toBe(0);
    });

    it('rejects the same file listed twice and names the duplicate', async () => {
      const rejection = rejectionOf(await upload(['report.txt', 'report.txt']));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toMatch(/^Invalid filePaths \(received: "report\.txt"\)\./);
      expect(rejection.message).toContain('listed twice');
      expect(rejection.message).toContain('Remove the duplicate');
      expect(apiCallCount(api)).toBe(0);
    });

    it('rejects two spellings of the same file as a duplicate', async () => {
      const absolute = path.join(process.env.WORKSPACE_DIR as string, 'report.txt');

      const rejection = rejectionOf(await upload(['report.txt', absolute]));

      expect(rejection.message).toContain('listed twice');
      expect(apiCallCount(api)).toBe(0);
    });

    it('rejects a file that is not under the workspace and says what to do', async () => {
      const rejection = rejectionOf(await upload(['report.txt', '../secret.txt']));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toMatch(/^Invalid filePaths \(received: "\.\.\/secret\.txt"\)\./);
      expect(rejection.message).toContain('File not found under workspace');
      expect(apiCallCount(api)).toBe(0);
    });
  });

  describe('users', () => {
    const open = (users: unknown) => call('openDirectMessage', { users });

    it.each([
      ['an empty array', []],
      ['a non-array', 'U0123ABCD456'],
    ])('rejects %s and points at findUsers', async (_label, users) => {
      const rejection = rejectionOf(await open(users));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toContain('Invalid users (received: ');
      expect(rejection.message).toContain('Get a valid value from findUsers.');
      expect(rejection.message).toContain('1-8');
      expect(apiCallCount(api)).toBe(0);
    });

    it('rejects more than 8 participants', async () => {
      const nine = Array.from({ length: 9 }, () => 'U0123ABCD456');

      const rejection = rejectionOf(await open(nine));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toMatch(/^Invalid users\. Get a valid value from findUsers\./);
      expect(rejection.message).toContain('at most 8 people');
      expect(rejection.message).toContain('got 9');
      expect(apiCallCount(api)).toBe(0);
    });

    it.each([
      ['a plain name', 'Pawel'],
      ['a name that starts like a user ID', 'Wanda'],
      ['a full name', 'Wojciech Nowak'],
      ['an all-alphabetic word that starts with U', 'UNITEDSTATES'],
      ['a lowercase all-alphabetic word that starts with w', 'workspaces'],
      ['an ID one character short', 'U0123456'],
      ['a non-string entry', 42],
    ])('rejects %s and points at findUsers', async (_label, entry) => {
      const rejection = rejectionOf(await open([entry]));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toContain('Invalid users (received: ');
      expect(rejection.message).toContain('Get a valid value from findUsers.');
      expect(rejection.message).toContain('not a user ID or e-mail address');
      expect(apiCallCount(api)).toBe(0);
    });

    it('rejects an e-mail no Slack user has and points at findUsers', async () => {
      const unknownEmail = ['nobody', 'example.com'].join('@');
      const rejection = rejectionOf(await open([unknownEmail]));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toContain(`(received: "${unknownEmail}")`);
      expect(rejection.message).toContain('Get a valid value from findUsers.');
      expect(rejection.message).toContain('No Slack user has this e-mail address');
      expect(api.conversations.open).not.toHaveBeenCalled();
    });
  });

  describe('channel', () => {
    it.each([
      ['sendChannel', { channel: 'nonexistent', message: 'hi' }],
      ['getChannelMessages', { channel: 'nonexistent' }],
      ['getThreadMessages', { channel: 'nonexistent', thread_ts: VALID_TS }],
      ['uploadFile', { channel: 'nonexistent', filePaths: ['report.txt'] }],
    ])('%s rejects an unknown channel and points at listChannelIds', async (name, params) => {
      const rejection = rejectionOf(await call(name, params));

      expect(rejection.code).toBe('INVALID_PARAM');
      expect(rejection.message).toMatch(/^Invalid channel \(received: "nonexistent"\)\./);
      expect(rejection.message).toContain('Get a valid value from listChannelIds.');
      expect(rejection.message).toContain('findUsers then openDirectMessage');
      expect(rejection.message).not.toContain(EM_DASH);
      expect(api.chat.postMessage).not.toHaveBeenCalled();
      expect(api.files.getUploadURLExternal).not.toHaveBeenCalled();
    });
  });

  describe('Slack API errors', () => {
    it('keeps a Slack API error on formatSlackError with the tool failure code', async () => {
      api.chat.postMessage.mockRejectedValue({ data: { error: 'not_in_channel' } });

      const rejection = rejectionOf(
        await call('sendChannel', { channel: 'C12345678', message: 'hi' })
      );

      expect(rejection.code).toBe('SEND_FAILED');
      expect(rejection.message).toContain('not a member of this channel');
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSetupGuidance, RefreshLock, OAuthRefreshError } from '@speedwave/mcp-shared';
import {
  formatSlackError,
  isSlackAuthExpiredError,
  slackCall,
  SlackClients,
  initializeSlackClients,
  sendChannel,
  readChannel,
  readThread,
  getChannels,
  getFileContent,
  downloadFile,
  getUsers,
  getCurrentUser,
  listDms,
  openDm,
} from './client.js';
import { WebClient } from '@slack/web-api';
import fs from 'fs/promises';

// Mock WebClient constructor function
const mockWebClientInstance = {
  chat: {
    postMessage: vi.fn(),
  },
  conversations: {
    list: vi.fn(),
    history: vi.fn(),
  },
  users: {
    lookupByEmail: vi.fn(),
  },
  // Background auth.test defaults to success; override per-test with mockResolvedValueOnce
  auth: {
    test: vi.fn().mockResolvedValue({ ok: true }),
  },
};

// Class mock records the token so slackCall's rotate-on-change check (client.token !== token) works
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function (
    this: typeof mockWebClientInstance & { token?: string },
    token?: string
  ) {
    Object.assign(this, mockWebClientInstance);
    this.token = token;
  }),
}));

// Mock both named and default-object fs exports (oauth-client imports named; refresh reads bearer)
const { readFileMock, mkdirMock, writeFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('fs/promises', () => ({
  default: { readFile: readFileMock, mkdir: mkdirMock, writeFile: writeFileMock },
  readFile: readFileMock,
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

/** Configured client container whose user mock keeps per-test method stubs. */
function presentClients(): SlackClients {
  return {
    user: {
      token: 'xoxe.xoxp-test',
      chat: { postMessage: vi.fn() },
      conversations: { list: vi.fn(), history: vi.fn(), replies: vi.fn(), open: vi.fn() },
      users: { lookupByEmail: vi.fn(), info: vi.fn() },
      files: { info: vi.fn() },
      auth: { test: vi.fn() },
    } as unknown as WebClient,
    tokenState: { accessToken: 'xoxe.xoxp-test' },
    lock: new RefreshLock(),
    _tokensStatus: 'present',
  };
}

describe('slack client', () => {
  describe('formatSlackError', () => {
    it('formats authentication errors with reconnect guidance', () => {
      const errors = [
        { data: { error: 'not_authed' } },
        { data: { error: 'invalid_auth' } },
        { data: { error: 'token_expired' } },
        { data: { error: 'token_revoked' } },
      ];

      for (const error of errors) {
        const message = formatSlackError(error);
        expect(message).toBe(
          withSetupGuidance(
            'Slack authentication failed. Reconnect Slack in Speedwave Desktop (Integrations → Slack).'
          )
        );
      }
    });

    it('maps an invalid_grant refresh failure to reconnect guidance', () => {
      const error = new OAuthRefreshError('tool_error', 'invalid_grant: token_revoked');
      const message = formatSlackError(error);
      expect(message).toBe(
        withSetupGuidance(
          'Slack sign-in expired. Reconnect Slack in Speedwave Desktop (Integrations → Slack).'
        )
      );
    });

    it('surfaces other refresh failures with their detail', () => {
      const error = new OAuthRefreshError('worker_unreachable', 'cannot reach oauth worker');
      const message = formatSlackError(error);
      expect(message).toBe('Slack token refresh failed: cannot reach oauth worker');
    });

    it('formats permission errors', () => {
      const errors = [
        { data: { error: 'missing_scope' } },
        { data: { error: 'restricted_action' } },
      ];

      for (const error of errors) {
        const message = formatSlackError(error);
        expect(message).toContain('Permission denied');
      }
    });

    it('formats channel not found error', () => {
      const error = { data: { error: 'channel_not_found' } };
      const message = formatSlackError(error);
      expect(message).toBe('Channel not found in Slack.');
    });

    it('formats user not found errors', () => {
      const errors = [
        { data: { error: 'users_not_found' } },
        { data: { error: 'user_not_found' } },
      ];

      for (const error of errors) {
        const message = formatSlackError(error);
        expect(message).toBe('User not found in Slack.');
      }
    });

    it('formats rate limit error', () => {
      const error = { data: { error: 'ratelimited' } };
      const message = formatSlackError(error);
      expect(message).toBe('Rate limit exceeded. Please try again later.');
    });

    it('formats an archived-channel error', () => {
      const error = { data: { error: 'is_archived' } };
      const message = formatSlackError(error);
      expect(message).toContain('archived');
      expect(message).toContain('Choose a different channel');
    });

    it('formats a message-too-long error', () => {
      const error = { data: { error: 'msg_too_long' } };
      const message = formatSlackError(error);
      expect(message).toContain("Slack's length limit");
    });

    it('formats a not-in-channel error with a listChannelIds pointer', () => {
      const error = { data: { error: 'not_in_channel' } };
      const message = formatSlackError(error);
      expect(message).toContain('not a member of this channel');
      expect(message).toContain('listChannelIds');
    });

    it('formats a cant-dm-bot error', () => {
      const error = { data: { error: 'cant_dm_bot' } };
      const message = formatSlackError(error);
      expect(message).toContain('cannot receive DMs');
    });

    it('formats no_text and invalid_arguments as a missing/malformed-field error', () => {
      for (const code of ['no_text', 'invalid_arguments']) {
        const message = formatSlackError({ data: { error: code } });
        expect(message).toContain('missing or malformed');
      }
    });

    it('formats network errors', () => {
      const errors = [{ message: 'getaddrinfo ENOTFOUND slack.com' }, { message: 'ECONNREFUSED' }];

      for (const error of errors) {
        const message = formatSlackError(error);
        expect(message).toContain('Network error');
      }
    });

    it('formats unknown Slack API errors', () => {
      const error = { data: { error: 'some_unknown_error' } };
      const message = formatSlackError(error);
      expect(message).toBe('Slack API error: some_unknown_error');
    });

    it('falls back to error message', () => {
      const error = { message: 'Something went wrong' };
      const message = formatSlackError(error);
      expect(message).toBe('Something went wrong');
    });

    it('returns default message when no details available', () => {
      const error = {};
      const message = formatSlackError(error);
      expect(message).toBe('Slack API error');
    });

    it('handles error property directly', () => {
      const error = { error: 'channel_not_found' };
      const message = formatSlackError(error);
      expect(message).toBe('Channel not found in Slack.');
    });
  });

  describe('isSlackAuthExpiredError', () => {
    it('matches token_expired and invalid_auth', () => {
      expect(isSlackAuthExpiredError({ data: { error: 'token_expired' } })).toBe(true);
      expect(isSlackAuthExpiredError({ data: { error: 'invalid_auth' } })).toBe(true);
    });

    it('treats terminal states as non-refreshable', () => {
      expect(isSlackAuthExpiredError({ data: { error: 'token_revoked' } })).toBe(false);
      expect(isSlackAuthExpiredError({ data: { error: 'account_inactive' } })).toBe(false);
    });

    it('ignores non-auth errors and malformed shapes', () => {
      expect(isSlackAuthExpiredError({ data: { error: 'channel_not_found' } })).toBe(false);
      expect(isSlackAuthExpiredError(new Error('boom'))).toBe(false);
      expect(isSlackAuthExpiredError(undefined)).toBe(false);
      expect(isSlackAuthExpiredError(null)).toBe(false);
    });
  });

  describe('initializeSlackClients', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('successfully initializes the client with a valid access token', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('xoxe.xoxp-access-token-123\n');

      const clients = await initializeSlackClients();

      expect(clients._tokensStatus).toBe('present');
      expect(clients.user).toBeDefined();
      expect(clients.tokenState.accessToken).toBe('xoxe.xoxp-access-token-123');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('✅ Slack: Access token loaded')
      );
    });

    it('returns _tokensStatus=missing when the access token is empty', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('  \n');

      const result = await initializeSlackClients();
      expect(result._tokensStatus).toBe('missing');
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Slack access token is empty or missing')
      );
    });

    it('returns _tokensStatus=missing when the token cannot be read', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT: no such file'));

      const result = await initializeSlackClients();
      expect(result._tokensStatus).toBe('missing');
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load Slack access token')
      );
    });

    it('wraps a non-Error fs rejection into an errno-aware message (still returns missing)', async () => {
      // Non-Error rejection is wrapped so its message (not "Unknown error") surfaces in the warning
      vi.mocked(fs.readFile).mockRejectedValueOnce('plain string failure');

      const result = await initializeSlackClients();
      expect(result._tokensStatus).toBe('missing');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('plain string failure'));
    });

    it('trims whitespace from the access token', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('  xoxe.xoxp-access-token-123  \n');

      const clients = await initializeSlackClients();

      expect(clients._tokensStatus).toBe('present');
      expect(WebClient).toHaveBeenCalledWith('xoxe.xoxp-access-token-123');
    });

    it('background auth.test failure marks tracker failed (covers !res.ok throw path)', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('xoxe.xoxp-access-token-123');
      mockWebClientInstance.auth.test.mockResolvedValueOnce({
        ok: false,
        error: 'account_inactive',
      });

      const clients = await initializeSlackClients();
      expect(clients._tokensStatus).toBe('present');
      // Wait for the background promise to settle.
      await vi.waitFor(() => expect(clients.statusTracker!.getStatus()).toBe('failed'));
      expect(clients.statusTracker!.getError()).toContain('account_inactive');
    });

    it('background auth.test reporting not-ok without explicit error uses fallback message', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('xoxe.xoxp-access-token-123');
      mockWebClientInstance.auth.test.mockResolvedValueOnce({ ok: false });

      const clients = await initializeSlackClients();
      await vi.waitFor(() => expect(clients.statusTracker!.getStatus()).toBe('failed'));
      expect(clients.statusTracker!.getError()).toContain('auth.test reported not ok');
    });
  });

  describe('slackCall', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.WORKER_OAUTH_URL = 'http://oauth.test/mcp';
    });

    afterEach(() => {
      delete process.env.WORKER_OAUTH_URL;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    /** Stubs the oauth worker JSON-RPC refresh round-trip as a success. */
    function stubOauthWorkerSuccess(): void {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            jsonrpc: '2.0',
            id: '1',
            result: {
              content: [
                { type: 'text', text: JSON.stringify({ expiresIn: 43200, grantedScopes: [] }) },
              ],
            },
          }),
        })
      );
    }

    it('refreshes once on token_expired and retries with the rotated token', async () => {
      stubOauthWorkerSuccess();
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('bearer-uuid') // /secrets/oauth-auth-token-slack
        .mockResolvedValueOnce('xoxe.xoxp-rotated\n'); // /tokens/access_token re-read

      const clients = presentClients();
      const apiCall = vi
        .fn()
        .mockRejectedValueOnce({ data: { error: 'token_expired' } })
        .mockResolvedValueOnce({ ok: true });

      const result = await slackCall(clients, (c) => apiCall(c));

      expect(result).toEqual({ ok: true });
      expect(apiCall).toHaveBeenCalledTimes(2);
      expect(clients.tokenState.accessToken).toBe('xoxe.xoxp-rotated');
      // WebClient recreated with the rotated token (state transition).
      expect(WebClient).toHaveBeenCalledWith('xoxe.xoxp-rotated');
      expect(clients.user.token).toBe('xoxe.xoxp-rotated');
    });

    it('does not refresh on a terminal token_revoked error', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const clients = presentClients();
      const apiCall = vi.fn().mockRejectedValue({ data: { error: 'token_revoked' } });

      await expect(slackCall(clients, (c) => apiCall(c))).rejects.toEqual({
        data: { error: 'token_revoked' },
      });
      expect(apiCall).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('propagates a refresh failure without retrying the call', async () => {
      // No WORKER_OAUTH_URL → refreshAccessToken throws not_configured.
      delete process.env.WORKER_OAUTH_URL;
      const clients = presentClients();
      const apiCall = vi.fn().mockRejectedValue({ data: { error: 'token_expired' } });

      await expect(slackCall(clients, (c) => apiCall(c))).rejects.toThrow(OAuthRefreshError);
      expect(apiCall).toHaveBeenCalledTimes(1);
    });

    it('reuses the existing WebClient when the token has not changed', async () => {
      const clients = presentClients();
      const seen: unknown[] = [];
      await slackCall(clients, async (c) => {
        seen.push(c);
        return 'ok';
      });
      expect(seen[0]).toBe(clients.user);
      expect(WebClient).not.toHaveBeenCalled();
    });
  });

  describe('sendChannel', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    it('sends message to channel by ID', async () => {
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });
      mockClients.user.chat.postMessage = mockPostMessage;

      const result = await sendChannel(mockClients, {
        channel: 'C12345678',
        message: 'Hello, world!',
      });

      expect(result).toEqual({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C12345678',
        text: 'Hello, world!',
      });
    });

    it('sends message to channel by name', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          { id: 'C12345678', name: 'general', name_normalized: 'general' },
          { id: 'C87654321', name: 'random', name_normalized: 'random' },
        ],
      });
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });

      mockClients.user.conversations.list = mockList;
      mockClients.user.chat.postMessage = mockPostMessage;

      const result = await sendChannel(mockClients, {
        channel: 'general',
        message: 'Hello, general!',
      });

      expect(result.ok).toBe(true);
      expect(result.channel).toBe('C12345678');
      expect(mockList).toHaveBeenCalledWith({
        types: 'public_channel,private_channel',
        limit: 1000,
      });
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C12345678',
        text: 'Hello, general!',
      });
    });

    it('resolves a channel that lives on a later list page', async () => {
      // Pagination: a channel on page 2+ must still resolve even when pages are sparse
      const mockList = vi
        .fn()
        .mockResolvedValueOnce({
          channels: [{ id: 'C1', name: 'general' }],
          response_metadata: { next_cursor: 'cur-2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C9', name: 'speedwave-devs-log' }],
          response_metadata: { next_cursor: '' },
        });
      const mockPostMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C9' });
      mockClients.user.conversations.list = mockList;
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, { channel: 'speedwave-devs-log', message: 'Hi' });

      expect(mockList).toHaveBeenCalledTimes(2);
      expect(mockList).toHaveBeenNthCalledWith(2, {
        types: 'public_channel,private_channel',
        limit: 1000,
        cursor: 'cur-2',
      });
      expect(mockPostMessage).toHaveBeenCalledWith({ channel: 'C9', text: 'Hi' });
    });

    it('stops resolving on a found name without fetching further pages', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C1', name: 'general' }],
        response_metadata: { next_cursor: 'cur-2' },
      });
      const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
      mockClients.user.conversations.list = mockList;
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, { channel: 'general', message: 'Hi' });

      expect(mockList).toHaveBeenCalledTimes(1);
    });

    it('sends message to channel with # prefix', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C12345678', name: 'general', name_normalized: 'general' }],
      });
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });

      mockClients.user.conversations.list = mockList;
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, {
        channel: '#general',
        message: 'Hello!',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C12345678',
        text: 'Hello!',
      });
    });

    it('throws error when channel not found', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C12345678', name: 'general' }],
      });

      mockClients.user.conversations.list = mockList;

      await expect(
        sendChannel(mockClients, {
          channel: 'nonexistent',
          message: 'Hello!',
        })
      ).rejects.toThrow(
        'Channel not found: nonexistent. If this is a person, use findUsers then openDirectMessage. ' +
          'If it is a channel, call listChannelIds to see channels you (the signed-in user) are a ' +
          'member of — Speedwave has no bot to invite, so a missing channel usually means you are not a member.'
      );
    });

    it('resolves channel by normalized name', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C12345678', name: 'team-eng', name_normalized: 'team-eng' }],
      });
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });

      mockClients.user.conversations.list = mockList;
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, {
        channel: 'team-eng',
        message: 'Hello!',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C12345678',
        text: 'Hello!',
      });
    });

    it('handles response without ok field', async () => {
      const mockPostMessage = vi.fn().mockResolvedValue({
        ts: '1234567890.123456',
        channel: 'C12345678',
      });
      mockClients.user.chat.postMessage = mockPostMessage;

      const result = await sendChannel(mockClients, {
        channel: 'C12345678',
        message: 'Hello!',
      });

      expect(result.ok).toBe(false);
    });

    it('recognizes DM channel IDs', async () => {
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'D12345678',
      });
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, {
        channel: 'D12345678',
        message: 'Direct message',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'D12345678',
        text: 'Direct message',
      });
    });

    it('recognizes group channel IDs', async () => {
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'G12345678',
      });
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, {
        channel: 'G12345678',
        message: 'Group message',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'G12345678',
        text: 'Group message',
      });
    });
  });

  describe('readChannel', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    it('reads messages from channel by ID', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [
          {
            user: 'U123',
            text: 'Hello',
            ts: '1234567890.123456',
            type: 'message',
          },
          {
            user: 'U456',
            text: 'Hi there',
            ts: '1234567891.123456',
            type: 'message',
            username: 'bot_user',
          },
        ],
      });

      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({
        user: 'U123',
        text: 'Hello',
        ts: '1234567890.123456',
        type: 'message',
        username: undefined,
      });
      expect(result.messages[1]).toEqual({
        user: 'U456',
        text: 'Hi there',
        ts: '1234567891.123456',
        type: 'message',
        username: 'bot_user',
      });
      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 50,
      });
    });

    it('surfaces files metadata and attachment text from history', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [
          {
            user: 'U1',
            text: '',
            ts: '1.0',
            type: 'message',
            files: [{ id: 'F1', name: 'podsumowanie.md', mimetype: 'text/markdown', size: 1234 }],
          },
          {
            user: 'U2',
            text: '',
            ts: '2.0',
            type: 'message',
            attachments: [
              { title: 'SPW-208', text: 'spike: wybrac backend' },
              { fallback: 'Jira created a Task' },
            ],
          },
        ],
      });
      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, { channel: 'C12345678' });

      expect(result.messages[0].files).toEqual([
        {
          id: 'F1',
          name: 'podsumowanie.md',
          title: undefined,
          mimetype: 'text/markdown',
          size: 1234,
        },
      ]);
      expect(result.messages[1].attachments_text).toBe(
        'SPW-208: spike: wybrac backend\nJira created a Task'
      );
      // Plain messages carry neither key.
      expect(result.messages[0].attachments_text).toBeUndefined();
    });

    it('surfaces thread markers (thread_ts/reply_count) from history', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [
          { user: 'U1', text: 'parent', ts: '1.0', type: 'message', reply_count: 3 },
          { user: 'U2', text: 'broadcast reply', ts: '1.2', type: 'message', thread_ts: '1.0' },
        ],
      });
      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, { channel: 'C12345678' });

      expect(result.messages[0].reply_count).toBe(3);
      expect(result.messages[1].thread_ts).toBe('1.0');
    });

    it('reads messages from channel by name', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C12345678', name: 'general' }],
      });
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [],
      });

      mockClients.user.conversations.list = mockList;
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'general',
        limit: 50,
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 50,
      });
    });

    it('uses default limit of 50 (matches the tool schema)', async () => {
      const mockHistory = vi.fn().mockResolvedValue({ messages: [] });
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 50,
      });
    });

    it('clamps limit to minimum of 1', async () => {
      const mockHistory = vi.fn().mockResolvedValue({ messages: [] });
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'C12345678',
        limit: -5,
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 1,
      });
    });

    it('clamps limit to maximum of 100', async () => {
      const mockHistory = vi.fn().mockResolvedValue({ messages: [] });
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'C12345678',
        limit: 200,
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 100,
      });
    });

    it('forwards oldest/latest/cursor to conversations.history', async () => {
      const mockHistory = vi.fn().mockResolvedValue({ messages: [] });
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'C12345678',
        oldest: '1717000000.000000',
        latest: '1718000000.000000',
        cursor: 'cur-abc',
        limit: 10,
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 10,
        oldest: '1717000000.000000',
        latest: '1718000000.000000',
        cursor: 'cur-abc',
      });
    });

    it('returns next_cursor and has_more for a paginated response', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [{ user: 'U1', text: 'm', ts: '1.0', type: 'message' }],
        has_more: true,
        response_metadata: { next_cursor: 'cur-next' },
      });
      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, { channel: 'C12345678' });

      expect(result.next_cursor).toBe('cur-next');
      expect(result.has_more).toBe(true);
    });

    it('omits next_cursor on the last page (empty cursor string)', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [],
        has_more: false,
        response_metadata: { next_cursor: '' },
      });
      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, { channel: 'C12345678' });

      expect(result.next_cursor).toBeUndefined();
      expect(result.has_more).toBe(false);
    });

    it('derives has_more from next_cursor when has_more is absent', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [],
        response_metadata: { next_cursor: 'cur-next' },
      });
      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, { channel: 'C12345678' });

      expect(result.has_more).toBe(true);
    });

    it('handles messages with missing fields', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [
          {
            // Missing user, text, ts fields
            type: 'message',
          },
          {
            user: null,
            text: null,
            ts: null,
          },
        ],
      });

      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(result.messages[0]).toEqual({
        user: 'unknown',
        text: '',
        ts: '',
        type: 'message',
        username: undefined,
      });
      expect(result.messages[1]).toEqual({
        user: 'unknown',
        text: '',
        ts: '',
        type: 'message',
        username: undefined,
      });
    });

    it('handles empty messages array', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [],
      });

      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(result.messages).toEqual([]);
      expect(result.has_more).toBe(false);
    });

    it('handles missing messages array', async () => {
      const mockHistory = vi.fn().mockResolvedValue({});

      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(result.messages).toEqual([]);
    });
  });

  describe('readThread', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    it('reads a thread by channel ID with default limit', async () => {
      const mockReplies = vi.fn().mockResolvedValue({
        messages: [
          {
            user: 'U1',
            text: 'parent',
            ts: '1717000000.000100',
            type: 'message',
            reply_count: 1,
          },
          {
            user: 'U2',
            text: 'reply',
            ts: '1717000000.000200',
            type: 'message',
            thread_ts: '1717000000.000100',
          },
        ],
        has_more: false,
      });
      mockClients.user.conversations.replies = mockReplies;

      const result = await readThread(mockClients, {
        channel: 'C12345678',
        thread_ts: '1717000000.000100',
      });

      expect(mockReplies).toHaveBeenCalledWith({
        channel: 'C12345678',
        ts: '1717000000.000100',
        limit: 50,
      });
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].reply_count).toBe(1);
      expect(result.messages[1].thread_ts).toBe('1717000000.000100');
      expect(result.has_more).toBe(false);
      expect(result.limit_used).toBe(50);
    });

    it('resolves channel names and forwards cursor', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C77', name: 'general' }],
      });
      const mockReplies = vi.fn().mockResolvedValue({
        messages: [],
        has_more: true,
        response_metadata: { next_cursor: 'cur-next' },
      });
      mockClients.user.conversations.list = mockList;
      mockClients.user.conversations.replies = mockReplies;

      const result = await readThread(mockClients, {
        channel: '#general',
        thread_ts: '1717000000.000100',
        cursor: 'cur-1',
        limit: 7,
      });

      expect(mockReplies).toHaveBeenCalledWith({
        channel: 'C77',
        ts: '1717000000.000100',
        limit: 7,
        cursor: 'cur-1',
      });
      expect(result.next_cursor).toBe('cur-next');
      expect(result.has_more).toBe(true);
    });

    it('clamps limit to 1-100', async () => {
      const mockReplies = vi.fn().mockResolvedValue({ messages: [] });
      mockClients.user.conversations.replies = mockReplies;

      const result = await readThread(mockClients, {
        channel: 'C1',
        thread_ts: '1717000000.000100',
        limit: 500,
      });
      expect(mockReplies).toHaveBeenCalledWith({
        channel: 'C1',
        ts: '1717000000.000100',
        limit: 100,
      });
      expect(result.limit_used).toBe(100);
    });

    it('propagates API errors (e.g. thread_not_found)', async () => {
      const mockReplies = vi.fn().mockRejectedValue({ data: { error: 'thread_not_found' } });
      mockClients.user.conversations.replies = mockReplies;

      await expect(
        readThread(mockClients, { channel: 'C1', thread_ts: '1717000000.000900' })
      ).rejects.toEqual({
        data: { error: 'thread_not_found' },
      });
    });

    it('rejects a thread_ts that is not a genuine Slack timestamp before calling the API', async () => {
      const mockReplies = vi.fn();
      mockClients.user.conversations.replies = mockReplies;

      await expect(
        readThread(mockClients, { channel: 'C1', thread_ts: '1717000000' })
      ).rejects.toThrow(/does not look like a Slack timestamp/);
      await expect(
        readThread(mockClients, { channel: 'C1', thread_ts: '1717000000.0001' })
      ).rejects.toThrow(/does not look like a Slack timestamp/);
      expect(mockReplies).not.toHaveBeenCalled();
    });
  });

  describe('getFileContent', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubInfo(file: Record<string, unknown>): void {
      (mockClients.user.files.info as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        file,
      });
    }

    function stubDownload(body: string, contentType = 'text/markdown'): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: (h: string) => (h === 'content-type' ? contentType : null) },
        arrayBuffer: async () => {
          const b = Buffer.from(body, 'utf-8');
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('reads a text file with the bearer header', async () => {
      stubInfo({
        id: 'F1',
        name: 'podsumowanie.md',
        mimetype: 'text/markdown',
        size: 11,
        url_private: 'https://files.slack.com/files-pri/T1-F1/podsumowanie.md',
      });
      const fetchMock = stubDownload('# Heading\nx');

      const result = await getFileContent(mockClients, { file: 'F1' });

      expect(result).toEqual({
        id: 'F1',
        name: 'podsumowanie.md',
        mimetype: 'text/markdown',
        size: 11,
        content: '# Heading\nx',
        truncated: false,
      });
      const [, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer xoxe.xoxp-test',
      });
    });

    it('refuses binary files with actionable metadata', async () => {
      stubInfo({
        id: 'F2',
        name: 'screen.png',
        mimetype: 'image/png',
        size: 999,
        url_private: 'https://files.slack.com/files-pri/T1-F2/screen.png',
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(getFileContent(mockClients, { file: 'F2' })).rejects.toThrow(
        /image\/png — only text files/
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws on a file without url_private', async () => {
      stubInfo({ id: 'F3', name: 'gone' });
      await expect(getFileContent(mockClients, { file: 'F3' })).rejects.toThrow(
        /no downloadable content/
      );
    });

    it('treats an HTML login page as an auth failure (not file content)', async () => {
      stubInfo({
        id: 'F4',
        name: 'notes.md',
        mimetype: 'text/markdown',
        size: 5,
        url_private: 'https://files.slack.com/files-pri/T1-F4/notes.md',
      });
      stubDownload('<html>login</html>', 'text/html');
      // No WORKER_OAUTH_URL: refresh fails instead of returning the login page as content
      await expect(getFileContent(mockClients, { file: 'F4' })).rejects.toThrow();
    });

    it('rejects a huge text file from metadata without fetching', async () => {
      stubInfo({
        id: 'F9',
        name: 'giant.log',
        mimetype: 'text/plain',
        size: 100 * 1024 * 1024,
        url_private: 'https://files.slack.com/files-pri/T1-F9/giant.log',
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(getFileContent(mockClients, { file: 'F9' })).rejects.toThrow(
        /too large to read/
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects via Content-Length when files.info omitted the size', async () => {
      stubInfo({
        id: 'F10',
        name: 'nosize.log',
        mimetype: 'text/plain',
        url_private: 'https://files.slack.com/files-pri/T1-F10/nosize.log',
      });
      const arrayBuffer = vi.fn();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: {
            get: (h: string) => (h === 'content-length' ? String(100 * 1024 * 1024) : 'text/plain'),
          },
          arrayBuffer,
        })
      );

      await expect(getFileContent(mockClients, { file: 'F10' })).rejects.toThrow(
        /over the download cap/
      );
      expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('truncates oversized files and flags it', async () => {
      const big = 'a'.repeat(1024 * 1024 + 10);
      stubInfo({
        id: 'F5',
        name: 'big.log',
        mimetype: 'text/plain',
        size: big.length,
        url_private: 'https://files.slack.com/files-pri/T1-F5/big.log',
      });
      stubDownload(big, 'text/plain');

      const result = await getFileContent(mockClients, { file: 'F5' });
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBe(1024 * 1024);
    });
  });

  describe('downloadFile', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      process.env.WORKSPACE_DIR = '/ws';
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env.WORKSPACE_DIR;
    });

    function stubInfo(file: Record<string, unknown>): void {
      (mockClients.user.files.info as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        file,
      });
    }

    function stubDownload(
      bytes: Buffer,
      contentType = 'application/pdf'
    ): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: (h: string) => (h === 'content-type' ? contentType : null) },
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('writes a binary file under /workspace/slack-files with id-prefixed name', async () => {
      stubInfo({
        id: 'F1',
        name: 'analiza_techniczna.pdf',
        mimetype: 'application/pdf',
        size: 4,
        url_private: 'https://files.slack.com/files-pri/T1-F1/analiza.pdf',
      });
      const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
      const fetchMock = stubDownload(bytes);

      const result = await downloadFile(mockClients, { file: 'F1' });

      expect(result).toEqual({
        id: 'F1',
        name: 'analiza_techniczna.pdf',
        mimetype: 'application/pdf',
        size: 4,
        path: '/ws/.speedwave/slack/F1-analiza_techniczna.pdf',
      });
      expect(fs.mkdir).toHaveBeenCalledWith('/ws/.speedwave/slack', { recursive: true });
      const [target, payload] = vi.mocked(fs.writeFile).mock.calls[0];
      expect(target).toBe('/ws/.speedwave/slack/F1-analiza_techniczna.pdf');
      expect(Buffer.from(payload as Buffer)).toEqual(bytes);
      const [, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer xoxe.xoxp-test',
      });
    });

    it('sanitizes traversal and separators out of the saved filename', async () => {
      stubInfo({
        id: 'F2',
        name: '../../etc/pa ss?wd*.txt',
        mimetype: 'text/plain',
        size: 1,
        url_private: 'https://files.slack.com/files-pri/T1-F2/x',
      });
      stubDownload(Buffer.from([0x41]), 'text/plain');

      const result = await downloadFile(mockClients, { file: 'F2' });

      // No separators survive; leading dots stripped; unsafe chars → underscore.
      expect(result.path).toBe('/ws/.speedwave/slack/F2-pa_ss_wd_.txt');
      expect(result.path).not.toContain('..');
    });

    it('rejects oversized downloads before writing anything', async () => {
      stubInfo({
        id: 'F3',
        name: 'huge.bin',
        mimetype: 'application/octet-stream',
        size: 60 * 1024 * 1024,
        url_private: 'https://files.slack.com/files-pri/T1-F3/huge.bin',
      });
      stubDownload(Buffer.alloc(50 * 1024 * 1024 + 1), 'application/octet-stream');

      await expect(downloadFile(mockClients, { file: 'F3' })).rejects.toThrow(
        /over the download cap/
      );
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('throws on a file without url_private', async () => {
      stubInfo({ id: 'F4', name: 'gone' });
      await expect(downloadFile(mockClients, { file: 'F4' })).rejects.toThrow(
        /no downloadable content/
      );
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('treats an HTML login page as an auth failure, not file bytes', async () => {
      stubInfo({
        id: 'F5',
        name: 'doc.pdf',
        mimetype: 'application/pdf',
        size: 5,
        url_private: 'https://files.slack.com/files-pri/T1-F5/doc.pdf',
      });
      stubDownload(Buffer.from('<html>login</html>'), 'text/html');
      // No WORKER_OAUTH_URL: refresh fails instead of persisting the login page
      await expect(downloadFile(mockClients, { file: 'F5' })).rejects.toThrow();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('sanitizes a hostile file ID falling back from files.info', async () => {
      // files.info without an id → meta.id falls back to the caller's argument.
      stubInfo({
        name: 'x.pdf',
        mimetype: 'application/pdf',
        size: 1,
        url_private: 'https://files.slack.com/files-pri/T1-X/x.pdf',
      });
      stubDownload(Buffer.from([0x41]));

      const result = await downloadFile(mockClients, { file: '../../etc/passwd' });

      // sanitizeFilename keeps only the basename — traversal segments drop out.
      expect(result.path).toBe('/ws/.speedwave/slack/passwd-x.pdf');
      expect(result.path).not.toContain('..');
    });

    it('rejects via Content-Length before buffering the body', async () => {
      stubInfo({
        id: 'F7',
        name: 'huge.bin',
        mimetype: 'application/octet-stream',
        size: 60 * 1024 * 1024,
        url_private: 'https://files.slack.com/files-pri/T1-F7/huge.bin',
      });
      const arrayBuffer = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (h: string) =>
            h === 'content-length' ? String(60 * 1024 * 1024) : 'application/octet-stream',
        },
        arrayBuffer,
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(downloadFile(mockClients, { file: 'F7' })).rejects.toThrow(
        /over the download cap/
      );
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('passes an abort signal to the CDN fetch', async () => {
      stubInfo({
        id: 'F8',
        name: 'a.pdf',
        mimetype: 'application/pdf',
        size: 1,
        url_private: 'https://files.slack.com/files-pri/T1-F8/a.pdf',
      });
      const fetchMock = stubDownload(Buffer.from([0x41]));

      await downloadFile(mockClients, { file: 'F8' });

      const [, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it('falls back to /workspace when WORKSPACE_DIR is unset', async () => {
      delete process.env.WORKSPACE_DIR;
      stubInfo({
        id: 'F6',
        name: 'note.md',
        mimetype: 'text/markdown',
        size: 1,
        url_private: 'https://files.slack.com/files-pri/T1-F6/note.md',
      });
      stubDownload(Buffer.from([0x41]), 'text/markdown');

      const result = await downloadFile(mockClients, { file: 'F6' });
      expect(result.path).toBe('/workspace/.speedwave/slack/F6-note.md');
    });
  });

  describe('getChannels', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    it('returns list of channels user is member of', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          {
            id: 'C12345',
            name: 'general',
            is_channel: true,
            is_private: false,
            is_member: true,
            num_members: 50,
          },
          {
            id: 'C67890',
            name: 'random',
            is_channel: true,
            is_private: false,
            is_member: true,
            num_members: 30,
          },
          {
            id: 'C11111',
            name: 'not-member',
            is_channel: true,
            is_private: false,
            is_member: false,
            num_members: 10,
          },
        ],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels).toHaveLength(2);
      expect(result.channels[0]).toEqual({
        id: 'C12345',
        name: 'general',
        is_channel: true,
        is_private: false,
        is_member: true,
        num_members: 50,
      });
      expect(result.channels[1]).toEqual({
        id: 'C67890',
        name: 'random',
        is_channel: true,
        is_private: false,
        is_member: true,
        num_members: 30,
      });
      expect(mockList).toHaveBeenCalledWith({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
      });
    });

    it('merges member channels across all list pages', async () => {
      const mockList = vi
        .fn()
        .mockResolvedValueOnce({
          channels: [{ id: 'C1', name: 'page1', is_channel: true, is_member: true }],
          response_metadata: { next_cursor: 'cur-2' },
        })
        .mockResolvedValueOnce({
          channels: [
            { id: 'C2', name: 'page2-skip', is_channel: true, is_member: false },
            { id: 'C3', name: 'page2-take', is_channel: true, is_member: true },
          ],
        });
      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels.map((c) => c.id)).toEqual(['C1', 'C3']);
      expect(mockList).toHaveBeenCalledTimes(2);
      expect(mockList).toHaveBeenNthCalledWith(2, {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
        cursor: 'cur-2',
      });
    });

    it('caps pagination at the runaway-cursor backstop', async () => {
      // A cursor that never empties must not loop forever.
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'CX', name: 'x', is_member: true }],
        response_metadata: { next_cursor: 'cur-again' },
      });
      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(mockList).toHaveBeenCalledTimes(20);
      expect(result.channels).toHaveLength(20);
    });

    it('filters out channels user is not member of', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          {
            id: 'C12345',
            name: 'general',
            is_channel: true,
            is_private: false,
            is_member: false,
          },
        ],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels).toHaveLength(0);
    });

    it('handles private channels', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          {
            id: 'G12345',
            name: 'private-channel',
            is_channel: false,
            is_private: true,
            is_member: true,
            num_members: 5,
          },
        ],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels[0]).toEqual({
        id: 'G12345',
        name: 'private-channel',
        is_channel: false,
        is_private: true,
        is_member: true,
        num_members: 5,
      });
    });

    it('handles channels with missing fields', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          {
            // Missing all fields except is_member
            is_member: true,
          },
          {
            id: null,
            name: null,
            is_channel: null,
            is_private: null,
            is_member: true,
          },
        ],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      // These channels pass the is_member filter, so they will be included
      expect(result.channels[0]).toEqual({
        id: '',
        name: '',
        is_channel: false,
        is_private: false,
        is_member: true,
        num_members: undefined,
      });
      expect(result.channels[1]).toEqual({
        id: '',
        name: '',
        is_channel: false,
        is_private: false,
        is_member: true,
        num_members: undefined,
      });
    });

    it('handles empty channels array', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels).toEqual([]);
    });

    it('handles missing channels array', async () => {
      const mockList = vi.fn().mockResolvedValue({});

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels).toEqual([]);
    });
  });

  describe('listDms', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    function stubList(pages: Record<string, unknown>[]): ReturnType<typeof vi.fn> {
      const fn = mockClients.user.conversations.list as ReturnType<typeof vi.fn>;
      for (const page of pages) {
        fn.mockResolvedValueOnce(page);
      }
      return fn;
    }

    it('maps im and mpim entries and requests both types', async () => {
      const list = stubList([
        {
          ok: true,
          channels: [
            { id: 'D1', is_im: true, user: 'U1' },
            { id: 'D2', is_im: true, user: 'U2', is_user_deleted: true },
            { id: 'G1', is_mpim: true, name: 'mpdm-anna--marek--user-1' },
          ],
          response_metadata: { next_cursor: '' },
        },
      ]);

      const { dms } = await listDms(mockClients);

      expect(dms).toEqual([
        { id: 'D1', type: 'im', user: 'U1', is_user_deleted: undefined },
        { id: 'D2', type: 'im', user: 'U2', is_user_deleted: true },
        { id: 'G1', type: 'mpim', name: 'mpdm-anna--marek--user-1' },
      ]);
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ types: 'im,mpim' }));
    });

    it('paginates with the cursor and does not require is_member', async () => {
      const list = stubList([
        {
          ok: true,
          // No is_member field anywhere — im objects do not carry it.
          channels: [{ id: 'D1', is_im: true, user: 'U1' }],
          response_metadata: { next_cursor: 'CUR2' },
        },
        {
          ok: true,
          channels: [{ id: 'D2', is_im: true, user: 'U2' }],
          response_metadata: { next_cursor: '' },
        },
      ]);

      const { dms } = await listDms(mockClients);

      expect(dms.map((d) => d.id)).toEqual(['D1', 'D2']);
      expect(list).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'CUR2' }));
    });

    it('skips malformed entries without an id', async () => {
      stubList([
        {
          ok: true,
          channels: [
            { is_im: true, user: 'U1' },
            { id: 'D2', is_im: true, user: 'U2' },
          ],
          response_metadata: { next_cursor: '' },
        },
      ]);

      const { dms } = await listDms(mockClients);

      expect(dms.map((d) => d.id)).toEqual(['D2']);
    });

    it('returns an empty list for a user with no DMs', async () => {
      stubList([{ ok: true, channels: [], response_metadata: { next_cursor: '' } }]);
      const { dms } = await listDms(mockClients);
      expect(dms).toEqual([]);
    });
  });

  describe('openDm', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    function stubOpen(channelId: string): ReturnType<typeof vi.fn> {
      const fn = mockClients.user.conversations.open as ReturnType<typeof vi.fn>;
      fn.mockResolvedValue({ ok: true, channel: { id: channelId } });
      return fn;
    }

    it('passes user IDs straight through (U… and enterprise W…)', async () => {
      const open = stubOpen('D9');

      const result = await openDm(mockClients, { users: ['U0123ABC', 'W0456DEF'] });

      expect(result).toEqual({ id: 'D9' });
      expect(open).toHaveBeenCalledWith({ users: 'U0123ABC,W0456DEF' });
    });

    it('resolves email entries via users.lookupByEmail', async () => {
      const open = stubOpen('D10');
      (mockClients.user.users.lookupByEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        user: { id: 'U77', name: 'pawel' },
      });

      const result = await openDm(mockClients, { users: ['pawel@example.pl'] });

      expect(result).toEqual({ id: 'D10' });
      expect(open).toHaveBeenCalledWith({ users: 'U77' });
    });

    it('throws on an unknown email and on a plain name', async () => {
      (mockClients.user.users.lookupByEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('users_not_found'), { data: { error: 'users_not_found' } })
      );
      await expect(openDm(mockClients, { users: ['ghost@example.pl'] })).rejects.toThrow(
        /No Slack user found for email "ghost@example.pl"/
      );

      await expect(openDm(mockClients, { users: ['Pawel'] })).rejects.toThrow(/findUsers first/);
      expect(mockClients.user.conversations.open).not.toHaveBeenCalled();
    });

    it('accepts a lowercase user ID and normalizes it to uppercase', async () => {
      const open = stubOpen('D11');

      const result = await openDm(mockClients, { users: ['u0123abc'] });

      expect(result).toEqual({ id: 'D11' });
      expect(open).toHaveBeenCalledWith({ users: 'U0123ABC' });
    });

    it('rejects a non-array users value before any API call', async () => {
      await expect(
        openDm(mockClients, { users: undefined as unknown as string[] })
      ).rejects.toThrow(/'users' is required/);
      expect(mockClients.user.conversations.open).not.toHaveBeenCalled();
    });

    it('rejects more than 8 participants before any API call', async () => {
      const open = mockClients.user.conversations.open as ReturnType<typeof vi.fn>;
      const nine = Array.from({ length: 9 }, (_, i) => `U${i}`);

      await expect(openDm(mockClients, { users: nine })).rejects.toThrow(/at most 8 people/);
      expect(open).not.toHaveBeenCalled();
    });

    it('rejects an empty users list', async () => {
      const open = mockClients.user.conversations.open as ReturnType<typeof vi.fn>;
      await expect(openDm(mockClients, { users: [] })).rejects.toThrow(/at least one user/);
      expect(open).not.toHaveBeenCalled();
    });

    it('accepts exactly 8 participants (the boundary)', async () => {
      const open = stubOpen('G8');
      const eight = Array.from({ length: 8 }, (_, i) => `U${i}`);

      const result = await openDm(mockClients, { users: eight });

      expect(result).toEqual({ id: 'G8' });
      expect(open).toHaveBeenCalledWith({ users: eight.join(',') });
    });

    it('throws when Slack returns no conversation ID', async () => {
      (mockClients.user.conversations.open as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
      });
      await expect(openDm(mockClients, { users: ['U1'] })).rejects.toThrow(
        /did not return a conversation ID/
      );
    });

    it('propagates missing_scope so formatSlackError can guide re-auth', async () => {
      (mockClients.user.conversations.open as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } })
      );
      await expect(openDm(mockClients, { users: ['U1'] })).rejects.toMatchObject({
        data: { error: 'missing_scope' },
      });
    });
  });

  describe('getUsers', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    it('returns user by email', async () => {
      const mockLookup = vi.fn().mockResolvedValue({
        user: {
          id: 'U12345',
          name: 'john.doe',
          real_name: 'John Doe',
          profile: {
            email: 'john.doe@example.com',
          },
        },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'john.doe@example.com',
      });

      expect(result.user).toEqual({
        id: 'U12345',
        name: 'john.doe',
        real_name: 'John Doe',
        email: 'john.doe@example.com',
      });
      expect(mockLookup).toHaveBeenCalledWith({
        email: 'john.doe@example.com',
      });
    });

    it('returns null when user not found', async () => {
      const mockLookup = vi.fn().mockRejectedValue({
        data: { error: 'users_not_found' },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'nonexistent@example.com',
      });

      expect(result.user).toBeNull();
    });

    it('trims surrounding whitespace from the email before lookup', async () => {
      const mockLookup = vi.fn().mockResolvedValue({ user: { id: 'U1', name: 'pawel' } });
      mockClients.user.users.lookupByEmail = mockLookup;

      await getUsers(mockClients, { email: '  pawel@example.pl  ' });

      expect(mockLookup).toHaveBeenCalledWith({ email: 'pawel@example.pl' });
    });

    it('returns null when user object is missing', async () => {
      const mockLookup = vi.fn().mockResolvedValue({});

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.user).toBeNull();
    });

    it('handles user with missing optional fields', async () => {
      const mockLookup = vi.fn().mockResolvedValue({
        user: {
          id: 'U12345',
          name: 'john.doe',
          // Missing real_name and profile
        },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'john.doe@example.com',
      });

      expect(result.user).toEqual({
        id: 'U12345',
        name: 'john.doe',
        real_name: undefined,
        email: undefined,
      });
    });

    it('handles user with empty fields', async () => {
      const mockLookup = vi.fn().mockResolvedValue({
        user: {
          id: null,
          name: null,
          real_name: null,
          profile: {},
        },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.user).toEqual({
        id: '',
        name: '',
        real_name: null,
        email: undefined,
      });
    });

    it('throws error for other API errors', async () => {
      // token_revoked is terminal: no refresh attempt, error passes through.
      const mockLookup = vi.fn().mockRejectedValue({
        data: { error: 'token_revoked' },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      await expect(
        getUsers(mockClients, {
          email: 'test@example.com',
        })
      ).rejects.toEqual({
        data: { error: 'token_revoked' },
      });
    });

    it('throws error for network errors', async () => {
      const mockLookup = vi.fn().mockRejectedValue(new Error('Network error'));

      mockClients.user.users.lookupByEmail = mockLookup;

      await expect(
        getUsers(mockClients, {
          email: 'test@example.com',
        })
      ).rejects.toThrow('Network error');
    });
  });

  describe('getCurrentUser', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = presentClients();
    });

    it('resolves id/name/team from auth.test, enriched by users.info', async () => {
      (mockClients.user.auth.test as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        user_id: 'U12345',
        user: 'pawel',
        team_id: 'T999',
      });
      (mockClients.user.users.info as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        user: { name: 'pawel', real_name: 'Paweł Kowalski', profile: { display_name: 'pawel.k' } },
      });

      const result = await getCurrentUser(mockClients);

      expect(result).toEqual({
        id: 'U12345',
        name: 'pawel',
        team_id: 'T999',
        real_name: 'Paweł Kowalski',
        display_name: 'pawel.k',
      });
      expect(mockClients.user.users.info).toHaveBeenCalledWith({ user: 'U12345' });
    });

    it('degrades to auth.test alone when users.info enrichment fails', async () => {
      (mockClients.user.auth.test as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        user_id: 'U12345',
        user: 'pawel',
      });
      (mockClients.user.users.info as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('missing_scope')
      );

      const result = await getCurrentUser(mockClients);

      expect(result).toEqual({ id: 'U12345', name: 'pawel', team_id: undefined });
    });

    it('throws when auth.test reports not ok', async () => {
      (mockClients.user.auth.test as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: 'invalid_auth',
      });

      await expect(getCurrentUser(mockClients)).rejects.toThrow('invalid_auth');
    });

    it('throws when auth.test omits user_id', async () => {
      (mockClients.user.auth.test as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

      await expect(getCurrentUser(mockClients)).rejects.toThrow(
        'auth.test did not return a user_id.'
      );
    });
  });
});

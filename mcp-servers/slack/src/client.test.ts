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
  getChannels,
  getUsers,
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
  // `auth.test` is invoked by the background connection test that
  // initializeSlackClients schedules after successful token load. The default
  // resolves so that path is exercised in the happy-token test; specific
  // tests can override via mockWebClientInstance.auth.test.mockResolvedValueOnce.
  auth: {
    test: vi.fn().mockResolvedValue({ ok: true }),
  },
};

// Mock @slack/web-api - use class for vitest 4.x compatibility. The mock
// records the constructor token so slackCall's recreate-on-rotation check
// (`client.token !== token`) behaves like the real WebClient.
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function (
    this: typeof mockWebClientInstance & { token?: string },
    token?: string
  ) {
    Object.assign(this, mockWebClientInstance);
    this.token = token;
  }),
}));

// Mock fs/promises. The named `readFile` mirrors the default-object one
// because @speedwave/mcp-shared's oauth-client imports it as a named binding
// from 'node:fs/promises' (the slackCall refresh path reads the bearer file).
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock('fs/promises', () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

/** Configured client container whose user mock keeps per-test method stubs. */
function presentClients(): SlackClients {
  return {
    user: {
      token: 'xoxe.xoxp-test',
      chat: { postMessage: vi.fn() },
      conversations: { list: vi.fn(), history: vi.fn() },
      users: { lookupByEmail: vi.fn() },
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
      // The shared loadTokenFile wraps any non-Error rejection into a proper
      // Error ("Failed to read token file: … (plain string failure)"), so the
      // message — not "Unknown error" — surfaces in the warning.
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
      ).rejects.toThrow('Channel not found: nonexistent');
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
});

/**
 * DM Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RefreshLock } from '@speedwave/mcp-shared';
import { handleListDirectMessages, handleOpenDirectMessage, createDmTools } from './dm-tools.js';
import type { SlackClients } from '../client.js';

// Mock the client module
vi.mock('../client.js', async () => {
  const actual = await vi.importActual('../client.js');
  return {
    ...actual,
    listDms: vi.fn(),
    openDm: vi.fn(),
    formatSlackError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  };
});

// Mock the user-directory boundary — its machinery has its own test file.
vi.mock('../user-directory.js', () => ({
  peekUserDirectory: vi.fn(),
  displayNameOf: vi.fn(
    (u: { display_name?: string; real_name?: string; name: string }) =>
      u.display_name || u.real_name || u.name
  ),
}));

import * as client from '../client.js';
import { peekUserDirectory } from '../user-directory.js';

function presentClients(): SlackClients {
  return {
    user: {} as never,
    tokenState: { accessToken: 'xoxp-test' },
    lock: new RefreshLock(),
    _tokensStatus: 'present',
  };
}

function unconfiguredClients(): SlackClients {
  return {
    user: {} as never,
    tokenState: { accessToken: '' },
    lock: new RefreshLock(),
    _tokensStatus: 'missing',
  };
}

describe('dm-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleListDirectMessages', () => {
    it('names 1:1 entries from the directory and passes mpim through', async () => {
      vi.mocked(client.listDms).mockResolvedValue({
        dms: [
          { id: 'D1', type: 'im', user: 'U1' },
          { id: 'G1', type: 'mpim', name: 'mpdm-anna--marek--user-1' },
        ],
      });
      vi.mocked(peekUserDirectory).mockResolvedValue(
        new Map([['U1', { id: 'U1', name: 'pawel', real_name: 'Paweł Kowalski' }]])
      );

      const result = await handleListDirectMessages(presentClients(), {});

      expect(result.success).toBe(true);
      const data = result.data as { dms: { id: string; name?: string }[] };
      expect(data.dms[0].name).toBe('Paweł Kowalski');
      expect(data.dms[1].name).toBe('mpdm-anna--marek--user-1');
    });

    it('falls back to the raw user ID when the directory is unavailable', async () => {
      vi.mocked(client.listDms).mockResolvedValue({
        dms: [{ id: 'D1', type: 'im', user: 'U1' }],
      });
      vi.mocked(peekUserDirectory).mockResolvedValue(null);

      const result = await handleListDirectMessages(presentClients(), {});

      expect(result.success).toBe(true);
      const data = result.data as { dms: { name?: string }[] };
      expect(data.dms[0].name).toBe('U1');
    });

    it('maps failures (e.g. missing_scope) to LIST_FAILED', async () => {
      vi.mocked(client.listDms).mockRejectedValue(new Error('Permission denied — re-authorise'));

      const result = await handleListDirectMessages(presentClients(), {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
      expect(result.error?.message).toContain('re-authorise');
    });
  });

  describe('handleOpenDirectMessage', () => {
    it('returns the conversation ID on success', async () => {
      vi.mocked(client.openDm).mockResolvedValue({ id: 'D9' });

      const result = await handleOpenDirectMessage(presentClients(), { users: ['U1'] });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 'D9' });
      expect(client.openDm).toHaveBeenCalledWith(expect.anything(), { users: ['U1'] });
    });

    it('maps failures to OPEN_FAILED', async () => {
      vi.mocked(client.openDm).mockRejectedValue(
        new Error("'Pawel' is not a user ID or email. Find the person with findUsers first.")
      );

      const result = await handleOpenDirectMessage(presentClients(), { users: ['Pawel'] });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OPEN_FAILED');
      expect(result.error?.message).toContain('findUsers');
    });
  });

  describe('createDmTools', () => {
    it('registers both tools with the right annotations', () => {
      const tools = createDmTools(presentClients());
      expect(tools.map((t) => t.tool.name)).toEqual(['listDirectMessages', 'openDirectMessage']);
      expect(tools[0].tool.annotations?.readOnlyHint).toBe(true);
      // Opening a conversation mutates state on Slack's side.
      expect(tools[1].tool.annotations?.readOnlyHint).not.toBe(true);
    });

    it('returns NOT_CONFIGURED for both tools when the worker has no token', async () => {
      const tools = createDmTools(unconfiguredClients());

      for (const { handler } of tools) {
        const result = await handler({ users: ['U1'] });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text as string);
        expect(parsed.code).toBe('NOT_CONFIGURED');
      }
    });

    it('forwards the users array to openDm verbatim (cap enforced in client)', async () => {
      // The minItems/maxItems schema is a hint to the model; the runtime cap
      // lives in openDm (client.ts), so the handler forwards as-is and surfaces
      // a client-thrown cap violation as OPEN_FAILED.
      const tools = createDmTools(presentClients());
      vi.mocked(client.openDm).mockRejectedValue(
        new Error('A Slack DM holds at most 8 people; got 9.')
      );

      const nine = Array.from({ length: 9 }, (_, i) => `U${i}`);
      const result = await tools[1].handler({ users: nine });

      expect(client.openDm).toHaveBeenCalledWith(expect.anything(), { users: nine });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('OPEN_FAILED');
      expect(parsed.message).toContain('at most 8');
    });
  });
});

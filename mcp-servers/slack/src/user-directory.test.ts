/**
 * User Directory Tests — cache lifecycle, enrichment fallbacks, name search.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RefreshLock } from '@speedwave/mcp-shared';
import { WebClient } from '@slack/web-api';
import { SlackClients, SlackMessage } from './client.js';
import {
  ensureUserDirectory,
  peekUserDirectory,
  displayNameOf,
  enrichMessagesWithAuthors,
  normalizeForSearch,
  searchUsers,
  USER_DIRECTORY_TTL_MS,
} from './user-directory.js';

/** Client container with a stubbable users.list. */
function clientsWith(usersList: ReturnType<typeof vi.fn>): SlackClients {
  return {
    user: { token: 'xoxe.xoxp-test', users: { list: usersList } } as unknown as WebClient,
    tokenState: { accessToken: 'xoxe.xoxp-test' },
    lock: new RefreshLock(),
    _tokensStatus: 'present',
  };
}

function member(
  id: string,
  name: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id, name, ...extra };
}

function pageResponse(
  members: Record<string, unknown>[],
  nextCursor?: string
): Record<string, unknown> {
  return { ok: true, members, response_metadata: { next_cursor: nextCursor ?? '' } };
}

describe('user-directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('ensureUserDirectory', () => {
    it('builds the map from a single page with profile fields', async () => {
      const usersList = vi.fn().mockResolvedValue(
        pageResponse([
          member('U1', 'pawel', {
            real_name: 'Paweł Kowalski',
            profile: { display_name: 'pawelk', email: 'pawel@x.pl' },
          }),
          member('U2', 'bot', { is_bot: true }),
          member('U3', 'gone', { deleted: true }),
        ])
      );
      const clients = clientsWith(usersList);

      const dir = await ensureUserDirectory(clients);

      expect(dir.size).toBe(3);
      expect(dir.get('U1')).toEqual({
        id: 'U1',
        name: 'pawel',
        real_name: 'Paweł Kowalski',
        display_name: 'pawelk',
        email: 'pawel@x.pl',
        deleted: undefined,
        is_bot: undefined,
      });
      // Deleted users stay in the map — old messages must still enrich.
      expect(dir.get('U3')?.deleted).toBe(true);
      expect(usersList).toHaveBeenCalledWith({ limit: 200, cursor: undefined });
    });

    it('skips members without an id', async () => {
      const usersList = vi
        .fn()
        .mockResolvedValue(pageResponse([{ name: 'ghost' }, member('U1', 'a')]));
      const clients = clientsWith(usersList);

      const dir = await ensureUserDirectory(clients);

      expect(dir.size).toBe(1);
      expect(dir.has('U1')).toBe(true);
    });

    it('merges cursor-paginated pages and stops at the empty cursor', async () => {
      const usersList = vi
        .fn()
        .mockResolvedValueOnce(pageResponse([member('U1', 'a')], 'CUR2'))
        .mockResolvedValueOnce(pageResponse([member('U2', 'b')]));
      const clients = clientsWith(usersList);

      const dir = await ensureUserDirectory(clients);

      expect(dir.size).toBe(2);
      expect(usersList).toHaveBeenCalledTimes(2);
      expect(usersList).toHaveBeenLastCalledWith({ limit: 200, cursor: 'CUR2' });
    });

    it('stops at the page backstop on a runaway cursor', async () => {
      const usersList = vi.fn().mockResolvedValue(pageResponse([member('U1', 'a')], 'LOOP'));
      const clients = clientsWith(usersList);

      await ensureUserDirectory(clients);

      expect(usersList).toHaveBeenCalledTimes(25);
    });

    it('serves the cache within TTL without refetching', async () => {
      const usersList = vi.fn().mockResolvedValue(pageResponse([member('U1', 'a')]));
      const clients = clientsWith(usersList);

      await ensureUserDirectory(clients);
      await ensureUserDirectory(clients);

      expect(usersList).toHaveBeenCalledTimes(1);
    });

    it('single-flights two concurrent builds into one fetch sequence', async () => {
      let release!: (v: Record<string, unknown>) => void;
      const usersList = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        })
      );
      const clients = clientsWith(usersList);

      const p1 = ensureUserDirectory(clients);
      const p2 = ensureUserDirectory(clients);
      release(pageResponse([member('U1', 'a')]));

      const [d1, d2] = await Promise.all([p1, p2]);
      expect(d1).toBe(d2);
      expect(usersList).toHaveBeenCalledTimes(1);
    });

    it('rebuilds after TTL expiry', async () => {
      vi.useFakeTimers();
      const usersList = vi.fn().mockResolvedValue(pageResponse([member('U1', 'a')]));
      const clients = clientsWith(usersList);

      await ensureUserDirectory(clients);
      vi.advanceTimersByTime(USER_DIRECTORY_TTL_MS + 1);
      await ensureUserDirectory(clients);

      expect(usersList).toHaveBeenCalledTimes(2);
    });

    it('serves stale data when a rebuild fails (state transition)', async () => {
      vi.useFakeTimers();
      const usersList = vi
        .fn()
        .mockResolvedValueOnce(pageResponse([member('U1', 'a')]))
        .mockRejectedValueOnce(new Error('slack down'));
      const clients = clientsWith(usersList);

      const first = await ensureUserDirectory(clients);
      vi.advanceTimersByTime(USER_DIRECTORY_TTL_MS + 1);
      const second = await ensureUserDirectory(clients);

      expect(second).toBe(first);
    });

    it('throws when there is no data and the build fails, then retries cleanly', async () => {
      const usersList = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(pageResponse([member('U1', 'a')]));
      const clients = clientsWith(usersList);

      await expect(ensureUserDirectory(clients)).rejects.toThrow('boom');
      // inflight was cleared on failure — the next call starts a fresh build.
      const dir = await ensureUserDirectory(clients);
      expect(dir.size).toBe(1);
    });
  });

  describe('peekUserDirectory', () => {
    it('returns null instead of throwing when the first build fails', async () => {
      const usersList = vi.fn().mockRejectedValue(new Error('boom'));
      const clients = clientsWith(usersList);

      expect(await peekUserDirectory(clients)).toBeNull();
    });

    it('bounded wait: returns null when the build is slower than waitMs, map later', async () => {
      let release!: (v: Record<string, unknown>) => void;
      const usersList = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        })
      );
      const clients = clientsWith(usersList);

      const early = await peekUserDirectory(clients, 10);
      expect(early).toBeNull();

      release(pageResponse([member('U1', 'a')]));
      // The build it raced against keeps running and populates the cache.
      await vi.waitFor(async () => {
        expect(await peekUserDirectory(clients, 10)).not.toBeNull();
      });
    });

    it('swallows a failing background rebuild and keeps serving stale data', async () => {
      vi.useFakeTimers();
      const usersList = vi
        .fn()
        .mockResolvedValueOnce(pageResponse([member('U1', 'a')]))
        .mockRejectedValueOnce(new Error('slack down'));
      const clients = clientsWith(usersList);

      await ensureUserDirectory(clients);
      vi.advanceTimersByTime(USER_DIRECTORY_TTL_MS + 1);

      const stale = await peekUserDirectory(clients);
      expect(stale?.size).toBe(1);
      // Let the failed background rebuild settle — it must not reject unhandled.
      await vi.runAllTimersAsync();
      expect((await peekUserDirectory(clients))?.size).toBe(1);
    });

    it('returns stale data immediately and kicks a background rebuild', async () => {
      vi.useFakeTimers();
      const usersList = vi
        .fn()
        .mockResolvedValueOnce(pageResponse([member('U1', 'a')]))
        .mockResolvedValueOnce(pageResponse([member('U1', 'a'), member('U2', 'b')]));
      const clients = clientsWith(usersList);

      await ensureUserDirectory(clients);
      vi.advanceTimersByTime(USER_DIRECTORY_TTL_MS + 1);

      const stale = await peekUserDirectory(clients);
      expect(stale?.size).toBe(1); // immediate stale answer
      expect(usersList).toHaveBeenCalledTimes(2); // rebuild kicked in background
    });
  });

  describe('displayNameOf', () => {
    it('prefers display_name, then real_name, then name', () => {
      expect(displayNameOf({ id: 'U', name: 'n', real_name: 'r', display_name: 'd' })).toBe('d');
      expect(displayNameOf({ id: 'U', name: 'n', real_name: 'r' })).toBe('r');
      expect(displayNameOf({ id: 'U', name: 'n' })).toBe('n');
    });
  });

  describe('enrichMessagesWithAuthors', () => {
    function msg(user: string, extra: Partial<SlackMessage> = {}): SlackMessage {
      return { user, text: 'x', ts: '1.0', type: 'message', ...extra };
    }

    it('sets author for known IDs and falls back to username for unknown bots', async () => {
      const usersList = vi
        .fn()
        .mockResolvedValue(pageResponse([member('U1', 'pawel', { real_name: 'Paweł' })]));
      const clients = clientsWith(usersList);
      const messages = [msg('U1'), msg('B9', { username: 'jira-bot' }), msg('UX')];

      await enrichMessagesWithAuthors(clients, messages);

      expect(messages[0].author).toBe('Paweł');
      expect(messages[1].author).toBe('jira-bot');
      expect(messages[2].author).toBeUndefined();
    });

    it('returns messages unchanged when the directory is unavailable (never throws)', async () => {
      const usersList = vi.fn().mockRejectedValue(new Error('boom'));
      const clients = clientsWith(usersList);
      const messages = [msg('U1')];

      await expect(enrichMessagesWithAuthors(clients, messages)).resolves.toBe(messages);
      expect(messages[0].author).toBeUndefined();
      expect(messages[0].user).toBe('U1');
    });
  });

  describe('normalizeForSearch', () => {
    it('lowercases and strips Polish diacritics including ł', () => {
      expect(normalizeForSearch('Paweł')).toBe('pawel');
      expect(normalizeForSearch('ŚWIĄTEK')).toBe('swiatek');
      expect(normalizeForSearch('Żółć')).toBe('zolc');
      expect(normalizeForSearch('plain')).toBe('plain');
    });
  });

  describe('searchUsers', () => {
    const roster = [
      member('U1', 'pkowalski', { real_name: 'Paweł Kowalski' }),
      member('U2', 'anna', { profile: { display_name: 'Ania Nowak' } }),
      member('U3', 'gone', { real_name: 'Paweł Stary', deleted: true }),
      member('U4', 'pavel', { real_name: 'Pavel Novak' }),
    ];

    it('matches name, real_name and display_name, diacritic-insensitively both ways', async () => {
      const clients = clientsWith(vi.fn().mockResolvedValue(pageResponse(roster)));

      const byAscii = await searchUsers(clients, { query: 'pawel' });
      expect(byAscii.map((u) => u.id)).toEqual(['U1']);

      const byDiacritic = await searchUsers(clients, { query: 'Paweł' });
      expect(byDiacritic.map((u) => u.id).sort()).toEqual(['U1']);

      const byDisplay = await searchUsers(clients, { query: 'ania' });
      expect(byDisplay.map((u) => u.id)).toEqual(['U2']);
    });

    it('excludes deleted users and respects the limit cap', async () => {
      const clients = clientsWith(vi.fn().mockResolvedValue(pageResponse(roster)));

      const hits = await searchUsers(clients, { query: 'pa' });
      expect(hits.map((u) => u.id).sort()).toEqual(['U1', 'U4']); // U3 deleted

      const capped = await searchUsers(clients, { query: 'pa', limit: 1 });
      expect(capped).toHaveLength(1);
    });

    it('returns empty for no match and throws when the build fails with no data', async () => {
      const clients = clientsWith(vi.fn().mockResolvedValue(pageResponse(roster)));
      expect(await searchUsers(clients, { query: 'zzz' })).toEqual([]);

      const broken = clientsWith(vi.fn().mockRejectedValue(new Error('boom')));
      await expect(searchUsers(broken, { query: 'pawel' })).rejects.toThrow('boom');
    });
  });
});

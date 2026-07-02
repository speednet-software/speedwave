/**
 * User Directory — lazy, cached workspace user map built from `users.list`.
 * Serves ID→name and name→ID lookups.
 */

import type { UsersListResponse } from '@slack/web-api';
import { SlackClients, SlackMessage, slackCall } from './client.js';

/** A workspace user as kept in the directory. */
export interface SlackDirectoryUser {
  id: string;
  name: string;
  real_name?: string;
  display_name?: string;
  email?: string;
  /** Deactivated account — kept for enriching old messages, excluded from search. */
  deleted?: boolean;
  is_bot?: boolean;
}

/** Cache holder living on the SlackClients container (test isolation — no module state). */
export interface UserDirectoryCache {
  /** Null until the first successful build. */
  byId: Map<string, SlackDirectoryUser> | null;
  /** Epoch ms of the last successful build (0 = never). */
  fetchedAt: number;
  /** Single-flight: the in-progress build, if any. */
  inflight: Promise<Map<string, SlackDirectoryUser>> | null;
}

/** Renames are rare — an hour of staleness is invisible in practice. */
export const USER_DIRECTORY_TTL_MS = 3_600_000;

/** Slack-recommended page size for users.list. */
const USERS_LIST_PAGE_LIMIT = 200;

/** Backstop against runaway cursors — 25 × 200 covers 5k users. */
const USERS_LIST_MAX_PAGES = 25;

/** Latency bound for read-path lookups (enrichment must not stall reads). */
export const DIRECTORY_WAIT_MS = 3_000;

/**
 * The container's cache holder, created on first use.
 * @param clients - Slack client container
 */
function cacheOf(clients: SlackClients): UserDirectoryCache {
  if (!clients._userDirectory) {
    clients._userDirectory = { byId: null, fetchedAt: 0, inflight: null };
  }
  return clients._userDirectory;
}

/**
 * Fetch every workspace user via cursor-paginated users.list.
 * @param clients - Slack client container
 */
async function fetchAllUsers(clients: SlackClients): Promise<Map<string, SlackDirectoryUser>> {
  const byId = new Map<string, SlackDirectoryUser>();
  let cursor: string | undefined;
  for (let page = 0; page < USERS_LIST_MAX_PAGES; page += 1) {
    const result = (await slackCall(clients, (c) =>
      c.users.list({ limit: USERS_LIST_PAGE_LIMIT, cursor })
    )) as UsersListResponse;
    for (const member of result.members ?? []) {
      if (!member.id) {
        continue;
      }
      byId.set(member.id, {
        id: member.id,
        name: member.name || '',
        real_name: member.real_name,
        display_name: member.profile?.display_name || undefined,
        email: member.profile?.email,
        deleted: member.deleted,
        is_bot: member.is_bot,
      });
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) {
      break;
    }
  }
  return byId;
}

/**
 * Start (or join) a directory build, clearing `inflight` on settle.
 * @param clients - Slack client container
 */
function buildDirectory(clients: SlackClients): Promise<Map<string, SlackDirectoryUser>> {
  const cache = cacheOf(clients);
  if (cache.inflight) {
    return cache.inflight;
  }
  cache.inflight = fetchAllUsers(clients)
    .then((byId) => {
      cache.byId = byId;
      cache.fetchedAt = Date.now();
      return byId;
    })
    .finally(() => {
      cache.inflight = null;
    });
  return cache.inflight;
}

/**
 * Fresh-or-rebuilt directory; degrades to stale data on rebuild failure, else throws.
 * @param clients - Slack client container
 */
export async function ensureUserDirectory(
  clients: SlackClients
): Promise<Map<string, SlackDirectoryUser>> {
  const cache = cacheOf(clients);
  const fresh = cache.byId && Date.now() - cache.fetchedAt < USER_DIRECTORY_TTL_MS;
  if (fresh && cache.byId) {
    return cache.byId;
  }
  try {
    return await buildDirectory(clients);
  } catch (err) {
    if (cache.byId) {
      console.warn(`user directory rebuild failed, serving stale data: ${String(err)}`);
      return cache.byId;
    }
    throw err;
  }
}

/**
 * Non-blocking, never-throwing directory lookup; returns stale data immediately, else races build against `waitMs`.
 * @param clients - Slack client container
 * @param waitMs - Maximum time to wait for a first build
 */
export async function peekUserDirectory(
  clients: SlackClients,
  waitMs: number = DIRECTORY_WAIT_MS
): Promise<Map<string, SlackDirectoryUser> | null> {
  const cache = cacheOf(clients);
  if (cache.byId) {
    if (Date.now() - cache.fetchedAt >= USER_DIRECTORY_TTL_MS) {
      buildDirectory(clients).catch(() => undefined);
    }
    return cache.byId;
  }
  try {
    return await Promise.race([
      buildDirectory(clients),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), waitMs);
      }),
    ]);
  } catch {
    return null;
  }
}

/**
 * Best human-readable name for a directory user.
 * @param u - Directory entry
 */
export function displayNameOf(u: SlackDirectoryUser): string {
  return u.display_name || u.real_name || u.name;
}

/**
 * Set `author` on each message from the directory; unknown IDs fall back to the message's `username`. Never throws.
 * @param clients - Slack client container
 * @param messages - Messages to enrich in place
 */
export async function enrichMessagesWithAuthors(
  clients: SlackClients,
  messages: SlackMessage[]
): Promise<SlackMessage[]> {
  // peekUserDirectory never throws by contract — no defensive catch needed.
  const directory = await peekUserDirectory(clients);
  for (const msg of messages) {
    const entry = directory?.get(msg.user);
    const author = entry ? displayNameOf(entry) : msg.username;
    if (author) {
      msg.author = author;
    }
  }
  return messages;
}

/**
 * Search-normalize: lowercase, strip diacritics, explicit ł→l (U+0142 does not decompose under NFD).
 * @param s - Raw string
 */
export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
}

/**
 * Case- and diacritic-insensitive substring search over name/real_name/display_name; excludes deleted users.
 * @param clients - Slack client container
 * @param params - Parameters
 * @param params.query - Partial name to match
 * @param params.limit - Result cap (default 25)
 */
export async function searchUsers(
  clients: SlackClients,
  params: { query: string; limit?: number }
): Promise<SlackDirectoryUser[]> {
  const needle = normalizeForSearch(params.query);
  const limit = params.limit ?? 25;
  const directory = await ensureUserDirectory(clients);
  const hits: SlackDirectoryUser[] = [];
  for (const u of directory.values()) {
    if (u.deleted) {
      continue;
    }
    const haystacks = [u.name, u.real_name, u.display_name];
    if (haystacks.some((h) => h && normalizeForSearch(h).includes(needle))) {
      hits.push(u);
      if (hits.length >= limit) {
        break;
      }
    }
  }
  return hits;
}

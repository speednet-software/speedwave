/**
 * Slack API Client module providing isolated client for mcp-slack worker
 * @module slack/client
 *
 * Isolated Slack client for mcp-slack worker. ONLY has access to the Slack
 * user access token (`/tokens/access_token`, RO mount) — refreshed by the
 * host-side oauth worker (ADR-060/071). All calls run as the signed-in user.
 *
 * Error Handling Convention:
 * - initializeSlackClients returns a `_tokensStatus:'missing'` container on
 *   config failures (graceful degradation), never throws
 * - Instance methods throw errors on API failures
 */

import {
  WebClient,
  ChatPostMessageResponse,
  ConversationsListResponse,
  ConversationsHistoryResponse,
  UsersLookupByEmailResponse,
} from '@slack/web-api';
import {
  ts,
  withSetupGuidance,
  ConnectionStatusTracker,
  backgroundConnectionTest,
  loadTokenFile,
  authedSdkCall,
  RefreshLock,
  OAuthRefreshError,
  type AuthedTokenState,
} from '@speedwave/mcp-shared';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/** Whether the Slack access token was loadable at startup. */
export type SlackTokensStatus = 'present' | 'missing';

/**
 * Container for the Slack user WebClient plus its refresh plumbing.
 *
 * Returned in **every** state, including when the token is absent — callers
 * check `_tokensStatus === 'missing'` rather than null. `user` is recreated
 * by {@link slackCall} whenever the rotating token changes on disk.
 *
 * `statusTracker` is optional only so tool-level unit tests can mock without
 * constructing a tracker; runtime always populates it.
 */
export interface SlackClients {
  user: WebClient;
  /** Mutable holder for the current rotating access token. */
  tokenState: AuthedTokenState;
  /** Serializes refreshes so concurrent auth failures trigger one refresh. */
  lock: RefreshLock;
  statusTracker?: ConnectionStatusTracker;
  /** Whether the access token was loaded — drives "not configured" semantics. */
  _tokensStatus: SlackTokensStatus;
}

/**
 * Represents a Slack message with user, text, and timestamp information
 * @interface SlackMessage
 * @property {string} user - User ID who sent the message
 * @property {string} text - Message text content
 * @property {string} ts - Timestamp (unique message identifier)
 * @property {string} type - Message type (usually "message")
 * @property {string} [username] - Optional display username
 */
export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  type: string;
  username?: string;
}

/**
 * Represents a Slack channel with ID, name, and membership status
 * @interface SlackChannel
 * @property {string} id - Channel ID (e.g., C01234567)
 * @property {string} name - Channel name (without # prefix)
 * @property {boolean} is_channel - Whether it's a channel (vs DM/group)
 * @property {boolean} is_private - Whether it's a private channel
 * @property {boolean} is_member - Whether the user is a member
 * @property {number} [num_members] - Optional member count
 */
export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_member: boolean;
  num_members?: number;
}

/**
 * Represents a Slack user with ID, username, and contact information
 * @interface SlackUser
 * @property {string} id - User ID (e.g., U01234567)
 * @property {string} name - Username
 * @property {string} [real_name] - Optional real name
 * @property {string} [email] - Optional email address
 */
export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  email?: string;
}

/** One page of channel history (cursor pagination over conversations.history). */
export interface SlackHistoryPage {
  messages: SlackMessage[];
  /** Pass back as `cursor` to fetch the next (older) page. */
  next_cursor?: string;
  has_more: boolean;
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Factory
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the Slack client from the OAuth access token.
 * Loads `access_token` from /tokens/ (written at sign-in by Desktop and on
 * every refresh by the host-side oauth worker).
 *
 * IMPORTANT: Returns a `'missing'` container (not throws) when the token is
 * absent. This enables "graceful degradation" — the server starts even
 * without config and tools return a clear "not configured" error.
 *
 * DO NOT change this to throw — it breaks container startup for unconfigured services.
 * @returns Initialized clients (status carried in `_tokensStatus`)
 */
export async function initializeSlackClients(): Promise<SlackClients> {
  const tokensMissing = (): SlackClients => ({
    user: new WebClient('xoxp-not-configured'),
    tokenState: { accessToken: '' },
    lock: new RefreshLock(),
    statusTracker: new ConnectionStatusTracker(),
    _tokensStatus: 'missing',
  });

  try {
    const accessToken = await loadTokenFile('access_token');
    if (!accessToken) {
      console.warn(
        `${ts()} ${withSetupGuidance('Slack access token is empty or missing. Sign in with Slack in Speedwave Desktop.')}`
      );
      return tokensMissing();
    }

    console.log(`${ts()} ✅ Slack: Access token loaded`);

    const statusTracker = new ConnectionStatusTracker();
    const clients: SlackClients = {
      user: new WebClient(accessToken),
      tokenState: { accessToken },
      lock: new RefreshLock(),
      statusTracker,
      _tokensStatus: 'present',
    };
    // Background sanity check through the refresh wrapper, so a worker booting
    // with an expired rotating token self-heals instead of reporting failure.
    backgroundConnectionTest(
      statusTracker,
      async () => {
        const res = await slackCall(clients, (c) => c.auth.test());
        if (!res.ok) {
          throw new Error(res.error ?? 'auth.test reported not ok');
        }
      },
      'Slack'
    );

    return clients;
  } catch (error) {
    console.warn(
      `${ts()} ${withSetupGuidance(`Failed to load Slack access token: ${error instanceof Error ? error.message : 'Unknown error'}.`)}`
    );
    return tokensMissing();
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Refresh wrapper
//═══════════════════════════════════════════════════════════════════════════════

/** Slack platform errors that mean "token stale" → refresh + retry once. */
const AUTH_EXPIRED_ERRORS = new Set(['token_expired', 'invalid_auth']);

/**
 * True when a thrown `@slack/web-api` error indicates a stale access token.
 * Terminal states (`token_revoked`, `account_inactive`) deliberately return
 * false — a refresh cannot heal them and would burn the rate window.
 * @param err - error thrown by a WebClient call
 */
export function isSlackAuthExpiredError(err: unknown): boolean {
  const slackError = (err as { data?: { error?: string } } | null | undefined)?.data?.error;
  return typeof slackError === 'string' && AUTH_EXPIRED_ERRORS.has(slackError);
}

/**
 * Run a WebClient call with rotating-token semantics: on a stale-token error,
 * `authedSdkCall` refreshes once via the oauth worker (single-flight) and
 * retries once. The WebClient binds its token at construction, so it is
 * recreated whenever the token on disk rotated.
 * @param clients - the client container
 * @param fn - the SDK call to execute
 */
export async function slackCall<T>(
  clients: SlackClients,
  fn: (client: WebClient) => Promise<T>
): Promise<T> {
  return authedSdkCall({
    service: 'slack',
    state: clients.tokenState,
    lock: clients.lock,
    isAuthError: isSlackAuthExpiredError,
    send: async (token) => {
      if (clients.user.token !== token) {
        clients.user = new WebClient(token);
      }
      return fn(clients.user);
    },
  });
}

//═══════════════════════════════════════════════════════════════════════════════
// Error Handling
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Format Slack error messages consistently
 * Sanitizes errors and provides user-friendly messages
 * @param {unknown} error - Error object from Slack API
 * @returns {string} Formatted, user-friendly error message
 */
export function formatSlackError(error: unknown): string {
  // Refresh-path failures (oauth worker): an invalid_grant class means the
  // refresh token is dead (30-day expiry, revocation) — only a new sign-in helps.
  if (error instanceof OAuthRefreshError) {
    if (error.message.includes('invalid_grant')) {
      return withSetupGuidance(
        'Slack sign-in expired. Reconnect Slack in Speedwave Desktop (Integrations → Slack).'
      );
    }
    return `Slack token refresh failed: ${error.message}`;
  }

  // Handle @slack/web-api error responses
  const e = error as { message?: string; data?: { error?: string }; error?: string };
  const slackError = e.data?.error || e.error;

  if (
    slackError === 'not_authed' ||
    slackError === 'invalid_auth' ||
    slackError === 'token_expired' ||
    slackError === 'token_revoked'
  ) {
    return withSetupGuidance(
      'Slack authentication failed. Reconnect Slack in Speedwave Desktop (Integrations → Slack).'
    );
  }

  if (slackError === 'missing_scope' || slackError === 'restricted_action') {
    return 'Permission denied. Your Slack sign-in may not have sufficient permissions.';
  }

  if (slackError === 'channel_not_found') {
    return 'Channel not found in Slack.';
  }

  if (slackError === 'users_not_found' || slackError === 'user_not_found') {
    return 'User not found in Slack.';
  }

  if (slackError === 'ratelimited') {
    return 'Rate limit exceeded. Please try again later.';
  }

  if (e.message?.includes('getaddrinfo') || e.message?.includes('ECONNREFUSED')) {
    return 'Network error. Cannot connect to Slack API.';
  }

  // Return Slack error code if known
  if (slackError) {
    return `Slack API error: ${slackError}`;
  }

  return e.message || 'Slack API error';
}

//═══════════════════════════════════════════════════════════════════════════════
// Helpers
//═══════════════════════════════════════════════════════════════════════════════

/**
 * `conversations.list` pages may carry FAR fewer entries than `limit`
 * (Slack returns ~200 even with limit=1000), so a single call silently
 * drops channels — iterate `next_cursor` until exhausted.
 */
const CHANNEL_LIST_PAGE_LIMIT = 1000;

/** Hard cap on pagination (20k channels) — runaway-cursor backstop. */
const CHANNEL_LIST_MAX_PAGES = 20;

/** One `conversations.list` page request. */
function listChannelsPage(
  clients: SlackClients,
  types: string,
  excludeArchived: boolean,
  cursor: string | undefined
): Promise<ConversationsListResponse> {
  return slackCall(clients, (c) =>
    c.conversations.list({
      types,
      limit: CHANNEL_LIST_PAGE_LIMIT,
      ...(excludeArchived ? { exclude_archived: true } : {}),
      ...(cursor ? { cursor } : {}),
    })
  );
}

/** Cursor from a list response, or undefined on the last page. */
function nextCursorOf(result: ConversationsListResponse): string | undefined {
  return result.response_metadata?.next_cursor || undefined;
}

/**
 * Resolve channel name/id to channel ID
 * Supports: #channel-name, channel-name, or C123ABC (ID)
 * Paginates the channel list; returns as soon as the name matches.
 * @param {SlackClients} clients - Slack client container
 * @param {string} channel - Channel name or ID
 * @returns {Promise<string>} Channel ID
 * @throws {Error} If channel not found
 */
async function resolveChannelId(clients: SlackClients, channel: string): Promise<string> {
  // If already looks like an ID, return as-is
  if (/^[CDG][A-Z0-9]+$/.test(channel)) {
    return channel;
  }

  // Remove # prefix if present
  const channelName = channel.replace(/^#/, '');

  interface Channel {
    id?: string;
    name?: string;
    name_normalized?: string;
  }

  let cursor: string | undefined;
  for (let page = 0; page < CHANNEL_LIST_MAX_PAGES; page += 1) {
    const result = await listChannelsPage(clients, 'public_channel,private_channel', false, cursor);
    const found = result.channels?.find(
      (ch: Channel) => ch.name === channelName || ch.name_normalized === channelName
    );
    if (found?.id) {
      return found.id;
    }
    cursor = nextCursorOf(result);
    if (!cursor) {
      break;
    }
  }

  throw new Error(`Channel not found: ${channel}`);
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Implementations
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Send message to channel (as the signed-in user)
 * @param {SlackClients} clients - Slack client container
 * @param {Object} params - Parameters
 * @param {string} params.channel - Channel name or ID
 * @param {string} params.message - Message text to send
 * @returns {Promise<Object>} Result with ok status, timestamp, and channel ID
 * @throws {Error} If sending fails
 */
export async function sendChannel(
  clients: SlackClients,
  params: { channel: string; message: string }
): Promise<{ ok: boolean; ts?: string; channel?: string }> {
  const channelId = await resolveChannelId(clients, params.channel);

  const result = (await slackCall(clients, (c) =>
    c.chat.postMessage({
      channel: channelId,
      text: params.message,
    })
  )) as ChatPostMessageResponse;

  return {
    ok: result.ok || false,
    ts: result.ts,
    channel: result.channel,
  };
}

/**
 * Read message history from channel, with cursor pagination and an optional
 * timestamp window (`oldest`/`latest`) — iterate `next_cursor` to export the
 * full history.
 * @param {SlackClients} clients - Slack client container
 * @param {Object} params - Parameters
 * @param {string} params.channel - Channel name or ID
 * @param {number} [params.limit=50] - Maximum messages per page (1-100)
 * @param {string} [params.oldest] - Only messages after this timestamp
 * @param {string} [params.latest] - Only messages before this timestamp
 * @param {string} [params.cursor] - Cursor from a previous page
 * @returns {Promise<SlackHistoryPage>} One page of messages
 * @throws {Error} If reading fails
 */
export async function readChannel(
  clients: SlackClients,
  params: { channel: string; limit?: number; oldest?: string; latest?: string; cursor?: string }
): Promise<SlackHistoryPage> {
  const channelId = await resolveChannelId(clients, params.channel);
  const limit = Math.min(Math.max(params.limit || 50, 1), 100);

  const result = (await slackCall(clients, (c) =>
    c.conversations.history({
      channel: channelId,
      limit,
      ...(params.oldest ? { oldest: params.oldest } : {}),
      ...(params.latest ? { latest: params.latest } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    })
  )) as ConversationsHistoryResponse;

  interface RawMessage {
    user?: string;
    text?: string;
    ts?: string;
    type?: string;
    username?: string;
  }

  const messages: SlackMessage[] = (result.messages || []).map((msg: RawMessage) => ({
    user: msg.user || 'unknown',
    text: msg.text || '',
    ts: msg.ts || '',
    type: msg.type || 'message',
    username: msg.username,
  }));

  const nextCursor = result.response_metadata?.next_cursor || undefined;
  return {
    messages,
    next_cursor: nextCursor,
    has_more: result.has_more ?? Boolean(nextCursor),
  };
}

/**
 * List channels the user is a member of
 * @param {SlackClients} clients - Slack client container
 * @param {Object} [options] - Optional parameters
 * @param {string} [options.types] - Channel types to include (default: public_channel,private_channel)
 * @returns {Promise<Object>} Object containing array of channels
 * @throws {Error} If listing fails
 */
export async function getChannels(
  clients: SlackClients,
  options?: { types?: string }
): Promise<{ channels: SlackChannel[] }> {
  const types = options?.types || 'public_channel,private_channel';

  interface RawChannel {
    id?: string;
    name?: string;
    is_channel?: boolean;
    is_private?: boolean;
    is_member?: boolean;
    num_members?: number;
  }

  const raw: RawChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CHANNEL_LIST_MAX_PAGES; page += 1) {
    const result = await listChannelsPage(clients, types, true, cursor);
    raw.push(...((result.channels as RawChannel[] | undefined) || []));
    cursor = nextCursorOf(result);
    if (!cursor) {
      break;
    }
  }

  const channels: SlackChannel[] = raw
    .filter((ch: RawChannel) => ch.is_member)
    .map((ch: RawChannel) => ({
      id: ch.id || '',
      name: ch.name || '',
      is_channel: ch.is_channel || false,
      is_private: ch.is_private || false,
      is_member: Boolean(ch.is_member),
      num_members: ch.num_members,
    }));

  return { channels };
}

/**
 * Get user by email address
 * @param {SlackClients} clients - Slack client container
 * @param {Object} params - Parameters
 * @param {string} params.email - Email address to look up
 * @returns {Promise<Object>} Object containing user info or null if not found
 * @throws {Error} If lookup fails (except for user not found)
 */
export async function getUsers(
  clients: SlackClients,
  params: { email: string }
): Promise<{ user: SlackUser | null }> {
  try {
    const result = (await slackCall(clients, (c) =>
      c.users.lookupByEmail({
        email: params.email,
      })
    )) as UsersLookupByEmailResponse;

    if (!result.user) {
      return { user: null };
    }

    return {
      user: {
        id: result.user.id || '',
        name: result.user.name || '',
        real_name: result.user.real_name,
        email: result.user.profile?.email,
      },
    };
  } catch (error: unknown) {
    const e = error as { data?: { error?: string } };
    if (e.data?.error === 'users_not_found') {
      return { user: null };
    }
    throw error;
  }
}

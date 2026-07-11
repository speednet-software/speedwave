/**
 * Isolated Slack client for mcp-slack worker (@module slack/client): only accesses the Slack user access token (`/tokens/access_token`, RO), refreshed by the host-side oauth worker (ADR-060/071). All calls run as the signed-in user.
 * Error convention: `initializeSlackClients` returns a `_tokensStatus:'missing'` container on config failures (never throws); instance methods throw on API failures.
 */

import { mkdir, writeFile } from 'fs/promises';
import type { UserDirectoryCache } from './user-directory.js';
import path from 'path';
import {
  WebClient,
  ChatPostMessageResponse,
  ConversationsListResponse,
  ConversationsHistoryResponse,
  ConversationsRepliesResponse,
  UsersLookupByEmailResponse,
  AuthTestResponse,
  UsersInfoResponse,
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
  clampPageSize,
  type AuthedTokenState,
} from '@speedwave/mcp-shared';

// ── Types ──────────────────────────────────────────────────────────────────

/** Whether the Slack access token was loadable at startup. */
export type SlackTokensStatus = 'present' | 'missing';

/**
 * Container for the Slack user WebClient plus its refresh plumbing. Returned in **every** state, including when the token is
 * absent — check `_tokensStatus === 'missing'` rather than null; `user` is recreated by {@link slackCall} on rotation. `statusTracker` is optional only for tool-level unit-test mocking; runtime always populates it.
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
  /** Lazy users.list cache (see user-directory.ts) — created on first use. */
  _userDirectory?: UserDirectoryCache;
}

/** A Slack message: user ID, text, `ts` (the unique message identifier), and type. */
export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  type: string;
  /** Human-readable sender name resolved from the user directory (absent when unresolvable). */
  author?: string;
  username?: string;
  /** Present when the message belongs to a thread (equals the parent's ts). */
  thread_ts?: string;
  /** On a thread parent: number of replies — fetch them via readThread. */
  reply_count?: number;
  /** Files uploaded with this message (metadata only — content via getFileContent). */
  files?: SlackFileMeta[];
  /** Flattened text of legacy attachments (Jira/app messages often have empty `text`). */
  attachments_text?: string;
}

/** Metadata of a file shared in a message. */
export interface SlackFileMeta {
  id: string;
  name: string;
  title?: string;
  mimetype?: string;
  size?: number;
}

/** A Slack channel: ID (e.g. C01234567), name without `#` prefix, and membership/privacy flags. */
export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_member: boolean;
  num_members?: number;
}

/** A Slack user: ID (e.g. U01234567), username, and optional real name/email. */
export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  /** Profile display name — what the workspace actually shows. */
  display_name?: string;
  email?: string;
}

/** One page of channel history (cursor pagination over conversations.history). */
export interface SlackHistoryPage {
  messages: SlackMessage[];
  /** Pass back as `cursor` to fetch the next (older) page. */
  next_cursor?: string;
  has_more: boolean;
  /** The page size actually used, after clamping the requested `limit` to 1-100. */
  limit_used?: number;
}

/** The signed-in user's own identity, as resolved by getCurrentUser. */
export interface SlackCurrentUser extends SlackUser {
  team_id?: string;
}

// ── Client Factory ────────────────────────────────────────────────────────

/**
 * Initialize the Slack client from `access_token` in /tokens/ (written at sign-in by Desktop, refreshed by the host-side oauth worker).
 * Returns a `'missing'` container (never throws) when absent — graceful degradation so the server starts unconfigured. DO NOT change to throw.
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

// ── Refresh wrapper ───────────────────────────────────────────────────────

/** Slack platform errors that mean "token stale" → refresh + retry once. */
const AUTH_EXPIRED_ERRORS = new Set(['token_expired', 'invalid_auth']);

/**
 * True when a thrown `@slack/web-api` error indicates a stale access token.
 * Terminal states (`token_revoked`, `account_inactive`) deliberately return false — a refresh cannot heal them.
 * @param err - The thrown value to inspect.
 */
export function isSlackAuthExpiredError(err: unknown): boolean {
  const slackError = (err as { data?: { error?: string } } | null | undefined)?.data?.error;
  return typeof slackError === 'string' && AUTH_EXPIRED_ERRORS.has(slackError);
}

/**
 * Run a WebClient call with rotating-token refresh-and-retry on stale errors.
 * @param clients - The Slack client container.
 * @param fn - The WebClient call to run.
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

// ── Error Handling ────────────────────────────────────────────────────────

const AUTH_FAILURE_MESSAGE = withSetupGuidance(
  'Slack authentication failed. Reconnect Slack in Speedwave Desktop (Integrations → Slack).'
);
const MISSING_SCOPE_MESSAGE = withSetupGuidance(
  'Permission denied: the Slack sign-in lacks a newly required permission. ' +
    'Re-authorise Slack in Speedwave Desktop (Integrations → Slack) and retry.'
);
const MALFORMED_FIELD_MESSAGE =
  'Slack rejected the request: a required field was missing or malformed (e.g. empty message text).';

/** Slack platform error code → user-facing message, for exact-match codes. */
const SLACK_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  not_authed: AUTH_FAILURE_MESSAGE,
  invalid_auth: AUTH_FAILURE_MESSAGE,
  token_expired: AUTH_FAILURE_MESSAGE,
  token_revoked: AUTH_FAILURE_MESSAGE,
  missing_scope: MISSING_SCOPE_MESSAGE,
  restricted_action: MISSING_SCOPE_MESSAGE,
  channel_not_found: 'Channel not found in Slack.',
  users_not_found: 'User not found in Slack.',
  user_not_found: 'User not found in Slack.',
  ratelimited: 'Rate limit exceeded. Please try again later.',
  is_archived:
    'This channel is archived and cannot receive new messages. Choose a different channel.',
  msg_too_long: "Message text exceeds Slack's length limit; shorten it and retry.",
  not_in_channel:
    'The signed-in user is not a member of this channel; use listChannelIds to see channels you can post to.',
  cant_dm_bot:
    'Slack apps/bots cannot receive DMs. Use findUsers to confirm the recipient is a real person.',
  no_text: MALFORMED_FIELD_MESSAGE,
  invalid_arguments: MALFORMED_FIELD_MESSAGE,
});

/**
 * Sanitizes a Slack API error and returns a user-friendly message via {@link SLACK_ERROR_MESSAGES}.
 * @param error - The thrown value to format.
 */
export function formatSlackError(error: unknown): string {
  // invalid_grant: refresh token dead (revocation or 30-day expiry) — only new sign-in helps.
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

  if (slackError && slackError in SLACK_ERROR_MESSAGES) {
    return SLACK_ERROR_MESSAGES[slackError];
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

// ── Helpers ────────────────────────────────────────────────────────────────

// conversations.list may return far fewer entries than limit; iterate next_cursor until exhausted.
const CHANNEL_LIST_PAGE_LIMIT = 1000;

/** Hard cap on pagination (20k channels) — runaway-cursor backstop. */
const CHANNEL_LIST_MAX_PAGES = 20;

/**
 * One `conversations.list` page request; `cursor` undefined requests the first page.
 * @param clients - The Slack client container.
 * @param types - Comma-separated conversation types to include.
 * @param excludeArchived - Whether to exclude archived conversations.
 * @param cursor - Pagination cursor, or undefined for the first page.
 */
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

/**
 * Cursor from a list response, or undefined on the last page.
 * @param result - A conversations.list response.
 */
function nextCursorOf(result: ConversationsListResponse): string | undefined {
  return result.response_metadata?.next_cursor || undefined;
}

/**
 * Resolve channel name/id to channel ID. Supports #channel-name, channel-name, or C123ABC (ID).
 * Paginates the channel list; returns as soon as the name matches; throws if not found.
 * @param clients - The Slack client container.
 * @param channel - Channel name (with or without `#`) or channel ID.
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

  throw new Error(
    `Channel not found: ${channel}. If this is a person, use findUsers then openDirectMessage. ` +
      'If it is a channel, call listChannelIds to see channels you (the signed-in user) are a ' +
      'member of — Speedwave has no bot to invite, so a missing channel usually means you are not a member.'
  );
}

// ── Tool Implementations ──────────────────────────────────────────────────

/**
 * Send a message to a channel as the signed-in user; returns ok status, timestamp, and channel ID; throws if sending fails.
 * @param clients - The Slack client container.
 * @param params - Message target and body.
 * @param params.channel - Channel name (with or without `#`) or channel ID.
 * @param params.message - Message text.
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
 * Read message history from a channel, with cursor pagination and an optional `oldest`/`latest` timestamp window.
 * `limit` defaults to 50, clamped 1-100; iterate `next_cursor` to export the full history; throws if reading fails.
 * @param clients - The Slack client container.
 * @param params - Query params.
 * @param params.channel - Channel name (with or without `#`) or channel ID.
 * @param params.limit - Max messages per page (default 50, clamped 1-100).
 * @param params.oldest - Oldest timestamp (inclusive) of the window.
 * @param params.latest - Latest timestamp (exclusive) of the window.
 * @param params.cursor - Pagination cursor from a previous page.
 */
export async function readChannel(
  clients: SlackClients,
  params: { channel: string; limit?: number; oldest?: string; latest?: string; cursor?: string }
): Promise<SlackHistoryPage> {
  const channelId = await resolveChannelId(clients, params.channel);
  const limit = clampPageSize(params.limit, 50, 100);

  const result = (await slackCall(clients, (c) =>
    c.conversations.history({
      channel: channelId,
      limit,
      ...(params.oldest ? { oldest: params.oldest } : {}),
      ...(params.latest ? { latest: params.latest } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    })
  )) as ConversationsHistoryResponse;

  return toHistoryPage(result, limit);
}

interface RawFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
}

interface RawAttachment {
  title?: string;
  text?: string;
  fallback?: string;
}

interface RawMessage {
  user?: string;
  text?: string;
  ts?: string;
  type?: string;
  username?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: RawFile[];
  attachments?: RawAttachment[];
}

/**
 * Compact, model-readable rendering of legacy attachments.
 * @param attachments - raw attachments from a message
 */
function flattenAttachments(attachments: RawAttachment[] | undefined): string | undefined {
  if (!attachments?.length) return undefined;
  const parts = attachments
    .map((a) => [a.title, a.text].filter(Boolean).join(': ') || a.fallback || '')
    .filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

/**
 * File metadata subset surfaced to the model.
 * @param files - raw files from a message
 */
function mapFiles(files: RawFile[] | undefined): SlackFileMeta[] | undefined {
  if (!files?.length) return undefined;
  return files.map((f) => ({
    id: f.id || '',
    name: f.name || '',
    title: f.title,
    mimetype: f.mimetype,
    size: f.size,
  }));
}

/**
 * Maps a history/replies response onto the shared page shape.
 * @param result - Raw conversations.history/replies response.
 * @param result.messages - Raw messages returned by Slack.
 * @param result.has_more - Whether more pages are available.
 * @param result.response_metadata - Pagination metadata.
 * @param result.response_metadata.next_cursor - Cursor for the next page.
 * @param limitUsed - The (possibly clamped) `limit` actually sent to Slack.
 */
function toHistoryPage(
  result: {
    messages?: RawMessage[];
    has_more?: boolean;
    response_metadata?: { next_cursor?: string };
  },
  limitUsed: number
): SlackHistoryPage {
  const messages: SlackMessage[] = (result.messages || []).map((msg: RawMessage) => ({
    user: msg.user || 'unknown',
    text: msg.text || '',
    ts: msg.ts || '',
    type: msg.type || 'message',
    username: msg.username,
    thread_ts: msg.thread_ts,
    reply_count: msg.reply_count,
    files: mapFiles(msg.files),
    attachments_text: flattenAttachments(msg.attachments),
  }));

  const nextCursor = result.response_metadata?.next_cursor || undefined;
  return {
    messages,
    next_cursor: nextCursor,
    has_more: result.has_more ?? Boolean(nextCursor),
    limit_used: limitUsed,
  };
}

/** Shape of a genuine Slack message timestamp — seconds dot 6-digit microseconds. */
const SLACK_TS_RE = /^\d+\.\d{6}$/;

/**
 * True when `value` looks like a real Slack `ts` (e.g. "1717000000.000100"); guards against a reformatted/rounded copy.
 * @param value - The candidate timestamp string.
 */
function looksLikeSlackTs(value: string): boolean {
  return SLACK_TS_RE.test(value);
}

/**
 * Read one page of a thread (`conversations.replies`) — the first item on the first page is the thread parent, rest are replies (oldest first).
 * `limit` defaults to 50, clamped 1-100; throws if reading fails or `thread_ts` is not a genuine Slack timestamp.
 * @param clients - The Slack client container.
 * @param params - Query params.
 * @param params.channel - Channel name (with or without `#`) or channel ID.
 * @param params.thread_ts - Thread parent's Slack timestamp.
 * @param params.limit - Max messages per page (default 50, clamped 1-100).
 * @param params.cursor - Pagination cursor from a previous page.
 */
export async function readThread(
  clients: SlackClients,
  params: { channel: string; thread_ts: string; limit?: number; cursor?: string }
): Promise<SlackHistoryPage> {
  if (!looksLikeSlackTs(params.thread_ts)) {
    throw new Error(
      `thread_ts "${params.thread_ts}" does not look like a Slack timestamp (expected e.g. ` +
        '"1717000000.000100"). Copy it exactly from a getChannelMessages/getThreadMessages ' +
        'result — do not reformat or round it.'
    );
  }
  const channelId = await resolveChannelId(clients, params.channel);
  const limit = clampPageSize(params.limit, 50, 100);

  const result = (await slackCall(clients, (c) =>
    c.conversations.replies({
      channel: channelId,
      ts: params.thread_ts,
      limit,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    })
  )) as ConversationsRepliesResponse;

  return toHistoryPage(result, limit);
}

/** Max file bytes returned to the model — guards context and worker memory. */
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;

/**
 * Mimetypes whose content is returned as text.
 * @param mimetype - file mimetype from files.info
 */
function isTextLike(mimetype: string): boolean {
  return (
    mimetype.startsWith('text/') ||
    mimetype === 'application/json' ||
    mimetype === 'application/xml' ||
    mimetype.endsWith('+json') ||
    mimetype.endsWith('+xml')
  );
}

/** Result of a file-content read. */
export interface SlackFileContent {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  content: string;
  /** True when the file was larger than the byte cap and got cut. */
  truncated: boolean;
}

/** files.info metadata, narrowed to the fields the download path needs. */
interface SlackFileMetaResolved {
  id: string;
  name: string;
  mimetype: string;
  size?: number;
  url_private: string;
}

/**
 * Resolve a file's metadata via files.info (requires `files:read`); kept separate from the byte download so callers can
 * gate on mimetype (e.g. getFileContent refusing binaries) without ever fetching the bytes.
 * @param clients - The Slack client container.
 * @param fileId - Slack file ID.
 */
async function resolveSlackFileMeta(
  clients: SlackClients,
  fileId: string
): Promise<SlackFileMetaResolved> {
  const info = await slackCall(clients, (c) => c.files.info({ file: fileId }));
  const file = info.file as
    | { id?: string; name?: string; mimetype?: string; size?: number; url_private?: string }
    | undefined;
  if (!file?.url_private) {
    throw new Error(`File not found or has no downloadable content: ${fileId}`);
  }
  return {
    id: file.id || fileId,
    name: file.name || '',
    mimetype: file.mimetype || 'application/octet-stream',
    size: file.size,
    url_private: file.url_private,
  };
}

/** Slack CDN downloads normally finish in seconds; a minute covers slow links. */
const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Download a resolved file's bytes from url_private with the bearer header. With a stale token Slack answers HTTP 200
 * with an HTML login page — detected by content-type and routed through the refresh wrapper.
 * @param clients - The Slack client container.
 * @param meta - Resolved file metadata (url_private, mimetype, name).
 * @param maxBytes - When set, rejects an over-cap Content-Length before buffering.
 */
async function downloadSlackFileBytes(
  clients: SlackClients,
  meta: SlackFileMetaResolved,
  maxBytes?: number
): Promise<Buffer> {
  return slackCall(clients, async (c) => {
    const resp = await fetch(meta.url_private, {
      headers: { Authorization: `Bearer ${c.token ?? ''}` },
      signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
    });
    const contentType = resp.headers.get('content-type') || '';
    const htmlButNotHtmlFile = contentType.includes('text/html') && meta.mimetype !== 'text/html';
    if (!resp.ok || htmlButNotHtmlFile) {
      // Mimic the platform-error shape so isSlackAuthExpiredError triggers.
      throw Object.assign(new Error('file download unauthorized'), {
        data: { error: 'token_expired' },
      });
    }
    const declared = Number(resp.headers.get('content-length') || 0);
    if (maxBytes !== undefined && declared > maxBytes) {
      throw new Error(
        `File '${meta.name}' is ${declared} bytes — over the download cap. ` +
          'Ask the user to share it another way.'
      );
    }
    return Buffer.from(await resp.arrayBuffer());
  });
}

/** Buffering cap for both file paths — the worker container has 128 MiB total. */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Read the content of a text file shared on Slack (requires `files:read`). Binary files are refused from metadata
 * alone — no bytes are downloaded — use downloadFile + the office integration for PDFs/documents instead.
 * @param clients - The Slack client container.
 * @param params - Target file.
 * @param params.file - Slack file ID.
 */
export async function getFileContent(
  clients: SlackClients,
  params: { file: string }
): Promise<SlackFileContent> {
  const meta = await resolveSlackFileMeta(clients, params.file);
  if (!isTextLike(meta.mimetype)) {
    throw new Error(
      `File '${meta.name}' is ${meta.mimetype} — only text files can be read inline. ` +
        'Download it into the workspace with downloadFile instead.'
    );
  }
  // Reject oversized files from metadata — bounded worker buffer.
  if (meta.size !== undefined && meta.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `File '${meta.name}' is ${meta.size} bytes — too large to read. ` +
        'Ask the user to share an excerpt.'
    );
  }
  const body = await downloadSlackFileBytes(clients, meta, MAX_DOWNLOAD_BYTES);
  const truncated = body.length > MAX_FILE_CONTENT_BYTES;
  const content = body.subarray(0, MAX_FILE_CONTENT_BYTES).toString('utf-8');
  return {
    id: meta.id,
    name: meta.name,
    mimetype: meta.mimetype,
    size: meta.size ?? body.length,
    content,
    truncated,
  };
}

/** Hidden workspace subpath for downloads — keeps the project root clean (same convention as office's `.speedwave/office`). */
const SLACK_DOWNLOAD_SUBPATH = path.join('.speedwave', 'slack');

/** Workspace mount root (env override for tests). */
function workspaceDir(): string {
  return process.env.WORKSPACE_DIR || '/workspace';
}

/**
 * Reduce a filename to a safe basename (no separators, no leading dots).
 * @param name - Raw filename from Slack's files.info.
 */
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'file';
}

/** Result of a workspace download. */
export interface SlackDownloadedFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  /** Container path the file was written to (under /workspace). */
  path: string;
}

/**
 * Download any file shared on Slack into the project workspace (`/workspace/.speedwave/slack/<id>-<name>`), where
 * filesystem reads and the office integration (PDF/Word/Excel) can process it. Requires `files:read`.
 * @param clients - The Slack client container.
 * @param params - Target file.
 * @param params.file - Slack file ID.
 */
export async function downloadFile(
  clients: SlackClients,
  params: { file: string }
): Promise<SlackDownloadedFile> {
  const meta = await resolveSlackFileMeta(clients, params.file);
  const body = await downloadSlackFileBytes(clients, meta, MAX_DOWNLOAD_BYTES);
  if (body.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `File '${meta.name}' is ${body.length} bytes — over the download cap. ` +
        'Ask the user to share it another way.'
    );
  }
  const dir = path.join(workspaceDir(), SLACK_DOWNLOAD_SUBPATH);
  await mkdir(dir, { recursive: true });
  // meta.id can fall back to the caller-provided file ID — sanitize it too.
  const target = path.join(dir, `${sanitizeFilename(meta.id)}-${sanitizeFilename(meta.name)}`);
  await writeFile(target, body);
  return {
    id: meta.id,
    name: meta.name,
    mimetype: meta.mimetype,
    size: body.length,
    path: target,
  };
}

/**
 * List channels the user is a member of; `options.types` defaults to `public_channel,private_channel`; throws if listing fails.
 * @param clients - The Slack client container.
 * @param options - Listing options.
 * @param options.types - Comma-separated conversation types to include.
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
 * Get a user by email address; returns `{ user: null }` if not found, throws on any other lookup failure.
 * @param clients - The Slack client container.
 * @param params - Lookup params.
 * @param params.email - Email address to look up.
 */
export async function getUsers(
  clients: SlackClients,
  params: { email: string }
): Promise<{ user: SlackUser | null }> {
  const email = params.email.trim();
  try {
    const result = (await slackCall(clients, (c) =>
      c.users.lookupByEmail({
        email,
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
        display_name: result.user.profile?.display_name || undefined,
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

/**
 * Resolve the signed-in user's identity via `auth.test` (ground truth for "me"), enriched with `users.info` for the display name when that lookup succeeds.
 * Throws (with `.data.error` set) if `auth.test` fails or reports `ok: false`, or if `ok: true` but `user_id` is missing (malformed response).
 * @param clients - The Slack client container.
 */
export async function getCurrentUser(clients: SlackClients): Promise<SlackCurrentUser> {
  const auth = (await slackCall(clients, (c) => c.auth.test())) as AuthTestResponse;
  if (!auth.ok) {
    const code = auth.error ?? 'unknown_error';
    throw Object.assign(new Error(code), { data: { error: code } });
  }
  if (!auth.user_id) {
    throw new Error('auth.test did not return a user_id.');
  }

  const base: SlackCurrentUser = {
    id: auth.user_id,
    name: auth.user || '',
    team_id: auth.team_id,
  };

  try {
    const info = (await slackCall(clients, (c) =>
      c.users.info({ user: auth.user_id as string })
    )) as UsersInfoResponse;
    if (info.user) {
      base.real_name = info.user.real_name;
      base.display_name = info.user.profile?.display_name || undefined;
      base.name = info.user.name || base.name;
    }
  } catch (error) {
    // Best-effort enrichment — auth.test alone is enough ground truth for "me".
    console.warn(
      `${ts()} Slack getCurrentUser: users.info enrichment failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return base;
}

/** One direct-message conversation as returned by listDms. */
export interface SlackDmSummary {
  /** Conversation ID — pass to getChannelMessages/sendChannel. */
  id: string;
  type: 'im' | 'mpim';
  /** 1:1 only: the other party's user ID. */
  user?: string;
  /** mpim only: the synthetic mpdm-… name. */
  name?: string;
  /** 1:1 only: the other party's account is deactivated. */
  is_user_deleted?: boolean;
}

/**
 * List the signed-in user's open DM conversations (1:1 and group). Requires `im:read` + `mpim:read`. No `is_member` filter — im
 * objects do not carry it (that filter is why getChannels cannot serve DMs). Throws on missing scopes or API failure.
 * @param clients - The Slack client container.
 */
export async function listDms(clients: SlackClients): Promise<{ dms: SlackDmSummary[] }> {
  interface RawDm {
    id?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    user?: string;
    name?: string;
    is_user_deleted?: boolean;
  }

  const dms: SlackDmSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CHANNEL_LIST_MAX_PAGES; page += 1) {
    const result = await listChannelsPage(clients, 'im,mpim', true, cursor);
    for (const ch of (result.channels ?? []) as RawDm[]) {
      if (!ch.id) {
        continue;
      }
      if (ch.is_im) {
        dms.push({ id: ch.id, type: 'im', user: ch.user, is_user_deleted: ch.is_user_deleted });
      } else {
        dms.push({ id: ch.id, type: 'mpim', name: ch.name });
      }
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) {
      break;
    }
  }
  return { dms };
}

/** User-ID shape accepted by conversations.open (U… or enterprise W…): a letter/digit run of at least 8 chars after the prefix, no upper length bound. */
const USER_ID_RE = /^[UW][A-Z0-9]{8,}$/;

/** Slack caps a single conversation at 8 participants (conversations.open). */
const MAX_DM_PARTICIPANTS = 8;

/**
 * Open (or return the existing) DM conversation with one or more users. Entries may be user IDs (`U…`/`W…`) or exact e-mail
 * addresses (plain names rejected with findUsers guidance); 1 user opens a 1:1 DM, 2-8 a group DM (`im:write`/`mpim:write`); opening is silent until a message is sent.
 * @param clients - The Slack client container.
 * @param params - Recipients.
 * @param params.users - 1-8 user IDs or e-mail addresses.
 */
export async function openDm(
  clients: SlackClients,
  params: { users: string[] }
): Promise<{ id: string }> {
  if (!Array.isArray(params.users)) {
    throw new Error("'users' is required: an array of 1-8 user IDs or e-mail addresses.");
  }
  if (params.users.length === 0) {
    throw new Error('openDirectMessage needs at least one user.');
  }
  if (params.users.length > MAX_DM_PARTICIPANTS) {
    throw new Error(
      `A Slack DM holds at most ${MAX_DM_PARTICIPANTS} people; got ${params.users.length}.`
    );
  }
  const ids: string[] = [];
  for (const entry of params.users) {
    const normalized = entry.toUpperCase();
    if (USER_ID_RE.test(normalized)) {
      ids.push(normalized);
    } else if (entry.includes('@')) {
      const found = await getUsers(clients, { email: entry });
      if (!found.user) {
        throw new Error(
          `No Slack user found for email "${entry}". Check for typos/whitespace, or use findUsers to search by name instead.`
        );
      }
      ids.push(found.user.id);
    } else {
      throw new Error(
        `'${entry}' is not a user ID or email. Find the person with findUsers first.`
      );
    }
  }

  const result = await slackCall(clients, (c) => c.conversations.open({ users: ids.join(',') }));
  const channel = result.channel as { id?: string } | undefined;
  if (!channel?.id) {
    throw new Error('Slack did not return a conversation ID from conversations.open.');
  }
  return { id: channel.id };
}

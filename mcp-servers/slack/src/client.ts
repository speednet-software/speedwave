/**
 * Slack API Client module providing isolated client for mcp-slack worker
 * @module slack/client
 * Slack API Client
 *
 * Isolated Slack client for mcp-slack worker.
 * ONLY has access to Slack tokens - no other service tokens.
 *
 * Security:
 * - Tokens read from /tokens/ (RO mount)
 * - Tokens NEVER exposed in responses
 * - Blast radius containment: only Slack exposed if compromised
 *
 * Error Handling Convention:
 * - Factory functions (initializeSlackClients) return null on config failures (graceful degradation)
 * - Instance methods throw errors on API failures
 */

import {
  WebClient,
  ChatPostMessageResponse,
  ConversationsListResponse,
  ConversationsHistoryResponse,
  UsersLookupByEmailResponse,
} from '@slack/web-api';
import fs from 'fs/promises';
import path from 'path';
import { ts } from '@speedwave/mcp-shared';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Container for bot and user Slack WebClient instances
 * @interface SlackClients
 * @property {WebClient} bot - Bot token client for admin operations
 * @property {WebClient} user - User token client for user-context operations
 */
export interface SlackClients {
  bot: WebClient;
  user: WebClient;
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

//═══════════════════════════════════════════════════════════════════════════════
// Token Loading
//═══════════════════════════════════════════════════════════════════════════════

const TOKENS_DIR = process.env.TOKENS_DIR || '/tokens';

/**
 * Load a token from the tokens directory
 * @param {string} tokenName - Name of the token file
 * @returns {Promise<string>} Token content (trimmed)
 * @throws {Error} If token file cannot be read
 */
async function loadToken(tokenName: string): Promise<string> {
  const tokenPath = path.join(TOKENS_DIR, tokenName);
  const token = await fs.readFile(tokenPath, 'utf-8');
  return token.trim();
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Factory
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize Slack clients from tokens
 * Loads bot_token and user_token from /tokens/ directory.
 *
 * IMPORTANT: Returns null (not throws) when tokens are missing or invalid.
 * This enables "graceful degradation" - server starts even without config:
 * - User can run `speedwave up` without configuring all integrations
 * - Healthcheck reports `configured: false` for unconfigured services
 * - Tools return clear "not configured" error when called
 *
 * DO NOT change this to throw - it breaks container startup for unconfigured services.
 * @returns Initialized clients, or null if tokens not found/invalid
 */
export async function initializeSlackClients(): Promise<SlackClients | null> {
  try {
    const botToken = await loadToken('bot_token');
    const userToken = await loadToken('user_token');

    // Validate tokens are not empty
    const missingTokens: string[] = [];
    if (!botToken) missingTokens.push('bot_token');
    if (!userToken) missingTokens.push('user_token');

    if (missingTokens.length > 0) {
      console.warn(
        `${ts()} Slack tokens are empty or missing. Missing: ${missingTokens.join(', ')}. Run: speedwave setup slack`
      );
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      return null;
    }

    console.log(`${ts()} ✅ Slack: Tokens loaded`);

    return {
      bot: new WebClient(botToken),
      user: new WebClient(userToken),
    };
  } catch (error) {
    console.warn(
      `${ts()} Failed to load Slack tokens: ${error instanceof Error ? error.message : 'Unknown error'}. Run: speedwave setup slack`
    );
    // Graceful degradation: log warning, return null, let server start
    // DO NOT throw here - see JSDoc above for rationale
    return null;
  }
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
  // Handle @slack/web-api error responses
  const e = error as { message?: string; data?: { error?: string }; error?: string };
  const slackError = e.data?.error || e.error;

  if (
    slackError === 'not_authed' ||
    slackError === 'invalid_auth' ||
    slackError === 'token_revoked'
  ) {
    return 'Authentication failed. Check your Slack tokens. Run: speedwave setup slack';
  }

  if (slackError === 'missing_scope' || slackError === 'restricted_action') {
    return 'Permission denied. Your Slack tokens may not have sufficient permissions.';
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
 * Resolve channel name/id to channel ID
 * Supports: #channel-name, channel-name, or C123ABC (ID)
 * @param {WebClient} client - Slack WebClient instance
 * @param {string} channel - Channel name or ID
 * @returns {Promise<string>} Channel ID
 * @throws {Error} If channel not found
 */
async function resolveChannelId(client: WebClient, channel: string): Promise<string> {
  // If already looks like an ID, return as-is
  if (/^[CDG][A-Z0-9]+$/.test(channel)) {
    return channel;
  }

  // Remove # prefix if present
  const channelName = channel.replace(/^#/, '');

  // List channels to find by name
  const result = await client.conversations.list({
    types: 'public_channel,private_channel',
    limit: 1000,
  });

  interface Channel {
    id?: string;
    name?: string;
    name_normalized?: string;
  }

  const found = result.channels?.find(
    (ch: Channel) => ch.name === channelName || ch.name_normalized === channelName
  );

  if (!found || !found.id) {
    throw new Error(`Channel not found: ${channel}`);
  }

  return found.id;
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Implementations
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Send message to channel (as user, not bot)
 * @param {SlackClients} clients - Slack client instances
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
  const channelId = await resolveChannelId(clients.user, params.channel);

  const result = (await clients.user.chat.postMessage({
    channel: channelId,
    text: params.message,
  })) as ChatPostMessageResponse;

  return {
    ok: result.ok || false,
    ts: result.ts,
    channel: result.channel,
  };
}

/**
 * Read message history from channel
 * @param {SlackClients} clients - Slack client instances
 * @param {Object} params - Parameters
 * @param {string} params.channel - Channel name or ID
 * @param {number} [params.limit=20] - Maximum number of messages (1-100)
 * @returns {Promise<Object>} Object containing array of messages
 * @throws {Error} If reading fails
 */
export async function readChannel(
  clients: SlackClients,
  params: { channel: string; limit?: number }
): Promise<{ messages: SlackMessage[] }> {
  const channelId = await resolveChannelId(clients.user, params.channel);
  const limit = Math.min(Math.max(params.limit || 20, 1), 100);

  const result = (await clients.user.conversations.history({
    channel: channelId,
    limit,
  })) as ConversationsHistoryResponse;

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

  return { messages };
}

/**
 * List channels the user is a member of
 * @param {SlackClients} clients - Slack client instances
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
  const result = (await clients.user.conversations.list({
    types,
    exclude_archived: true,
    limit: 1000,
  })) as ConversationsListResponse;

  interface RawChannel {
    id?: string;
    name?: string;
    is_channel?: boolean;
    is_private?: boolean;
    is_member?: boolean;
    num_members?: number;
  }

  const channels: SlackChannel[] = (result.channels || [])
    .filter((ch: RawChannel) => ch.is_member)
    .map((ch: RawChannel) => ({
      id: ch.id || '',
      name: ch.name || '',
      is_channel: ch.is_channel || false,
      is_private: ch.is_private || false,
      is_member: ch.is_member || false,
      num_members: ch.num_members,
    }));

  return { channels };
}

/**
 * Get user by email address
 * @param {SlackClients} clients - Slack client instances
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
    const result = (await clients.user.users.lookupByEmail({
      email: params.email,
    })) as UsersLookupByEmailResponse;

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

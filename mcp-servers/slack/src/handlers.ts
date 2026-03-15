/**
 * Slack MCP Handlers module providing testable handler functions with dependency injection
 * @module slack/handlers
 * Slack MCP Handlers
 * Extracted from index.ts for testability
 *
 * This module exports createSlackHandlers() factory function
 * that returns all Slack tool handlers with injected dependencies.
 */

import { WebClient } from '@slack/web-api';
import { ToolHandler, ToolsCallResult, loadToken, ts } from '@speedwave/mcp-shared';

//═══════════════════════════════════════════════════════════════════════════════
// Helper Functions & Types
//═══════════════════════════════════════════════════════════════════════════════

// v0.55: entire service token directory is mounted as /tokens
// Files: /tokens/bot_token, /tokens/user_token (no service prefix)
const TOKEN_DIR = '/tokens';
const USER_TOKEN_PATH = `${TOKEN_DIR}/user_token`;

/**
 * User info cache
 * Maps User ID → { real_name, name, email }
 * Rationale: Avoid redundant API calls for same users
 * @interface UserInfo
 * @property {string} [real_name] - User's real name
 * @property {string} [name] - User's username
 * @property {string} [email] - User's email address
 */
interface UserInfo {
  real_name?: string;
  name?: string;
  email?: string;
}

/**
 * Slack API response types
 * Provides type safety for API responses
 * @interface SlackChannel
 * @property {string} id - Channel ID
 * @property {string} name - Channel name
 * @property {boolean} is_private - Whether channel is private
 * @property {boolean} is_member - Whether user is a member
 * @property {number} [num_members] - Number of channel members
 */
interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  num_members?: number;
}

/**
 * Represents a Slack message from API
 * @interface SlackMessage
 * @property {string} [user] - User ID who sent the message
 * @property {string} [text] - Message text
 * @property {string} [ts] - Message timestamp
 * @property {string} [type] - Message type
 */
interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  type?: string;
}

/**
 * Error thrown when user info fetch fails.
 * Provides proper error context instead of silent null returns.
 */
class UserInfoError extends Error {
  /**
   * Create a new UserInfoError
   * @param userId - The Slack user ID that failed to fetch
   * @param cause - The underlying error that caused the failure
   */
  constructor(
    public readonly userId: string,
    public readonly cause?: Error
  ) {
    super(`Failed to fetch user info for ${userId}${cause ? `: ${cause.message}` : ''}`);
    this.name = 'UserInfoError';
  }
}

/**
 * Error thrown when channel resolution fails.
 * Provides proper error context instead of silent fallback returns.
 */
class ChannelResolutionError extends Error {
  /**
   * Create a new ChannelResolutionError
   * @param channelInput - The channel name or ID that failed to resolve
   * @param cause - The underlying error that caused the failure
   */
  constructor(
    public readonly channelInput: string,
    public readonly cause?: Error
  ) {
    super(`Failed to resolve channel "${channelInput}"${cause ? `: ${cause.message}` : ''}`);
    this.name = 'ChannelResolutionError';
  }
}

/**
 * Response from conversations.list API
 * @interface SlackConversationsListResponse
 * @property {boolean} ok - Whether request was successful
 * @property {SlackChannel[]} [channels] - Array of channels
 * @property {string} [error] - Error message if ok is false
 */
interface SlackConversationsListResponse {
  ok: boolean;
  channels?: SlackChannel[];
  error?: string;
}

/**
 * Response from conversations.history API
 * @interface SlackConversationsHistoryResponse
 * @property {boolean} ok - Whether request was successful
 * @property {SlackMessage[]} [messages] - Array of messages
 * @property {string} [error] - Error message if ok is false
 */
interface SlackConversationsHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
}

//═══════════════════════════════════════════════════════════════════════════════
// Handler Factory
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Create Slack MCP handlers with dependency injection
 * Factory function that creates all Slack tool handlers with proper dependency injection
 * @param {Object|null} slackClients - Slack WebClient instances (bot + user) or null if not configured
 * @param {WebClient} slackClients.bot - Bot token client
 * @param {WebClient} slackClients.user - User token client
 * @returns {SlackHandlers} Object with all handler functions
 */
export function createSlackHandlers(slackClients: { bot: WebClient; user: WebClient } | null) {
  // User cache specific to this handler instance
  const userCache: Map<string, UserInfo> = new Map();

  /**
   * Get user information by User ID
   * Uses cache to avoid redundant API calls
   * @async
   * @param {string} userId - Slack User ID (e.g., U019URTBANR)
   * @returns {Promise<UserInfo>} User info (real_name, name, email)
   * @throws {UserInfoError} When user info cannot be fetched
   */
  async function getUserInfo(userId: string): Promise<UserInfo> {
    // Check cache first
    if (userCache.has(userId)) {
      return userCache.get(userId)!;
    }

    // Fetch from API
    if (!slackClients) {
      const error = new UserInfoError(userId);
      console.error(`${ts()} ❌ ${error.message}: Slack clients not configured`);
      throw error;
    }

    try {
      const result = await slackClients.bot.users.info({ user: userId });
      if (result.ok && result.user) {
        const userInfo: UserInfo = {
          real_name: result.user.real_name,
          name: result.user.name,
          email: result.user.profile?.email,
        };
        userCache.set(userId, userInfo);
        return userInfo;
      }
      // API returned ok=false or no user data
      const error = new UserInfoError(userId);
      console.error(
        `${ts()} ❌ ${error.message}: API returned ok=${result.ok}, user=${!!result.user}`
      );
      throw error;
    } catch (error) {
      // Re-throw UserInfoError as-is
      if (error instanceof UserInfoError) {
        throw error;
      }
      // Wrap other errors with context
      const wrappedError = new UserInfoError(
        userId,
        error instanceof Error ? error : new Error(String(error))
      );
      console.error(`${ts()} ❌ ${wrappedError.message}`);
      throw wrappedError;
    }
  }

  /**
   * Convert channel name to ID
   * Supports: #channel-name, channel-name, or C123ABC (ID)
   *
   * Rationale:
   * - Slack API requires channel IDs (format: C0123ABC) for reliable access
   * - users.conversations API has a bug: returns is_member=false for private channels even when user IS a member
   * - This helper resolves channel names to IDs automatically
   * @async
   * @param {string} channelInput - Channel name or ID
   * @returns {Promise<string>} Channel ID
   * @throws {ChannelResolutionError} When channel cannot be resolved
   */
  async function resolveChannelId(channelInput: string): Promise<string> {
    // If already looks like ID (starts with C for public or G for private/group), return as-is
    // Slack channel ID formats: C (public), G (private/group), D (DM)
    if (channelInput.match(/^[CGD][A-Z0-9]+$/)) {
      return channelInput;
    }

    // Remove # prefix if present
    const channelName = channelInput.replace(/^#/, '');

    try {
      // Try to find channel by name using users.conversations
      const userToken = await loadToken(USER_TOKEN_PATH);
      const response = await fetch(
        'https://slack.com/api/users.conversations?types=public_channel,private_channel&exclude_archived=false&limit=1000',
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
          },
        }
      );

      const result = (await response.json()) as SlackConversationsListResponse;

      if (result.ok && result.channels) {
        const channel = result.channels.find((ch: SlackChannel) => ch.name === channelName);
        if (channel) {
          console.log(`${ts()} ✅ Resolved channel name "${channelName}" → ID ${channel.id}`);
          return channel.id;
        }
      }

      // Channel not found - throw error with context
      const error = new ChannelResolutionError(channelInput);
      console.error(
        `${ts()} ❌ ${error.message}: Channel "${channelName}" not found in user's conversations (API ok=${result.ok}, channels count=${result.channels?.length ?? 0})`
      );
      throw error;
    } catch (error) {
      // Re-throw ChannelResolutionError as-is
      if (error instanceof ChannelResolutionError) {
        throw error;
      }
      // Wrap other errors with context
      const wrappedError = new ChannelResolutionError(
        channelInput,
        error instanceof Error ? error : new Error(String(error))
      );
      console.error(`${ts()} ❌ ${wrappedError.message}`);
      throw wrappedError;
    }
  }

  /**
   * Create "not configured" error response
   * @returns {ToolsCallResult} Error result indicating Slack is not configured
   */
  function createNotConfiguredError(): ToolsCallResult {
    return {
      content: [
        {
          type: 'text',
          text: '❌ Slack integration not configured. Run: speedwave setup slack',
        },
      ],
      isError: true,
    };
  }

  //═══════════════════════════════════════════════════════════════════════════════
  // Tool Handlers
  //═══════════════════════════════════════════════════════════════════════════════

  /**
   * Handler: send_channel
   * Send message to channel (as user, not bot)
   *
   * Security Model (per FINAL_DOCS.md):
   * 1. Bot Token → Check if bot is channel member (access control)
   * 2. User Token → Send message as user (authenticity)
   *
   * Why bot membership check?
   * - Bot on channel = team approved AI access (transparent)
   * - Kick bot = instant revoke for all devs
   * - Blast radius limited to channels with bot
   * @async
   * @param {Record<string, unknown>} params - Tool parameters
   * @param {string} params.channel - Channel name or ID
   * @param {string} params.message - Message to send
   * @returns {Promise<ToolsCallResult>} Result with success/error message
   */
  const handleSendChannel: ToolHandler = async (
    params: Record<string, unknown>
  ): Promise<ToolsCallResult> => {
    if (!slackClients) {
      return createNotConfiguredError();
    }

    try {
      const channel = params.channel as string;
      const message = params.message as string;

      // Validate required parameters
      if (!channel || !message) {
        return {
          content: [{ type: 'text', text: '❌ Missing required fields: channel, message' }],
          isError: true,
        };
      }

      // Resolve channel name to ID (supports #channel-name, channel-name, or ID)
      const channelId = await resolveChannelId(channel);

      // Step 1: Check if bot is channel member (using Bot Token)
      // This validates access - bot must be explicitly added to channel
      const membersResult = await slackClients.bot.conversations.members({
        channel: channelId,
      });

      if (!membersResult.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Cannot access channel ${channel}. Bot might not be a member or channel doesn't exist.`,
            },
          ],
          isError: true,
        };
      }

      // Get bot user ID to check membership
      const authResult = await slackClients.bot.auth.test();
      const botUserId = authResult.user_id;

      if (!membersResult.members?.includes(botUserId!)) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Access denied: Bot Speedwave is not a member of ${channel}. Add bot to channel first: /invite @Speedwave`,
            },
          ],
          isError: true,
        };
      }

      // Step 2: Send message using User Token (writes as user, not bot)
      const result = await slackClients.user.chat.postMessage({
        channel: channelId,
        text: message,
      });

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to send message: ${result.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `✅ Message sent to ${channel} (as user)\nTimestamp: ${result.ts}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error sending message: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };

  /**
   * Handler: read_channel
   * Read message history from a channel
   *
   * IMPORTANT: Uses user token (NOT bot token) because:
   * - User token has access to private channels user is member of
   * - Bot token only works for channels where bot is invited
   * - Same pattern as handleGetChannels (see commit history)
   * @async
   * @param {Record<string, unknown>} params - Tool parameters
   * @param {string} params.channel - Channel name or ID
   * @param {number} [params.limit=20] - Max messages to retrieve (1-100)
   * @returns {Promise<ToolsCallResult>} Result with formatted messages
   */
  const handleReadChannel: ToolHandler = async (
    params: Record<string, unknown>
  ): Promise<ToolsCallResult> => {
    if (!slackClients) {
      return createNotConfiguredError();
    }

    try {
      const channel = params.channel as string;
      const limit = (params.limit as number | undefined) ?? 20;

      // Validate required parameters
      if (!channel) {
        return {
          content: [{ type: 'text', text: '❌ Missing required field: channel' }],
          isError: true,
        };
      }

      // Resolve channel name to ID (supports #channel-name, channel-name, or ID)
      const channelId = await resolveChannelId(channel);

      // Validate limit
      const messageLimit = Math.min(Math.max(limit, 1), 100);

      // Load user token for history API (user has access to private channels they're member of)
      const userToken = await loadToken(USER_TOKEN_PATH);

      // Get channel history using user token (NOT bot token)
      // Rationale: User token works for ALL channels user is member of (including private)
      // Bot token only works for channels where bot is explicitly invited
      const response = await fetch(
        `https://slack.com/api/conversations.history?channel=${channelId}&limit=${messageLimit}`,
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
          },
        }
      );

      const result = (await response.json()) as SlackConversationsHistoryResponse;

      if (!result.ok || !result.messages) {
        return {
          content: [
            { type: 'text', text: `❌ Error reading channel: ${result.error || 'Unknown error'}` },
          ],
          isError: true,
        };
      }

      // Collect unique user IDs from messages
      const userIds = new Set<string>();
      result.messages.forEach((msg: SlackMessage) => {
        if (msg.user) {
          userIds.add(msg.user);
        }
      });

      // Fetch user info for all unique users (parallel for performance)
      // Errors are caught individually - failed lookups will just show user IDs instead of names
      await Promise.all(
        Array.from(userIds).map(async (userId) => {
          try {
            await getUserInfo(userId);
          } catch {
            // Error already logged by getUserInfo - user ID will be shown as fallback
          }
        })
      );

      // Format messages for display with real names
      // Limit response size to prevent memory issues (100KB max)
      const MAX_RESPONSE_SIZE = 100 * 1024;
      let totalSize = 0;
      let truncated = false;

      const formattedMessages = result.messages
        .map((msg: SlackMessage) => {
          // Check if we've exceeded the size limit
          if (truncated) {
            return null;
          }

          const userId = msg.user || 'unknown';
          let displayName = userId;

          // Try to get real name from cache
          if (userId !== 'unknown') {
            const userInfo = userCache.get(userId);
            if (userInfo?.real_name) {
              displayName = userInfo.real_name;
            } else if (userInfo?.name) {
              displayName = `@${userInfo.name}`;
            }
          }

          const text = msg.text || '(no text)';
          const timestamp = msg.ts
            ? new Date(parseFloat(msg.ts) * 1000).toISOString()
            : '(unknown time)';

          // Use structured format with clear separators for better parsing
          const formatted = `────────────────────────────────\n📅 ${timestamp}\n👤 ${displayName}\n💬 ${text}`;

          // Check size limit
          totalSize += formatted.length;
          if (totalSize > MAX_RESPONSE_SIZE) {
            truncated = true;
            return null;
          }

          return formatted;
        })
        .filter(Boolean)
        .join('\n\n');

      const truncatedNote = truncated ? '\n\n⚠️ Response truncated due to size limit (100KB)' : '';

      return {
        content: [
          {
            type: 'text',
            text: `📨 Channel: ${channel}\n📊 Messages: ${result.messages.length}${truncatedNote}\n\n${formattedMessages}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error reading channel: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };

  /**
   * Handler: get_channels
   * List all channels user is a member of (including private channels)
   *
   * IMPORTANT: Uses users.conversations API (NOT conversations.list)
   * - conversations.list has visibility issues with private channels
   * - users.conversations returns ALL channels user is member of
   * - This is the FIXED version (see commit history)
   * @async
   * @param {Record<string, unknown>} _params - Tool parameters (unused)
   * @returns {Promise<ToolsCallResult>} Result with formatted channel list
   */
  const handleGetChannels: ToolHandler = async (
    _params: Record<string, unknown>
  ): Promise<ToolsCallResult> => {
    if (!slackClients) {
      return createNotConfiguredError();
    }

    try {
      // Load user token directly for fetch() call
      const userToken = await loadToken(USER_TOKEN_PATH);

      // Use users.conversations API (returns ALL channels user is member of, including private)
      // See: commands/speedwave/context/slack.sh implementation
      const response = await fetch(
        'https://slack.com/api/users.conversations?types=public_channel,private_channel&exclude_archived=false&limit=1000',
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
          },
        }
      );

      const result = (await response.json()) as SlackConversationsListResponse;

      if (!result.ok || !result.channels) {
        return {
          content: [{ type: 'text', text: '❌ Failed to list channels' }],
          isError: true,
        };
      }

      // Format channels for display
      const formattedChannels = result.channels
        .map((ch: SlackChannel) => {
          const visibility = ch.is_private ? '🔒 private' : '🌐 public';
          const membership = ch.is_member ? '✅ member' : '❌ not member';
          return `${ch.name} (${ch.id}) - ${visibility}, ${membership}`;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `📋 Total channels: ${result.channels.length}\n\n${formattedChannels}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error listing channels: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };

  /**
   * Handler: get_users
   * Get user information by email address
   * @async
   * @param {Record<string, unknown>} params - Tool parameters
   * @param {string} params.email - Email address to look up
   * @returns {Promise<ToolsCallResult>} Result with user information
   */
  const handleGetUsers: ToolHandler = async (
    params: Record<string, unknown>
  ): Promise<ToolsCallResult> => {
    if (!slackClients) {
      return createNotConfiguredError();
    }

    try {
      const email = params.email as string;

      // Validate required parameters
      if (!email) {
        return {
          content: [{ type: 'text', text: '❌ Missing required field: email' }],
          isError: true,
        };
      }

      // Validate email format (basic RFC 5322 compliant regex)
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (typeof email !== 'string' || !emailRegex.test(email)) {
        return {
          content: [{ type: 'text', text: '❌ Invalid email format' }],
          isError: true,
        };
      }

      // Lookup user by email
      const userResult = await slackClients.bot.users.lookupByEmail({ email });
      if (!userResult.ok || !userResult.user) {
        return {
          content: [{ type: 'text', text: `❌ User not found: ${email}` }],
          isError: true,
        };
      }

      const user = userResult.user;

      // Format user info
      const userInfo = `
👤 User Information:
━━━━━━━━━━━━━━━━━━━━━━
ID: ${user.id}
Username: ${user.name}
Real Name: ${user.real_name}
Email: ${user.profile?.email}
━━━━━━━━━━━━━━━━━━━━━━
`.trim();

      return {
        content: [{ type: 'text', text: userInfo }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error getting user info: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };

  // Return all handlers
  return {
    handleSendChannel,
    handleReadChannel,
    handleGetChannels,
    handleGetUsers,
  };
}

/**
 * Return type of createSlackHandlers factory containing all handler functions
 * @typedef {Object} SlackHandlers
 * @property {ToolHandler} handleSendChannel - Handler for sending messages
 * @property {ToolHandler} handleReadChannel - Handler for reading channel history
 * @property {ToolHandler} handleGetChannels - Handler for listing channels
 * @property {ToolHandler} handleGetUsers - Handler for user lookup
 */
export type SlackHandlers = ReturnType<typeof createSlackHandlers>;

// Export error classes for type checking in tests and consumers
export { UserInfoError, ChannelResolutionError };

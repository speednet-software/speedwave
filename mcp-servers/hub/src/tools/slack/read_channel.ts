/**
 * Slack: Read Channel
 *
 * Read message history from a channel.
 * Uses user token for access to private channels user is member of.
 * Security notes:
 * - User token provides access to private channels user is member of
 * - Response size limited to 100KB to prevent memory issues
 * @param {string} channel - Channel name (#general) or channel ID (C0123ABC)
 * @param {number} [limit=20] - Number of messages to retrieve (1-100)
 * @returns {object} Array of messages with user info and timestamps
 * @example
 * // Read last 10 messages from #general
 * const messages = await slack.readChannel({
 *   channel: "#general",
 *   limit: 10
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getChannelMessages',
  service: 'slack',
  category: 'read',
  deferLoading: true,
  description: 'Read message history from a Slack channel',
  keywords: ['slack', 'read', 'message', 'history', 'channel', 'get'],
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name (e.g., #general) or channel ID' },
      limit: {
        type: 'number',
        description: 'Number of messages to retrieve (default: 20, max: 100)',
      },
    },
    required: ['channel'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ts: { type: 'string', description: 'Message timestamp/ID' },
            user: { type: 'string', description: 'User ID who sent the message' },
            text: { type: 'string', description: 'Message text content' },
            type: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const messages = await slack.getChannelMessages({ channel: "#general", limit: 10 })`,
  inputExamples: [
    {
      description: 'Minimal: read with defaults',
      input: { channel: '#general' },
    },
    {
      description: 'Partial: limit messages',
      input: { channel: '#engineering', limit: 50 },
    },
    {
      description: 'Full: read by channel ID with limit',
      input: { channel: 'C0123ABC456', limit: 100 },
    },
  ],
};

/**
 * Slack message from channel history
 */
interface Message {
  /** User ID who sent the message */
  user: string;
  /** Message text content */
  text: string;
  /** Message timestamp */
  timestamp: string;
}

/**
 * Execute read_channel tool
 * Reads message history from a Slack channel
 * Uses user token for access to private channels user is member of
 * @param params - Read parameters
 * @param params.channel - Channel name (#general) or channel ID (C0123ABC)
 * @param params.limit - Number of messages to retrieve (1-100, default: 20)
 * @param context - Execution context with slack service
 * @param context.slack - Slack service bridge instance
 * @param context.slack.readChannel - Function to read channel messages
 * @returns Array of messages with user info and timestamps or error
 */
export async function execute(
  params: { channel: string; limit?: number },
  context: { slack: { readChannel: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
  const { channel, limit = 20 } = params;

  if (!channel) {
    return {
      success: false,
      error: 'Missing required field: channel',
    };
  }

  // Validate limit
  const messageLimit = Math.min(Math.max(limit, 1), 100);

  try {
    const result = await context.slack.readChannel({
      channel,
      limit: messageLimit,
    });

    // Parse result - MCP returns formatted text, we need to extract messages
    const resultData = result as { messages?: Message[] };

    return {
      success: true,
      messages: resultData.messages || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

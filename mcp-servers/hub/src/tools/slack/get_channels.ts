/**
 * Slack: Get Channels
 *
 * List all channels the user is a member of (including private channels).
 * Uses users.conversations API for complete visibility.
 * @returns {object} Array of channels with visibility and membership info
 * @example
 * // Get all accessible channels
 * const channels = await slack.getChannels();
 * channels.forEach(ch => {
 *   console.log(`${ch.name} - ${ch.is_private ? 'private' : 'public'}`);
 * });
 *       because conversations.list has visibility issues with private channels
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listChannelIds',
  service: 'slack',
  category: 'read',
  deferLoading: false,
  description: 'List all channels the user is a member of (including private channels)',
  keywords: ['slack', 'channels', 'list', 'get', 'member'],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Channel ID' },
            name: { type: 'string', description: 'Channel name' },
            is_private: { type: 'boolean' },
            is_member: { type: 'boolean' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const channels = await slack.listChannelIds()`,
  inputExamples: [
    {
      description: 'List all channels (no params)',
      input: {},
    },
  ],
};

/**
 * Slack channel metadata
 */
interface Channel {
  /** Slack channel ID */
  id: string;
  /** Channel name without # prefix */
  name: string;
  /** Whether the channel is private */
  is_private: boolean;
  /** Whether the user is a member of the channel */
  is_member: boolean;
}

/**
 * Execute get_channels tool
 * Lists all channels the user is a member of (including private channels)
 * Uses users.conversations API for complete visibility
 * @param params - No parameters required
 * @param context - Execution context with slack service
 * @param context.slack - Slack service bridge instance
 * @param context.slack.getChannels - Function to get channel list
 * @returns Array of channels with visibility and membership info or error
 */
export async function execute(
  params: Record<string, unknown>,
  context: { slack: { getChannels: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; channels?: Channel[]; error?: string }> {
  try {
    const result = await context.slack.getChannels({});

    // Parse result - MCP returns formatted text, we need to extract channels
    const resultData = result as { channels?: Channel[] };

    return {
      success: true,
      channels: resultData.channels || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

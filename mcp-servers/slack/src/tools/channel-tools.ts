/**
 * Channel Tools - Tools for Slack channel operations
 */

import { Tool, ToolDefinition } from '../../../shared/dist/index.js';
import { withValidation, ToolResult } from './validation.js';
import {
  SlackClients,
  sendChannel,
  readChannel,
  getChannels,
  formatSlackError,
} from '../client.js';

//===============================================================================
// Types
//===============================================================================

interface SendChannelParams {
  channel: string;
  message: string;
}

interface GetChannelMessagesParams {
  channel: string;
  limit?: number;
  oldest?: string;
  latest?: string;
}

//===============================================================================
// Tool Definitions
//===============================================================================

const sendChannelTool: Tool = {
  name: 'sendChannel',
  description: 'Send a message to a Slack channel (as user, not bot)',
  inputSchema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Channel name (e.g., #general) or ID (e.g., C01234567)',
      },
      message: { type: 'string', description: 'Message text to send' },
    },
    required: ['channel', 'message'],
  },
};

const getChannelMessagesTool: Tool = {
  name: 'getChannelMessages',
  description: 'Get messages from a channel. Full data, no truncation.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID or name' },
      limit: { type: 'number', description: 'Max messages (default 50)' },
      oldest: { type: 'string', description: 'Start timestamp' },
      latest: { type: 'string', description: 'End timestamp' },
    },
    required: ['channel'],
  },
};

const listChannelIdsTool: Tool = {
  name: 'listChannelIds',
  description: 'List channel IDs and names.',
  inputSchema: {
    type: 'object',
    properties: {
      types: {
        type: 'string',
        description: 'Channel types (default: public_channel,private_channel)',
      },
    },
  },
};

//===============================================================================
// Tool Handlers
//===============================================================================

/**
 * Tool handler function
 * @param clients - Slack client instances
 * @param params - Tool parameters
 */
export async function handleSendChannel(
  clients: SlackClients,
  params: SendChannelParams
): Promise<ToolResult> {
  try {
    const result = await sendChannel(clients, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'SEND_FAILED', message: formatSlackError(error) } };
  }
}

/**
 * Tool handler function
 * @param clients - Slack client instances
 * @param params - Tool parameters
 */
export async function handleGetChannelMessages(
  clients: SlackClients,
  params: GetChannelMessagesParams
): Promise<ToolResult> {
  try {
    const result = await readChannel(clients, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'READ_FAILED', message: formatSlackError(error) } };
  }
}

/**
 * Tool handler function
 * @param clients - Slack client instances
 * @param params - Tool parameters
 * @param params.types - Channel types to include (default: public_channel,private_channel)
 */
export async function handleListChannelIds(
  clients: SlackClients,
  params: { types?: string }
): Promise<ToolResult> {
  try {
    const result = await getChannels(clients, { types: params.types });
    const channels = result.channels || [];
    return {
      success: true,
      data: {
        channels: channels.map((ch) => ({ id: ch.id, name: ch.name, is_private: ch.is_private })),
        count: channels.length,
      },
    };
  } catch (error) {
    return { success: false, error: { code: 'LIST_FAILED', message: formatSlackError(error) } };
  }
}

//===============================================================================
// Tool Definitions Export
//===============================================================================

/**
 * Tool handler function
 * @param clients - Slack client instances
 */
export function createChannelTools(clients: SlackClients | null): ToolDefinition[] {
  const withClients =
    <T>(handler: (c: SlackClients, p: T) => Promise<ToolResult>) =>
    async (params: T): Promise<ToolResult> => {
      if (!clients) {
        return {
          success: false,
          error: {
            code: 'NOT_CONFIGURED',
            message: 'Slack not configured. Run: speedwave setup slack',
          },
        };
      }
      return handler(clients, params);
    };

  return [
    {
      tool: sendChannelTool,
      handler: withValidation<SendChannelParams>(withClients(handleSendChannel)),
    },
    {
      tool: getChannelMessagesTool,
      handler: withValidation<GetChannelMessagesParams>(withClients(handleGetChannelMessages)),
    },
    {
      tool: listChannelIdsTool,
      handler: withValidation<{ types?: string }>(withClients(handleListChannelIds)),
    },
  ];
}

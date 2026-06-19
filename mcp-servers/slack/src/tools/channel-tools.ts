/**
 * Channel Tools - Tools for Slack channel operations
 */

import {
  Tool,
  ToolDefinition,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { withValidation, withClients, ToolResult } from './validation.js';
import { enrichMessagesWithAuthors } from '../user-directory.js';
import {
  SlackClients,
  sendChannel,
  readChannel,
  readThread,
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
  cursor?: string;
}

interface GetThreadMessagesParams {
  channel: string;
  thread_ts: string;
  limit?: number;
  cursor?: string;
}

//===============================================================================
// Tool Definitions
//===============================================================================

const sendChannelTool: Tool = {
  name: 'sendChannel',
  description:
    "Send a message to a Slack channel or DM conversation as the signed-in user (their name and avatar). Irreversible and instantly visible — requires the user's explicit confirmation of the exact recipient and verbatim text, in the current conversation, before calling.",
  inputSchema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description:
          'Channel name (e.g., #general), channel ID (C…), or DM conversation ID (D…/G…)',
      },
      message: { type: 'string', description: 'Message text to send' },
    },
    required: ['channel', 'message'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['slack', 'send', 'message', 'channel', 'post', 'write'],
  example: 'await slack.sendChannel({ channel: "#general", message: "Hello!" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message_ts: { type: 'string', description: 'Timestamp/ID of sent message' },
      channel: { type: 'string', description: 'Channel ID where message was sent' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: send simple message',
      input: { channel: '#general', message: 'Hello team!' },
    },
    {
      description: 'Full: send to specific channel ID',
      input: { channel: 'C0123ABC456', message: 'Deployment completed successfully! :rocket:' },
    },
  ],
};

const getChannelMessagesTool: Tool = {
  name: 'getChannelMessages',
  description:
    'Get one page of messages from a channel or DM conversation (newest first; accepts #name, C…, or D…/G… IDs). Iterate with `cursor` (from `next_cursor`) to read the full history.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID or name' },
      limit: { type: 'number', description: 'Max messages per page, 1-100 (default 50)' },
      oldest: { type: 'string', description: 'Only messages after this Slack timestamp' },
      latest: { type: 'string', description: 'Only messages before this Slack timestamp' },
      cursor: { type: 'string', description: 'Pagination cursor from a previous next_cursor' },
    },
    required: ['channel'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['slack', 'read', 'message', 'history', 'channel', 'get', 'pagination'],
  example: 'const messages = await slack.getChannelMessages({ channel: "#general", limit: 10 })',
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
            author: {
              type: 'string',
              description:
                'Human-readable sender name; absent if unresolvable — fall back to the user ID',
            },
            text: { type: 'string', description: 'Message text content' },
            type: { type: 'string' },
            thread_ts: {
              type: 'string',
              description: 'Present when the message belongs to a thread (parent ts)',
            },
            reply_count: {
              type: 'number',
              description: 'On a thread parent: reply count — expand via getThreadMessages',
            },
            files: {
              type: 'array',
              description: 'Files uploaded with the message — read text ones via getFileContent',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  title: { type: 'string' },
                  mimetype: { type: 'string' },
                  size: { type: 'number' },
                },
              },
            },
            attachments_text: {
              type: 'string',
              description: 'Flattened legacy-attachment text (app messages often have empty text)',
            },
          },
        },
      },
      next_cursor: {
        type: 'string',
        description: 'Pass as `cursor` to fetch the next (older) page; absent on the last page',
      },
      has_more: { type: 'boolean', description: 'True when another page exists' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: read with defaults',
      input: { channel: '#general' },
    },
    {
      description: 'Partial: time window',
      input: { channel: '#engineering', oldest: '1717000000.000000', limit: 50 },
    },
    {
      description: 'Full: next page by cursor',
      input: { channel: 'C0123ABC456', limit: 100, cursor: 'dXNlcjpVMDYxTkZUVDI=' },
    },
  ],
};

const getThreadMessagesTool: Tool = {
  name: 'getThreadMessages',
  description:
    "Get one page of a thread's messages in a channel or DM (parent first, then replies oldest-first). Find threads via getChannelMessages entries with reply_count > 0; iterate with `cursor`.",
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID or name' },
      thread_ts: { type: 'string', description: '`ts` of the thread parent message' },
      limit: { type: 'number', description: 'Max messages per page, 1-100 (default 50)' },
      cursor: { type: 'string', description: 'Pagination cursor from a previous next_cursor' },
    },
    required: ['channel', 'thread_ts'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['slack', 'thread', 'replies', 'read', 'message', 'history'],
  example:
    'const thread = await slack.getThreadMessages({ channel: "#general", thread_ts: "1717000000.000100" })',
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
            author: {
              type: 'string',
              description:
                'Human-readable sender name; absent if unresolvable — fall back to the user ID',
            },
            text: { type: 'string', description: 'Message text content' },
            type: { type: 'string' },
            thread_ts: { type: 'string', description: 'Parent ts of the thread' },
            reply_count: { type: 'number', description: 'Reply count (on the parent item)' },
          },
        },
      },
      next_cursor: {
        type: 'string',
        description: 'Pass as `cursor` to fetch the next page; absent on the last page',
      },
      has_more: { type: 'boolean', description: 'True when another page exists' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: read a thread',
      input: { channel: '#general', thread_ts: '1717000000.000100' },
    },
    {
      description: 'Full: next page by cursor',
      input: {
        channel: 'C0123ABC456',
        thread_ts: '1717000000.000100',
        limit: 100,
        cursor: 'dXNlcjpVMDYxTkZUVDI=',
      },
    },
  ],
};

const listChannelIdsTool: Tool = {
  name: 'listChannelIds',
  description:
    'List ALL channels the signed-in user is a member of (paginated under the hood). Speedwave acts as the user — there is no bot to invite; a channel missing here means the user is not a member of it. For DMs use listDirectMessages.',
  inputSchema: {
    type: 'object',
    properties: {
      types: {
        type: 'string',
        description: 'Channel types (default: public_channel,private_channel)',
      },
    },
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['slack', 'channels', 'list', 'get', 'member'],
  example: 'const channels = await slack.listChannelIds()',
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
  inputExamples: [
    {
      description: 'List all channels (no params)',
      input: {},
    },
  ],
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
    await enrichMessagesWithAuthors(clients, result.messages);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'READ_FAILED', message: formatSlackError(error) } };
  }
}

/**
 * Tool handler function
 * @param clients - Slack client instances
 * @param params - Tool parameters
 */
export async function handleGetThreadMessages(
  clients: SlackClients,
  params: GetThreadMessagesParams
): Promise<ToolResult> {
  try {
    const result = await readThread(clients, params);
    await enrichMessagesWithAuthors(clients, result.messages);
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
 * Tool handler function.
 * @param clients - Slack client instances (non-null; null check via _tokensStatus)
 */
export function createChannelTools(clients: SlackClients): ToolDefinition[] {
  const gate = withClients(clients);

  return [
    {
      tool: sendChannelTool,
      handler: withValidation<SendChannelParams>(gate(handleSendChannel)),
    },
    {
      tool: getChannelMessagesTool,
      handler: withValidation<GetChannelMessagesParams>(gate(handleGetChannelMessages)),
    },
    {
      tool: getThreadMessagesTool,
      handler: withValidation<GetThreadMessagesParams>(gate(handleGetThreadMessages)),
    },
    {
      tool: listChannelIdsTool,
      handler: withValidation<{ types?: string }>(gate(handleListChannelIds)),
    },
  ];
}

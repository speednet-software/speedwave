/**
 * Direct-Message Tools — listing and opening DM conversations (im + mpim).
 */

import {
  Tool,
  ToolDefinition,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { withValidation, withClients, missingParamResult, ToolResult } from './validation.js';
import { SlackClients, listDms, openDm, formatSlackError } from '../client.js';
import { peekUserDirectory, displayNameOf } from '../user-directory.js';

interface OpenDirectMessageParams {
  users: string[];
}

const listDirectMessagesTool: Tool = {
  name: 'listDirectMessages',
  description:
    "List the signed-in user's direct-message conversations — 1:1 DMs and group DMs — with member names. Read-only.",
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['slack', 'dm', 'direct', 'message', 'im', 'mpim', 'conversation', 'list', 'private'],
  example: 'const { dms } = await slack.listDirectMessages({})',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      dms: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Conversation ID — pass to getChannelMessages/sendChannel',
            },
            type: { type: 'string', enum: ['im', 'mpim'] },
            user: { type: 'string', description: '1:1 only: the other party user ID' },
            name: {
              type: 'string',
              description:
                '1:1: the other party display name (falls back to the user ID); mpim: the synthetic mpdm-… name',
            },
            is_user_deleted: { type: 'boolean' },
          },
          required: ['id', 'type'],
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List all DM conversations',
      input: {},
    },
  ],
};

const openDirectMessageTool: Tool = {
  name: 'openDirectMessage',
  description:
    'Open (or return the existing) DM conversation with one or more users, by user ID (U…) or exact email. Silent — the other person sees nothing until a message is sent. Returns the conversation ID for getChannelMessages/sendChannel. 2-8 users open a group DM.',
  inputSchema: {
    type: 'object',
    properties: {
      users: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 8,
        description: 'User IDs (from findUsers) or exact email addresses (Slack caps a DM at 8)',
      },
    },
    required: ['users'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['slack', 'dm', 'direct', 'message', 'open', 'start', 'conversation', 'person'],
  example: 'const { id } = await slack.openDirectMessage({ users: ["U0123ABC456"] })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'string', description: 'Conversation ID' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Open a 1:1 DM with a user found via findUsers',
      input: { users: ['U0123ABC456'] },
    },
  ],
};

/**
 * Handler for `listDirectMessages` — lists the signed-in user's DM conversations with resolved member names.
 * @param clients - The Slack client container.
 * @param _params - Unused (no input parameters).
 */
export async function handleListDirectMessages(
  clients: SlackClients,
  _params: Record<string, never>
): Promise<ToolResult> {
  try {
    const { dms } = await listDms(clients);
    // Best-effort 1:1 naming from the directory — raw ID when unavailable.
    const directory = await peekUserDirectory(clients);
    const named = dms.map((dm) => {
      if (dm.type !== 'im' || !dm.user) {
        return dm;
      }
      const entry = directory?.get(dm.user);
      return { ...dm, name: entry ? displayNameOf(entry) : dm.user };
    });
    return { success: true, data: { dms: named } };
  } catch (error) {
    return { success: false, error: { code: 'LIST_FAILED', message: formatSlackError(error) } };
  }
}

/**
 * Handler for `openDirectMessage` — opens (or returns the existing) DM conversation with one or more users.
 * @param clients - The Slack client container.
 * @param params - Recipients.
 */
export async function handleOpenDirectMessage(
  clients: SlackClients,
  params: OpenDirectMessageParams
): Promise<ToolResult> {
  if (!Array.isArray(params.users) || params.users.length === 0) {
    return missingParamResult(
      'users',
      params.users,
      'Provide an array of 1-8 user IDs (from findUsers) or exact e-mail addresses.'
    );
  }
  try {
    const result = await openDm(clients, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'OPEN_FAILED', message: formatSlackError(error) } };
  }
}

/**
 * Tool factory (shared NOT_CONFIGURED gating).
 * @param clients - The Slack client container.
 */
export function createDmTools(clients: SlackClients): ToolDefinition[] {
  const gate = withClients(clients);

  return [
    {
      tool: listDirectMessagesTool,
      handler: withValidation<Record<string, never>>(gate(handleListDirectMessages)),
    },
    {
      tool: openDirectMessageTool,
      handler: withValidation<OpenDirectMessageParams>(gate(handleOpenDirectMessage)),
    },
  ];
}

/**
 * File Tools - Reading files shared on Slack (requires the files:read scope).
 */

import {
  Tool,
  ToolDefinition,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { withValidation, ToolResult } from './validation.js';
import { SlackClients, getFileContent, formatSlackError } from '../client.js';

interface GetFileContentParams {
  file: string;
}

const getFileContentTool: Tool = {
  name: 'getFileContent',
  description:
    "Read the content of a TEXT file shared on Slack (markdown, code, logs, JSON, …). Take the `file` ID from a message's `files[].id` (getChannelMessages/getThreadMessages). Binary files (images, PDFs, office docs) are refused with their metadata.",
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File ID (F…) from a message files[] entry' },
    },
    required: ['file'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['slack', 'file', 'read', 'download', 'content', 'attachment', 'upload'],
  example: 'const file = await slack.getFileContent({ file: "F0123ABC456" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'string', description: 'File ID' },
      name: { type: 'string', description: 'File name' },
      mimetype: { type: 'string' },
      size: { type: 'number', description: 'File size in bytes' },
      content: { type: 'string', description: 'UTF-8 file content' },
      truncated: {
        type: 'boolean',
        description: 'True when the file exceeded the inline byte cap and was cut',
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Read a markdown file shared in a channel',
      input: { file: 'F0123ABC456' },
    },
  ],
};

/**
 * Tool handler function
 * @param clients - Slack client instances
 * @param params - Tool parameters
 */
export async function handleGetFileContent(
  clients: SlackClients,
  params: GetFileContentParams
): Promise<ToolResult> {
  try {
    const result = await getFileContent(clients, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'READ_FAILED', message: formatSlackError(error) } };
  }
}

/**
 * Tool factory (mirrors createChannelTools' not-configured gating).
 * @param clients - Slack client instances
 */
export function createFileTools(clients: SlackClients): ToolDefinition[] {
  const withClients =
    <T>(handler: (c: SlackClients, p: T) => Promise<ToolResult>) =>
    async (params: T): Promise<ToolResult> => {
      if (clients._tokensStatus === 'missing') {
        return {
          success: false,
          error: {
            code: 'NOT_CONFIGURED',
            message: notConfiguredMessage('Slack'),
          },
        };
      }
      return handler(clients, params);
    };

  return [
    {
      tool: getFileContentTool,
      handler: withValidation<GetFileContentParams>(withClients(handleGetFileContent)),
    },
  ];
}

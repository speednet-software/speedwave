/**
 * File Tools - Reading files shared on Slack (requires the files:read scope).
 */

import {
  Tool,
  ToolDefinition,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { withValidation, withClients, ToolResult } from './validation.js';
import { SlackClients, getFileContent, downloadFile, formatSlackError } from '../client.js';

interface GetFileContentParams {
  file: string;
}

interface DownloadFileParams {
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

const downloadFileTool: Tool = {
  name: 'downloadFile',
  description:
    'Download ANY file shared on Slack (PDF, images, office docs, large text) into the project workspace at /workspace/.speedwave/slack/. Use for binary files getFileContent refuses — then read PDFs/documents via the office integration or the filesystem.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File ID (F…) from a message files[] entry' },
    },
    required: ['file'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['slack', 'file', 'download', 'save', 'pdf', 'binary', 'workspace', 'attachment'],
  example: 'const saved = await slack.downloadFile({ file: "F0123ABC456" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'string', description: 'File ID' },
      name: { type: 'string', description: 'Original file name' },
      mimetype: { type: 'string' },
      size: { type: 'number', description: 'File size in bytes' },
      path: { type: 'string', description: 'Workspace path the file was written to' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Download a PDF for the office integration to read',
      input: { file: 'F0123ABC456' },
    },
  ],
};

/**
 * Tool handler function
 * @param clients - Slack client instances
 * @param params - Tool parameters
 */
export async function handleDownloadFile(
  clients: SlackClients,
  params: DownloadFileParams
): Promise<ToolResult> {
  try {
    const result = await downloadFile(clients, params);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: { code: 'DOWNLOAD_FAILED', message: formatSlackError(error) },
    };
  }
}

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
 * Tool factory.
 * @param clients - Slack client instances
 */
export function createFileTools(clients: SlackClients): ToolDefinition[] {
  const gate = withClients(clients);

  return [
    {
      tool: getFileContentTool,
      handler: withValidation<GetFileContentParams>(gate(handleGetFileContent)),
    },
    {
      tool: downloadFileTool,
      handler: withValidation<DownloadFileParams>(gate(handleDownloadFile)),
    },
  ];
}

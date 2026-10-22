/**
 * File Tools - Reading files shared on Slack (files:read scope) and uploading workspace files (files:write scope).
 */

import {
  Tool,
  ToolDefinition,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { withValidation, withClients, failureResult, ToolResult } from './validation.js';
import {
  SlackClients,
  getFileContent,
  downloadFile,
  uploadFile,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
} from '../client.js';
import { SLACK_FEATURE_IDS, featureNotEnabledResult, isFeatureEnabled } from '../features.js';

interface GetFileContentParams {
  file: string;
}

interface DownloadFileParams {
  file: string;
}

interface UploadFileParams {
  channel: string;
  filePaths: string[];
  thread_ts?: string;
  initial_comment?: string;
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
  _meta: { [META_KEYS.DEFER_LOADING]: true },
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
  _meta: { [META_KEYS.DEFER_LOADING]: true },
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

const uploadFileTool: Tool = {
  name: 'uploadFile',
  description: `Upload 1 to ${MAX_UPLOAD_FILES} files from /workspace to a Slack channel, DM or thread as the signed-in user (their name and avatar), all into the same target with one comment. Files are streamed, up to ${MAX_UPLOAD_BYTES / 1000 ** 3} GB each. One call has about 10 minutes, so split large sets over several calls. Files outside /workspace (e.g. /tmp, the home directory) must first be copied under /workspace/.speedwave/slack-out/. Pass \`thread_ts\` copied verbatim from getChannelMessages/getThreadMessages to post into that thread. If any file fails, nothing is shared. File sending is an opt-in feature (files:write scope): when it is not enabled the call fails before any Slack request and the user must click Enable for file sending in Speedwave Desktop, Integrations, Slack. A missing_scope error means the same. Irreversible and instantly visible: the user must confirm the recipient, the file list and the comment in the current conversation before calling.`,
  inputSchema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description:
          'Channel name (e.g., #general), channel ID (C…), or DM conversation ID (D…/G…)',
      },
      filePaths: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_UPLOAD_FILES,
        description:
          'Paths under /workspace of the files to send (e.g. ["/workspace/report.pdf"]); the same file twice is rejected',
      },
      thread_ts: {
        type: 'string',
        description:
          'Post into this thread. The exact `ts` of the thread parent, copied VERBATIM from a prior getChannelMessages/getThreadMessages result (e.g. "1717000000.000100"). Omit to post at channel level.',
      },
      initial_comment: {
        type: 'string',
        description: 'Message posted together with the files',
      },
    },
    required: ['channel', 'filePaths'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true, [META_KEYS.TIMEOUT_CLASS]: 'long' },
  keywords: ['slack', 'file', 'upload', 'send', 'attach', 'share', 'dm', 'thread', 'workspace'],
  example: 'await slack.uploadFile({ channel: "#general", filePaths: ["/workspace/report.pdf"] })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      ok: { type: 'boolean', description: 'Slack reported the upload as completed' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
          required: ['id', 'name'],
        },
        description: 'Uploaded files in call order: Slack file ID and original file name',
      },
      channel: { type: 'string', description: 'Channel ID the files were sent to' },
      thread_ts: { type: 'string', description: 'Thread the files were posted into, when given' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Send a file to a channel',
      input: { channel: '#general', filePaths: ['/workspace/report.pdf'] },
    },
    {
      description: 'Send two files into a thread with one comment',
      input: {
        channel: 'C0123ABC456',
        filePaths: ['/workspace/out/summary.md', '/workspace/out/data.csv'],
        thread_ts: '1717000000.000100',
        initial_comment: 'Summary attached',
      },
    },
  ],
};

/**
 * Tool handler function.
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
    return failureResult('DOWNLOAD_FAILED', error);
  }
}

/**
 * Tool handler function.
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
    return failureResult('READ_FAILED', error);
  }
}

/**
 * Tool handler function.
 * @param clients - Slack client instances
 * @param params - Tool parameters
 */
export async function handleUploadFile(
  clients: SlackClients,
  params: UploadFileParams
): Promise<ToolResult> {
  if (!(await isFeatureEnabled(SLACK_FEATURE_IDS.fileUpload))) {
    return featureNotEnabledResult(SLACK_FEATURE_IDS.fileUpload, 'uploadFile');
  }
  try {
    const result = await uploadFile(clients, params);
    return { success: true, data: result };
  } catch (error) {
    return failureResult('UPLOAD_FAILED', error);
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
    {
      tool: uploadFileTool,
      handler: withValidation<UploadFileParams>(gate(handleUploadFile)),
    },
  ];
}

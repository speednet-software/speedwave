import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  WRITE_ANNOTATIONS,
  WORKSPACE_WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
  MAX_WORKSPACE_FILES,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import { withRedmineErrors } from './error-handling.js';
import { resolveAttachmentFiles } from './attachment-files.js';
import { successResultSchema } from './schema-helpers.js';

const ATTACHMENT_ID_SOURCE =
  'obtained from getIssueFull({ issue_id, include: ["attachments"] }), attachments[].id';

const addAttachmentTool: Tool = {
  name: 'addAttachment',
  description: `Attach 1 to ${MAX_WORKSPACE_FILES} files from /workspace to an issue; the files and the optional comment become one history entry. Files are streamed, so size is limited only by the Redmine server (a refusal says so and attaches nothing). A path outside /workspace is rejected before anything is sent. List existing attachments with getIssueFull and include ["attachments"].`,
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true, [META_KEYS.TIMEOUT_CLASS]: 'long' },
  keywords: ['redmine', 'attachment', 'attach', 'upload', 'file', 'screenshot', 'issue'],
  example: `await redmine.addAttachment({ issue_id: 12345, file_paths: ["/workspace/report.pdf"], notes: "Report attached" })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_WORKSPACE_FILES,
        description: 'Paths under /workspace of the files to attach, e.g. ["/workspace/log.txt"]',
      },
      notes: { type: 'string', description: 'Comment saved together with the files' },
    },
    required: ['issue_id', 'file_paths'],
  },
  outputSchema: successResultSchema({
    attachments: {
      type: 'array',
      description: 'Attachments added by this call, as Redmine reports them',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          filename: { type: 'string' },
          filesize: { type: 'number' },
          content_type: { type: 'string' },
          content_url: { type: 'string' },
          created_on: { type: 'string' },
        },
      },
    },
  }),
  inputExamples: [
    {
      description: 'Minimal: attach one file',
      input: { issue_id: 12345, file_paths: ['/workspace/screenshot.png'] },
    },
    {
      description: 'Full: attach two files with one comment',
      input: {
        issue_id: 12345,
        file_paths: ['/workspace/out/report.pdf', '/workspace/out/data.csv'],
        notes: 'Report and data attached',
      },
    },
  ],
};

const downloadAttachmentTool: Tool = {
  name: 'downloadAttachment',
  description: `Download an attachment of an issue into /workspace/.speedwave/redmine/<attachment_id>-<name>; the bytes are not returned, open the saved path. attachment_id must belong to issue_id (${ATTACHMENT_ID_SOURCE}). A repeated download overwrites the same file.`,
  annotations: WORKSPACE_WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true, [META_KEYS.TIMEOUT_CLASS]: 'long' },
  keywords: ['redmine', 'attachment', 'download', 'save', 'file', 'screenshot', 'workspace'],
  example: `const saved = await redmine.downloadAttachment({ issue_id: 12345, attachment_id: 678 })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID the attachment belongs to' },
      attachment_id: { type: 'number', description: `Attachment ID, ${ATTACHMENT_ID_SOURCE}` },
    },
    required: ['issue_id', 'attachment_id'],
  },
  outputSchema: successResultSchema({
    id: { type: 'number', description: 'Attachment ID' },
    filename: { type: 'string', description: 'Original file name' },
    content_type: { type: 'string' },
    size: { type: 'number', description: 'Bytes written' },
    path: { type: 'string', description: 'Workspace path the file was written to' },
  }),
  inputExamples: [
    {
      description: 'Download a screenshot to look at it',
      input: { issue_id: 12345, attachment_id: 678 },
    },
  ],
};

const deleteAttachmentTool: Tool = {
  name: 'deleteAttachment',
  description: `Delete an attachment from an issue; irreversible. attachment_id must belong to issue_id (${ATTACHMENT_ID_SOURCE}).`,
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true, [META_KEYS.TIMEOUT_CLASS]: 'long' },
  keywords: ['redmine', 'attachment', 'delete', 'remove', 'file'],
  example: `await redmine.deleteAttachment({ issue_id: 12345, attachment_id: 678 })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID the attachment belongs to' },
      attachment_id: { type: 'number', description: `Attachment ID, ${ATTACHMENT_ID_SOURCE}` },
    },
    required: ['issue_id', 'attachment_id'],
  },
  outputSchema: successResultSchema({
    deleted_attachment_id: { type: 'number' },
  }),
  inputExamples: [
    {
      description: 'Delete an attachment',
      input: { issue_id: 12345, attachment_id: 678 },
    },
  ],
};

/**
 * Attachment tool definitions.
 * @param client - Redmine client instance
 */
export function createAttachmentTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
  if (!client) {
    return [
      { tool: addAttachmentTool, handler: unconfigured },
      { tool: downloadAttachmentTool, handler: unconfigured },
      { tool: deleteAttachmentTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: addAttachmentTool,
      handler: async (params) => {
        const { issue_id, file_paths, notes } = params as {
          issue_id: number;
          file_paths: unknown;
          notes?: string;
        };
        const resolved = await resolveAttachmentFiles(file_paths);
        if ('error' in resolved) return resolved.error;
        return withRedmineErrors({ issue_id }, async () => {
          const attachments = await client.addAttachments(issue_id, resolved.files, notes);
          return jsonResult({ attachments });
        });
      },
    },
    {
      tool: downloadAttachmentTool,
      handler: async (params) => {
        const { issue_id, attachment_id } = params as { issue_id: number; attachment_id: number };
        return withRedmineErrors({ issue_id, attachment_id }, async () =>
          jsonResult(await client.downloadAttachment(issue_id, attachment_id))
        );
      },
    },
    {
      tool: deleteAttachmentTool,
      handler: async (params) => {
        const { issue_id, attachment_id } = params as { issue_id: number; attachment_id: number };
        return withRedmineErrors({ issue_id, attachment_id }, async () => {
          await client.deleteAttachment(issue_id, attachment_id);
          return jsonResult({ deleted_attachment_id: attachment_id });
        });
      },
    },
  ];
}

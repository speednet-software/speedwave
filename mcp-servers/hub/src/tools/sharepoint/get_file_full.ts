/**
 * SharePoint: Get File Full
 *
 * Get full file details from SharePoint including metadata and content.
 * @param {string} file_id - File ID or path
 * @param {string[]} [include] - Additional data to include (e.g., ['content', 'metadata'])
 * @returns {object} File details with optional content
 * @example
 * // Get file metadata only
 * const file = await sharepoint.getFileFull({ file_id: "abc123" });
 *
 * // Get file with content
 * const file = await sharepoint.getFileFull({
 *   file_id: "document.pdf",
 *   include: ["content", "metadata"]
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { TIMEOUTS } from '../../../../shared/dist/index.js';

export const metadata: ToolMetadata = {
  name: 'getFileFull',
  service: 'sharepoint',
  category: 'read',
  deferLoading: true,
  timeoutMs: TIMEOUTS.LONG_OPERATION_MS,
  description: 'Get full file details from SharePoint including metadata and content',
  keywords: ['sharepoint', 'file', 'get', 'detail', 'download', 'metadata'],
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'File ID or path' },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: "Additional data to include (e.g., ['content', 'metadata'])",
      },
    },
    required: ['file_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      file: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          size: { type: 'number' },
          content: { type: 'string', description: 'File content (if requested)' },
          metadata: { type: 'object', description: 'File metadata' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const file = await sharepoint.getFileFull({ file_id: "abc123", include: ["content"] })`,
  inputExamples: [
    {
      description: 'Minimal: get file metadata only',
      input: { file_id: 'abc123' },
    },
    {
      description: 'Full: get file with content',
      input: { file_id: 'document.pdf', include: ['content', 'metadata'] },
    },
  ],
};

/**
 * File details from SharePoint
 */
interface FileDetails {
  /** File ID */
  id: string;
  /** File name */
  name: string;
  /** File size in bytes */
  size: number;
  /** File content (if requested) */
  content?: string;
  /** File metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Execute get_file_full tool
 * Retrieves full file details from SharePoint including optional content
 * @param params - Get file parameters
 * @param params.file_id - File ID or path
 * @param params.include - Additional data to include (content, metadata)
 * @param context - Execution context with sharepoint service
 * @param context.sharepoint - SharePoint service bridge instance
 * @param context.sharepoint.getFileFull - Function to get full file details
 * @returns File details with optional content or error
 */
export async function execute(
  params: { file_id: string; include?: string[] },
  context: { sharepoint: { getFileFull: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; file?: FileDetails; error?: string }> {
  const { file_id } = params;

  if (!file_id) {
    return {
      success: false,
      error: 'Missing required field: file_id',
    };
  }

  try {
    const result = await context.sharepoint.getFileFull(params);

    return {
      success: true,
      file: result as FileDetails,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

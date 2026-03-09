/**
 * SharePoint: List Files
 *
 * List files in configured SharePoint context directory.
 * Returns file metadata including names, sizes, and modification dates.
 * @param {string} [path=""] - Path relative to context directory
 * @returns {object} Array of file entries with metadata
 * @example
 * // List files in root
 * const files = await sharepoint.listFiles();
 *
 * // List files in subdirectory
 * const docs = await sharepoint.listFiles({ path: "documents" });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listFileIds',
  service: 'sharepoint',
  category: 'read',
  deferLoading: false,
  description: 'List files in configured SharePoint context directory',
  keywords: ['sharepoint', 'files', 'list', 'directory', 'folder'],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to context directory' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            size: { type: 'number', description: 'File size in bytes' },
            lastModified: { type: 'string', description: 'ISO 8601 timestamp' },
            isFolder: { type: 'boolean' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const files = await sharepoint.listFileIds({ path: "documents" })`,
  inputExamples: [
    {
      description: 'Minimal: list root directory',
      input: {},
    },
    {
      description: 'Full: list specific subdirectory',
      input: { path: 'documents/reports/2024' },
    },
  ],
};

/**
 * File entry metadata from SharePoint
 */
interface FileEntry {
  /** File or folder name */
  name: string;
  /** File size in bytes (undefined for folders) */
  size?: number;
  /** Last modified timestamp in ISO 8601 format */
  lastModified?: string;
  /** Whether this entry is a folder */
  isFolder: boolean;
}

/**
 * Execute list_files tool
 * Lists files and folders in a SharePoint directory
 * @param params - List parameters
 * @param params.path - Path relative to context directory (empty for root)
 * @param context - Execution context with sharepoint service
 * @param context.sharepoint - SharePoint service bridge instance
 * @param context.sharepoint.listFiles - Function to list files
 * @returns Array of file entries with metadata or error
 */
export async function execute(
  params: { path?: string },
  context: { sharepoint: { listFiles: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; files?: FileEntry[]; error?: string }> {
  const { path = '' } = params;

  try {
    const result = await context.sharepoint.listFiles({ path });

    const resultData = result as { files?: FileEntry[] };

    return {
      success: true,
      files: resultData.files || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

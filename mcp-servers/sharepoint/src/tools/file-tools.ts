/**
 * File Tools - Tools for SharePoint file operations
 */

import { Tool, ToolDefinition, notConfiguredMessage } from '@speedwave/mcp-shared';
import { withValidation, ToolResult } from './validation.js';
import { SharePointClient } from '../client.js';

//═══════════════════════════════════════════════════════════════════════════════
// Parameter Normalization (accept both snake_case and camelCase)
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize upload parameters to accept both snake_case and camelCase
 * Hub executor sends snake_case, but our handlers expect camelCase
 * @param params - Tool parameters
 */
function normalizeUploadParams(params: Record<string, unknown>): {
  localPath: string;
  sharepointPath: string;
  expectedEtag?: string;
  createOnly?: boolean;
  overwrite?: boolean;
} {
  return {
    localPath: (params.localPath ?? params.local_path) as string,
    sharepointPath: (params.sharepointPath ?? params.sharepoint_path) as string,
    expectedEtag: (params.expectedEtag ?? params.expected_etag) as string | undefined,
    createOnly: (params.createOnly ?? params.create_only) as boolean | undefined,
    overwrite: params.overwrite as boolean | undefined,
  };
}

/**
 * Normalize download parameters to accept both snake_case and camelCase
 * @param params - Tool parameters
 */
function normalizeDownloadParams(params: Record<string, unknown>): {
  sharepointPath: string;
  localPath: string;
} {
  return {
    sharepointPath: (params.sharepointPath ?? params.sharepoint_path) as string,
    localPath: (params.localPath ?? params.local_path) as string,
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Definitions
//═══════════════════════════════════════════════════════════════════════════════

const listFileIdsTool: Tool = {
  name: 'listFileIds',
  description: 'List file IDs and names in a folder.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Folder path (default: /)' },
    },
  },
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['sharepoint', 'files', 'list', 'directory', 'folder'],
  example: 'const files = await sharepoint.listFileIds({ path: "documents" })',
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

const getFileFullTool: Tool = {
  name: 'getFileFull',
  description: 'Get complete file metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'File ID' },
    },
    required: ['file_id'],
  },
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['sharepoint', 'file', 'get', 'detail', 'download', 'metadata'],
  example: 'const file = await sharepoint.getFileFull({ file_id: "abc123", include: ["content"] })',
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

const downloadFileTool: Tool = {
  name: 'downloadFile',
  description: 'Download a file from SharePoint to a local path.',
  inputSchema: {
    type: 'object',
    properties: {
      sharepointPath: { type: 'string', description: 'Source path in SharePoint (relative)' },
      sharepoint_path: { type: 'string', description: 'Source path (alias for sharepointPath)' },
      localPath: {
        type: 'string',
        description: 'Destination local path (must be under /workspace)',
      },
      local_path: { type: 'string', description: 'Destination local path (alias for localPath)' },
    },
  },
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  keywords: ['sharepoint', 'download', 'file', 'get', 'fetch'],
  example:
    'await sharepoint.downloadFile({ sharepoint_path: "docs/report.pdf", local_path: "/workspace/report.pdf" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Download a document to local workspace',
      input: {
        sharepoint_path: 'documents/report.pdf',
        local_path: '/workspace/report.pdf',
      },
    },
  ],
};

const uploadFileTool: Tool = {
  name: 'uploadFile',
  description:
    'Upload a local file to SharePoint. Supports ETag-based Compare-And-Swap for conflict detection.',
  inputSchema: {
    type: 'object',
    properties: {
      localPath: { type: 'string', description: 'Source local path (must be under /workspace)' },
      local_path: { type: 'string', description: 'Source local path (alias for localPath)' },
      sharepointPath: { type: 'string', description: 'Destination path in SharePoint (relative)' },
      sharepoint_path: {
        type: 'string',
        description: 'Destination path (alias for sharepointPath)',
      },
      expectedEtag: { type: 'string', description: 'Expected ETag for CAS (If-Match header)' },
      expected_etag: { type: 'string', description: 'Expected ETag (alias)' },
      createOnly: { type: 'boolean', description: "Only create if doesn't exist" },
      create_only: { type: 'boolean', description: 'Create only (alias)' },
      overwrite: { type: 'boolean', description: 'Overwrite without ETag check' },
    },
  },
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  keywords: ['sharepoint', 'upload', 'file', 'put', 'write', 'sync'],
  example:
    'await sharepoint.uploadFile({ local_path: "/workspace/report.pdf", sharepoint_path: "docs/report.pdf" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      etag: { type: 'string', description: 'New ETag after upload' },
      size: { type: 'number', description: 'File size in bytes' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Upload a file',
      input: {
        local_path: '/workspace/report.pdf',
        sharepoint_path: 'documents/report.pdf',
      },
    },
    {
      description: 'Upload only if not exists',
      input: {
        local_path: '/workspace/new-file.json',
        sharepoint_path: 'context/new-file.json',
        create_only: true,
      },
    },
    {
      description: 'Upload with ETag conflict check',
      input: {
        local_path: '/workspace/state.json',
        sharepoint_path: 'context/state.json',
        expected_etag: '"abc123"',
      },
    },
  ],
};

//═══════════════════════════════════════════════════════════════════════════════
// Tool Handlers
//═══════════════════════════════════════════════════════════════════════════════

/**
 * List file IDs in a SharePoint directory
 * @param client - SharePoint client instance
 * @param params - Tool parameters
 * @param params.path - File path
 */
export async function handleListFileIds(
  client: SharePointClient,
  params: { path?: string }
): Promise<ToolResult> {
  try {
    const result = await client.listFiles(params);
    const files = result.files || [];
    return {
      success: true,
      data: {
        files: files.map((f) => ({ id: f.id, name: f.name, isFolder: f.isFolder })),
        count: files.length,
        exists: result.exists,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: { code: 'LIST_FAILED', message: SharePointClient.formatError(error) },
    };
  }
}

/**
 * Get full file metadata by ID
 * @param client - SharePoint client instance
 * @param params - Tool parameters
 * @param params.file_id - File ID
 */
export async function handleGetFileFull(
  client: SharePointClient,
  params: { file_id: string }
): Promise<ToolResult> {
  try {
    const result = await client.getFileMetadata(params.file_id);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: { code: 'GET_FAILED', message: SharePointClient.formatError(error) },
    };
  }
}

/**
 * Handle file download from SharePoint to local path
 * @param client - SharePoint client instance
 * @param params - Tool parameters
 */
export async function handleDownloadFile(
  client: SharePointClient,
  params: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const normalized = normalizeDownloadParams(params);

    if (!normalized.sharepointPath) {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'sharepointPath (or sharepoint_path) is required',
        },
      };
    }
    if (!normalized.localPath) {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'localPath (or local_path) is required',
        },
      };
    }

    await client.downloadFile(normalized.sharepointPath, normalized.localPath);
    return { success: true, data: { downloaded: normalized.localPath } };
  } catch (error) {
    return {
      success: false,
      error: { code: 'DOWNLOAD_FAILED', message: SharePointClient.formatError(error) },
    };
  }
}

/**
 * Handle file upload from local path to SharePoint
 * @param client - SharePoint client instance
 * @param params - Tool parameters
 */
export async function handleUploadFile(
  client: SharePointClient,
  params: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const normalized = normalizeUploadParams(params);

    if (!normalized.localPath) {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'localPath (or local_path) is required',
        },
      };
    }
    if (!normalized.sharepointPath) {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'sharepointPath (or sharepoint_path) is required',
        },
      };
    }

    const result = await client.uploadFile(normalized.sharepointPath, normalized.localPath, {
      expectedEtag: normalized.expectedEtag,
      createOnly: normalized.createOnly,
      overwrite: normalized.overwrite,
    });

    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: { code: 'UPLOAD_FAILED', message: SharePointClient.formatError(error) },
    };
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Definitions Export
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Create file-related tool definitions
 * @param client - SharePoint client instance
 */
export function createFileTools(client: SharePointClient | null): ToolDefinition[] {
  const withClient =
    <T>(handler: (c: SharePointClient, p: T) => Promise<ToolResult>) =>
    async (params: T): Promise<ToolResult> => {
      if (!client) {
        return {
          success: false,
          error: {
            code: 'NOT_CONFIGURED',
            message: notConfiguredMessage('SharePoint'),
          },
        };
      }
      return handler(client, params);
    };

  return [
    {
      tool: listFileIdsTool,
      handler: withValidation<{ path?: string }>(withClient(handleListFileIds)),
    },
    {
      tool: getFileFullTool,
      handler: withValidation<{ file_id: string }>(withClient(handleGetFileFull)),
    },
    { tool: downloadFileTool, handler: withValidation(withClient(handleDownloadFile)) },
    { tool: uploadFileTool, handler: withValidation(withClient(handleUploadFile)) },
  ];
}

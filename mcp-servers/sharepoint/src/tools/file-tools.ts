/**
 * File Tools - Tools for SharePoint file operations
 */

import * as fs from 'fs/promises';
import { Tool, ToolDefinition, ts } from '@speedwave/mcp-shared';
import { withValidation, ToolResult } from './validation.js';
import { SharePointClient } from '../client.js';
import { handleSyncDirectory } from './sync-tools.js';
import { PathValidator } from '../path-validator.js';

//═══════════════════════════════════════════════════════════════════════════════
// Parameter Normalization (accept both snake_case and camelCase)
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize sync parameters to accept both snake_case and camelCase
 * Hub executor sends snake_case, but our handlers expect camelCase
 * @param params - Tool parameters
 */
function normalizeSyncParams(params: Record<string, unknown>): {
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

const syncTool: Tool = {
  name: 'sync',
  description:
    'Sync content with SharePoint. File mode (default): uploads single file with ETag CAS. Directory mode (when mode is provided): two-way sync like OneDrive.',
  inputSchema: {
    type: 'object',
    properties: {
      // Common params (accept both snake_case and camelCase)
      localPath: { type: 'string', description: 'Local path (file or directory)' },
      local_path: { type: 'string', description: 'Local path (alias for localPath)' },
      sharepointPath: { type: 'string', description: 'Destination path in SharePoint' },
      sharepoint_path: {
        type: 'string',
        description: 'Destination path (alias for sharepointPath)',
      },
      // File mode params
      expectedEtag: { type: 'string', description: 'Expected ETag for CAS (file mode)' },
      expected_etag: { type: 'string', description: 'Expected ETag (alias)' },
      createOnly: { type: 'boolean', description: "Only create if doesn't exist (file mode)" },
      create_only: { type: 'boolean', description: 'Create only (alias)' },
      overwrite: { type: 'boolean', description: 'Overwrite without ETag check (file mode)' },
      // Directory mode params (providing mode triggers directory sync)
      mode: {
        type: 'string',
        enum: ['two_way', 'pull', 'push'],
        description: 'Sync mode (triggers directory sync)',
      },
      delete: {
        type: 'boolean',
        description: 'Propagate deletions (directory mode, default: true)',
      },
      ignorePatterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to ignore',
      },
      ignore_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ignore patterns (alias)',
      },
      dryRun: { type: 'boolean', description: 'Preview only (directory mode)' },
      dry_run: { type: 'boolean', description: 'Dry run (alias)' },
    },
    // Note: required validation moved to handler after normalization
    // to support both snake_case and camelCase
  },
  category: 'write',
  keywords: ['sharepoint', 'sync', 'upload', 'download', 'file', 'onedrive'],
  example: `// Directory sync (with mode):
await sharepoint.sync({ local_path: "/home/speedwave/.claude/context", mode: "pull" });

// File sync (without mode):
await sharepoint.sync({ local_path: "/path/to/file.json", sharepoint_path: "context/file.json" });`,
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      synced_files: { type: 'number', description: 'Number of files synced' },
      conflicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Upload single file (FILE MODE - no mode param)',
      input: {
        local_path: '/home/speedwave/.claude/context/opportunities/acme/state.json',
        sharepoint_path: 'context/opportunities/acme/state.json',
      },
    },
    {
      description: 'Upload file only if not exists (FILE MODE)',
      input: {
        local_path: '/home/speedwave/.claude/context/opportunities/acme/state.json',
        sharepoint_path: 'context/opportunities/acme/state.json',
        create_only: true,
      },
    },
    {
      description: 'Upload file with ETag conflict check (FILE MODE)',
      input: {
        local_path: '/home/speedwave/.claude/context/opportunities/acme/state.json',
        sharepoint_path: 'context/opportunities/acme/state.json',
        expected_etag: '"abc123"',
      },
    },
    {
      description: 'Pull from SharePoint (DIRECTORY MODE)',
      input: { local_path: '/home/speedwave/.claude/context', mode: 'pull' },
    },
    {
      description: 'Two-way sync (DIRECTORY MODE)',
      input: { local_path: '/home/speedwave/.claude/context', mode: 'two_way' },
    },
    {
      description: 'Push to SharePoint (DIRECTORY MODE)',
      input: { local_path: '/home/speedwave/.claude/context', mode: 'push' },
    },
    {
      description: 'Dry run to preview changes (DIRECTORY MODE)',
      input: {
        local_path: '/home/speedwave/.claude/context',
        mode: 'two_way',
        dry_run: true,
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
 * Handle file sync (single file or directory based on params)
 * @param client - SharePoint client instance
 * @param params - Tool parameters
 */
export async function handleSync(
  client: SharePointClient,
  params: Record<string, unknown>
): Promise<ToolResult> {
  try {
    // Check if 'mode' is provided - this indicates directory sync mode
    // This allows sharepoint.sync({ local_path: "...", mode: "two_way" }) to work
    // as documented in hub's sync tool
    if (params.mode !== undefined) {
      // Get localPath for path type check
      const localPath = (params.localPath ?? params.local_path) as string | undefined;

      if (localPath) {
        // Check if the path is a file (not a directory)
        // This prevents the common error of passing a file path with mode
        // Translate Claude container path to MCP container path for fs.stat
        const pathValidator = new PathValidator();
        const translatedPath = pathValidator.translatePath(localPath);

        try {
          const stat = await fs.stat(translatedPath);
          if (stat.isFile()) {
            return {
              success: false,
              error: {
                code: 'INVALID_PARAM',
                message:
                  `Cannot use 'mode' parameter with a file path. ` +
                  `Use syncDirectory with a directory path instead, or remove 'mode' for single file sync. ` +
                  `Path: ${localPath}`,
              },
            };
          }
        } catch (error) {
          // ENOENT (not found) is expected - let syncDirectory handle missing paths
          // Other errors (EACCES, EIO, etc.) should be logged for debugging
          const isNotFound =
            error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';

          if (!isNotFound) {
            console.warn(
              `${ts()} [handleSync] fs.stat warning for ${translatedPath}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      // Route to directory sync handler
      return handleSyncDirectory(client, params);
    }

    // Normalize params to accept both snake_case and camelCase
    const normalized = normalizeSyncParams(params);

    // Validate required fields after normalization
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

    const result = await client.syncFile(normalized);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: { code: 'SYNC_FAILED', message: SharePointClient.formatError(error) },
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
            message: 'SharePoint not configured. Run: speedwave setup sharepoint',
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
    { tool: syncTool, handler: withValidation(withClient(handleSync)) },
  ];
}

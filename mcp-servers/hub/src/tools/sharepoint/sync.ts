/**
 * SharePoint: Sync
 *
 * Synchronize local content with SharePoint.
 * Supports file mode (single file) and directory mode (two-way sync).
 * @param {string} local_path - Absolute local path (must be /home/speedwave/.claude/context for directory mode)
 * @param {string} [sharepoint_path] - Destination path in SharePoint
 * @param {string} [mode] - Sync mode: two_way, pull, push (triggers directory mode)
 * @param {boolean} [dry_run=false] - Compute plan only, do not modify
 * @param {boolean} [delete] - Propagate deletions. Default: true for two_way, false for pull/push
 * @param {string} [expected_etag] - Expected ETag for CAS (file mode only)
 * @param {boolean} [create_only=false] - Create only if not exists (file mode only)
 * @param {boolean} [overwrite=false] - Overwrite unconditionally (file mode only)
 * @param {string[]} [ignore_patterns] - Globs to ignore during directory sync
 * @returns {object} Sync result with operations performed
 * @example
 * // Two-way sync of context directory (directory mode)
 * await sharepoint.sync({
 *   local_path: "/home/speedwave/.claude/context",
 *   mode: "two_way"
 * });
 *
 * // Pull from SharePoint (directory mode)
 * await sharepoint.sync({
 *   local_path: "/home/speedwave/.claude/context",
 *   mode: "pull",
 *   delete: true
 * });
 *
 * // Dry run to see what would happen
 * const plan = await sharepoint.sync({
 *   local_path: "/home/speedwave/.claude/context",
 *   mode: "two_way",
 *   dry_run: true
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'sync',
  service: 'sharepoint',
  category: 'write',
  deferLoading: true,
  timeoutClass: 'long',
  description: `Synchronize local content with SharePoint.

TWO MODES:
- FILE MODE (no mode param): Upload/download single file with ETag CAS conflict handling. Requires sharepoint_path.
- DIRECTORY MODE (with mode param): OneDrive-like two-way sync. Pass mode='pull', 'push', or 'two_way'.

IMPORTANT: For single file sync, do NOT pass 'mode' parameter. For directory sync, always pass 'mode'.`,
  keywords: ['sharepoint', 'sync', 'upload', 'download', 'file', 'onedrive'],
  inputSchema: {
    type: 'object',
    properties: {
      local_path: {
        type: 'string',
        description: 'Absolute local path to file or directory',
      },
      sharepoint_path: {
        type: 'string',
        description:
          'SharePoint destination path. REQUIRED for file mode. For directory mode defaults to "context".',
      },
      mode: {
        type: 'string',
        enum: ['two_way', 'pull', 'push'],
        description:
          'Sync mode - ONLY for directory sync. Omit this parameter for single file sync. Values: two_way (bidirectional), pull (download), push (upload).',
      },
    },
    required: ['local_path'],
  },
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
  example: `// Directory sync (with mode):
await sharepoint.sync({ local_path: "/home/speedwave/.claude/context", mode: "pull" });

// File sync (without mode):
await sharepoint.sync({ local_path: "/path/to/file.json", sharepoint_path: "context/file.json" });`,
  inputExamples: [
    // FILE MODE examples (no mode parameter)
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
    // DIRECTORY MODE examples (with mode parameter)
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

/**
 * Individual sync operation performed during synchronization
 */
interface SyncOperation {
  /** Type of operation performed */
  action: 'upload' | 'download' | 'delete' | 'conflict';
  /** Path of the file affected */
  path: string;
  /** Status of the operation */
  status: 'success' | 'skipped' | 'error';
  /** Error message if status is 'error' */
  error?: string;
}

/**
 * Result of a sync operation
 */
interface SyncResult {
  /** Whether the sync completed successfully */
  success: boolean;
  /** Array of all operations performed */
  operations: SyncOperation[];
  /** Summary statistics of the sync */
  summary: {
    /** Number of files uploaded */
    uploaded: number;
    /** Number of files downloaded */
    downloaded: number;
    /** Number of files deleted */
    deleted: number;
    /** Number of conflicts encountered */
    conflicts: number;
    /** Number of errors encountered */
    errors: number;
  };
}

/**
 * Execute sync tool
 * Synchronizes local content with SharePoint using file or directory mode
 * Directory mode is triggered when `mode` parameter is provided
 * @param params - Sync parameters
 * @param params.local_path - Absolute local path (must be /home/speedwave/.claude/context for directory mode)
 * @param params.sharepoint_path - Destination path in SharePoint
 * @param params.mode - Sync mode: two_way, pull, or push (triggers directory mode)
 * @param params.dry_run - Compute plan only without modifications
 * @param params.delete - Propagate deletions. Default: true for two_way, false for pull/push
 * @param params.expected_etag - Expected ETag for CAS (file mode only)
 * @param params.create_only - Create only if not exists (file mode only)
 * @param params.overwrite - Overwrite unconditionally (file mode only)
 * @param params.ignore_patterns - Glob patterns to ignore during directory sync
 * @param context - Execution context with sharepoint service
 * @param context.sharepoint - SharePoint service bridge instance
 * @param context.sharepoint.sync - File sync function
 * @param context.sharepoint.syncDirectory - Directory sync function
 * @returns Sync result with operations and summary or error
 */
export async function execute(
  params: {
    local_path: string;
    sharepoint_path?: string;
    mode?: 'two_way' | 'pull' | 'push';
    dry_run?: boolean;
    delete?: boolean;
    expected_etag?: string;
    create_only?: boolean;
    overwrite?: boolean;
    ignore_patterns?: string[];
  },
  context: {
    sharepoint: {
      sync: (p: Record<string, unknown>) => Promise<unknown>;
      syncDirectory: (p: Record<string, unknown>) => Promise<unknown>;
    };
  }
): Promise<{ success: boolean; result?: SyncResult; error?: string }> {
  // Validate SharePoint service is initialized
  if (!context?.sharepoint) {
    return {
      success: false,
      error: 'SharePoint service not initialized. Check MCP server configuration.',
    };
  }

  const { local_path, mode } = params;

  if (!local_path) {
    return {
      success: false,
      error: 'Missing required field: local_path',
    };
  }

  try {
    // Defense-in-depth: validate SharePoint path prefix when targeting opportunities/
    // Applies to both file and directory modes.
    const spPath = params.sharepoint_path;
    if (spPath && spPath.startsWith('opportunities/') && !spPath.startsWith('context/')) {
      return {
        success: false,
        error: `Invalid sharepoint_path: paths starting with "opportunities/" must be prefixed with "context/". Got: "${spPath}".`,
      };
    }

    // Directory mode is triggered when `mode` is provided
    const isDirectoryMode = mode !== undefined;

    if (isDirectoryMode) {
      // Directory sync - call syncDirectory
      const result = await context.sharepoint.syncDirectory({
        localPath: local_path,
        sharepointPath: params.sharepoint_path || 'context',
        mode: mode,
        delete: params.delete, // Let SharePoint MCP decide default based on mode
        ignorePatterns: params.ignore_patterns,
        dryRun: params.dry_run,
      });

      return {
        success: true,
        result: result as SyncResult,
      };
    } else {
      // File sync - existing behavior (single file upload)
      const result = await context.sharepoint.sync({
        localPath: local_path,
        sharepointPath: params.sharepoint_path,
        expectedEtag: params.expected_etag,
        createOnly: params.create_only,
        overwrite: params.overwrite,
      });

      return {
        success: true,
        result: result as SyncResult,
      };
    }
  } catch (error) {
    // Distinguish between different error types
    if (error instanceof TypeError) {
      return {
        success: false,
        error: `Configuration error: ${error.message}. Ensure SharePoint service is properly initialized.`,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

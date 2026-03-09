/**
 * Sync Tools - Tools for SharePoint directory sync operations
 */

import { Tool, ToolDefinition } from '../../../shared/dist/index.js';
import { withValidation, ToolResult } from './validation.js';
import { SharePointClient } from '../client.js';

//═══════════════════════════════════════════════════════════════════════════════
// Parameter Normalization (accept both snake_case and camelCase)
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize sync directory parameters to accept both snake_case and camelCase
 * Hub executor sends snake_case, but our handlers expect camelCase
 * @param params - Tool parameters
 */
function normalizeSyncDirectoryParams(params: Record<string, unknown>): {
  localPath: string;
  sharepointPath?: string;
  mode: 'two_way' | 'pull' | 'push';
  delete?: boolean;
  ignorePatterns?: string[];
  dryRun?: boolean;
  verbose?: boolean;
} {
  return {
    localPath: (params.localPath ?? params.local_path) as string,
    sharepointPath: (params.sharepointPath ?? params.sharepoint_path) as string | undefined,
    mode: params.mode as 'two_way' | 'pull' | 'push',
    delete: (params.delete ?? params.delete_enabled) as boolean | undefined,
    ignorePatterns: (params.ignorePatterns ?? params.ignore_patterns) as string[] | undefined,
    dryRun: (params.dryRun ?? params.dry_run) as boolean | undefined,
    verbose: params.verbose as boolean | undefined,
  };
}

const syncDirectoryTool: Tool = {
  name: 'syncDirectory',
  description: 'Synchronize a local directory with SharePoint (OneDrive-like behavior).',
  inputSchema: {
    type: 'object',
    properties: {
      // Accept both camelCase and snake_case (hub sends snake_case)
      localPath: { type: 'string', description: 'Local directory path' },
      local_path: { type: 'string', description: 'Local directory path (alias)' },
      sharepointPath: { type: 'string', description: 'SharePoint directory path' },
      sharepoint_path: { type: 'string', description: 'SharePoint directory path (alias)' },
      mode: { type: 'string', enum: ['two_way', 'pull', 'push'], description: 'Sync mode' },
      delete: {
        type: 'boolean',
        description: 'Propagate deletions. Default: true for two_way mode, false for pull/push',
      },
      ignorePatterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to ignore',
      },
      ignore_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to ignore (alias)',
      },
      dryRun: { type: 'boolean', description: 'Compute plan only. Default: false' },
      dry_run: { type: 'boolean', description: 'Compute plan only (alias)' },
      verbose: {
        type: 'boolean',
        description:
          'Include full plan.operations and executed arrays in response. Default: false (slim mode saves tokens). Note: errors, conflicts, and summary are always included regardless of this setting.',
      },
    },
    // Note: required validation moved to handler after normalization
    // to support both snake_case and camelCase
  },
};

/**
 * Handle directory synchronization
 * @param client - SharePoint client instance
 * @param params - Tool parameters
 */
export async function handleSyncDirectory(
  client: SharePointClient,
  params: Record<string, unknown>
): Promise<ToolResult> {
  try {
    // Normalize params to accept both snake_case and camelCase
    const normalized = normalizeSyncDirectoryParams(params);

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
    if (!normalized.mode) {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'mode is required (two_way, pull, or push)',
        },
      };
    }

    const result = await client.syncDirectory(normalized);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: { code: 'SYNC_DIR_FAILED', message: SharePointClient.formatError(error) },
    };
  }
}

/**
 * Create sync-related tool definitions
 * @param client - SharePoint client instance
 */
export function createSyncTools(client: SharePointClient | null): ToolDefinition[] {
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

  return [{ tool: syncDirectoryTool, handler: withValidation(withClient(handleSyncDirectory)) }];
}

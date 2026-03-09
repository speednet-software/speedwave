/**
 * SharePoint Tools Index
 * @module tools/sharepoint
 *
 * Exports all SharePoint tool metadata for progressive discovery.
 * Tools are loaded dynamically by the search_tools handler.
 *
 * Available tools (5):
 * - listFileIds: List files in SharePoint directory
 * - getFileFull: Get full file details with content
 * - sync: Synchronize single file with SharePoint (file mode)
 * - syncDirectory: Synchronize directory with SharePoint (OneDrive-like two-way sync)
 * - getCurrentUser: Get authenticated user info
 */

import { ToolMetadata } from '../../hub-types.js';
import { metadata as listFileIds } from './list_files.js';
import { metadata as getFileFull } from './get_file_full.js';
import { metadata as sync } from './sync.js';
import { metadata as syncDirectory } from './sync_directory.js';
import { metadata as getCurrentUser } from './get_current_user.js';

/**
 * All SharePoint tools metadata (keyed by tool name)
 * Used by search_tools for progressive discovery
 */
export const toolMetadata: Record<string, ToolMetadata> = {
  listFileIds,
  getFileFull,
  sync,
  syncDirectory,
  getCurrentUser,
};

/**
 * All SharePoint tool names
 */
export const tools = Object.keys(toolMetadata) as (keyof typeof toolMetadata)[];

/**
 * Type representing a valid SharePoint tool name
 */
export type SharePointToolName = keyof typeof toolMetadata;

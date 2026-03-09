/**
 * SharePoint: Sync Directory
 *
 * Synchronize a local directory with SharePoint (OneDrive-like behavior).
 * @param {string} local_path - Absolute local path (must be /home/speedwave/.claude/context)
 * @param {string} [sharepoint_path] - SharePoint directory path (default: context)
 * @param {string} mode - Sync mode: two_way, pull, push
 * @param {boolean} [delete] - Propagate deletions. Default: true for two_way, false for pull/push
 * @param {string[]} [ignore_patterns] - Globs to ignore during sync
 * @param {boolean} [dry_run=false] - Compute plan only
 * @returns {object} Sync result with operations performed
 * @example
 * // Two-way sync of context directory
 * await sharepoint.syncDirectory({
 *   local_path: "/home/speedwave/.claude/context",
 *   mode: "two_way"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'syncDirectory',
  service: 'sharepoint',
  category: 'write',
  deferLoading: true,
  timeoutClass: 'long',
  description: `Synchronize a local directory with SharePoint (OneDrive-like two-way sync).

NOTE: You can also use sharepoint.sync() with 'mode' parameter for directory sync.
This tool is a dedicated shortcut for directory operations.`,
  keywords: ['sharepoint', 'sync', 'directory', 'folder', 'onedrive', 'two-way'],
  inputSchema: {
    type: 'object',
    properties: {
      local_path: {
        type: 'string',
        description: 'Local directory path (must be /home/speedwave/.claude/context)',
      },
      sharepoint_path: {
        type: 'string',
        description: 'SharePoint directory path (default: context)',
      },
      mode: { type: 'string', enum: ['two_way', 'pull', 'push'], description: 'Sync mode' },
      delete: {
        type: 'boolean',
        description: 'Propagate deletions. Default: true for two_way, false for pull/push',
      },
      ignore_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to ignore',
      },
      dry_run: { type: 'boolean', description: 'Compute plan only (default: false)' },
    },
    required: ['local_path', 'mode'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      plan: {
        type: 'object',
        properties: {
          operations: { type: 'array' },
          summary: { type: 'object' },
        },
      },
      executed: { type: 'array' },
      conflicts: { type: 'array' },
      errors: { type: 'array' },
      summary: { type: 'object' },
    },
    required: ['success'],
  },
  example: `await sharepoint.syncDirectory({ local_path: "/home/speedwave/.claude/context", mode: "pull" })`,
  inputExamples: [
    {
      description: 'Pull from SharePoint (download)',
      input: { local_path: '/home/speedwave/.claude/context', mode: 'pull' },
    },
    {
      description: 'Two-way sync (OneDrive-like)',
      input: { local_path: '/home/speedwave/.claude/context', mode: 'two_way' },
    },
    {
      description: 'Push to SharePoint (upload)',
      input: { local_path: '/home/speedwave/.claude/context', mode: 'push' },
    },
    {
      description: 'Dry run to preview changes',
      input: {
        local_path: '/home/speedwave/.claude/context',
        mode: 'two_way',
        dry_run: true,
      },
    },
  ],
};

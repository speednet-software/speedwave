/**
 * OS: List Notes
 *
 * List notes from a specific folder or all folders.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listNotes',
  service: 'os',
  osCategory: 'notes',
  category: 'read',
  deferLoading: false,
  description:
    'List notes from a specific folder or all folders (title, creation date, modification date)',
  keywords: ['os', 'notes', 'list', 'documents', 'memos'],
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: { type: 'string', description: 'Folder ID (omit for all folders)' },
      limit: { type: 'number', description: 'Maximum notes to return (default: 50)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            folder_id: { type: 'string' },
            created_at: { type: 'string', description: 'ISO8601' },
            modified_at: { type: 'string', description: 'ISO8601' },
          },
        },
      },
    },
  },
  example: `const { notes } = await os.listNotes({ limit: 20 })`,
  inputExamples: [
    {
      description: 'Minimal: list all notes',
      input: {},
    },
    {
      description: 'Full: list from specific folder',
      input: { folder_id: 'folder-123', limit: 10 },
    },
  ],
  timeoutMs: 30_000,
};

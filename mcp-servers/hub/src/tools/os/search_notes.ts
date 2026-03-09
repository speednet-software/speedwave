/**
 * OS: Search Notes
 *
 * Search notes by query string across titles and content.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'searchNotes',
  service: 'os',
  osCategory: 'notes',
  category: 'read',
  deferLoading: false,
  description: 'Search notes by query string across titles and content',
  keywords: ['os', 'notes', 'search', 'find', 'query'],
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      folder_id: { type: 'string', description: 'Limit search to folder (omit for all)' },
      limit: { type: 'number', description: 'Maximum results (default: 20)' },
    },
    required: ['query'],
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
            snippet: { type: 'string', description: 'Matching text snippet' },
            folder_id: { type: 'string' },
            modified_at: { type: 'string' },
          },
        },
      },
      total: { type: 'number' },
    },
  },
  example: `const { notes } = await os.searchNotes({ query: "meeting notes" })`,
  inputExamples: [
    {
      description: 'Minimal: search all notes',
      input: { query: 'meeting notes' },
    },
    {
      description: 'Full: search in specific folder',
      input: { query: 'architecture decision', folder_id: 'work-folder', limit: 5 },
    },
  ],
  timeoutMs: 30_000,
};

/**
 * OS: List Note Folders
 *
 * List all note folders/notebooks.
 * macOS: Notes.app folders, Linux: GNOME Notes, Windows: OneNote/Sticky Notes.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listNoteFolders',
  service: 'os',
  osCategory: 'notes',
  category: 'read',
  deferLoading: false,
  description: 'List all note folders/notebooks available on the system',
  keywords: ['os', 'notes', 'folders', 'notebooks', 'list', 'categories'],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      folders: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            account_name: { type: 'string' },
            note_count: { type: 'number' },
          },
        },
      },
    },
  },
  example: `const { folders } = await os.listNoteFolders()`,
  inputExamples: [
    {
      description: 'List all note folders (no params)',
      input: {},
    },
  ],
  timeoutMs: 30_000,
};

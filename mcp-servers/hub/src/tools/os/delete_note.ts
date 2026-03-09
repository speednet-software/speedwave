/**
 * OS: Delete Note
 *
 * Delete a note by ID.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'deleteNote',
  service: 'os',
  osCategory: 'notes',
  category: 'delete',
  deferLoading: false,
  description: 'Delete a note by its ID',
  keywords: ['os', 'note', 'delete', 'remove'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID to delete' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"deleted"' },
    },
  },
  example: `await os.deleteNote({ id: "note-789" })`,
  inputExamples: [
    {
      description: 'Delete a note',
      input: { id: 'note-789' },
    },
  ],
  timeoutMs: 30_000,
};

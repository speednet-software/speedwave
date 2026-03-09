/**
 * OS: Update Note
 *
 * Update an existing note's title or body.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'updateNote',
  service: 'os',
  osCategory: 'notes',
  category: 'write',
  deferLoading: false,
  description: 'Update an existing note (title, body, or both)',
  keywords: ['os', 'note', 'update', 'edit', 'modify'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID to update' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body (plain text or HTML)' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"updated"' },
    },
  },
  example: `await os.updateNote({ id: "note-789", body: "Updated content here" })`,
  inputExamples: [
    {
      description: 'Minimal: update body only',
      input: { id: 'note-789', body: 'Updated content' },
    },
    {
      description: 'Full: update title and body',
      input: { id: 'note-789', title: 'Renamed Note', body: 'New content here' },
    },
  ],
  timeoutMs: 30_000,
};

/**
 * OS: Get Note
 *
 * Get the full content of a specific note by ID.
 * Notes may have large bodies with attachments, hence the 30s timeout.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getNote',
  service: 'os',
  osCategory: 'notes',
  category: 'read',
  deferLoading: false,
  description: 'Get the full content of a specific note including body (HTML and plaintext)',
  keywords: ['os', 'note', 'get', 'read', 'detail', 'content', 'body'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string', description: 'Note body (HTML)' },
      plaintext: { type: 'string', description: 'Note body (plain text)' },
      folder_id: { type: 'string' },
      folder_name: { type: 'string' },
      created_at: { type: 'string' },
      modified_at: { type: 'string' },
    },
  },
  example: `const note = await os.getNote({ id: "note-789" })`,
  inputExamples: [
    {
      description: 'Get note by ID',
      input: { id: 'note-789' },
    },
  ],
  timeoutMs: 30_000,
};

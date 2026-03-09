/**
 * OS: Create Note
 *
 * Create a new note in the specified folder.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'createNote',
  service: 'os',
  osCategory: 'notes',
  category: 'write',
  deferLoading: false,
  description: 'Create a new note with title and body in the specified folder',
  keywords: ['os', 'note', 'create', 'new', 'add', 'write'],
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title' },
      body: { type: 'string', description: 'Note body (plain text or HTML)' },
      folder_id: { type: 'string', description: 'Target folder ID (uses default if omitted)' },
    },
    required: ['title'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ID of created note' },
      status: { type: 'string', description: '"created"' },
    },
  },
  example: `const { id } = await os.createNote({ title: "Sprint Retro Notes", body: "## What went well\\n- Deployment was smooth" })`,
  inputExamples: [
    {
      description: 'Minimal: create with title only',
      input: { title: 'Quick thought' },
    },
    {
      description: 'Full: create with body in specific folder',
      input: {
        title: 'Sprint Retro Notes',
        body: '## What went well\n- Deployment was smooth\n- Tests all passed',
        folder_id: 'work-folder',
      },
    },
  ],
  timeoutMs: 30_000,
};

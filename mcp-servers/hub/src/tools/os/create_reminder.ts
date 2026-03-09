/**
 * OS: Create Reminder
 *
 * Create a new reminder in the specified list.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'createReminder',
  service: 'os',
  osCategory: 'reminders',
  category: 'write',
  deferLoading: false,
  description: 'Create a new reminder with optional due date, priority, and notes',
  keywords: ['os', 'reminder', 'create', 'new', 'add', 'task', 'todo'],
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Reminder title' },
      list_id: {
        type: 'string',
        description: 'Target reminder list ID (uses default list if omitted)',
      },
      due_date: { type: 'string', description: 'Due date in ISO8601 format' },
      priority: { type: 'number', description: '0=none, 1=high, 5=medium, 9=low' },
      notes: { type: 'string', description: 'Additional notes' },
    },
    required: ['name'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ID of created reminder' },
      status: { type: 'string', description: '"created"' },
    },
  },
  example: `const { id } = await os.createReminder({ name: "Review PR #42", due_date: "2025-01-15T10:00:00Z", priority: 1 })`,
  inputExamples: [
    {
      description: 'Minimal: create with name only',
      input: { name: 'Buy groceries' },
    },
    {
      description: 'Full: create with all fields',
      input: {
        name: 'Review PR #42',
        list_id: 'work-list',
        due_date: '2025-01-15T10:00:00Z',
        priority: 1,
        notes: 'Check test coverage',
      },
    },
  ],
  timeoutMs: 30_000,
};

/**
 * OS: List Reminders
 *
 * List reminders from a specific list or all lists.
 * Returns name, due date, completion status, and priority.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listReminders',
  service: 'os',
  osCategory: 'reminders',
  category: 'read',
  deferLoading: false,
  description:
    'List reminders from a specific list or all lists, with optional filtering by completion status',
  keywords: ['os', 'reminders', 'list', 'tasks', 'todo', 'due'],
  inputSchema: {
    type: 'object',
    properties: {
      list_id: { type: 'string', description: 'Reminder list ID (omit for all lists)' },
      completed: { type: 'boolean', description: 'Filter by completion status (omit for all)' },
      limit: { type: 'number', description: 'Maximum number of reminders to return (default: 50)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      reminders: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            due_date: { type: 'string', description: 'ISO8601 date' },
            completed: { type: 'boolean' },
            priority: { type: 'number', description: '0=none, 1=high, 5=medium, 9=low' },
            list_id: { type: 'string' },
          },
        },
      },
    },
  },
  example: `const { reminders } = await os.listReminders({ completed: false, limit: 20 })`,
  inputExamples: [
    {
      description: 'Minimal: list all incomplete reminders',
      input: { completed: false },
    },
    {
      description: 'Full: list from specific list with limit',
      input: { list_id: 'abc-123', completed: false, limit: 10 },
    },
  ],
  timeoutMs: 30_000,
};

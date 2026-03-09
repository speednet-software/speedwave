/**
 * OS: Get Reminder
 *
 * Get full details of a specific reminder by ID.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getReminder',
  service: 'os',
  osCategory: 'reminders',
  category: 'read',
  deferLoading: false,
  description: 'Get full details of a specific reminder by its ID',
  keywords: ['os', 'reminder', 'get', 'detail', 'show'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Reminder ID' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      notes: { type: 'string', description: 'Reminder notes/body' },
      due_date: { type: 'string', description: 'ISO8601 date' },
      completed: { type: 'boolean' },
      completed_date: { type: 'string', description: 'ISO8601 date' },
      priority: { type: 'number' },
      list_id: { type: 'string' },
      list_name: { type: 'string' },
    },
  },
  example: `const reminder = await os.getReminder({ id: "abc-123" })`,
  inputExamples: [
    {
      description: 'Get reminder by ID',
      input: { id: 'abc-123' },
    },
  ],
  timeoutMs: 30_000,
};

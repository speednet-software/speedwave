/**
 * OS: Complete Reminder
 *
 * Mark a reminder as completed.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'completeReminder',
  service: 'os',
  osCategory: 'reminders',
  category: 'write',
  deferLoading: false,
  description: 'Mark a reminder as completed by its ID',
  keywords: ['os', 'reminder', 'complete', 'done', 'finish', 'check'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Reminder ID to complete' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"completed"' },
    },
  },
  example: `await os.completeReminder({ id: "abc-123" })`,
  inputExamples: [
    {
      description: 'Complete a reminder',
      input: { id: 'abc-123' },
    },
  ],
  timeoutMs: 30_000,
};

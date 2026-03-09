/**
 * OS: List Reminder Lists
 *
 * List all reminder lists (calendars/groups) available on the system.
 * macOS: EventKit reminder calendars, Linux: EDS task lists, Windows: WinRT appointment stores.
 * First call may trigger macOS permission dialog (EventKit requestFullAccessToReminders).
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listReminderLists',
  service: 'os',
  osCategory: 'reminders',
  category: 'read',
  deferLoading: false,
  description:
    'List all reminder lists available on the system (e.g., "Reminders", "Work", "Shopping")',
  keywords: ['os', 'reminders', 'lists', 'calendars', 'groups', 'categories'],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      lists: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique list identifier' },
            name: { type: 'string', description: 'List name' },
            color: { type: 'string', description: 'List color (hex)' },
          },
        },
      },
    },
  },
  example: `const lists = await os.listReminderLists()`,
  inputExamples: [
    {
      description: 'List all reminder lists (no params)',
      input: {},
    },
  ],
  timeoutMs: 30_000,
};

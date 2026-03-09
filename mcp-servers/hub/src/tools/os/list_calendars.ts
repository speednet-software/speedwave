/**
 * OS: List Calendars
 *
 * List all calendars available on the system.
 * macOS: EventKit calendars, Linux: EDS calendars, Windows: WinRT appointment stores.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listCalendars',
  service: 'os',
  osCategory: 'calendar',
  category: 'read',
  deferLoading: false,
  description: 'List all calendars available on the system (e.g., "Home", "Work", "Holidays")',
  keywords: ['os', 'calendar', 'calendars', 'list', 'schedule'],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      calendars: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', description: 'local, exchange, caldav, etc.' },
            color: { type: 'string', description: 'Hex color' },
          },
        },
      },
    },
  },
  example: `const { calendars } = await os.listCalendars()`,
  inputExamples: [
    {
      description: 'List all calendars (no params)',
      input: {},
    },
  ],
  timeoutMs: 30_000,
};

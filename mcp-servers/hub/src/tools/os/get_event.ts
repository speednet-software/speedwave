/**
 * OS: Get Event
 *
 * Get full details of a specific calendar event by ID.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getEvent',
  service: 'os',
  osCategory: 'calendar',
  category: 'read',
  deferLoading: false,
  description: 'Get full details of a specific calendar event including attendees and notes',
  keywords: ['os', 'calendar', 'event', 'get', 'detail', 'show', 'meeting'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event ID' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      summary: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      location: { type: 'string' },
      notes: { type: 'string' },
      all_day: { type: 'boolean' },
      attendees: { type: 'array', items: { type: 'string' } },
      calendar_id: { type: 'string' },
      calendar_name: { type: 'string' },
      url: { type: 'string' },
    },
  },
  example: `const event = await os.getEvent({ id: "evt-123" })`,
  inputExamples: [
    {
      description: 'Get event by ID',
      input: { id: 'evt-123' },
    },
  ],
  timeoutMs: 30_000,
};

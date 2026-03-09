/**
 * OS: Delete Event
 *
 * Delete a calendar event by ID.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'deleteEvent',
  service: 'os',
  osCategory: 'calendar',
  category: 'delete',
  deferLoading: false,
  description: 'Delete a calendar event by its ID',
  keywords: ['os', 'calendar', 'event', 'delete', 'remove', 'cancel'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event ID to delete' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"deleted"' },
    },
  },
  example: `await os.deleteEvent({ id: "evt-123" })`,
  inputExamples: [
    {
      description: 'Delete an event',
      input: { id: 'evt-123' },
    },
  ],
  timeoutMs: 30_000,
};

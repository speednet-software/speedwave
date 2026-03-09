/**
 * OS: Update Event
 *
 * Update an existing calendar event.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'updateEvent',
  service: 'os',
  osCategory: 'calendar',
  category: 'write',
  deferLoading: false,
  description: 'Update an existing calendar event (summary, time, location, notes)',
  keywords: ['os', 'calendar', 'event', 'update', 'edit', 'modify', 'reschedule'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event ID to update' },
      summary: { type: 'string', description: 'New event title' },
      start: { type: 'string', description: 'New start time (ISO8601)' },
      end: { type: 'string', description: 'New end time (ISO8601)' },
      location: { type: 'string', description: 'New location' },
      notes: { type: 'string', description: 'New notes' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"updated"' },
    },
  },
  example: `await os.updateEvent({ id: "evt-123", summary: "Updated meeting title", start: "2025-01-15T10:00:00Z", end: "2025-01-15T11:00:00Z" })`,
  inputExamples: [
    {
      description: 'Minimal: update summary only',
      input: { id: 'evt-123', summary: 'Renamed meeting' },
    },
    {
      description: 'Full: reschedule and update details',
      input: {
        id: 'evt-123',
        summary: 'Sprint Planning (moved)',
        start: '2025-01-16T10:00:00Z',
        end: '2025-01-16T11:00:00Z',
        location: 'Room 7',
      },
    },
  ],
  timeoutMs: 30_000,
};

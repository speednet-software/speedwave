/**
 * OS: Create Event
 *
 * Create a new calendar event.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'createEvent',
  service: 'os',
  osCategory: 'calendar',
  category: 'write',
  deferLoading: false,
  description: 'Create a new calendar event with summary, start/end times, and optional location',
  keywords: ['os', 'calendar', 'event', 'create', 'new', 'add', 'meeting', 'schedule'],
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'Start time in ISO8601 format' },
      end: { type: 'string', description: 'End time in ISO8601 format' },
      calendar_id: { type: 'string', description: 'Target calendar ID (uses default if omitted)' },
      location: { type: 'string', description: 'Event location' },
      notes: { type: 'string', description: 'Event notes/description' },
      all_day: { type: 'boolean', description: 'Whether this is an all-day event' },
    },
    required: ['summary', 'start', 'end'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ID of created event' },
      status: { type: 'string', description: '"created"' },
    },
  },
  example: `const { id } = await os.createEvent({ summary: "Team standup", start: "2025-01-15T09:00:00Z", end: "2025-01-15T09:30:00Z" })`,
  inputExamples: [
    {
      description: 'Minimal: create with required fields',
      input: {
        summary: 'Team standup',
        start: '2025-01-15T09:00:00Z',
        end: '2025-01-15T09:30:00Z',
      },
    },
    {
      description: 'Full: create with all fields',
      input: {
        summary: 'Sprint Planning',
        start: '2025-01-15T10:00:00Z',
        end: '2025-01-15T11:00:00Z',
        calendar_id: 'work-cal',
        location: 'Room 42',
        notes: 'Q1 sprint planning',
        all_day: false,
      },
    },
  ],
  timeoutMs: 30_000,
};

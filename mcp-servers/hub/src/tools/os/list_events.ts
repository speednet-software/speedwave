/**
 * OS: List Events
 *
 * List calendar events within a date range.
 * Returns summary, start/end times, location, and calendar info.
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listEvents',
  service: 'os',
  osCategory: 'calendar',
  category: 'read',
  deferLoading: false,
  description: 'List calendar events within a date range, optionally filtered by calendar',
  keywords: ['os', 'calendar', 'events', 'list', 'schedule', 'meetings', 'appointments'],
  inputSchema: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'Start date in ISO8601 format (default: today)' },
      end: {
        type: 'string',
        description: 'End date in ISO8601 format (default: 7 days from start)',
      },
      calendar_id: { type: 'string', description: 'Filter by calendar ID (omit for all)' },
      limit: { type: 'number', description: 'Maximum number of events (default: 50)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            summary: { type: 'string' },
            start: { type: 'string', description: 'ISO8601' },
            end: { type: 'string', description: 'ISO8601' },
            location: { type: 'string' },
            all_day: { type: 'boolean' },
            calendar_id: { type: 'string' },
          },
        },
      },
    },
  },
  example: `const { events } = await os.listEvents({ start: "2025-01-13T00:00:00Z", end: "2025-01-17T23:59:59Z" })`,
  inputExamples: [
    {
      description: 'Minimal: this week events',
      input: {},
    },
    {
      description: 'Full: specific calendar and date range',
      input: {
        start: '2025-01-13T00:00:00Z',
        end: '2025-01-17T23:59:59Z',
        calendar_id: 'work-cal',
        limit: 20,
      },
    },
  ],
  timeoutMs: 30_000,
};

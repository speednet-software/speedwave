/**
 * Calendar Tools — OS Calendar integration
 */

import { Tool, ToolDefinition } from '../../../shared/dist/index.js';
import { withValidation, ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import { runCommand } from '../platform-runner.js';

//=============================================================================
// Types
//=============================================================================

/** Input parameters for the listCalendars tool (no params required). */
type ListCalendarsParams = Record<string, never>;

/** Input parameters for the listEvents tool. */
interface ListEventsParams {
  /** Filter by calendar ID. */
  calendar_id?: string;
  /** Start date in ISO8601 format. */
  start?: string;
  /** End date in ISO8601 format. */
  end?: string;
  /** Max events to return. */
  limit?: number;
}

/** Input parameters for the getEvent tool. */
interface GetEventParams {
  /** Event ID. */
  id: string;
}

/** Input parameters for the createEvent tool. */
interface CreateEventParams {
  /** Event title. */
  summary: string;
  /** Start time in ISO8601 format. */
  start: string;
  /** End time in ISO8601 format. */
  end: string;
  /** Target calendar ID. */
  calendar_id?: string;
  /** Event location. */
  location?: string;
  /** Event description/notes. */
  description?: string;
  /** Whether this is an all-day event. */
  all_day?: boolean;
}

/** Input parameters for the updateEvent tool. */
interface UpdateEventParams {
  /** Event ID to update. */
  id: string;
  /** New event title. */
  summary?: string;
  /** New start time in ISO8601 format. */
  start?: string;
  /** New end time in ISO8601 format. */
  end?: string;
  /** New location. */
  location?: string;
  /** New description. */
  description?: string;
}

/** Input parameters for the deleteEvent tool. */
interface DeleteEventParams {
  /** Event ID to delete. */
  id: string;
}

//=============================================================================
// Tool Definitions
//=============================================================================

const listCalendarsTool: Tool = {
  name: 'listCalendars',
  description: 'List all calendars available on this device',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const listEventsTool: Tool = {
  name: 'listEvents',
  description: 'List calendar events within a date range',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_id: { type: 'string', description: 'Filter by calendar ID' },
      start: { type: 'string', description: 'Start date in ISO8601 format' },
      end: { type: 'string', description: 'End date in ISO8601 format' },
      limit: { type: 'number', description: 'Max events to return (default 50)' },
    },
  },
};

const getEventTool: Tool = {
  name: 'getEvent',
  description: 'Get a specific calendar event by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event ID' },
    },
    required: ['id'],
  },
};

const createEventTool: Tool = {
  name: 'createEvent',
  description: 'Create a new calendar event',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'Start time in ISO8601 format' },
      end: { type: 'string', description: 'End time in ISO8601 format' },
      calendar_id: { type: 'string', description: 'Target calendar ID (uses default if omitted)' },
      location: { type: 'string', description: 'Event location' },
      description: { type: 'string', description: 'Event description/notes' },
      all_day: { type: 'boolean', description: 'Whether this is an all-day event' },
    },
    required: ['summary', 'start', 'end'],
  },
};

const updateEventTool: Tool = {
  name: 'updateEvent',
  description: 'Update an existing calendar event',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event ID to update' },
      summary: { type: 'string', description: 'New event title' },
      start: { type: 'string', description: 'New start time in ISO8601 format' },
      end: { type: 'string', description: 'New end time in ISO8601 format' },
      location: { type: 'string', description: 'New location' },
      description: { type: 'string', description: 'New description' },
    },
    required: ['id'],
  },
};

const deleteEventTool: Tool = {
  name: 'deleteEvent',
  description: 'Delete a calendar event',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event ID to delete' },
    },
    required: ['id'],
  },
};

//=============================================================================
// Handlers
//=============================================================================

/**
 * Lists all calendars available on this device.
 * @param _params - Unused tool input parameters.
 */
export async function handleListCalendars(_params: ListCalendarsParams): Promise<ToolResult> {
  const result = await runCommand('calendar', 'list_calendars');
  return { success: true, data: result.parsed };
}

/**
 * Lists calendar events within a date range.
 * @param params - Tool input parameters.
 */
export async function handleListEvents(params: ListEventsParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    strings: [['calendar_id', MAX_LENGTHS.id, false]],
    numbers: [['limit', 1, 10_000]],
    dates: ['start', 'end'],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('calendar', 'list_events', p);
  return { success: true, data: result.parsed };
}

/**
 * Gets a specific calendar event by ID.
 * @param params - Tool input parameters.
 */
export async function handleGetEvent(params: GetEventParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [['id', MAX_LENGTHS.id, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('calendar', 'get_event', p);
  return { success: true, data: result.parsed };
}

/**
 * Creates a new calendar event.
 * @param params - Tool input parameters.
 */
export async function handleCreateEvent(params: CreateEventParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['summary', 'start', 'end'],
    booleans: ['all_day'],
    strings: [
      ['summary', MAX_LENGTHS.short, false],
      ['calendar_id', MAX_LENGTHS.id, false],
      ['location', MAX_LENGTHS.short, false],
      ['description', MAX_LENGTHS.body, true],
    ],
    dates: ['start', 'end'],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('calendar', 'create_event', p);
  return { success: true, data: result.parsed };
}

/**
 * Updates an existing calendar event.
 * @param params - Tool input parameters.
 */
export async function handleUpdateEvent(params: UpdateEventParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [
      ['id', MAX_LENGTHS.id, false],
      ['summary', MAX_LENGTHS.short, false],
      ['location', MAX_LENGTHS.short, false],
      ['description', MAX_LENGTHS.body, true],
    ],
    dates: ['start', 'end'],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('calendar', 'update_event', p);
  return { success: true, data: result.parsed };
}

/**
 * Deletes a calendar event.
 * @param params - Tool input parameters.
 */
export async function handleDeleteEvent(params: DeleteEventParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [['id', MAX_LENGTHS.id, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('calendar', 'delete_event', p);
  return { success: true, data: result.parsed };
}

//=============================================================================
// Export
//=============================================================================

/** Creates tool definitions for all calendar operations. */
export function createCalendarTools(): ToolDefinition[] {
  return [
    { tool: listCalendarsTool, handler: withValidation(handleListCalendars) },
    { tool: listEventsTool, handler: withValidation(handleListEvents) },
    { tool: getEventTool, handler: withValidation(handleGetEvent) },
    { tool: createEventTool, handler: withValidation(handleCreateEvent) },
    { tool: updateEventTool, handler: withValidation(handleUpdateEvent) },
    { tool: deleteEventTool, handler: withValidation(handleDeleteEvent) },
  ];
}

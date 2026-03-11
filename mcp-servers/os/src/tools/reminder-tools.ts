/**
 * Reminder Tools — OS Reminders integration
 */

import { Tool, ToolDefinition } from '@speedwave/mcp-shared';
import { withValidation, ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import { runCommand } from '../platform-runner.js';

//=============================================================================
// Types
//=============================================================================

/** Input parameters for the listReminderLists tool (no params required). */
type ListReminderListsParams = Record<string, never>;

/** Input parameters for the listReminders tool. */
interface ListRemindersParams {
  /** Filter by reminder list ID. */
  list_id?: string;
  /** Max reminders to return. */
  limit?: number;
  /** Include completed reminders. */
  show_completed?: boolean;
}

/** Input parameters for the getReminder tool. */
interface GetReminderParams {
  /** Reminder ID. */
  id: string;
}

/** Input parameters for the createReminder tool. */
interface CreateReminderParams {
  /** Reminder title/name. */
  name: string;
  /** Target reminder list ID. */
  list_id?: string;
  /** Due date in ISO8601 format. */
  due_date?: string;
  /** Priority level (0=none, 1=high, 5=medium, 9=low). */
  priority?: number;
  /** Additional notes. */
  notes?: string;
}

/** Input parameters for the completeReminder tool. */
interface CompleteReminderParams {
  /** Reminder ID to complete. */
  id: string;
}

//=============================================================================
// Tool Definitions
//=============================================================================

const listReminderListsTool: Tool = {
  name: 'listReminderLists',
  description: 'List all reminder lists/groups available on this device',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const listRemindersTool: Tool = {
  name: 'listReminders',
  description: 'List reminders, optionally filtered by list',
  inputSchema: {
    type: 'object',
    properties: {
      list_id: { type: 'string', description: 'Filter by reminder list ID' },
      limit: { type: 'number', description: 'Max reminders to return (default 50)' },
      show_completed: {
        type: 'boolean',
        description: 'Include completed reminders (default false)',
      },
    },
  },
};

const getReminderTool: Tool = {
  name: 'getReminder',
  description: 'Get a specific reminder by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Reminder ID' },
    },
    required: ['id'],
  },
};

const createReminderTool: Tool = {
  name: 'createReminder',
  description: 'Create a new reminder',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Reminder title/name' },
      list_id: {
        type: 'string',
        description: 'Target reminder list ID (uses default list if omitted)',
      },
      due_date: { type: 'string', description: 'Due date in ISO8601 format' },
      priority: { type: 'number', description: 'Priority (0=none, 1=high, 5=medium, 9=low)' },
      notes: { type: 'string', description: 'Additional notes' },
    },
    required: ['name'],
  },
};

const completeReminderTool: Tool = {
  name: 'completeReminder',
  description: 'Mark a reminder as completed',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Reminder ID to complete' },
    },
    required: ['id'],
  },
};

//=============================================================================
// Handlers
//=============================================================================

/**
 * Lists all reminder lists/groups available on this device.
 * @param _params - Unused tool input parameters.
 */
export async function handleListReminderLists(
  _params: ListReminderListsParams
): Promise<ToolResult> {
  const result = await runCommand('reminders', 'list_lists');
  return { success: true, data: result.parsed };
}

/**
 * Lists reminders, optionally filtered by list.
 * @param params - Tool input parameters.
 */
export async function handleListReminders(params: ListRemindersParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    booleans: ['show_completed'],
    strings: [['list_id', MAX_LENGTHS.id, false]],
    numbers: [['limit', 1, 10_000]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('reminders', 'list_reminders', p);
  return { success: true, data: result.parsed };
}

/**
 * Gets a specific reminder by ID.
 * @param params - Tool input parameters.
 */
export async function handleGetReminder(params: GetReminderParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [['id', MAX_LENGTHS.id, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('reminders', 'get_reminder', p);
  return { success: true, data: result.parsed };
}

/**
 * Creates a new reminder.
 * @param params - Tool input parameters.
 */
export async function handleCreateReminder(params: CreateReminderParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['name'],
    strings: [
      ['name', MAX_LENGTHS.short, false],
      ['list_id', MAX_LENGTHS.id, false],
      ['notes', MAX_LENGTHS.body, true],
    ],
    numbers: [['priority', 0, 9]],
    dates: ['due_date'],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('reminders', 'create_reminder', p);
  return { success: true, data: result.parsed };
}

/**
 * Marks a reminder as completed.
 * @param params - Tool input parameters.
 */
export async function handleCompleteReminder(params: CompleteReminderParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [['id', MAX_LENGTHS.id, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('reminders', 'complete_reminder', p);
  return { success: true, data: result.parsed };
}

//=============================================================================
// Export
//=============================================================================

/** Creates tool definitions for all reminder operations. */
export function createReminderTools(): ToolDefinition[] {
  return [
    { tool: listReminderListsTool, handler: withValidation(handleListReminderLists) },
    { tool: listRemindersTool, handler: withValidation(handleListReminders) },
    { tool: getReminderTool, handler: withValidation(handleGetReminder) },
    { tool: createReminderTool, handler: withValidation(handleCreateReminder) },
    { tool: completeReminderTool, handler: withValidation(handleCompleteReminder) },
  ];
}

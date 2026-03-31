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
  /** Tags to assign (stored as [#tag] markers in the notes field). */
  tags?: string[];
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
  category: 'read',
  keywords: ['os', 'reminders', 'lists', 'calendars', 'groups', 'categories'],
  example: 'const lists = await os.listReminderLists()',
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
  inputExamples: [
    {
      description: 'List all reminder lists (no params)',
      input: {},
    },
  ],
};

const listRemindersTool: Tool = {
  name: 'listReminders',
  description: 'List reminders, optionally filtered by list',
  category: 'read',
  keywords: ['os', 'reminders', 'list', 'tasks', 'todo', 'due'],
  example: 'const { reminders } = await os.listReminders({ completed: false, limit: 20 })',
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
  outputSchema: {
    type: 'object',
    properties: {
      reminders: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            due_date: { type: 'string', description: 'ISO8601 date' },
            completed: { type: 'boolean' },
            priority: { type: 'number', description: '0=none, 1=high, 5=medium, 9=low' },
            notes: { type: 'string', description: 'Reminder notes/body' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags extracted from [#tag] markers in the notes',
            },
            list_id: { type: 'string' },
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: list all incomplete reminders',
      input: { completed: false },
    },
    {
      description: 'Full: list from specific list with limit',
      input: { list_id: 'abc-123', completed: false, limit: 10 },
    },
  ],
};

const getReminderTool: Tool = {
  name: 'getReminder',
  description: 'Get a specific reminder by ID',
  category: 'read',
  keywords: ['os', 'reminder', 'get', 'detail', 'show'],
  example: 'const reminder = await os.getReminder({ id: "abc-123" })',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Reminder ID' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      notes: { type: 'string', description: 'Reminder notes/body' },
      due_date: { type: 'string', description: 'ISO8601 date' },
      completed: { type: 'boolean' },
      completed_date: { type: 'string', description: 'ISO8601 date' },
      priority: { type: 'number' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags extracted from [#tag] markers in the notes',
      },
      list_id: { type: 'string' },
      list_name: { type: 'string' },
    },
  },
  inputExamples: [
    {
      description: 'Get reminder by ID',
      input: { id: 'abc-123' },
    },
  ],
};

const createReminderTool: Tool = {
  name: 'createReminder',
  description: 'Create a new reminder',
  category: 'write',
  keywords: ['os', 'reminder', 'create', 'new', 'add', 'task', 'todo'],
  example:
    'const { id } = await os.createReminder({ name: "Review PR #42", due_date: "2025-01-15T10:00:00Z", priority: 1 })',
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
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to assign (stored as [#tag] markers in the notes field)',
      },
    },
    required: ['name'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ID of created reminder' },
      status: { type: 'string', description: '"created"' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: create with name only',
      input: { name: 'Buy groceries' },
    },
    {
      description: 'Full: create with all fields',
      input: {
        name: 'Review PR #42',
        list_id: 'work-list',
        due_date: '2025-01-15T10:00:00Z',
        priority: 1,
        notes: 'Check test coverage',
        tags: ['work', 'code-review'],
      },
    },
  ],
};

const completeReminderTool: Tool = {
  name: 'completeReminder',
  description: 'Mark a reminder as completed',
  category: 'write',
  keywords: ['os', 'reminder', 'complete', 'done', 'finish', 'check'],
  example: 'await os.completeReminder({ id: "abc-123" })',
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
  inputExamples: [
    {
      description: 'Complete a reminder',
      input: { id: 'abc-123' },
    },
  ],
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
    stringArrays: [['tags', 50, MAX_LENGTHS.short]],
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

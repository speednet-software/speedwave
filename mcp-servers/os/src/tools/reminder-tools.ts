/**
 * Reminder Tools — OS Reminders integration
 */

import {
  Tool,
  ToolDefinition,
  teachingToolResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import {
  withValidation,
  ToolResult,
  validateAll,
  requireFields,
  asRecord,
  MAX_LENGTHS,
} from './validation.js';
import { runCommand } from '../platform-runner.js';

/** Tags become `[#tag]` markers inside the notes field, so these characters would forge markers. */
const TAG_MARKER_CHARS = { pattern: /[[\]#]/, describe: '[, ], or # characters' };

/** Input parameters for the listReminderLists tool (no params required). */
type ListReminderListsParams = Record<string, never>;

const REMINDER_SORT_VALUES = ['due_date', 'created', 'name'] as const;

/** Input parameters for the listReminders tool. */
interface ListRemindersParams {
  /** Filter by reminder list ID. */
  list_id?: string;
  /** Max reminders to return (default 50). */
  limit?: number;
  /** Include completed reminders. */
  show_completed?: boolean;
  /** Only reminders due at or after this date (same format as `due_date`). */
  due_from?: string;
  /** Only reminders due at or before this date; a bare day includes that whole day. */
  due_to?: string;
  /** Only incomplete reminders due before now. */
  overdue?: boolean;
  /** Case- and diacritic-insensitive substring of the name or notes. */
  search?: string;
  /** Result order (default due_date). */
  sort?: (typeof REMINDER_SORT_VALUES)[number];
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

/** Input parameters for the updateReminder tool; omitted fields keep their current value. */
interface UpdateReminderParams {
  /** Reminder ID to update. */
  id: string;
  /** New title/name. */
  name?: string;
  /** Move the reminder to this list (ID or exact display name). */
  list_id?: string;
  /** New due date in ISO8601 format; `null` removes the due date. */
  due_date?: string | null;
  /** New priority level (0=none, 1=high, 5=medium, 9=low). */
  priority?: number;
  /** New notes; existing tags are kept unless `tags` is also given. */
  notes?: string;
  /** New tags (replaces the current set); existing notes are kept unless `notes` is also given. */
  tags?: string[];
  /** Mark as completed (true) or reopen (false). */
  completed?: boolean;
}

/** Input parameters for the completeReminder tool. */
interface CompleteReminderParams {
  /** Reminder ID to complete. */
  id: string;
}

/** Input parameters for the deleteReminder tool. */
interface DeleteReminderParams {
  /** Reminder ID to delete. */
  id: string;
}

const listReminderListsTool: Tool = {
  name: 'listReminderLists',
  description: 'List all reminder lists/groups available on this device',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'reminders',
  },
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
  description:
    'List reminders, optionally filtered by list, due date range, overdue state or text; reports total and truncated when the limit cut the result',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'reminders',
  },
  keywords: ['os', 'reminders', 'list', 'tasks', 'todo', 'due'],
  example:
    'const { reminders, total, truncated } = await os.listReminders({ overdue: true, sort: "due_date" })',
  inputSchema: {
    type: 'object',
    properties: {
      list_id: {
        type: 'string',
        description: 'Filter by reminder list id or its exact display name',
      },
      limit: { type: 'number', description: 'Max reminders to return (default 50)' },
      show_completed: {
        type: 'boolean',
        description: 'Include completed reminders (default false)',
      },
      due_from: {
        type: 'string',
        description:
          'Only reminders due at or after this moment, same format as due_date (a bare day starts at local midnight). Reminders without a due date are left out when a range is given',
      },
      due_to: {
        type: 'string',
        description:
          'Only reminders due before the end of this moment, same format as due_date (a bare day includes that whole day). Reminders without a due date are left out when a range is given',
      },
      overdue: {
        type: 'boolean',
        description:
          'Only incomplete reminders already past due (an all-day reminder is overdue once its day is over); ignores show_completed (default false)',
      },
      search: {
        type: 'string',
        description:
          'Substring of the name or notes, ignoring case and diacritics ("faktura" finds "Faktúra")',
      },
      sort: {
        type: 'string',
        enum: REMINDER_SORT_VALUES,
        description:
          'Order of the result: due_date ascending with undated last (default), created ascending, or name alphabetical',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      total: {
        type: 'number',
        description: 'Number of reminders that matched, before the limit was applied',
      },
      truncated: {
        type: 'boolean',
        description:
          'True when the limit cut the result; narrow the query instead of raising limit',
      },
      reminders: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            due_date: {
              type: 'string',
              description:
                'YYYY-MM-DD for an all-day reminder, otherwise local time with UTC offset (e.g. 2026-06-15T09:00:00+02:00)',
            },
            all_day: {
              type: 'boolean',
              description:
                'Present together with due_date: true when the reminder has no time of day',
            },
            completed: { type: 'boolean' },
            priority: { type: 'number', description: '0=none, 1=high, 5=medium, 9=low' },
            notes: { type: 'string', description: 'Reminder notes/body' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags extracted from [#tag] markers in the notes. Absent when no tags.',
            },
            list_id: { type: 'string' },
            list_name: { type: 'string' },
            completed_date: {
              type: 'string',
              description: 'Completion time as local time with UTC offset',
            },
          },
        },
      },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: list all incomplete reminders',
      input: { show_completed: false },
    },
    {
      description: 'Full: list from specific list with limit',
      input: { list_id: 'abc-123', show_completed: false, limit: 10 },
    },
    {
      description: 'Overdue reminders matching a word, earliest due first',
      input: { overdue: true, search: 'faktura', sort: 'due_date' },
    },
    {
      description: 'Everything due in June 2026 (a bare due_to day includes that whole day)',
      input: { due_from: '2026-06-01', due_to: '2026-06-30' },
    },
  ],
};

const getReminderTool: Tool = {
  name: 'getReminder',
  description: 'Get a specific reminder by ID',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'reminders',
  },
  keywords: ['os', 'reminder', 'get', 'detail', 'show'],
  example: 'const reminder = await os.getReminder({ id: "abc-123" })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Reminder ID (must be the exact id returned by a list/get/create call; names are not accepted)',
      },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      notes: { type: 'string', description: 'Reminder notes/body' },
      due_date: {
        type: 'string',
        description:
          'YYYY-MM-DD for an all-day reminder, otherwise local time with UTC offset (e.g. 2026-06-15T09:00:00+02:00)',
      },
      all_day: {
        type: 'boolean',
        description: 'Present together with due_date: true when the reminder has no time of day',
      },
      completed: { type: 'boolean' },
      completed_date: {
        type: 'string',
        description: 'Completion time as local time with UTC offset',
      },
      priority: { type: 'number' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags extracted from [#tag] markers in the notes. Absent when no tags.',
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
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'reminders',
  },
  keywords: ['os', 'reminder', 'create', 'new', 'add', 'task', 'todo'],
  example:
    'const { id } = await os.createReminder({ name: "Review PR #42", due_date: "2026-01-15T10:00:00", priority: 1 })',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Reminder title/name' },
      list_id: {
        type: 'string',
        description:
          'Target reminder list id or its exact display name (uses default list if omitted)',
      },
      due_date: {
        type: 'string',
        description:
          'YYYY-MM-DD for an all-day reminder, or YYYY-MM-DDTHH:MM:SS for a timed one (local time; a UTC offset or Z is converted to local time)',
      },
      priority: {
        type: 'integer',
        description:
          'Priority, 0-9 (0=none, 1-4=high, 5=medium, 6-9=low; EventKit treats 1-9 as a gradient)',
      },
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
      description: 'All-day: a bare date sets no time of day',
      input: { name: 'Pay rent', due_date: '2026-07-01' },
    },
    {
      description: 'Full: create with all fields',
      input: {
        name: 'Review PR #42',
        list_id: 'work-list',
        due_date: '2026-01-15T10:00:00',
        priority: 1,
        notes: 'Check test coverage',
        tags: ['work', 'code-review'],
      },
    },
  ],
};

const updateReminderTool: Tool = {
  name: 'updateReminder',
  description:
    'Update an existing reminder: only the provided fields change, omitted fields keep their value',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'reminders',
  },
  keywords: [
    'os',
    'reminder',
    'update',
    'edit',
    'modify',
    'rename',
    'move',
    'reschedule',
    'reopen',
  ],
  example: 'await os.updateReminder({ id: "abc-123", name: "Corrected title" })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Reminder ID to update (must be the exact id returned by a list/get/create call; names are not accepted)',
      },
      name: { type: 'string', description: 'New reminder title/name' },
      list_id: {
        type: 'string',
        description: 'Move the reminder to this list (id or exact display name)',
      },
      due_date: {
        type: ['string', 'null'],
        description:
          'New due date: YYYY-MM-DD for all-day, or YYYY-MM-DDTHH:MM:SS for a timed reminder (local time; an offset or Z is converted). Pass null to remove the due date (this also removes any recurrence)',
      },
      priority: {
        type: 'integer',
        description:
          'New priority, 0-9 (0=none, 1-4=high, 5=medium, 6-9=low; EventKit treats 1-9 as a gradient)',
      },
      notes: {
        type: 'string',
        description:
          'New notes text (replaces the notes; existing tags are kept unless tags is also given)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'New tags, replacing the current set (stored as [#tag] markers in the notes field); existing notes are kept unless notes is also given',
      },
      completed: {
        type: 'boolean',
        description: 'true marks the reminder completed, false reopens a completed reminder',
      },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"updated"' },
    },
  },
  inputExamples: [
    {
      description: 'Minimal: rename only',
      input: { id: 'abc-123', name: 'Corrected title' },
    },
    {
      description: 'Reopen a completed reminder',
      input: { id: 'abc-123', completed: false },
    },
    {
      description: 'Remove the due date',
      input: { id: 'abc-123', due_date: null },
    },
    {
      description: 'Full: reschedule, move and retag at once',
      input: {
        id: 'abc-123',
        name: 'Review PR #42',
        list_id: 'work-list',
        due_date: '2026-01-16T10:00:00',
        priority: 5,
        notes: 'Rescheduled after the sync',
        tags: ['work'],
      },
    },
  ],
};

const completeReminderTool: Tool = {
  name: 'completeReminder',
  description: 'Mark a reminder as completed',
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'reminders',
  },
  keywords: ['os', 'reminder', 'complete', 'done', 'finish', 'check'],
  example: 'await os.completeReminder({ id: "abc-123" })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Reminder ID to complete (must be the exact id returned by a list/get/create call; names are not accepted)',
      },
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

const deleteReminderTool: Tool = {
  name: 'deleteReminder',
  description: 'Permanently delete a reminder (there is no trash to restore it from)',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_MS]: 30_000,
    [META_KEYS.OS_CATEGORY]: 'reminders',
  },
  keywords: ['os', 'reminder', 'delete', 'remove'],
  example: 'await os.deleteReminder({ id: "abc-123" })',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Reminder ID to delete (must be the exact id returned by a list/get/create call; names are not accepted)',
      },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '"deleted"' },
    },
  },
  inputExamples: [
    {
      description: 'Delete a reminder',
      input: { id: 'abc-123' },
    },
  ],
};

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
    booleans: ['show_completed', 'overdue'],
    strings: [
      ['list_id', MAX_LENGTHS.id, false],
      ['search', MAX_LENGTHS.short, false],
    ],
    numbers: [['limit', 1, 10_000]],
    dates: ['due_from', 'due_to'],
  });
  if (!v.valid) return v.error;
  if (p.search !== undefined) {
    const search = requireFields(p, ['search']);
    if (!search.valid) return search.error;
  }
  if (p.sort !== undefined && !(REMINDER_SORT_VALUES as readonly unknown[]).includes(p.sort)) {
    return teachingToolResult(
      {
        paramName: 'sort',
        received: p.sort,
        nextStep: `Pass one of ${REMINDER_SORT_VALUES.join(', ')}.`,
      },
      'INVALID_VALUE'
    );
  }
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
    integers: [['priority', 0, 9]],
    dates: ['due_date'],
    stringArrays: [['tags', 50, MAX_LENGTHS.short, TAG_MARKER_CHARS]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('reminders', 'create_reminder', p);
  return { success: true, data: result.parsed };
}

/**
 * Updates an existing reminder; only the fields present in params change.
 * @param params - Tool input parameters.
 */
export async function handleUpdateReminder(params: UpdateReminderParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    booleans: ['completed'],
    strings: [
      ['id', MAX_LENGTHS.id, false],
      ['name', MAX_LENGTHS.short, false],
      ['list_id', MAX_LENGTHS.id, false],
      ['notes', MAX_LENGTHS.body, true],
    ],
    integers: [['priority', 0, 9]],
    dates: ['due_date'],
    nullable: ['due_date'],
    stringArrays: [['tags', 50, MAX_LENGTHS.short, TAG_MARKER_CHARS]],
  });
  if (!v.valid) return v.error;
  if (p.name !== undefined) {
    const nonEmpty = requireFields(p, ['name']);
    if (!nonEmpty.valid) return nonEmpty.error;
  }
  const result = await runCommand('reminders', 'update_reminder', p);
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

/**
 * Permanently deletes a reminder.
 * @param params - Tool input parameters.
 */
export async function handleDeleteReminder(params: DeleteReminderParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [['id', MAX_LENGTHS.id, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('reminders', 'delete_reminder', p);
  return { success: true, data: result.parsed };
}

/** Creates tool definitions for all reminder operations. */
export function createReminderTools(): ToolDefinition[] {
  return [
    { tool: listReminderListsTool, handler: withValidation(handleListReminderLists) },
    { tool: listRemindersTool, handler: withValidation(handleListReminders) },
    { tool: getReminderTool, handler: withValidation(handleGetReminder) },
    { tool: createReminderTool, handler: withValidation(handleCreateReminder) },
    { tool: updateReminderTool, handler: withValidation(handleUpdateReminder) },
    { tool: completeReminderTool, handler: withValidation(handleCompleteReminder) },
    { tool: deleteReminderTool, handler: withValidation(handleDeleteReminder) },
  ];
}

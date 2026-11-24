import { sanitizeTextile } from './textile.js';
import { TOOL_NAMES } from './tool-names.js';

type FieldType = 'string' | 'date' | 'textile' | 'number' | 'boolean' | 'ids' | 'custom_fields';

type FilterSyntax = 'value' | 'expression' | 'map';

type CustomFieldValue = { id: number; value: unknown };

interface IssueField {
  name: string;
  type: FieldType;
  description: string;
  updateDescription?: string;
  create: boolean;
  update: boolean;
  required?: boolean;
  clearable?: boolean;
  requires?: string;
  bounds?: { min: number; max?: number; integer?: boolean };
  alias?: { name: string; description: string };
  filter?: { name: string; syntax: FilterSyntax; type?: string | string[]; description: string };
  read?: string;
  include?: string;
}

const ISSUE_FIELDS: readonly IssueField[] = [
  {
    name: 'project_id',
    type: 'string',
    description: 'Project ID or identifier',
    updateDescription: 'Move the issue to this project',
    create: true,
    update: true,
    required: true,
    filter: {
      name: 'project_id',
      syntax: 'value',
      type: 'string',
      description: 'Project identifier or key',
    },
  },
  {
    name: 'subject',
    type: 'string',
    description: 'Issue subject/title',
    updateDescription: 'New subject',
    create: true,
    update: true,
    required: true,
    read: 'subject',
  },
  {
    name: 'description',
    type: 'textile',
    description: 'Issue description',
    updateDescription: 'New description',
    create: true,
    update: true,
    clearable: true,
    read: 'description',
  },
  {
    name: 'tracker_id',
    type: 'number',
    description: 'Tracker ID',
    create: true,
    update: true,
    alias: { name: 'tracker', description: 'Tracker name' },
    filter: { name: 'tracker_id', syntax: 'value', type: 'number', description: 'Tracker ID' },
    read: 'tracker.id',
  },
  {
    name: 'status_id',
    type: 'number',
    description: 'Status ID',
    create: true,
    update: true,
    alias: { name: 'status', description: 'Status name' },
    filter: {
      name: 'status_id',
      syntax: 'value',
      type: ['number', 'string'],
      description: 'Status ID, or open / closed / *; use for a status getMappings does not map',
    },
    read: 'status.id',
  },
  {
    name: 'priority_id',
    type: 'number',
    description: 'Priority ID',
    create: true,
    update: true,
    alias: { name: 'priority', description: 'Priority name' },
    filter: { name: 'priority_id', syntax: 'value', type: 'number', description: 'Priority ID' },
    read: 'priority.id',
  },
  {
    name: 'assigned_to_id',
    type: 'number',
    description: 'Assigned user ID',
    create: true,
    update: true,
    clearable: true,
    alias: {
      name: 'assigned_to',
      description: "Assignee name, or 'me' to assign to the current authenticated user",
    },
    filter: {
      name: 'assigned_to_id',
      syntax: 'value',
      type: 'number',
      description: 'Assignee user ID',
    },
    read: 'assigned_to.id',
  },
  {
    name: 'category_id',
    type: 'number',
    description: `Category ID, from ${TOOL_NAMES.LIST_CATEGORIES}; must belong to the issue's project. A category with a default assignee sets the assignee when none is given`,
    create: true,
    update: true,
    clearable: true,
    filter: {
      name: 'category_id',
      syntax: 'value',
      type: ['number', 'string'],
      description: `Category filter, ID from ${TOOL_NAMES.LIST_CATEGORIES}, or Redmine filter syntax: "5|6" (any of), "!5" (not), "!*" (no category), "*" (any), ev / !ev / cf for history. Needs project_id or a configured project`,
    },
    read: 'category.id',
  },
  {
    name: 'fixed_version_id',
    type: 'number',
    description: `Target version ID, obtained from ${TOOL_NAMES.LIST_VERSIONS}`,
    updateDescription: `Target version ID, obtained from ${TOOL_NAMES.LIST_VERSIONS}; only an open version`,
    create: true,
    update: true,
    clearable: true,
    filter: {
      name: 'fixed_version_id',
      syntax: 'value',
      type: 'number',
      description: `Target version ID, obtained from ${TOOL_NAMES.LIST_VERSIONS}; add status: "*" for closed ones`,
    },
    read: 'fixed_version.id',
  },
  {
    name: 'parent_issue_id',
    type: 'number',
    description: 'Parent issue ID',
    create: true,
    update: true,
    clearable: true,
    filter: {
      name: 'parent_id',
      syntax: 'value',
      type: 'number',
      description: 'Parent issue ID (lists its subtasks); add status: "*" for closed ones',
    },
    read: 'parent.id',
  },
  {
    name: 'start_date',
    type: 'date',
    description: 'Start date, YYYY-MM-DD',
    create: true,
    update: true,
    clearable: true,
    filter: {
      name: 'start_date',
      syntax: 'expression',
      description:
        'Redmine filter expression: 2026-11-24, >=2026-11-01, <=2026-11-30, ><2026-11-01|2026-11-30, !*',
    },
    read: 'start_date',
  },
  {
    name: 'due_date',
    type: 'date',
    description: 'Due date, YYYY-MM-DD',
    create: true,
    update: true,
    clearable: true,
    filter: {
      name: 'due_date',
      syntax: 'expression',
      description:
        'Redmine filter expression: 2026-11-24, >=2026-11-01, <=2026-11-30, ><2026-11-01|2026-11-30, !*',
    },
    read: 'due_date',
  },
  {
    name: 'done_ratio',
    type: 'number',
    bounds: { min: 0, max: 100, integer: true },
    description: 'Percent done, 0 to 100; Redmine ignores it when progress is derived from status',
    create: true,
    update: true,
    filter: {
      name: 'done_ratio',
      syntax: 'expression',
      description: 'Redmine filter expression on percent done: 50, >=50, <=99, ><20|80',
    },
    read: 'done_ratio',
  },
  {
    name: 'estimated_hours',
    type: 'number',
    bounds: { min: 0 },
    description: 'Estimated hours',
    create: true,
    update: true,
    clearable: true,
    read: 'estimated_hours',
  },
  {
    name: 'is_private',
    type: 'boolean',
    description: 'Private issue, visible only to users with access to private issues',
    create: true,
    update: true,
    filter: {
      name: 'is_private',
      syntax: 'expression',
      description:
        'Redmine filter expression, a string: "1" for private issues, "0" for public ones',
    },
    read: 'is_private',
  },
  {
    name: 'custom_fields',
    type: 'custom_fields',
    description:
      'Custom field values as [{ id, value }]; value is an array for a multiple field, null clears that field',
    create: true,
    update: true,
    filter: {
      name: 'cf',
      syntax: 'map',
      type: 'object',
      description:
        'Custom field filters: a map of custom field ID to a Redmine filter expression, e.g. { "1": "2.4" }',
    },
    read: 'custom_fields',
  },
  {
    name: 'watcher_user_ids',
    type: 'ids',
    description: 'User IDs to add as watchers; Redmine accepts them only when the issue is created',
    create: true,
    update: false,
    filter: {
      name: 'watcher_id',
      syntax: 'expression',
      description: 'Redmine filter expression: me, a user ID, or !<user ID>',
    },
    read: 'watchers',
    include: 'watchers',
  },
  {
    name: 'notes',
    type: 'textile',
    description: 'Update notes/comment',
    create: false,
    update: true,
  },
  {
    name: 'private_notes',
    type: 'boolean',
    requires: 'notes',
    description: 'Make the notes of this update private, visible only to users who may see them',
    create: false,
    update: true,
  },
];

type IssueWriteMode = 'create' | 'update';

/** The `issue` object sent to Redmine. */
export type IssueWrite = Record<string, unknown>;

type IssueWriteResult =
  { ok: true; payload: IssueWrite } | { ok: false; paramName: string; problem: string };

/**
 * Input-schema properties of the fields a write accepts.
 * @param mode - Create or update.
 */
export function issueInputProperties(mode: IssueWriteMode): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of ISSUE_FIELDS.filter((f) => f[mode])) {
    properties[field.name] = fieldSchema(field, mode);
    if (field.alias) {
      properties[field.alias.name] = { type: 'string', description: field.alias.description };
    }
  }
  return properties;
}

/** Names of the fields createIssue requires. */
export function issueRequiredOnCreate(): string[] {
  return ISSUE_FIELDS.filter((f) => f.required).map((f) => f.name);
}

/** Input-schema properties of the listIssueIds filters. */
export function issueFilterProperties(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const { filter } of ISSUE_FIELDS) {
    if (filter) {
      properties[filter.name] = {
        type: filter.syntax === 'expression' ? 'string' : filter.type,
        description: filter.description,
      };
    }
  }
  return properties;
}

/**
 * The filter that cannot be sent, with why.
 * @param options - Tool parameters that may carry filters.
 */
export function issueFilterProblem(
  options: Record<string, unknown>
): { paramName: string; problem: string } | undefined {
  for (const { filter } of ISSUE_FIELDS) {
    const value = filter && options[filter.name];
    if (!filter || value === undefined) continue;
    const problem = filterValueProblem(filter, value);
    if (problem) return { paramName: filter.name, problem };
  }
  return undefined;
}

/**
 * Query parameters for the filters present in `options`.
 * @param options - Tool parameters that may carry filters.
 */
export function issueFilterParams(options: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const { filter } of ISSUE_FIELDS) {
    const value = filter && options[filter.name];
    if (!filter || value === undefined || value === null || value === '') continue;
    if (filter.syntax === 'map') {
      for (const [id, expression] of Object.entries(value as Record<string, unknown>)) {
        params[`cf_${id}`] = expression;
      }
    } else {
      params[filter.name] = value;
    }
  }
  return params;
}

/**
 * Validate the fields of a write and build the payload; a name alias with a value is left for the caller to resolve.
 * @param params - Tool parameters.
 * @param mode - Create or update.
 */
export function buildIssuePayload(
  params: Record<string, unknown>,
  mode: IssueWriteMode
): IssueWriteResult {
  const payload: IssueWrite = {};
  for (const field of ISSUE_FIELDS.filter((f) => f[mode])) {
    const aliasProblem = field.alias && unresolvedAliasProblem(field, params[field.alias.name]);
    if (field.alias && aliasProblem) {
      return { ok: false, paramName: field.alias.name, problem: aliasProblem };
    }
    const value = params[field.name];
    if (value === undefined) continue;
    const problem = valueProblem(field, value);
    if (problem) return { ok: false, paramName: field.name, problem };
    if (field.requires && params[field.requires] === undefined) {
      return {
        ok: false,
        paramName: field.name,
        problem: `${field.name} needs ${field.requires}: it only applies to the ${field.requires} of this update. Pass both, or omit ${field.name}.`,
      };
    }
    payload[field.name] = payloadValue(field, value);
  }
  return { ok: true, payload };
}

/**
 * The IDs that name aliases resolved to.
 * @param resolved - Tool parameters after names are resolved.
 */
export function resolvedAliasIds(resolved: Record<string, unknown>): IssueWrite {
  const ids: IssueWrite = {};
  for (const { name, alias } of ISSUE_FIELDS) {
    if (alias && resolved[name] !== undefined) ids[name] = resolved[name];
  }
  return ids;
}

/**
 * Sent fields the issue read back does not hold.
 * @param payload - What was sent.
 * @param issue - The issue after the write.
 */
export function ignoredFields(payload: IssueWrite, issue: object): string[] {
  const ignored: string[] = [];
  for (const field of ISSUE_FIELDS) {
    if (!(field.name in payload) || !field.read) continue;
    const actual = readPath(issue, field.read);
    if (field.type === 'custom_fields') {
      ignored.push(...ignoredCustomFields(payload[field.name] as CustomFieldValue[], actual));
    } else if (!holds(field, payload[field.name], actual)) {
      ignored.push(field.name);
    }
  }
  return ignored;
}

/**
 * The `include` values the read-back needs.
 * @param payload - What was sent.
 */
export function issueReadIncludes(payload: IssueWrite): string[] {
  return ISSUE_FIELDS.filter((f) => f.include && f.name in payload).map((f) => f.include!);
}

function fieldSchema(field: IssueField, mode: IssueWriteMode): Record<string, unknown> {
  const description =
    mode === 'update' && field.updateDescription ? field.updateDescription : field.description;
  const schema = { ...typeSchema(field.type), description };
  if (!field.clearable) return schema;
  return {
    ...schema,
    type: [schema.type, 'null'],
    description: `${description}; null clears`,
  };
}

function typeSchema(type: FieldType): { type: string; [key: string]: unknown } {
  switch (type) {
    case 'string':
    case 'date':
    case 'textile':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'ids':
      return { type: 'array', items: { type: 'number' } };
    case 'custom_fields':
      return {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Custom field ID' },
            value: {
              type: ['string', 'number', 'array', 'null'],
              description: 'Value; an array for a multiple field, null clears it',
            },
          },
          required: ['id', 'value'],
        },
      };
  }
}

function filterValueProblem(
  filter: NonNullable<IssueField['filter']>,
  value: unknown
): string | undefined {
  const name = filter.name;
  if (value === null || value === '') {
    return `${name} must not be empty; omit it to apply no filter.`;
  }
  if (filter.syntax === 'map' && !isCustomFieldFilter(value)) {
    return `${name} must be an object mapping a custom field ID (digits) to a filter expression string, e.g. { "1": "2.4" }.`;
  }
  if (filter.syntax === 'expression' && typeof value !== 'string') {
    return `${name} must be a Redmine filter expression string, e.g. "1".`;
  }
  return undefined;
}

function isCustomFieldFilter(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([id, expression]) => /^\d+$/.test(id) && typeof expression === 'string'
    )
  );
}

function unresolvedAliasProblem(field: IssueField, value: unknown): string | undefined {
  if (value !== null && value !== '') return undefined;
  const alias = field.alias!.name;
  return field.clearable
    ? `${alias} cannot be null or empty; pass ${field.name}: null to clear it.`
    : `${alias} cannot be cleared; pass a name, or omit it to leave the field unchanged.`;
}

function valueProblem(field: IssueField, value: unknown): string | undefined {
  const name = field.name;
  if (value === null && !field.clearable) {
    return `${name} cannot be cleared. Pass a value, or omit it to leave the field unchanged.`;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return field.clearable
      ? `${name}: empty string is not a value; pass null to clear it, or omit it to leave the field unchanged.`
      : `${name}: empty string is not a value; ${name} cannot be cleared, so pass a value or omit it.`;
  }
  return value === null ? undefined : typeProblem(field, value);
}

function typeProblem(field: IssueField, value: unknown): string | undefined {
  const name = field.name;
  switch (field.type) {
    case 'string':
    case 'textile':
      return typeof value === 'string' ? undefined : `${name} must be a string.`;
    case 'date':
      return typeof value === 'string' && isRealDate(value)
        ? undefined
        : `${name} must be a real date in YYYY-MM-DD format.`;
    case 'number':
      return numberProblem(field, value);
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${name} must be true or false.`;
    case 'ids':
      return Array.isArray(value) && value.every((id) => Number.isInteger(id) && id > 0)
        ? undefined
        : `${name} must be a list of positive integer user IDs.`;
    case 'custom_fields':
      return customFieldsProblem(value);
  }
}

function isRealDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(time) &&
    new Date(time).toISOString().slice(0, 10) === value
  );
}

function numberProblem(field: IssueField, value: unknown): string | undefined {
  const bounds = field.bounds;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${field.name} must be a finite number.`;
  }
  if (bounds?.integer && !Number.isInteger(value)) return `${field.name} must be a whole number.`;
  if (bounds && (value < bounds.min || (bounds.max !== undefined && value > bounds.max))) {
    return `${field.name} must be ${bounds.max === undefined ? `at least ${bounds.min}` : `from ${bounds.min} to ${bounds.max}`}.`;
  }
  return undefined;
}

function customFieldsProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return 'custom_fields must be a list of { id, value } objects.';
  }
  for (const item of value as Array<Partial<CustomFieldValue> | null>) {
    if (typeof item !== 'object' || item === null) {
      return 'custom_fields must be a list of { id, value } objects.';
    }
    if (!Number.isInteger(item.id) || (item.id as number) < 1) {
      return 'every custom_fields item needs id, the positive integer ID of the custom field.';
    }
    if (item.value === undefined) {
      return `custom_fields item ${item.id} needs value; pass value: null to clear it.`;
    }
    if (item.value === '') {
      return `custom_fields item ${item.id}: empty string is not a value; pass value: null to clear it.`;
    }
    if (!isCustomFieldValue(item.value)) {
      return `custom_fields item ${item.id}: value must be a string, a number, an array of non-empty strings or numbers, or null.`;
    }
  }
  return undefined;
}

function isCustomFieldValue(value: unknown): boolean {
  const scalar = (v: unknown) => (typeof v === 'string' && v !== '') || typeof v === 'number';
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    (Array.isArray(value) && value.every(scalar))
  );
}

function payloadValue(field: IssueField, value: unknown): unknown {
  if (value === null) return field.type === 'textile' ? '' : null;
  switch (field.type) {
    case 'string':
      return (value as string).trim();
    case 'textile':
      return sanitizeTextile(value as string);
    case 'custom_fields':
      return (value as CustomFieldValue[]).map(({ id, value: v }) => ({
        id,
        value: v === null ? '' : v,
      }));
    default:
      return value;
  }
}

function readPath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], source);
}

function ignoredCustomFields(sent: CustomFieldValue[], actual: unknown): string[] {
  const present = (actual as Array<CustomFieldValue> | undefined) ?? [];
  return sent
    .filter(({ id, value }) => listOf(value) !== listOf(present.find((cf) => cf.id === id)?.value))
    .map(({ id }) => `custom_fields.${id}`);
}

function listOf(value: unknown): string {
  const items = Array.isArray(value) ? value : [value];
  return JSON.stringify(
    items
      .filter((item) => item !== null && item !== undefined && item !== '')
      .map(String)
      .sort()
  );
}

function holds(field: IssueField, sent: unknown, actual: unknown): boolean {
  switch (field.type) {
    case 'ids': {
      if (actual === undefined) return true;
      const present = (actual as Array<{ id: number }>).map((w) => w.id);
      return (sent as number[]).every((id) => present.includes(id));
    }
    case 'number':
      return numberOf(sent) === numberOf(actual);
    case 'boolean':
      return Boolean(sent) === Boolean(actual);
    default:
      return textOf(sent) === textOf(actual);
  }
}

function numberOf(value: unknown): number | null {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).replace(/\r\n/g, '\n').trim();
}

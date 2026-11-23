export const SPRINT_STATUSES = ['open', 'active', 'closed'] as const;
export const SPRINT_SHARINGS = ['none', 'descendants', 'hierarchy', 'tree', 'system'] as const;

/** Sprint status word. */
export type SprintStatus = (typeof SPRINT_STATUSES)[number];
/** Sprint sharing word. */
export type SprintSharing = (typeof SPRINT_SHARINGS)[number];

/** A sprint as the tools return it. */
export interface AgileSprint {
  id: number;
  project_id?: number;
  name: string;
  description?: string;
  status?: SprintStatus;
  start_date?: string;
  end_date?: string;
  sharing?: SprintSharing;
  story_points?: number;
  done_ratio?: number;
  estimated_hours?: number;
  spent_hours?: number;
  issues?: Array<Record<string, unknown>>;
}

/** Agile data of an issue. */
export interface AgileData {
  agile_sprint_id: number | null;
  story_points: number | null;
  position: number | null;
  color: string | null;
}

/** A page of sprints. */
export interface SprintList {
  sprints: AgileSprint[];
  total_count: number;
  offset: number;
  limit: number;
}

type Raw = Record<string, unknown>;

const SPRINT_KEYS = [
  'id',
  'project_id',
  'name',
  'description',
  'start_date',
  'end_date',
  'story_points',
  'done_ratio',
  'estimated_hours',
  'spent_hours',
] as const;

function codeOf(words: readonly string[], word: string, field: string): number {
  const code = words.indexOf(word);
  if (code < 0) {
    throw new Error(`Unknown ${field} "${word}". Allowed values: ${words.join(', ')}.`);
  }
  return code;
}

/**
 * Integer code of a sprint status word.
 * @param word - open, active or closed.
 */
export function statusCode(word: string): number {
  return codeOf(SPRINT_STATUSES, word, 'status');
}

/**
 * Integer code of a sprint sharing word.
 * @param word - none, descendants, hierarchy, tree or system.
 */
export function sharingCode(word: string): number {
  return codeOf(SPRINT_SHARINGS, word, 'sharing');
}

function wordOf(words: readonly string[], value: unknown): string {
  return typeof value === 'number' ? words[value] : String(value);
}

function unwrap(raw: unknown, key: string): Raw {
  const body = (raw ?? {}) as Raw;
  return (body[key] ?? body) as Raw;
}

/**
 * Parse one sprint as Redmine returns it.
 * @param raw - Response body or one element of a sprint list.
 */
export function parseSprint(raw: unknown): AgileSprint {
  const body = unwrap(raw, 'agile_sprint');
  const sprint: Raw = {};
  for (const key of SPRINT_KEYS) {
    if (body[key] !== undefined) sprint[key] = body[key];
  }
  if (body.status !== undefined) sprint.status = wordOf(SPRINT_STATUSES, body.status);
  if (body.sharing !== undefined) sprint.sharing = wordOf(SPRINT_SHARINGS, body.sharing);
  if (Array.isArray(body.issues)) sprint.issues = body.issues as Raw[];
  return sprint as unknown as AgileSprint;
}

/**
 * Parse the body of a sprint list.
 * @param raw - Response body of `agile_sprints.json`.
 * @param requested - Paging the request asked for, used when Redmine echoes none.
 * @param requested.offset - Requested offset.
 * @param requested.limit - Requested limit.
 */
export function parseSprintList(
  raw: unknown,
  requested: { offset?: number; limit?: number }
): SprintList {
  const body = (raw ?? {}) as Raw;
  const sprints = ((body.sprints ?? []) as unknown[]).map(parseSprint);
  return {
    sprints,
    total_count: (body.total_count as number | undefined) ?? sprints.length,
    offset: (body.offset as number | undefined) ?? requested.offset ?? 0,
    limit: (body.limit as number | undefined) ?? requested.limit ?? 25,
  };
}

/**
 * Parse the body of `agile_data.json`.
 * @param raw - Response body.
 */
export function parseAgileData(raw: unknown): AgileData {
  const body = unwrap(raw, 'agile_data');
  return {
    agile_sprint_id: (body.agile_sprint_id as number | null | undefined) ?? null,
    story_points: (body.story_points as number | null | undefined) ?? null,
    position: (body.position as number | null | undefined) ?? null,
    color: (body.color as string | null | undefined) ?? null,
  };
}

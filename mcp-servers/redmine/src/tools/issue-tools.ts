/**
 * Issue Tools - 6 tools for Redmine issue operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  teachingErrorResult,
  META_KEYS,
  MAX_WORKSPACE_FILES,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import {
  buildIssuePayload,
  ignoredFields,
  issueFilterProblem,
  issueFilterProperties,
  issueInputProperties,
  issueRequiredOnCreate,
  resolvedAliasIds,
} from '../issue-fields.js';
import { resolveParams } from './helpers.js';
import { resolveAttachmentFiles } from './attachment-files.js';
import { withRedmineErrors, withTargetProject } from './error-handling.js';
import { successResultSchema } from './schema-helpers.js';

/** Result shape of every ids-only issue lookup; getIssueFull takes an id from `ids`. */
const ISSUE_IDS_OUTPUT_SCHEMA = successResultSchema({
  ids: {
    type: 'array',
    items: { type: 'number' },
    description: 'Issue IDs; fetch details with getIssueFull',
  },
  total_count: { type: 'number' },
});

/**
 * Resolve `assigned_to` to `assigned_to_id` in place; returns a teaching error result when the
 * identifier matches no user, undefined on success/no-op.
 * @param client - Redmine client used for user resolution
 * @param resolved - Params object mutated in place
 */
async function resolveAssignedTo(
  client: RedmineClient,
  resolved: Record<string, unknown>
): Promise<ReturnType<typeof teachingErrorResult> | undefined> {
  if (!resolved.assigned_to || resolved.assigned_to_id) return undefined;
  const userId = await client.resolveUser(resolved.assigned_to as string);
  if (userId === null) {
    return teachingErrorResult({
      paramName: 'assigned_to',
      received: resolved.assigned_to,
      correctValueTool: 'resolveUser',
      nextStep:
        'Call resolveUser({ identifier }) or listUsers to find a valid username, email, or numeric user ID, then retry with assigned_to_id.',
    });
  }
  resolved.assigned_to_id = userId;
  delete resolved.assigned_to;
  return undefined;
}

const CATEGORY_NEEDS_PROJECT =
  'category_id requires project_id: Redmine ignores the category filter on a query without a project, so no request was sent. Pass project_id, or configure the Project ID of the integration.';

const NAMED_REF = {
  type: 'object',
  properties: { id: { type: 'number' }, name: { type: 'string' } },
};

function versionContext(params: Record<string, unknown>): { fixed_version_id: number } | undefined {
  return typeof params.fixed_version_id === 'number'
    ? { fixed_version_id: params.fixed_version_id }
    : undefined;
}

const ISSUE_PROPERTIES = {
  id: { type: 'number' },
  project: NAMED_REF,
  tracker: NAMED_REF,
  status: NAMED_REF,
  priority: NAMED_REF,
  author: NAMED_REF,
  assigned_to: { ...NAMED_REF, description: 'Absent when unassigned' },
  category: { ...NAMED_REF, description: 'Absent when none is set' },
  fixed_version: { ...NAMED_REF, description: 'Target version; absent when none is set' },
  parent: { type: 'object', properties: { id: { type: 'number' } } },
  subject: { type: 'string' },
  description: { type: 'string' },
  start_date: { type: ['string', 'null'] },
  due_date: { type: ['string', 'null'] },
  done_ratio: { type: 'number' },
  is_private: { type: 'boolean' },
  estimated_hours: { type: ['number', 'null'] },
  total_estimated_hours: { type: ['number', 'null'] },
  spent_hours: { type: 'number' },
  total_spent_hours: { type: 'number' },
  custom_fields: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
        value: { type: ['string', 'array', 'null'], description: 'An array for a multiple field' },
        multiple: { type: 'boolean' },
      },
    },
  },
  created_on: { type: 'string', description: 'ISO 8601 timestamp' },
  updated_on: { type: 'string', description: 'ISO 8601 timestamp' },
  closed_on: { type: ['string', 'null'] },
  journals: {
    type: 'array',
    description: 'Only with include: ["journals"]',
    items: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        user: NAMED_REF,
        notes: { type: 'string' },
        private_notes: { type: 'boolean' },
        details: { type: 'array', items: { type: 'object' } },
        created_on: { type: 'string' },
        updated_on: { type: 'string' },
      },
    },
  },
  attachments: { type: 'array', description: 'Only with include: ["attachments"]' },
  relations: { type: 'array', description: 'Only with include: ["relations"]' },
  children: { type: 'array', description: 'Only with include: ["children"]' },
  watchers: { type: 'array', description: 'Only with include: ["watchers"]' },
  changesets: { type: 'array', description: 'Only with include: ["changesets"]' },
  allowed_statuses: { type: 'array', description: 'Only with include: ["allowed_statuses"]' },
};

const WRITE_RESULT_SCHEMA = successResultSchema({
  ...ISSUE_PROPERTIES,
  ignored_fields: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Sent fields that the issue read back after the write does not hold (custom fields as custom_fields.<id>); empty when every sent field was applied. notes, private_notes and project_id cannot be verified this way',
  },
  message: { type: 'string', description: 'Present only when ignored_fields is not empty' },
});

const listIssueIdsTool: Tool = {
  name: 'listIssueIds',
  description:
    'List issue IDs with optional filters. Returns only IDs for efficiency. Omitting assigned_to returns issues for ALL users; pass assigned_to: "me" to scope to the current user. Omitting status returns open issues only; pass status: "*" to count closed ones too, e.g. for every issue in a target version or every subtask. start_date, due_date, done_ratio, is_private and watcher_id take a Redmine filter expression (e.g. due_date: "<=2026-11-30", done_ratio: "<=99"); cf maps a custom field ID to an expression.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.SELF_PARAM]: "assigned_to: 'me'",
  },
  keywords: ['redmine', 'issues', 'list', 'filter', 'tasks', 'bugs', 'ids'],
  example: `const { ids, total_count } = await redmine.listIssueIds({ status: "open", assigned_to: "me" })`,
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'open (default), closed, * (all), or a status name from getMappings',
      },
      assigned_to: { type: 'string', description: 'Assignee: me, user_id, or username' },
      ...issueFilterProperties(),
      limit: { type: 'number', description: 'Max results (default 25, max 100)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  outputSchema: ISSUE_IDS_OUTPUT_SCHEMA,
  inputExamples: [
    {
      description: 'Minimal: list all issues (with defaults)',
      input: {},
    },
    {
      description: 'Partial: my open issues',
      input: { status: 'open', assigned_to: 'me' },
    },
    {
      description: 'Partial: issues without a category (needs a project)',
      input: { project_id: 'my-project', category_id: '!*' },
    },
    {
      description: 'Full: project issues with subtasks',
      input: { project_id: 'my-project', status: 'open', assigned_to: 'me', limit: 50 },
    },
    {
      description: 'Filters: due by the end of the month, not finished, custom field 1 equals 2.4',
      input: {
        project_id: 'my-project',
        due_date: '<=2026-11-30',
        done_ratio: '<=99',
        cf: { '1': '2.4' },
      },
    },
    {
      description: 'Filters: started in November, watched by me',
      input: { project_id: 'my-project', start_date: '><2026-11-01|2026-11-30', watcher_id: 'me' },
    },
  ],
};

const getIssueFullTool: Tool = {
  name: 'getIssueFull',
  description: 'Get complete issue data including custom_fields, relations. No truncation.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['redmine', 'issue', 'show', 'get', 'detail', 'single', 'full'],
  example: `const issue = await redmine.getIssueFull({ issue_id: 12345, include: ["journals", "attachments"] })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: {
        type: 'number',
        description: 'Issue ID — obtained from listIssueIds or searchIssueIds',
      },
      include: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'journals',
            'attachments',
            'relations',
            'children',
            'watchers',
            'changesets',
            'allowed_statuses',
          ],
        },
        description:
          'Additional data to include. journals: comments, each with private_notes, details (field changes), created_on and updated_on. watchers: users watching the issue, set with watcher_user_ids on createIssue. attachments: files, for downloadAttachment. relations: links to other issues. children: subtasks. changesets: linked repository revisions. allowed_statuses: statuses the current user may set.',
      },
    },
    required: ['issue_id'],
  },
  outputSchema: successResultSchema(ISSUE_PROPERTIES),
  inputExamples: [
    {
      description: 'Minimal: get basic issue details',
      input: { issue_id: 12345 },
    },
    {
      description: 'Full: get issue with journals, attachments and relations',
      input: { issue_id: 12345, include: ['journals', 'attachments', 'relations'] },
    },
  ],
};

const searchIssueIdsTool: Tool = {
  name: 'searchIssueIds',
  description: 'Search issues by text query. Returns matching IDs only.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'issue', 'search', 'find', 'query', 'ids'],
  example: `const { ids, total_count } = await redmine.searchIssueIds({ query: "authentication error", project_id: "my-project" })`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      project_id: { type: 'string', description: 'Limit to project' },
      limit: { type: 'number', description: 'Max results (default 25)' },
    },
    required: ['query'],
  },
  outputSchema: ISSUE_IDS_OUTPUT_SCHEMA,
  inputExamples: [
    {
      description: 'Minimal: search all projects',
      input: { query: 'authentication error' },
    },
    {
      description: 'Partial: search in project',
      input: { query: 'login fails', project_id: 'my-project' },
    },
    {
      description: 'Full: search with limit',
      input: { query: 'priority:high author:john', project_id: 'my-project', limit: 50 },
    },
  ],
};

const createIssueTool: Tool = {
  name: 'createIssue',
  description: `Create a new Redmine issue. tracker/priority/status names must match this project's configured mappings (see getMappings); an unrecognized name throws an error listing valid values. Omitted fields keep Redmine's defaults; null clears a field whose description says so, '' is rejected, and a rejected call sends nothing. file_paths attaches 1 to ${MAX_WORKSPACE_FILES} files from /workspace; a path outside /workspace is rejected before anything is created. Returns the whole issue as Redmine holds it after the write plus ignored_fields, the sent fields Redmine did not apply (no permission, a field disabled for the tracker, or a value derived from status or subtasks); project_id cannot be verified.`,
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.TIMEOUT_CLASS]: 'long',
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.SELF_PARAM]: "assigned_to: 'me'",
  },
  keywords: ['redmine', 'issue', 'create', 'new', 'task', 'bug', 'add'],
  example: `const issue = await redmine.createIssue({ subject: "Fix bug", project_id: "my-project", tracker: "bug" })`,
  inputSchema: {
    type: 'object',
    properties: {
      ...issueInputProperties('create'),
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_WORKSPACE_FILES,
        description:
          'Paths under /workspace of files to attach, e.g. ["/workspace/screenshot.png"]',
      },
    },
    required: issueRequiredOnCreate(),
  },
  outputSchema: WRITE_RESULT_SCHEMA,
  inputExamples: [
    {
      description: 'Minimal: create with required fields only',
      input: { subject: 'Fix login bug', project_id: 'my-project' },
    },
    {
      description: 'Partial: bug with priority',
      input: {
        subject: 'Users cannot reset password',
        project_id: 'my-project',
        tracker: 'bug',
        priority: 'high',
        assigned_to: 'me',
      },
    },
    {
      description: 'Partial: bug with a screenshot attached',
      input: {
        subject: 'Layout broken on mobile',
        project_id: 'my-project',
        tracker: 'bug',
        file_paths: ['/workspace/screenshot.png'],
      },
    },
    {
      description: 'Planning fields: dates, progress, custom field, watcher',
      input: {
        subject: 'Prepare the migration',
        project_id: 'my-project',
        start_date: '2026-11-24',
        due_date: '2026-12-01',
        done_ratio: 20,
        custom_fields: [{ id: 1, value: '2.4' }],
        watcher_user_ids: [1739],
        is_private: false,
      },
    },
    {
      description: 'Full: create subtask with all fields',
      input: {
        subject: 'Implement JWT validation',
        project_id: 'my-project',
        description:
          'h2. Context\n\nToken expiry not validated.\n\nh2. Acceptance Criteria\n\n* Validate token on each request',
        tracker: 'task',
        priority: 'normal',
        assigned_to: 'jane.doe',
        parent_issue_id: 12345,
      },
    },
  ],
};

const updateIssueTool: Tool = {
  name: 'updateIssue',
  description:
    "Update an existing Redmine issue. tracker/priority/status names must match this project's configured mappings (see getMappings); an unrecognized name throws an error listing valid values. Omitted fields stay unchanged; null clears a field whose description says so, '' is rejected, and a rejected call sends nothing. Returns the whole issue as Redmine holds it after the update plus ignored_fields, the sent fields Redmine did not apply (no permission, a field disabled for the tracker, or a value derived from status or subtasks); notes, private_notes and project_id cannot be verified.",
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.SELF_PARAM]: "assigned_to: 'me'",
  },
  keywords: ['redmine', 'issue', 'update', 'modify', 'change', 'edit', 'move', 'project'],
  example: `const updated = await redmine.updateIssue({ issue_id: 12345, done_ratio: 50, due_date: null });
if (updated.ignored_fields.length > 0) {
  throw new Error(updated.message);
}`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: {
        type: 'number',
        description: 'Issue ID to update, obtained from listIssueIds or searchIssueIds',
      },
      ...issueInputProperties('update'),
    },
    required: ['issue_id'],
  },
  outputSchema: WRITE_RESULT_SCHEMA,
  inputExamples: [
    {
      description: 'Minimal: close issue',
      input: { issue_id: 12345, status: 'closed' },
    },
    {
      description: 'Partial: reassign with note',
      input: {
        issue_id: 12345,
        assigned_to_id: 42,
        notes: 'Reassigning for code review',
      },
    },
    {
      description: 'Partial: plan into a target version (id from listVersions)',
      input: { issue_id: 12345, fixed_version_id: 87 },
    },
    {
      description: 'Plan: set the due date and progress, clear the target version',
      input: { issue_id: 12345, due_date: '2026-12-01', done_ratio: 50, fixed_version_id: null },
    },
    {
      description: 'Private note',
      input: { issue_id: 12345, notes: 'Only for the team', private_notes: true },
    },
    {
      description: 'Full: update multiple fields',
      input: {
        issue_id: 12345,
        subject: 'Updated title',
        status: 'in_progress',
        assigned_to_id: 42,
        notes: 'Starting work on this issue',
      },
    },
  ],
};

const commentIssueTool: Tool = {
  name: 'commentIssue',
  description: 'Add a comment to an issue',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'issue', 'comment', 'note', 'add'],
  example: `await redmine.commentIssue({ issue_id: 12345, notes: "Work in progress" })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      notes: { type: 'string', description: 'Comment text' },
    },
    required: ['issue_id', 'notes'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      journal_id: { type: 'number', description: 'ID of created journal entry' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Simple comment',
      input: { issue_id: 12345, notes: 'Work in progress' },
    },
    {
      description: 'Detailed comment with Textile',
      input: {
        issue_id: 12345,
        notes: 'h3. Update\n\n* Completed code review\n* Tests passing\n* Ready for merge',
      },
    },
  ],
};

/**
 * Tool handler function.
 * @param client - Redmine client instance
 */
export function createIssueTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
  if (!client) {
    return [
      { tool: listIssueIdsTool, handler: unconfigured },
      { tool: getIssueFullTool, handler: unconfigured },
      { tool: searchIssueIdsTool, handler: unconfigured },
      { tool: createIssueTool, handler: unconfigured },
      { tool: updateIssueTool, handler: unconfigured },
      { tool: commentIssueTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listIssueIdsTool,
      handler: async (params) => {
        const p = params as Record<string, unknown>;
        const filterProblem = issueFilterProblem(p);
        if (filterProblem) return rejected(listIssueIdsTool.name, filterProblem);
        const listIds = () =>
          withRedmineErrors(undefined, async () => {
            const specialStatuses = ['open', 'closed', '*'];
            const statusValue = p.status as string | undefined;
            let resolved: Record<string, unknown>;
            if (statusValue && specialStatuses.includes(statusValue)) {
              resolved = { ...p, status_id: statusValue };
              delete resolved.status;
            } else {
              resolved = resolveParams(p, client.getMappings());
            }
            const assignError = await resolveAssignedTo(client, resolved);
            if (assignError) return assignError;
            const result = await client.listIssues(
              resolved as Parameters<typeof client.listIssues>[0]
            );
            return jsonResult({
              ids: result.issues.map((i: { id: number }) => i.id),
              total_count: result.total_count,
            });
          });
        return p.category_id
          ? withTargetProject(
              client,
              p.project_id as string | undefined,
              listIds,
              CATEGORY_NEEDS_PROJECT
            )
          : listIds();
      },
    },
    {
      tool: getIssueFullTool,
      handler: async (params) => {
        const { issue_id, include = [] } = params as { issue_id: number; include?: string[] };
        return withRedmineErrors({ issue_id }, async () => {
          const result = await client.showIssue(issue_id, { include });
          return jsonResult(result);
        });
      },
    },
    {
      tool: searchIssueIdsTool,
      handler: async (params) =>
        withRedmineErrors(undefined, async () => {
          const { query, project_id, limit } = params as {
            query: string;
            project_id?: string;
            limit?: number;
          };
          const result = await client.searchIssues(query, { project_id, limit });
          return jsonResult({
            ids: result.results.map((i: { id: number }) => i.id),
            total_count: result.total_count,
          });
        }),
    },
    {
      tool: createIssueTool,
      handler: async (params) =>
        withRedmineErrors(versionContext(params), async () => {
          const { file_paths, ...fields } = params as Record<string, unknown>;
          const checked = buildIssuePayload(fields, 'create');
          if (!checked.ok) return rejected(createIssueTool.name, checked);
          const attachments =
            file_paths === undefined
              ? { files: undefined }
              : await resolveAttachmentFiles(file_paths);
          if ('error' in attachments) return attachments.error;
          const resolved = resolveParams(fields, client.getMappings());
          const assignError = await resolveAssignedTo(client, resolved);
          if (assignError) return assignError;
          const payload = { ...checked.payload, ...resolvedAliasIds(resolved) };
          const issue = await client.createIssue(payload, attachments.files);
          return writeResult(issue, payload);
        }),
    },
    {
      tool: updateIssueTool,
      handler: async (params) => {
        const { issue_id, ...fields } = params as { issue_id: number } & Record<string, unknown>;
        return withRedmineErrors({ issue_id, ...versionContext(params) }, async () => {
          const checked = buildIssuePayload(fields, 'update');
          if (!checked.ok) return rejected(updateIssueTool.name, checked);
          const resolved = resolveParams(fields, client.getMappings());
          const assignError = await resolveAssignedTo(client, resolved);
          if (assignError) return assignError;
          const payload = { ...checked.payload, ...resolvedAliasIds(resolved) };
          const issue = await client.updateIssue(issue_id, payload);
          return writeResult(issue, payload);
        });
      },
    },
    {
      tool: commentIssueTool,
      handler: async (params) => {
        const { issue_id, notes } = params as { issue_id: number; notes: string };
        return withRedmineErrors({ issue_id }, async () => {
          await client.commentIssue(issue_id, notes);
          return jsonResult({ ok: true });
        });
      },
    },
  ];
}

function rejected(
  toolName: string,
  { paramName, problem }: { paramName: string; problem: string }
): ReturnType<typeof teachingErrorResult> {
  return teachingErrorResult({
    paramName,
    nextStep: `${problem} ${toolName} rejected the call and sent nothing to Redmine.`,
  });
}

function writeResult(issue: object, payload: Record<string, unknown>) {
  const ignored = ignoredFields(payload, issue);
  const customFields = ignored.filter((name) => name.startsWith('custom_fields.'));
  const others = ignored.filter((name) => !customFields.includes(name));
  const reasons = [
    others.length > 0 &&
      `Redmine did not apply ${others.join(', ')}: no permission, the field is disabled for the tracker, or it is derived from status or subtasks.`,
    customFields.length > 0 &&
      `Redmine did not apply ${customFields.join(', ')}: the custom field is not enabled for this project or tracker, or the user may not edit it.`,
  ].filter(Boolean);
  return jsonResult({
    ...issue,
    ignored_fields: ignored,
    ...(reasons.length > 0 && { message: reasons.join(' ') }),
  });
}

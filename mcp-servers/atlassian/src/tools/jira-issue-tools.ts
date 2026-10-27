/**
 * Jira issue tools: search/CRUD, parent, components, links, transitions, assignment, current account, attachments (14).
 * @module mcp-atlassian/tools/jira-issue-tools
 */

import axios from 'axios';
import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  teachingErrorResult,
  readWorkspaceFile,
  withDeclaredParams,
  META_KEYS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createJiraIssuesClient, UnknownLinkRelationError } from '../domains/jira-issues.js';
import { createJiraProjectsClient } from '../domains/jira-projects.js';
import type { AdfDoc } from '../types.js';
import { withValidation } from './validation.js';
import { resolveRichText } from './rich-text.js';

interface WriteContext {
  outcome: string;
  issueTypeLookup: string;
}

interface JiraRejection {
  fields: Record<string, string>;
  messages: string[];
}

const ACCOUNT_ID_RESOLUTION_GUIDANCE =
  'Pass an account ID, "me" for the account this worker authenticates as (see getMyself), or reuse an assignee/reporter account_id from a prior getIssue/searchIssues result. Do not guess an account ID.';

const MAX_ATTACHMENT_BYTES = (() => {
  const raw = process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES;
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 25 * 1024 * 1024;
})();

const USER_SCOPED_META = {
  [META_KEYS.USER_SCOPED]: true,
  [META_KEYS.CURRENT_USER_TOOL]: 'getMyself',
};

const userSchema = {
  type: ['object', 'null'],
  properties: { account_id: { type: 'string' }, name: { type: 'string' } },
};

const issueRefProperties = {
  key: { type: 'string' },
  summary: { type: 'string' },
  status: { type: 'string' },
};

const searchIssueProperties = {
  key: { type: 'string' },
  id: { type: 'string' },
  web_url: { type: 'string' },
  summary: { type: 'string' },
  type: { type: 'string' },
  status: { type: 'string' },
  project: { type: 'string' },
  priority: { type: ['string', 'null'] },
  labels: { type: 'array', items: { type: 'string' } },
  components: { type: 'array', items: { type: 'string' } },
  parent: {
    type: ['object', 'null'],
    properties: { ...issueRefProperties, type: { type: 'string' } },
  },
  links: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        relation: { type: 'string' },
        issue: { type: 'object', properties: issueRefProperties },
      },
    },
  },
  assignee: userSchema,
  reporter: userSchema,
  created: { type: 'string' },
  updated: { type: 'string' },
};

const issueProperties = {
  ...searchIssueProperties,
  description: { type: 'string', description: 'Markdown' },
};

const errorProperties = { success: { type: 'boolean' }, error: { type: 'string' } };

const issueOutputSchema = {
  type: 'object',
  properties: {
    ...errorProperties,
    issue: { type: 'object', properties: issueProperties },
  },
  required: ['success'],
};

const flagOutputSchema = (flag: string) => ({
  type: 'object',
  properties: { ...errorProperties, [flag]: { type: 'boolean' } },
  required: ['success'],
});

const issueParam = (extra = '') => ({
  type: 'string',
  description: `Issue key (e.g. PROJ-123) or numeric ID.${extra}`,
});

const descriptionProperties = {
  description: {
    type: 'string',
    description:
      'Markdown description (headings, lists, code, links, tables). Send either description or description_adf, not both.',
  },
  description_adf: {
    type: 'object',
    description:
      'Raw Atlassian Document Format document for content Markdown cannot express (mentions, panels). Send either description or description_adf, not both.',
  },
};

const assigneeDescription = `Account ID, "me" or null to unassign. ${ACCOUNT_ID_RESOLUTION_GUIDANCE}`;

const searchIssuesTool: Tool = {
  name: 'searchIssues',
  description:
    'Search Jira issues with JQL (enhanced search, paginated by next_page_token). Results carry parent, components and links but no description; use getIssue for the description. For "my"/"assigned to me" queries use `assignee = currentUser()` directly in the JQL. If a project allowlist is configured, matches outside it are silently removed from the returned issues, and next_page_token/is_last still reflect the unfiltered upstream page (so a page that looks "last" may still be hiding excluded items).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false, ...USER_SCOPED_META },
  keywords: ['jira', 'issues', 'search', 'jql', 'query', 'tickets', 'find'],
  example:
    'const { issues, next_page_token } = await atlassian.searchIssues({ jql: "project = PROJ AND status = \\"To Do\\" ORDER BY created DESC", max_results: 20 })',
  inputSchema: {
    type: 'object',
    properties: {
      jql: { type: 'string', description: 'JQL query string' },
      max_results: { type: 'number', description: 'Max issues per page (default 50, max 100)' },
      next_page_token: { type: 'string', description: 'Opaque cursor from a previous page' },
    },
    required: ['jql'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ...errorProperties,
      issues: { type: 'array', items: { type: 'object', properties: searchIssueProperties } },
      next_page_token: { type: ['string', 'null'] },
      is_last: { type: 'boolean' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Minimal: most recent issues', input: { jql: 'ORDER BY created DESC' } },
    {
      description: 'Partial: open issues in a project',
      input: { jql: 'project = PROJ AND statusCategory != Done' },
    },
    {
      description: 'Full: paginated search',
      input: { jql: 'assignee = currentUser()', max_results: 25, next_page_token: 'CAEaAggD' },
    },
  ],
};

const getIssueTool: Tool = {
  name: 'getIssue',
  description:
    'Get a single Jira issue by key or ID, with its Markdown description, parent, components and links (each link has an id for unlinkIssues).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['jira', 'issue', 'get', 'show', 'ticket', 'detail'],
  example: 'const { issue } = await atlassian.getIssue({ issue: "PROJ-123" })',
  inputSchema: {
    type: 'object',
    properties: { issue: issueParam() },
    required: ['issue'],
  },
  outputSchema: issueOutputSchema,
  inputExamples: [
    { description: 'By key', input: { issue: 'PROJ-123' } },
    { description: 'By numeric ID', input: { issue: '10042' } },
  ],
};

const createIssueTool: Tool = {
  name: 'createIssue',
  description:
    'Create a Jira issue. Sub-task types require `parent`. `components` are names; list them with listComponents. Returns the created issue.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true, ...USER_SCOPED_META },
  keywords: ['jira', 'issue', 'create', 'new', 'ticket', 'open', 'subtask', 'parent'],
  example:
    'const { issue } = await atlassian.createIssue({ project: "PROJ", type: "Bug", summary: "Fix login", description: "Steps to reproduce..." })',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Target project key' },
      type: { type: 'string', description: 'Issue type name (e.g. Task, Bug, Story, Sub-task)' },
      summary: { type: 'string', description: 'Issue summary' },
      ...descriptionProperties,
      priority: { type: 'string', description: 'Priority name (e.g. High)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
      assignee: { type: 'string', description: assigneeDescription },
      parent: {
        type: 'string',
        description: 'Parent issue key or ID (required for Sub-task, optional under an epic)',
      },
      components: {
        type: 'array',
        items: { type: 'string' },
        description: 'Component names (see listComponents)',
      },
    },
    required: ['project', 'type', 'summary'],
  },
  outputSchema: issueOutputSchema,
  inputExamples: [
    { description: 'Minimal', input: { project: 'PROJ', type: 'Task', summary: 'Task title' } },
    {
      description: 'Partial: Markdown description and labels',
      input: {
        project: 'PROJ',
        type: 'Bug',
        summary: 'Bug',
        description: 'Repro:\n1. ...',
        labels: ['triage'],
      },
    },
    {
      description: 'Sub-task with parent and components',
      input: {
        project: 'PROJ',
        type: 'Sub-task',
        summary: 'Write tests',
        parent: 'PROJ-10',
        components: ['core'],
        assignee: 'me',
      },
    },
  ],
};

const updateIssueTool: Tool = {
  name: 'updateIssue',
  description:
    'Update fields of a Jira issue; omitted fields stay unchanged. `parent: null` detaches the parent, `components` replaces the whole list (empty clears), `type` changes the issue type (Jira may refuse some changes, see listIssueTypes with `issue`). Returns the updated issue.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true, ...USER_SCOPED_META },
  keywords: ['jira', 'issue', 'update', 'edit', 'change', 'modify', 'ticket', 'parent', 'type'],
  example: 'await atlassian.updateIssue({ issue: "PROJ-123", summary: "New title", parent: null })',
  inputSchema: {
    type: 'object',
    properties: {
      issue: issueParam(' An allowlist requires a key, not a numeric ID.'),
      type: { type: 'string', description: 'New issue type name' },
      summary: { type: 'string', description: 'New summary' },
      ...descriptionProperties,
      priority: { type: 'string', description: 'New priority name' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Replacement label set' },
      assignee: { type: ['string', 'null'], description: assigneeDescription },
      parent: {
        type: ['string', 'null'],
        description: 'New parent issue key or ID, or null to detach',
      },
      components: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replacement component names (empty array clears; see listComponents)',
      },
    },
    required: ['issue'],
  },
  outputSchema: issueOutputSchema,
  inputExamples: [
    { description: 'Rename', input: { issue: 'PROJ-123', summary: 'Renamed' } },
    { description: 'Detach from the parent', input: { issue: 'PROJ-123', parent: null } },
    {
      description: 'Full',
      input: {
        issue: 'PROJ-123',
        type: 'Story',
        summary: 'X',
        description: 'Y',
        priority: 'High',
        labels: ['a', 'b'],
        components: ['core'],
        parent: 'PROJ-10',
        assignee: 'me',
      },
    },
  ],
};

const deleteIssueTool: Tool = {
  name: 'deleteIssue',
  description:
    'Delete a Jira issue (irreversible). Jira refuses an issue that still has sub-tasks: delete or move the sub-tasks first.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'issue', 'delete', 'remove', 'ticket'],
  example: 'await atlassian.deleteIssue({ issue: "PROJ-123" })',
  inputSchema: {
    type: 'object',
    properties: { issue: issueParam(' An allowlist requires a key, not a numeric ID.') },
    required: ['issue'],
  },
  outputSchema: flagOutputSchema('deleted'),
  inputExamples: [{ description: 'Delete an issue', input: { issue: 'PROJ-123' } }],
};

const linkIssuesTool: Tool = {
  name: 'linkIssues',
  description:
    'Link two issues. `relation` reads from the side of `issue`: ("PROJ-1", "blocks", "PROJ-2") means PROJ-1 blocks PROJ-2; "is blocked by" reverses it. Valid relations come from listLinkTypes.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'link', 'relation', 'blocks', 'relates', 'duplicate', 'depends'],
  example: 'await atlassian.linkIssues({ issue: "PROJ-1", relation: "blocks", target: "PROJ-2" })',
  inputSchema: {
    type: 'object',
    properties: {
      issue: issueParam(' The side the relation reads from.'),
      relation: {
        type: 'string',
        description: 'Relation text such as "blocks" or "is blocked by" (see listLinkTypes)',
      },
      target: issueParam(' The other end of the link.'),
    },
    required: ['issue', 'relation', 'target'],
  },
  outputSchema: flagOutputSchema('linked'),
  inputExamples: [
    {
      description: 'PROJ-1 blocks PROJ-2',
      input: { issue: 'PROJ-1', relation: 'blocks', target: 'PROJ-2' },
    },
  ],
};

const unlinkIssuesTool: Tool = {
  name: 'unlinkIssues',
  description:
    'Remove an issue link by its link ID (the `links[].id` of getIssue or searchIssues).',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'unlink', 'link', 'relation', 'remove'],
  example: 'await atlassian.unlinkIssues({ link_id: "10001" })',
  inputSchema: {
    type: 'object',
    properties: {
      link_id: { type: 'string', description: 'Link ID from `links[].id` of an issue' },
    },
    required: ['link_id'],
  },
  outputSchema: flagOutputSchema('unlinked'),
  inputExamples: [{ description: 'Remove a link', input: { link_id: '10001' } }],
};

const listLinkTypesTool: Tool = {
  name: 'listLinkTypes',
  description:
    'List the issue link types with their inward and outward relation texts; either text is a valid `relation` for linkIssues.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'link', 'types', 'relations', 'blocks'],
  example: 'const { link_types } = await atlassian.listLinkTypes({})',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: {
    type: 'object',
    properties: {
      ...errorProperties,
      link_types: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            inward: { type: 'string' },
            outward: { type: 'string' },
          },
        },
      },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'List link types', input: {} }],
};

const getTransitionsTool: Tool = {
  name: 'getTransitions',
  description: 'List the workflow transitions currently available for an issue.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'transitions', 'workflow', 'status', 'list'],
  example: 'const { transitions } = await atlassian.getTransitions({ issue: "PROJ-123" })',
  inputSchema: { type: 'object', properties: { issue: issueParam() }, required: ['issue'] },
  outputSchema: {
    type: 'object',
    properties: {
      ...errorProperties,
      transitions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            to_status: { type: 'string' },
          },
        },
      },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'List transitions', input: { issue: 'PROJ-123' } }],
};

const transitionIssueTool: Tool = {
  name: 'transitionIssue',
  description: 'Move an issue through a workflow transition by transition ID (see getTransitions).',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'transition', 'workflow', 'status', 'move', 'close', 'resolve'],
  example: 'await atlassian.transitionIssue({ issue: "PROJ-123", transition_id: "31" })',
  inputSchema: {
    type: 'object',
    properties: {
      issue: issueParam(),
      transition_id: { type: 'string', description: 'Transition ID from getTransitions' },
    },
    required: ['issue', 'transition_id'],
  },
  outputSchema: flagOutputSchema('transitioned'),
  inputExamples: [
    { description: 'Apply a transition', input: { issue: 'PROJ-123', transition_id: '31' } },
  ],
};

const assignIssueTool: Tool = {
  name: 'assignIssue',
  description: `Assign an issue to an account, or unassign it (omit assignee or pass null). ${ACCOUNT_ID_RESOLUTION_GUIDANCE}`,
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true, ...USER_SCOPED_META },
  keywords: ['jira', 'assign', 'assignee', 'unassign', 'owner'],
  example: 'await atlassian.assignIssue({ issue: "PROJ-123", assignee: "me" })',
  inputSchema: {
    type: 'object',
    properties: {
      issue: issueParam(),
      assignee: { type: ['string', 'null'], description: assigneeDescription },
    },
    required: ['issue'],
  },
  outputSchema: flagOutputSchema('assigned'),
  inputExamples: [
    { description: 'Assign to me', input: { issue: 'PROJ-123', assignee: 'me' } },
    { description: 'Unassign', input: { issue: 'PROJ-123' } },
  ],
};

const getMyselfTool: Tool = {
  name: 'getMyself',
  description: 'Get the Atlassian account this worker authenticates as.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'me', 'myself', 'current user', 'account', 'whoami'],
  example: 'const { user } = await atlassian.getMyself({})',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: {
    type: 'object',
    properties: { ...errorProperties, user: userSchema },
    required: ['success'],
  },
  inputExamples: [{ description: 'Who am I', input: {} }],
};

const addAttachmentTool: Tool = {
  name: 'addAttachment',
  description: `Attach a file to a Jira issue. The worker reads \`file_path\` (a path under /workspace) fully into memory before uploading, so it is capped at ${MAX_ATTACHMENT_BYTES} bytes regardless of Jira's own attachment-size limit.`,
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'attachment', 'attach', 'upload', 'file', 'screenshot', 'image', 'załącznik'],
  example: 'await atlassian.addAttachment({ issue: "PROJ-123", file_path: "/workspace/bug.png" })',
  inputSchema: {
    type: 'object',
    properties: {
      issue: issueParam(),
      file_path: {
        type: 'string',
        description: `Path under /workspace to read (e.g. /workspace/bug.png), max ${MAX_ATTACHMENT_BYTES} bytes`,
      },
      filename: {
        type: 'string',
        description: 'Attachment file name; defaults to the basename of file_path',
      },
      content_type: { type: 'string', description: 'MIME type (default application/octet-stream)' },
    },
    required: ['issue', 'file_path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ...errorProperties,
      attachment: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          filename: { type: 'string' },
          size: { type: 'number' },
          mime_type: { type: 'string' },
          created: { type: 'string' },
          url: { type: 'string' },
          author: userSchema,
        },
      },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'From a workspace file',
      input: { issue: 'PROJ-123', file_path: '/workspace/bug.png' },
    },
    {
      description: 'With an explicit filename and MIME type',
      input: {
        issue: 'PROJ-123',
        file_path: '/workspace/.speedwave/shot.png',
        filename: 'bug.png',
        content_type: 'image/png',
      },
    },
  ],
};

const deleteAttachmentTool: Tool = {
  name: 'deleteAttachment',
  description: 'Delete a Jira attachment by its attachment ID (irreversible).',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'attachment', 'delete', 'remove', 'załącznik', 'usuń'],
  example: 'await atlassian.deleteAttachment({ attachment_id: "10475" })',
  inputSchema: {
    type: 'object',
    properties: {
      attachment_id: { type: 'string', description: 'Attachment ID (e.g. 10475)' },
    },
    required: ['attachment_id'],
  },
  outputSchema: flagOutputSchema('deleted'),
  inputExamples: [{ description: 'Delete an attachment', input: { attachment_id: '10475' } }],
};

/**
 * Build the Jira issue tool definitions; every handler rejects undeclared and missing required arguments.
 * @param client - The Atlassian client (`null` when the service is not configured).
 */
export function createJiraIssueTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [
    searchIssuesTool,
    getIssueTool,
    createIssueTool,
    updateIssueTool,
    deleteIssueTool,
    linkIssuesTool,
    unlinkIssuesTool,
    listLinkTypesTool,
    getTransitionsTool,
    transitionIssueTool,
    assignIssueTool,
    getMyselfTool,
    addAttachmentTool,
    deleteAttachmentTool,
  ];
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: withDeclaredParams(tool, unconfigured) }));
  }
  const issues = createJiraIssuesClient(client);
  const projects = createJiraProjectsClient(client);

  const componentRejection = async (
    project: string,
    components: string[] | undefined,
    outcome: string
  ) => {
    if (!components?.length) return undefined;
    const known = (await projects.listComponents(project)).map((c) => c.name);
    if (components.every((name) => known.includes(name))) return undefined;
    return teachingErrorResult({
      paramName: 'components',
      correctValueTool: 'listComponents',
      nextStep: `Project ${project} has no component with one of these names, so ${outcome}; Jira would otherwise create it in the project. Available components: ${known.join(', ') || 'none'}. Retry with names from that list.`,
    });
  };

  const isSubtaskType = async (project: string, type: string) =>
    (await projects.listIssueTypes(project)).some((t) => t.subtask && t.name === type);

  const handlers: Record<string, ToolDefinition['handler']> = {
    searchIssues: withValidation(client, async (_c, params) => {
      const { jql, max_results, next_page_token } = params as {
        jql: string;
        max_results?: number;
        next_page_token?: string;
      };
      return jsonResult(
        await issues.search({ jql, maxResults: max_results, nextPageToken: next_page_token })
      );
    }),

    getIssue: withValidation(client, async (_c, params) => {
      const { issue } = params as { issue: string };
      return jsonResult({ issue: await issues.get(issue) });
    }),

    createIssue: withValidation(client, async (_c, params) => {
      const p = params as {
        project: string;
        type: string;
        summary: string;
        description?: string;
        description_adf?: AdfDoc;
        priority?: string;
        labels?: string[];
        assignee?: string;
        parent?: string;
        components?: string[];
      };
      const description = resolveRichText(
        'description',
        p.description,
        'description_adf',
        p.description_adf
      );
      if ('error' in description) return description.error;
      const outcome = 'nothing was created';
      const unknownComponent = await componentRejection(p.project, p.components, outcome);
      if (unknownComponent) return unknownComponent;
      try {
        return jsonResult({ issue: await issues.create(p) });
      } catch (error) {
        const typeRefusal = jiraRejection(error)?.fields.issuetype;
        if (
          typeRefusal !== undefined &&
          p.parent === undefined &&
          (await isSubtaskType(p.project, p.type))
        ) {
          return parentRejection(outcome, typeRefusal);
        }
        return translateWriteRejection(error, {
          outcome,
          issueTypeLookup: `listIssueTypes with project "${p.project}"`,
        });
      }
    }),

    updateIssue: withValidation(client, async (_c, params) => {
      const { issue, ...fields } = params as {
        issue: string;
        type?: string;
        summary?: string;
        description?: string;
        description_adf?: AdfDoc;
        priority?: string;
        labels?: string[];
        assignee?: string | null;
        parent?: string | null;
        components?: string[];
      };
      const description = resolveRichText(
        'description',
        fields.description,
        'description_adf',
        fields.description_adf
      );
      if ('error' in description) return description.error;
      const outcome = 'nothing was changed';
      if (fields.components?.length) {
        const { project } = await issues.get(issue);
        const unknownComponent = await componentRejection(project, fields.components, outcome);
        if (unknownComponent) return unknownComponent;
      }
      try {
        return jsonResult({ issue: await issues.update(issue, fields) });
      } catch (error) {
        return translateWriteRejection(error, {
          outcome,
          issueTypeLookup: `listIssueTypes with issue "${issue}"`,
        });
      }
    }),

    deleteIssue: withValidation(client, async (_c, params) => {
      const { issue } = params as { issue: string };
      try {
        await issues.delete(issue);
      } catch (error) {
        const rejection = jiraRejection(error);
        if (rejection?.messages.some((m) => /sub-?task/i.test(m))) {
          return teachingErrorResult({
            paramName: 'issue',
            nextStep: `${issue} still has sub-tasks, so Jira refused the delete and nothing was removed. Delete the sub-tasks first, or move them to another parent with updateIssue and parent, then retry.`,
          });
        }
        throw error;
      }
      return jsonResult({ deleted: true });
    }),

    linkIssues: withValidation(client, async (_c, params) => {
      const { issue, relation, target } = params as {
        issue: string;
        relation: string;
        target: string;
      };
      try {
        await issues.linkIssues(issue, relation, target);
      } catch (error) {
        if (error instanceof UnknownLinkRelationError) {
          return teachingErrorResult({
            paramName: 'relation',
            correctValueTool: 'listLinkTypes',
            nextStep: `This site has no link relation with that text, so no link was created. Available relations: ${error.available.join(', ')}. Retry with one of them.`,
          });
        }
        throw error;
      }
      return jsonResult({ linked: true });
    }),

    unlinkIssues: withValidation(client, async (_c, params) => {
      const { link_id } = params as { link_id: string };
      await issues.unlinkIssues(link_id);
      return jsonResult({ unlinked: true });
    }),

    listLinkTypes: withValidation(client, async () =>
      jsonResult({ link_types: await issues.listLinkTypes() })
    ),

    getTransitions: withValidation(client, async (_c, params) => {
      const { issue } = params as { issue: string };
      return jsonResult({ transitions: await issues.getTransitions(issue) });
    }),

    transitionIssue: withValidation(client, async (_c, params) => {
      const { issue, transition_id } = params as { issue: string; transition_id: string };
      await issues.transition(issue, transition_id);
      return jsonResult({ transitioned: true });
    }),

    assignIssue: withValidation(client, async (_c, params) => {
      const { issue, assignee } = params as { issue: string; assignee?: string | null };
      await issues.assign(issue, assignee ?? null);
      return jsonResult({ assigned: true });
    }),

    getMyself: withValidation(client, async () => jsonResult({ user: await issues.getMyself() })),

    addAttachment: withValidation(client, async (_c, params) => {
      const { issue, filename, file_path, content_type } = params as {
        issue: string;
        filename?: string;
        file_path: string;
        content_type?: string;
      };
      const file = await readWorkspaceFile(file_path, MAX_ATTACHMENT_BYTES);
      return jsonResult({
        attachment: await issues.addAttachment(issue, {
          filename: filename || file.name,
          data: file.buffer,
          contentType: content_type || 'application/octet-stream',
        }),
      });
    }),

    deleteAttachment: withValidation(client, async (_c, params) => {
      const { attachment_id } = params as { attachment_id: string };
      await issues.deleteAttachment(attachment_id);
      return jsonResult({ deleted: true });
    }),
  };

  return tools.map((tool) => ({ tool, handler: withDeclaredParams(tool, handlers[tool.name]) }));
}

function translateWriteRejection(error: unknown, context: WriteContext) {
  const rejection = jiraRejection(error);
  if (!rejection) throw error;
  const { fields, messages } = rejection;
  const { outcome } = context;

  if (fields.issuetype !== undefined) {
    return teachingErrorResult({
      paramName: 'type',
      correctValueTool: 'listIssueTypes',
      nextStep: `Jira refused this issue type, so ${outcome}. Call ${context.issueTypeLookup} for the types allowed here; some type changes (for example between a standard type and a Sub-task) cannot be done through the API.${withJiraMessage(fields.issuetype)}`,
    });
  }
  const parentMessage = fields.parent ?? messages.find(isParentMessage);
  if (fields.parent !== undefined || parentMessage !== undefined) {
    return parentRejection(outcome, parentMessage);
  }
  throw error;
}

function parentRejection(outcome: string, jiraMessage: string | undefined) {
  return teachingErrorResult({
    paramName: 'parent',
    nextStep: `Jira rejected the parent, so ${outcome}. A Sub-task type needs parent set to the key of an existing issue; other types accept only a parent one level above them (for example an epic for a story).${withJiraMessage(jiraMessage)}`,
  });
}

function withJiraMessage(text: string | undefined): string {
  return text ? ` Jira said: ${text}` : '';
}

function isParentMessage(message: string): boolean {
  return (
    /must have a parent/i.test(message) || (/parent/i.test(message) && /sub-?task/i.test(message))
  );
}

function jiraRejection(error: unknown): JiraRejection | undefined {
  if (!axios.isAxiosError(error) || error.response?.status !== 400) return undefined;
  const data = (error.response.data ?? {}) as {
    errors?: Record<string, string>;
    errorMessages?: string[];
  };
  return { fields: data.errors ?? {}, messages: data.errorMessages ?? [] };
}

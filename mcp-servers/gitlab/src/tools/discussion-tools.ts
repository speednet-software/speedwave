import {
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
  teachingErrorResult,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import type { DraftNoteInput, PublishDraftNotesInput } from '../client.js';
import { droppedAnchorFields, type DiffAnchor } from '../diff-position.js';
import { withValidation } from './validation.js';
import { TOOL_NAMES } from '../tool-names.js';

type MrParams = {
  project_id: string | number;
  mr_iid: number;
};

interface WriteToolSpec {
  name: string;
  annotations?: Tool['annotations'];
  description: string;
  keywords: string[];
  example: string;
  properties: Record<string, unknown>;
  required: string[];
  output: Record<string, unknown>;
  inputExample: { description: string; input: Record<string, unknown> };
}

const WRITE_META = {
  [META_KEYS.DEFER_LOADING]: true,
  [META_KEYS.USER_SCOPED]: true,
  [META_KEYS.CURRENT_USER_TOOL]: TOOL_NAMES.GET_CURRENT_USER,
};

const PROJECT_ID = { type: ['string', 'number'], description: 'Project ID or path' };
const MR_IID = {
  type: ['number', 'string'],
  description: 'Merge request IID as a number or string, e.g. 42 or "#42"',
};
const DISCUSSION_ID = { type: 'string', description: 'Discussion ID from listMrDiscussions' };
const ANCHOR_PROPERTIES = {
  path: {
    type: 'string',
    description:
      'File path to attach the comment to; without line it is a file-level comment. Required for line, end_line and side to apply',
  },
  line: {
    type: 'number',
    description:
      'Line number on the chosen side; with end_line, the first line. The line must be inside a diff hunk (added, removed or context line); GitLab rejects any other with a line_code error',
  },
  end_line: {
    type: 'number',
    description: 'Last line of a multi-line comment, same side as line; needs line',
  },
  side: {
    type: 'string',
    enum: ['new', 'old'],
    description: '"new" (default) numbers lines of the new file, "old" of the old file',
  },
};

const listMrDiscussionsTool: Tool = {
  name: 'listMrDiscussions',
  description: 'List discussion threads on a merge request',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'merge', 'request', 'discussions', 'threads'],
  example:
    'const discussions = await gitlab.listMrDiscussions({ project_id: "speedwave/core", mr_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: {
        type: ['number', 'string'],
        description: 'Merge request IID as a number or string, e.g. 42 or "#42"',
      },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      discussions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            notes: { type: 'array' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List MR discussions',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
};

const createMrDiscussionTool: Tool = {
  name: 'createMrDiscussion',
  description:
    'Create a discussion thread on a merge request, optionally attached to a file, line or line range of the diff. Posted as the currently authenticated GitLab user.',
  annotations: WRITE_ANNOTATIONS,
  _meta: WRITE_META,
  keywords: ['gitlab', 'merge', 'request', 'discussion', 'thread', 'line', 'diff', 'review'],
  example:
    'await gitlab.createMrDiscussion({ project_id: "speedwave/core", mr_iid: 42, body: "Missing null check", path: "src/a.ts", line: 42, side: "new" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: PROJECT_ID,
      mr_iid: MR_IID,
      body: { type: 'string', description: 'Discussion body' },
      ...ANCHOR_PROPERTIES,
    },
    required: ['project_id', 'mr_iid', 'body'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      discussion: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          notes: { type: 'array' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Start discussion',
      input: {
        project_id: 'my-group/my-project',
        mr_iid: 123,
        body: 'Can we refactor this?',
      },
    },
    {
      description: 'Comment on lines 42 to 45 of the new file',
      input: {
        project_id: 'my-group/my-project',
        mr_iid: 123,
        body: 'Missing null check',
        path: 'src/a.ts',
        line: 42,
        end_line: 45,
        side: 'new',
      },
    },
  ],
};

const createMrDiscussionNoteTool = writeTool({
  name: 'createMrDiscussionNote',
  description:
    'Reply in an existing merge request discussion. Posted as the currently authenticated GitLab user.',
  keywords: ['gitlab', 'merge', 'request', 'discussion', 'reply', 'note'],
  example:
    'await gitlab.createMrDiscussionNote({ project_id: "speedwave/core", mr_iid: 42, discussion_id: "6a9c", body: "Fixed in abc123" })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    discussion_id: DISCUSSION_ID,
    body: { type: 'string', description: 'Reply body' },
  },
  required: ['project_id', 'mr_iid', 'discussion_id', 'body'],
  output: { note: { type: 'object' } },
  inputExample: {
    description: 'Reply in a thread',
    input: { project_id: 'my-group/my-project', mr_iid: 123, discussion_id: '6a9c', body: 'Done' },
  },
});

const updateMrDiscussionNoteTool = writeTool({
  name: 'updateMrDiscussionNote',
  description: 'Edit the body of a note in a merge request discussion.',
  keywords: ['gitlab', 'merge', 'request', 'discussion', 'edit', 'note'],
  example:
    'await gitlab.updateMrDiscussionNote({ project_id: "speedwave/core", mr_iid: 42, discussion_id: "6a9c", note_id: 1202, body: "Updated" })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    discussion_id: DISCUSSION_ID,
    note_id: { type: 'number', description: 'Note ID inside the discussion' },
    body: { type: 'string', description: 'New note body' },
  },
  required: ['project_id', 'mr_iid', 'discussion_id', 'note_id', 'body'],
  output: { note: { type: 'object' } },
  inputExample: {
    description: 'Edit a note',
    input: {
      project_id: 'my-group/my-project',
      mr_iid: 123,
      discussion_id: '6a9c',
      note_id: 1202,
      body: 'Updated text',
    },
  },
});

const deleteMrDiscussionNoteTool = writeTool({
  name: 'deleteMrDiscussionNote',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  description: 'Delete a note from a merge request discussion.',
  keywords: ['gitlab', 'merge', 'request', 'discussion', 'delete', 'note'],
  example:
    'await gitlab.deleteMrDiscussionNote({ project_id: "speedwave/core", mr_iid: 42, discussion_id: "6a9c", note_id: 1202 })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    discussion_id: DISCUSSION_ID,
    note_id: { type: 'number', description: 'Note ID inside the discussion' },
  },
  required: ['project_id', 'mr_iid', 'discussion_id', 'note_id'],
  output: {},
  inputExample: {
    description: 'Delete a note',
    input: { project_id: 'my-group/my-project', mr_iid: 123, discussion_id: '6a9c', note_id: 1202 },
  },
});

const resolveMrDiscussionTool = writeTool({
  name: 'resolveMrDiscussion',
  description: 'Resolve or reopen a merge request discussion.',
  keywords: ['gitlab', 'merge', 'request', 'discussion', 'resolve', 'reopen'],
  example:
    'await gitlab.resolveMrDiscussion({ project_id: "speedwave/core", mr_iid: 42, discussion_id: "6a9c", resolved: true })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    discussion_id: DISCUSSION_ID,
    resolved: { type: 'boolean', description: 'true resolves the discussion, false reopens it' },
  },
  required: ['project_id', 'mr_iid', 'discussion_id', 'resolved'],
  output: { discussion: { type: 'object' } },
  inputExample: {
    description: 'Resolve a thread',
    input: {
      project_id: 'my-group/my-project',
      mr_iid: 123,
      discussion_id: '6a9c',
      resolved: true,
    },
  },
});

const createMrDraftNoteTool = writeTool({
  name: 'createMrDraftNote',
  description:
    'Create a draft review note, visible only to you until published. Attach it to a file, line or line range with path, line, end_line and side, or reply to a discussion with in_reply_to_discussion_id.',
  keywords: ['gitlab', 'merge', 'request', 'draft', 'review', 'note', 'comment'],
  example:
    'await gitlab.createMrDraftNote({ project_id: "speedwave/core", mr_iid: 42, note: "nit: name", path: "src/a.ts", line: 7 })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    note: { type: 'string', description: 'Draft note body' },
    ...ANCHOR_PROPERTIES,
    in_reply_to_discussion_id: {
      type: 'string',
      description: 'Discussion ID to reply to; the draft is published as a reply',
    },
    resolve_discussion: {
      type: 'boolean',
      description: 'Resolve the replied discussion when the draft is published',
    },
  },
  required: ['project_id', 'mr_iid', 'note'],
  output: { draft_note: { type: 'object' } },
  inputExample: {
    description: 'Draft a line comment',
    input: {
      project_id: 'my-group/my-project',
      mr_iid: 123,
      note: 'nit: rename',
      path: 'src/a.ts',
      line: 7,
    },
  },
});

const updateMrDraftNoteTool = writeTool({
  name: 'updateMrDraftNote',
  description:
    'Edit the text of a draft review note. The anchor cannot be changed: to move a draft, call deleteMrDraftNote and then createMrDraftNote.',
  keywords: ['gitlab', 'merge', 'request', 'draft', 'review', 'edit', 'note'],
  example:
    'await gitlab.updateMrDraftNote({ project_id: "speedwave/core", mr_iid: 42, draft_note_id: 88, note: "Reworded" })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    draft_note_id: { type: 'number', description: 'Draft note ID from listMrDraftNotes' },
    note: { type: 'string', description: 'New draft note body' },
  },
  required: ['project_id', 'mr_iid', 'draft_note_id', 'note'],
  output: { draft_note: { type: 'object' } },
  inputExample: {
    description: 'Reword a draft',
    input: { project_id: 'my-group/my-project', mr_iid: 123, draft_note_id: 88, note: 'Reworded' },
  },
});

const deleteMrDraftNoteTool = writeTool({
  name: 'deleteMrDraftNote',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  description: 'Delete a draft review note.',
  keywords: ['gitlab', 'merge', 'request', 'draft', 'review', 'delete', 'note'],
  example:
    'await gitlab.deleteMrDraftNote({ project_id: "speedwave/core", mr_iid: 42, draft_note_id: 88 })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    draft_note_id: { type: 'number', description: 'Draft note ID from listMrDraftNotes' },
  },
  required: ['project_id', 'mr_iid', 'draft_note_id'],
  output: {},
  inputExample: {
    description: 'Delete a draft',
    input: { project_id: 'my-group/my-project', mr_iid: 123, draft_note_id: 88 },
  },
});

const listMrDraftNotesTool: Tool = {
  name: 'listMrDraftNotes',
  description:
    'List the unpublished draft review notes of the currently authenticated GitLab user on a merge request; GitLab keeps drafts per author, so notes of other users are not listed',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: WRITE_META,
  keywords: ['gitlab', 'merge', 'request', 'draft', 'review', 'notes'],
  example:
    'const drafts = await gitlab.listMrDraftNotes({ project_id: "speedwave/core", mr_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: { project_id: PROJECT_ID, mr_iid: MR_IID },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      draft_notes: { type: 'array', items: { type: 'object' } },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List draft notes',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
};

const publishMrDraftNoteTool = writeTool({
  name: 'publishMrDraftNote',
  description: 'Publish one draft review note, as the currently authenticated GitLab user.',
  keywords: ['gitlab', 'merge', 'request', 'draft', 'review', 'publish'],
  example:
    'await gitlab.publishMrDraftNote({ project_id: "speedwave/core", mr_iid: 42, draft_note_id: 88 })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    draft_note_id: { type: 'number', description: 'Draft note ID from listMrDraftNotes' },
  },
  required: ['project_id', 'mr_iid', 'draft_note_id'],
  output: {},
  inputExample: {
    description: 'Publish one draft',
    input: { project_id: 'my-group/my-project', mr_iid: 123, draft_note_id: 88 },
  },
});

const publishMrDraftNotesTool = writeTool({
  name: 'publishMrDraftNotes',
  description: `Publish all your draft review notes at once, optionally with a summary note and a reviewer state. Does not approve the merge request; use ${TOOL_NAMES.APPROVE_MERGE_REQUEST} for that.`,
  keywords: ['gitlab', 'merge', 'request', 'draft', 'review', 'publish', 'submit'],
  example:
    'await gitlab.publishMrDraftNotes({ project_id: "speedwave/core", mr_iid: 42, note: "Summary", reviewer_state: "requested_changes" })',
  properties: {
    project_id: PROJECT_ID,
    mr_iid: MR_IID,
    note: { type: 'string', description: 'Summary note posted with the review' },
    internal: { type: 'boolean', description: 'Make the summary note internal' },
    reviewer_state: {
      type: 'string',
      enum: ['reviewed', 'requested_changes'],
      description: 'Review state to set on the merge request',
    },
  },
  required: ['project_id', 'mr_iid'],
  output: {},
  inputExample: {
    description: 'Submit the review',
    input: {
      project_id: 'my-group/my-project',
      mr_iid: 123,
      note: 'Summary',
      reviewer_state: 'requested_changes',
    },
  },
});

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createDiscussionTools(client: GitLabClient | null): ToolDefinition[] {
  return [
    {
      tool: listMrDiscussionsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, limit } = params as {
          project_id: string | number;
          mr_iid: number;
          limit?: number;
        };
        const result = await c.listMrDiscussions(project_id, mr_iid, limit);
        return jsonResult(result);
      }),
    },
    {
      tool: createMrDiscussionTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, body, path, line, end_line, side } = params as MrParams &
          DiffAnchor & { body: string };
        const orphan = droppedAnchorError({ path, line, end_line, side });
        if (orphan) return orphan;
        const discussion = await c.createMrDiscussion(project_id, mr_iid, body, {
          path,
          line,
          end_line,
          side,
        });
        return jsonResult({ success: true, discussion });
      }),
    },
    {
      tool: createMrDiscussionNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, discussion_id, body } = params as MrParams & {
          discussion_id: string;
          body: string;
        };
        const note = await c.createMrDiscussionNote(project_id, mr_iid, discussion_id, body);
        return jsonResult({ success: true, note });
      }),
    },
    {
      tool: updateMrDiscussionNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, discussion_id, note_id, body } = params as MrParams & {
          discussion_id: string;
          note_id: number;
          body: string;
        };
        const note = await c.updateMrDiscussionNote(
          project_id,
          mr_iid,
          discussion_id,
          note_id,
          body
        );
        return jsonResult({ success: true, note });
      }),
    },
    {
      tool: deleteMrDiscussionNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, discussion_id, note_id } = params as MrParams & {
          discussion_id: string;
          note_id: number;
        };
        await c.deleteMrDiscussionNote(project_id, mr_iid, discussion_id, note_id);
        return jsonResult({ success: true });
      }),
    },
    {
      tool: resolveMrDiscussionTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, discussion_id, resolved } = params as MrParams & {
          discussion_id: string;
          resolved: boolean;
        };
        const discussion = await c.resolveMrDiscussion(project_id, mr_iid, discussion_id, resolved);
        return jsonResult({ success: true, discussion });
      }),
    },
    {
      tool: createMrDraftNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, ...input } = params as MrParams & DraftNoteInput;
        const orphan = droppedAnchorError(input);
        if (orphan) return orphan;
        const draft_note = await c.createMrDraftNote(project_id, mr_iid, input);
        return jsonResult({ success: true, draft_note });
      }),
    },
    {
      tool: updateMrDraftNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, draft_note_id, note } = params as MrParams & {
          draft_note_id: number;
          note: string;
        };
        const draft_note = await c.updateMrDraftNote(project_id, mr_iid, draft_note_id, note);
        return jsonResult({ success: true, draft_note });
      }),
    },
    {
      tool: deleteMrDraftNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, draft_note_id } = params as MrParams & {
          draft_note_id: number;
        };
        await c.deleteMrDraftNote(project_id, mr_iid, draft_note_id);
        return jsonResult({ success: true });
      }),
    },
    {
      tool: listMrDraftNotesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid } = params as MrParams;
        const draft_notes = await c.listMrDraftNotes(project_id, mr_iid);
        return jsonResult({ success: true, draft_notes, count: draft_notes.length });
      }),
    },
    {
      tool: publishMrDraftNoteTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, draft_note_id } = params as MrParams & {
          draft_note_id: number;
        };
        await c.publishMrDraftNote(project_id, mr_iid, draft_note_id);
        return jsonResult({ success: true });
      }),
    },
    {
      tool: publishMrDraftNotesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, ...options } = params as MrParams & PublishDraftNotesInput;
        await c.publishMrDraftNotes(project_id, mr_iid, options);
        return jsonResult({ success: true });
      }),
    },
  ];
}

function droppedAnchorError(anchor: DiffAnchor) {
  const given = droppedAnchorFields(anchor);
  if (given.length === 0) return undefined;
  return teachingErrorResult({
    paramName: given.join(', '),
    nextStep:
      'line, end_line and side need path (the file to comment on), and end_line needs line; add the missing field or remove the field',
  });
}

function writeTool(spec: WriteToolSpec): Tool {
  return {
    name: spec.name,
    description: spec.description,
    annotations: spec.annotations ?? WRITE_ANNOTATIONS,
    _meta: WRITE_META,
    keywords: spec.keywords,
    example: spec.example,
    inputSchema: { type: 'object', properties: spec.properties, required: spec.required },
    outputSchema: {
      type: 'object',
      properties: { success: { type: 'boolean' }, ...spec.output, error: { type: 'string' } },
      required: ['success'],
    },
    inputExamples: [spec.inputExample],
  };
}

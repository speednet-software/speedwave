import { describe, it, expect } from 'vitest';
import { WORKSPACE_WRITE_ANNOTATIONS } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';

const READ_ONLY_TOOL_NAMES = [
  'searchIssues',
  'getIssue',
  'listLinkTypes',
  'getTransitions',
  'getMyself',
  'getComments',
  'listProjects',
  'getProject',
  'listIssueTypes',
  'listComponents',
  'listBoards',
  'getBoard',
  'getBoardConfiguration',
  'listSprints',
  'getSprint',
  'listSpaces',
  'getSpace',
  'searchPages',
  'getPage',
  'getPageByTitle',
  'getPageChildren',
  'getPageComments',
  'getPageLabels',
  'listAttachments',
];

const WORKSPACE_WRITE_TOOL_NAMES = ['downloadAttachment'];

const CHANGING_TOOL_NAMES = [
  'createIssue',
  'updateIssue',
  'deleteIssue',
  'linkIssues',
  'unlinkIssues',
  'transitionIssue',
  'assignIssue',
  'addAttachment',
  'deleteAttachment',
  'addComment',
  'addWorklog',
  'moveIssuesToSprint',
  'createPage',
  'updatePage',
  'addPageComment',
  'addPageLabels',
];

describe('Atlassian read-only access annotations', () => {
  const tools = createToolDefinitions(null).map((td) => td.tool);
  const names = (predicate: (hint: unknown) => boolean) =>
    tools.filter((t) => predicate(t.annotations?.readOnlyHint)).map((t) => t.name);

  it('lists every tool as reading, writing only into the workspace, or changing', () => {
    expect([...tools.map((t) => t.name)].sort()).toEqual(
      [...READ_ONLY_TOOL_NAMES, ...WORKSPACE_WRITE_TOOL_NAMES, ...CHANGING_TOOL_NAMES].sort()
    );
  });

  it('marks exactly the reading and workspace-writing tools readOnlyHint true', () => {
    expect(names((hint) => hint === true).sort()).toEqual(
      [...READ_ONLY_TOOL_NAMES, ...WORKSPACE_WRITE_TOOL_NAMES].sort()
    );
  });

  it.each(WORKSPACE_WRITE_TOOL_NAMES)('marks %s as writing only into the workspace', (name) => {
    expect(tools.find((t) => t.name === name)?.annotations).toEqual(WORKSPACE_WRITE_ANNOTATIONS);
  });

  it.each(CHANGING_TOOL_NAMES)('does not mark %s as read-only', (name) => {
    expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).not.toBe(true);
  });
});

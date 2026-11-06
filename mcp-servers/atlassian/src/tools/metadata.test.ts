/**
 * Access annotation tests: every Atlassian tool carries readOnlyHint, set correctly for the hub's read-only mode.
 */

import { describe, it, expect } from 'vitest';
import { createToolDefinitions } from './index.js';

/** Tools that only read: the hub lets them through in read-only mode (ADR-108). */
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

/** Tools that create, change, delete or write files: the hub blocks them in read-only mode. */
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

  it('lists every tool as either reading or changing', () => {
    expect([...tools.map((t) => t.name)].sort()).toEqual(
      [...READ_ONLY_TOOL_NAMES, ...CHANGING_TOOL_NAMES].sort()
    );
  });

  it('marks exactly the reading tools readOnlyHint true', () => {
    expect(names((hint) => hint === true).sort()).toEqual([...READ_ONLY_TOOL_NAMES].sort());
  });

  it.each(CHANGING_TOOL_NAMES)('does not mark %s as read-only', (name) => {
    expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).not.toBe(true);
  });
});

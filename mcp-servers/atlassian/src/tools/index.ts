/**
 * Atlassian tools aggregator — 35 tools (camelCase names) across:
 * - Jira issues (8): searchIssues, getIssue, createIssue, updateIssue, getTransitions, transitionIssue, assignIssue, getMyself
 * - Jira comments (3): addComment, getComments, addWorklog
 * - Jira projects (3): listProjects, getProject, listIssueTypes
 * - Jira Agile (6): listBoards, getBoard, getBoardConfiguration, listSprints, getSprint, moveIssuesToSprint
 * - Confluence spaces (2): listSpaces, getSpace
 * - Confluence pages (6): searchPages, getPage, getPageByTitle, createPage, updatePage, getPageChildren
 * - Confluence content (5): addPageComment, getPageComments, addPageLabels, getPageLabels, listAttachments
 * @module mcp-atlassian/tools
 */

import { type ToolDefinition } from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createJiraIssueTools } from './jira-issue-tools.js';
import { createJiraCommentTools } from './jira-comment-tools.js';
import { createJiraProjectTools } from './jira-project-tools.js';
import { createJiraAgileTools } from './jira-agile-tools.js';
import { createConfluenceSpaceTools } from './confluence-space-tools.js';
import { createConfluencePageTools } from './confluence-page-tools.js';
import { createConfluenceContentTools } from './confluence-content-tools.js';

/**
 * Build the full list of Atlassian tool definitions.
 * @param client - The Atlassian client (`null` when the service is not configured —
 *   tools are still listed, but every handler returns a "not configured" error).
 * @returns All tool definitions for the worker.
 */
export function createToolDefinitions(client: AtlassianClient | null): ToolDefinition[] {
  return [
    ...createJiraIssueTools(client),
    ...createJiraCommentTools(client),
    ...createJiraProjectTools(client),
    ...createJiraAgileTools(client),
    ...createConfluenceSpaceTools(client),
    ...createConfluencePageTools(client),
    ...createConfluenceContentTools(client),
  ];
}

export { createJiraIssueTools } from './jira-issue-tools.js';
export { createJiraCommentTools } from './jira-comment-tools.js';
export { createJiraProjectTools } from './jira-project-tools.js';
export { createJiraAgileTools } from './jira-agile-tools.js';
export { createConfluenceSpaceTools } from './confluence-space-tools.js';
export { createConfluencePageTools } from './confluence-page-tools.js';
export { createConfluenceContentTools } from './confluence-content-tools.js';

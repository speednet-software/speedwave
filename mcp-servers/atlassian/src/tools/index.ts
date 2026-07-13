/**
 * Atlassian tools aggregator — 35 tools: Jira issues/comments/projects/Agile, Confluence pages.
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
 * @param client - The Atlassian client (`null` when not configured — every handler then errors).
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

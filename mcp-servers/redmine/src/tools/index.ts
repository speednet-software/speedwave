/** Redmine tools aggregator: exports all 23 tools across issue/time entry/journal/user/project/relation/config domains. */

import { ToolDefinition } from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import { createIssueTools } from './issue-tools.js';
import { createTimeEntryTools } from './time-entry-tools.js';
import { createJournalTools } from './journal-tools.js';
import { createUserTools } from './user-tools.js';
import { createProjectTools } from './project-tools.js';
import { createRelationTools } from './relation-tools.js';
import { createConfigTools } from './config-tools.js';

/**
 * Aggregates tool definitions from every Redmine domain module.
 * @param client - Redmine client instance
 */
export function createToolDefinitions(client: RedmineClient | null): ToolDefinition[] {
  return [
    ...createIssueTools(client),
    ...createTimeEntryTools(client),
    ...createJournalTools(client),
    ...createUserTools(client),
    ...createProjectTools(client),
    ...createRelationTools(client),
    ...createConfigTools(client),
  ];
}

export { createIssueTools } from './issue-tools.js';
export { createTimeEntryTools } from './time-entry-tools.js';
export { createJournalTools } from './journal-tools.js';
export { createUserTools } from './user-tools.js';
export { createProjectTools } from './project-tools.js';
export { createRelationTools } from './relation-tools.js';
export { createConfigTools } from './config-tools.js';

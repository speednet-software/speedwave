/** Redmine tools aggregator: exports all 24 tools across issue/time entry/journal/user/project/relation/config domains. */

import {
  Tool,
  ToolDefinition,
  ToolHandler,
  normalizeNumericIdParams,
  teachingErrorResult,
  withDeclaredParams,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import { createIssueTools } from './issue-tools.js';
import { createTimeEntryTools } from './time-entry-tools.js';
import { createJournalTools } from './journal-tools.js';
import { createUserTools } from './user-tools.js';
import { createProjectTools } from './project-tools.js';
import { createRelationTools } from './relation-tools.js';
import { createConfigTools } from './config-tools.js';

function withNumericIds(tool: Tool, handler: ToolHandler): ToolHandler {
  const ids = Object.entries(tool.inputSchema.properties)
    .filter(
      ([name, schema]) => name.endsWith('_id') && (schema as { type?: unknown }).type === 'number'
    )
    .map(([name]) => name);
  return async (params, ...rest) => {
    const normalized = normalizeNumericIdParams(params, ids);
    if (!normalized.ok) {
      return teachingErrorResult(normalized.error);
    }
    return handler(normalized.value, ...rest);
  };
}

/**
 * Aggregates tool definitions from every Redmine domain module; each handler rejects an undeclared or missing required argument and any numeric ID that is not a positive integer.
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
  ].map(({ tool, handler }) => ({
    tool,
    handler: withDeclaredParams(tool, withNumericIds(tool, handler)),
  }));
}

export { createIssueTools } from './issue-tools.js';
export { createTimeEntryTools } from './time-entry-tools.js';
export { createJournalTools } from './journal-tools.js';
export { createUserTools } from './user-tools.js';
export { createProjectTools } from './project-tools.js';
export { createRelationTools } from './relation-tools.js';
export { createConfigTools } from './config-tools.js';

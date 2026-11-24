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
import { createAttachmentTools } from './attachment-tools.js';
import { createTimeEntryTools } from './time-entry-tools.js';
import { createJournalTools } from './journal-tools.js';
import { createUserTools } from './user-tools.js';
import { createProjectTools } from './project-tools.js';
import { createRelationTools } from './relation-tools.js';
import { createConfigTools } from './config-tools.js';
import { createCategoryTools } from './category-tools.js';

function numericIdParams(tool: Tool): { ids: string[]; nullable: Set<string> } {
  const ids: string[] = [];
  const nullable = new Set<string>();
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    if (!name.endsWith('_id')) continue;
    const type = (schema as { type?: unknown }).type;
    if (type === 'number') ids.push(name);
    if (
      Array.isArray(type) &&
      type.length === 2 &&
      type.includes('number') &&
      type.includes('null')
    ) {
      ids.push(name);
      nullable.add(name);
    }
  }
  return { ids, nullable };
}

function withNumericIds(tool: Tool, handler: ToolHandler): ToolHandler {
  const { ids, nullable } = numericIdParams(tool);
  return async (params, ...rest) => {
    const checked = ids.filter((name) => !(nullable.has(name) && params[name] === null));
    const normalized = normalizeNumericIdParams(params, checked);
    if (!normalized.ok) {
      const { paramName, nextStep } = normalized.error;
      return teachingErrorResult({ paramName, nextStep });
    }
    return handler(normalized.value, ...rest);
  };
}

function withoutAliasConflicts(tool: Tool, handler: ToolHandler): ToolHandler {
  const declared = new Set(Object.keys(tool.inputSchema.properties));
  const pairs = [...declared]
    .filter((name) => !name.endsWith('_id') && declared.has(`${name}_id`))
    .map((name) => [name, `${name}_id`] as const);
  const given = (value: unknown) => value !== undefined && value !== null && value !== '';
  return async (params, ...rest) => {
    const conflict = pairs.find(([name, idName]) => given(params[name]) && given(params[idName]));
    if (conflict) {
      const [name, idName] = conflict;
      return teachingErrorResult({
        paramName: `${name} and ${idName}`,
        nextStep: `${tool.name} takes either ${name} (a name) or ${idName} (an ID), not both, so the call was rejected and nothing was sent. Retry with one of them.`,
      });
    }
    return handler(params, ...rest);
  };
}

/**
 * Aggregates tool definitions from every Redmine domain module; each handler rejects an undeclared or missing required argument, a name given with its `_id` twin, and a numeric ID that is not a positive integer.
 * @param client - Redmine client instance
 */
export function createToolDefinitions(client: RedmineClient | null): ToolDefinition[] {
  return [
    ...createIssueTools(client),
    ...createAttachmentTools(client),
    ...createTimeEntryTools(client),
    ...createJournalTools(client),
    ...createUserTools(client),
    ...createProjectTools(client),
    ...createCategoryTools(client),
    ...createRelationTools(client),
    ...createConfigTools(client),
  ].map(({ tool, handler }) => ({
    tool,
    handler: withDeclaredParams(tool, withoutAliasConflicts(tool, withNumericIds(tool, handler))),
  }));
}

export { createIssueTools } from './issue-tools.js';
export { createAttachmentTools } from './attachment-tools.js';
export { createTimeEntryTools } from './time-entry-tools.js';
export { createJournalTools } from './journal-tools.js';
export { createUserTools } from './user-tools.js';
export { createProjectTools } from './project-tools.js';
export { createRelationTools } from './relation-tools.js';
export { createConfigTools } from './config-tools.js';

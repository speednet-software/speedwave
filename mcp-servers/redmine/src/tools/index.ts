/**
 * Redmine Tools Aggregator
 *
 * Exports all 23 tools organized by domain:
 * - Issue: 6 tools (list_issue_ids, get_issue_full, search_issue_ids, create_issue, update_issue, comment_issue)
 * - Time Entry: 3 tools (list_time_entries, create_time_entry, update_time_entry)
 * - Journal: 3 tools (list_journals, update_journal, delete_journal)
 * - User: 3 tools (list_users, resolve_user, get_current_user)
 * - Project: 3 tools (list_project_ids, get_project_full, search_project_ids)
 * - Relation: 3 tools (list_relations, create_relation, delete_relation)
 * - Config: 2 tools (get_mappings, get_config)
 */

import { ToolDefinition } from '../../../shared/dist/index.js';
import { RedmineClient } from '../client.js';
import { createIssueTools } from './issue-tools.js';
import { createTimeEntryTools } from './time-entry-tools.js';
import { createJournalTools } from './journal-tools.js';
import { createUserTools } from './user-tools.js';
import { createProjectTools } from './project-tools.js';
import { createRelationTools } from './relation-tools.js';
import { createConfigTools } from './config-tools.js';

/**
 * Tool handler function
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

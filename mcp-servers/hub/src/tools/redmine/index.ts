/**
 * Redmine Tools Index
 *
 * Exports all Redmine tool metadata for progressive discovery.
 * Tools are loaded dynamically by the search_tools handler.
 *
 * Available tools (23):
 * Issues:
 * - listIssueIds: List issues with filtering
 * - getIssueFull: Get issue details
 * - searchIssueIds: Full-text search
 * - createIssue: Create new issue
 * - updateIssue: Update issue
 * - commentIssue: Add comment
 *
 * Journals:
 * - listJournals: List issue history
 * - updateJournal: Update comment
 * - deleteJournal: Delete comment
 *
 * Time:
 * - listTimeEntries: List time entries
 * - createTimeEntry: Log time
 * - updateTimeEntry: Update time entry
 *
 * Users:
 * - listUsers: List assignable users
 * - resolveUser: Resolve user identifier
 * - getCurrentUser: Get authenticated user
 *
 * Config:
 * - getMappings: Get ID mappings
 * - getConfig: Get project configuration
 *
 * Projects:
 * - listProjectIds: List project IDs
 * - getProjectFull: Get project details
 * - searchProjectIds: Search projects
 *
 * Relations:
 * - listRelations: List issue relations
 * - createRelation: Create relation between issues
 * - deleteRelation: Delete relation
 */

import { ToolMetadata } from '../../hub-types.js';
import { metadata as listIssueIds } from './list_issues.js';
import { metadata as getIssueFull } from './show_issue.js';
import { metadata as searchIssueIds } from './search_issues.js';
import { metadata as createIssue } from './create_issue.js';
import { metadata as updateIssue } from './update_issue.js';
import { metadata as commentIssue } from './comment_issue.js';
import { metadata as listJournals } from './list_journals.js';
import { metadata as updateJournal } from './update_journal.js';
import { metadata as deleteJournal } from './delete_journal.js';
import { metadata as listTimeEntries } from './list_time_entries.js';
import { metadata as createTimeEntry } from './create_time_entry.js';
import { metadata as updateTimeEntry } from './update_time_entry.js';
import { metadata as listUsers } from './list_users.js';
import { metadata as resolveUser } from './resolve_user.js';
import { metadata as getCurrentUser } from './get_current_user.js';
import { metadata as getMappings } from './get_mappings.js';
import { metadata as getConfig } from './get_config.js';
import { metadata as listProjectIds } from './list_projects.js';
import { metadata as getProjectFull } from './show_project.js';
import { metadata as searchProjectIds } from './search_projects.js';
import { metadata as listRelations } from './list_relations.js';
import { metadata as createRelation } from './create_relation.js';
import { metadata as deleteRelation } from './delete_relation.js';

/**
 * All Redmine tools metadata keyed by camelCase name
 */
export const toolMetadata: Record<string, ToolMetadata> = {
  listIssueIds,
  getIssueFull,
  createIssue,
  updateIssue,
  searchIssueIds,
  commentIssue,
  listJournals,
  updateJournal,
  deleteJournal,
  listTimeEntries,
  createTimeEntry,
  updateTimeEntry,
  listUsers,
  resolveUser,
  getCurrentUser,
  getMappings,
  getConfig,
  listProjectIds,
  getProjectFull,
  searchProjectIds,
  listRelations,
  createRelation,
  deleteRelation,
};

/**
 * All Redmine tool names (camelCase)
 * Derived from toolMetadata keys to maintain SSOT
 */
export const tools = Object.keys(toolMetadata) as (keyof typeof toolMetadata)[];

/**
 * Union type of all Redmine tool names for type safety
 */
export type RedmineToolName = keyof typeof toolMetadata;

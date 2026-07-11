/**
 * SSOT for tool names referenced outside their own definition file: by
 * {@link RedmineClient.formatError}'s 404 recovery hints.
 * @module tool-names
 */

export const TOOL_NAMES = {
  LIST_ISSUE_IDS: 'listIssueIds',
  SEARCH_ISSUE_IDS: 'searchIssueIds',
  LIST_PROJECT_IDS: 'listProjectIds',
  SEARCH_PROJECT_IDS: 'searchProjectIds',
  LIST_JOURNALS: 'listJournals',
  LIST_RELATIONS: 'listRelations',
  LIST_TIME_ENTRIES: 'listTimeEntries',
} as const;

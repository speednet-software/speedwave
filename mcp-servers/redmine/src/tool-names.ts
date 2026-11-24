/** SSOT for tool names referenced outside their own definition file, by {@link RedmineClient.formatError}'s recovery hints. */

export const TOOL_NAMES = {
  LIST_ISSUE_IDS: 'listIssueIds',
  GET_ISSUE_FULL: 'getIssueFull',
  SEARCH_ISSUE_IDS: 'searchIssueIds',
  CREATE_ISSUE: 'createIssue',
  UPDATE_ISSUE: 'updateIssue',
  LIST_PROJECT_IDS: 'listProjectIds',
  SEARCH_PROJECT_IDS: 'searchProjectIds',
  LIST_VERSIONS: 'listVersions',
  LIST_CATEGORIES: 'listCategories',
  LIST_JOURNALS: 'listJournals',
  LIST_RELATIONS: 'listRelations',
  LIST_TIME_ENTRIES: 'listTimeEntries',
} as const;

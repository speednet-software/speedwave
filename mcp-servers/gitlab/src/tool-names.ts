/**
 * SSOT for tool names referenced outside their own definition file: by client-built teaching
 * messages ({@link GitLabClient.formatError}) and by other tools' `_meta` fields.
 */

export const TOOL_NAMES = {
  LIST_PROJECT_IDS: 'listProjectIds',
  LIST_MR_IDS: 'listMrIds',
  LIST_ISSUES: 'listIssues',
  LIST_BRANCHES: 'listBranches',
  GET_CURRENT_USER: 'getCurrentUser',
} as const;

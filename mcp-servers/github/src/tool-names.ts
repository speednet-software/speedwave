/**
 * SSOT for tool names referenced in client teaching messages, tool descriptions,
 * and identity `_meta`. A rename here updates the registered tool and every reference.
 */

export const TOOL_NAMES = {
  LIST_PULL_REQUESTS: 'listPullRequests',
  GET_REPO: 'getRepo',
  LIST_BRANCHES: 'listBranches',
  GET_TREE: 'getTree',
  LIST_ISSUES: 'listIssues',
  LIST_LABELS: 'listLabels',
  LIST_COMMITS: 'listCommits',
  GET_BRANCH: 'getBranch',
  GET_CURRENT_USER: 'getCurrentUser',
} as const;

/** A tool name embedded in a client teaching-error message. */
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

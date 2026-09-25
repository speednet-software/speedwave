import { Tool, TIMEOUTS } from '@speedwave/mcp-shared';

import { DETAIL_LEVELS } from './search-tools.js';

export const MAX_META_TOOL_DESCRIPTION_LENGTH = 4096;

export const SEARCH_TOOLS_TOOL: Tool = {
  name: 'search_tools',
  description: `Search available MCP tools by keyword or short phrase. Returns tool names, descriptions, and optionally full schemas.
Use this to discover tools before executing code. Start with 'names_only' for efficiency.

Built-in services: slack, sharepoint, redmine, gitlab, github, atlassian, office, playwright, context7, os. Plugin services (if enabled) are also searchable.

Matching is tokenized and ranked (each word matched independently against name/keywords/description), so a natural phrase like "my logged hours" also works. A zero-match result includes a 'hint' with next steps.

Examples:
- search_tools({ query: "slack", detail_level: "names_only" })
- search_tools({ query: "issue", detail_level: "full_schema", service: "redmine" })
- search_tools({ query: "reminders", detail_level: "with_descriptions", service: "os" })
- search_tools({ query: "*", detail_level: "with_descriptions", include_deferred: false })  // core tools only`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "Search query (e.g., 'slack', 'issue', 'merge request')",
      },
      detail_level: {
        type: 'string',
        enum: [...DETAIL_LEVELS],
        description:
          "Level of detail. Use 'names_only' first, then 'full_schema' for specific tools.",
      },
      service: {
        type: 'string',
        description:
          'Limit search to specific service. Built-in: slack, sharepoint, redmine, gitlab, github, atlassian, office, playwright, context7, os. Plugin services also accepted.',
      },
      include_deferred: {
        type: 'boolean',
        description:
          'Include deferred (on-demand) tools (default: true). Set false to get only core tools.',
      },
    },
    required: ['query'],
  },
};

export const EXECUTE_CODE_TOOL: Tool = {
  name: 'execute_code',
  description: `Execute JavaScript code (ES2022+) in a secure sandbox with MCP tools.

⚠️ SCHEMA FIRST - MANDATORY WORKFLOW:
Before calling ANY tool for the first time, you MUST:
1. search_tools({ query: "toolName", detail_level: "full_schema", service: "serviceName" })
2. Read the inputSchema and example from the response
3. Use EXACT parameter structure from schema

DO NOT guess parameter formats - always check schema first!

⚠️ ISOLATED SANDBOX: Each execute_code call runs in a fresh sandbox. Variables do NOT persist between calls. Put your entire workflow (fetch IDs → fetch details → process) in a SINGLE code block.

IMPORTANT: Use plain JavaScript, NOT TypeScript. Do NOT use type annotations like ": number[]" or ": string".

GRANULAR TOOLS PATTERN (recommended):
\`\`\`javascript
// Step 1: Get IDs (lightweight, ~100 tokens)
const { ids, total_count } = await redmine.listIssueIds({
  status: "open",
  assigned_to: "me"
});

// Step 2: Get full details for selected issues (batch returns { results, errors })
const { results: issues } = await batch(ids.slice(0, 5).map(id =>
  redmine.getIssueFull({ issue_id: id, include: ["journals"] })
));

// Step 3: Work with complete data
return issues.filter(i =>
  i.custom_fields?.find(cf => cf.name === "Priority")?.value === "High"
);
\`\`\`

Available globals:
- redmine: listIssueIds, getIssueFull, searchIssueIds, createIssue, updateIssue, ...
- gitlab: listProjectIds, getProjectFull, listMrIds, getMrFull, listPipelineIds, getPipelineFull, ...
- slack: listChannelIds, getChannelMessages, sendChannel
- sharepoint: listFileIds, getFileFull, downloadFile, uploadFile
- os: listReminders, createReminder, listEvents, createEvent, listEmails, sendEmail, listNotes, createNote, ...
- context7: resolveLibraryId, queryDocs (up-to-date library documentation)
- batch(promises): Parallel execution with partial failure support
  ⚠️ Returns { results: T[], errors: [{index, error}] } - ALWAYS destructure!
  ✅ const { results } = await batch([...])
  ❌ const data = await batch([...]); data.map(...) // WRONG: data is not array!
- paginate(fetcher, config): Async generator for large datasets
  fetcher(offset, limit) returns one page: { ids, total_count }, { issues, total_count }, ... or a bare array (arrays under other keys throw)
  config: { limit, offset, maxItems, maxPages, stopWhen }; consume with collectPages/findInPages/countInPages/filterPages/mapPages/takeFromPages
  const allIds = await collectPages(paginate((offset, limit) => redmine.listIssueIds({ status: "open", offset, limit }), { maxItems: 500 }));

Plugin services use the same dot syntax. A dashed plugin slug is camelCased into its global (e.g. \`my-plugin\` → \`myPlugin.someTool()\`); search_tools returns this as the \`sandboxGlobal\` field whenever it differs from the service name.

Example - Cross-service workflow:
\`\`\`javascript
// Get IDs from multiple services
const [issueData, mrData] = await Promise.all([
  redmine.listIssueIds({ status: "open", assigned_to: "me" }),
  gitlab.listMrIds({ project_id: "my-project", state: "opened" })
]);

// Fetch full details in parallel
const { results, errors } = await batch([
  ...issueData.ids.slice(0, 5).map(id => redmine.getIssueFull({ issue_id: id })),
  ...mrData.mrs.slice(0, 5).map(mr => gitlab.getMrFull({ project_id: "my-project", mr_iid: mr.iid }))
]);

return { total: results.length, failed: errors.length };
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'JavaScript code to execute (ES2022+). Do NOT use TypeScript type annotations. Use globals (redmine, slack, gitlab, etc.) directly - no imports needed; a dashed plugin slug is camelCased (my-plugin -> myPlugin). Return value is sent to model.',
      },
      timeout_ms: {
        type: 'number',
        description: `Execution timeout in milliseconds (default: ${TIMEOUTS.EXECUTION_MS}ms, max: ${TIMEOUTS.EXECUTION_MS}ms). For long operations (sharepoint.downloadFile, sharepoint.uploadFile) timeout auto-extends to ${TIMEOUTS.LONG_OPERATION_MS}ms.`,
      },
    },
    required: ['code'],
  },
  inputExamples: [
    {
      description: 'Minimal: get IDs only',
      input: {
        code: `const { ids, total_count } = await redmine.listIssueIds({ status: "open" });\nreturn { count: total_count, first_10: ids.slice(0, 10) };`,
      },
    },
    {
      description: 'Partial: get full details for selected items',
      input: {
        code: `const { ids } = await redmine.listIssueIds({ status: "open", assigned_to: "me" });\nconst { results } = await batch(ids.slice(0, 5).map(id => redmine.getIssueFull({ issue_id: id, include: ["journals"] })));\nreturn { results };`,
      },
    },
    {
      description: 'Full: cross-service granular workflow',
      input: {
        code: `const [issueData, mrData] = await Promise.all([\n  redmine.listIssueIds({ status: "open" }),\n  gitlab.listMrIds({ project_id: "my-project", state: "opened" })\n]);\nconst { results } = await batch([\n  ...issueData.ids.slice(0, 3).map(id => redmine.getIssueFull({ issue_id: id })),\n  ...mrData.mrs.slice(0, 3).map(mr => gitlab.getMrFull({ project_id: "my-project", mr_iid: mr.iid }))\n]);\nreturn { total: results.length };`,
      },
    },
  ],
};

export const META_TOOLS: readonly Tool[] = [SEARCH_TOOLS_TOOL, EXECUTE_CODE_TOOL];

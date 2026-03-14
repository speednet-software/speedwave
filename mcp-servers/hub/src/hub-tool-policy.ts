/**
 * Hub Tool Policy - Hub-side policy metadata for all tools
 * @module hub-tool-policy
 *
 * Contains policy data that is hub-specific and NOT part of the tool contract:
 * - category (audit logging)
 * - deferLoading (progressive disclosure)
 * - timeoutClass (execution timeout)
 * - timeoutMs (custom per-tool timeout)
 * - osCategory (OS sub-integration filtering)
 *
 * Workers own the tool contract (name, description, inputSchema, etc.).
 * Hub owns the policy (how to present/execute tools).
 */

import type { Tool } from '@speedwave/mcp-shared';
import { ToolCategory, TimeoutClass } from './hub-types.js';
import { TIMEOUTS } from '@speedwave/mcp-shared';
import { BUILT_IN_SERVICES as _BUILT_IN_SERVICES } from './service-list.js';

/**
 * Hub-side policy for a single tool.
 * These fields control how the hub presents and executes tools,
 * but are NOT part of the worker's tool contract.
 */
export interface ToolPolicy {
  /** Tool category for audit logging */
  category: ToolCategory;
  /** Defer loading: true = on-demand discovery, false = always loaded (core tool) */
  deferLoading: boolean;
  /** Timeout class: 'standard' (default) or 'long' for slow operations */
  timeoutClass?: TimeoutClass;
  /** Custom timeout in milliseconds (overrides WORKER_REQUEST_MS) */
  timeoutMs?: number;
  /** OS sub-integration category (only for os service) */
  osCategory?: 'reminders' | 'calendar' | 'mail' | 'notes';
}

/**
 * Supported service names (re-exported from service-list for backward compatibility)
 */
export const SUPPORTED_SERVICES = _BUILT_IN_SERVICES;
/**
 * Union type of all supported service names.
 */
export type SupportedService = (typeof SUPPORTED_SERVICES)[number];

/**
 * Tool policies grouped by service, keyed by camelCase tool name.
 * Extracted from the former hub/src/tools/{service}/*.ts files.
 *
 * Structure mirrors the old TOOL_REGISTRY to avoid name collisions
 * (e.g., getCurrentUser exists in both redmine and sharepoint).
 */
export const TOOL_POLICIES: Readonly<Record<string, Readonly<Record<string, ToolPolicy>>>> =
  Object.freeze({
    // ═══════════════════════════════════════════════════════════════════════════
    // Slack (4 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    slack: Object.freeze({
      sendChannel: { category: 'write', deferLoading: false },
      getChannelMessages: { category: 'read', deferLoading: true },
      listChannelIds: { category: 'read', deferLoading: false },
      getUsers: { category: 'read', deferLoading: true },
    } satisfies Record<string, ToolPolicy>),

    // ═══════════════════════════════════════════════════════════════════════════
    // SharePoint (5 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    sharepoint: Object.freeze({
      listFileIds: { category: 'read', deferLoading: false },
      getFileFull: { category: 'read', deferLoading: true, timeoutMs: TIMEOUTS.LONG_OPERATION_MS },
      sync: { category: 'write', deferLoading: true, timeoutClass: 'long' },
      syncDirectory: { category: 'write', deferLoading: true, timeoutClass: 'long' },
      getCurrentUser: { category: 'read', deferLoading: true },
    } satisfies Record<string, ToolPolicy>),

    // ═══════════════════════════════════════════════════════════════════════════
    // Redmine (23 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    redmine: Object.freeze({
      listIssueIds: { category: 'read', deferLoading: false },
      getIssueFull: { category: 'read', deferLoading: false },
      searchIssueIds: { category: 'read', deferLoading: true },
      createIssue: { category: 'write', deferLoading: false },
      updateIssue: { category: 'write', deferLoading: true },
      commentIssue: { category: 'write', deferLoading: true },
      listJournals: { category: 'read', deferLoading: true },
      updateJournal: { category: 'write', deferLoading: true },
      deleteJournal: { category: 'delete', deferLoading: true },
      listTimeEntries: { category: 'read', deferLoading: true },
      createTimeEntry: { category: 'write', deferLoading: true },
      updateTimeEntry: { category: 'write', deferLoading: true },
      listUsers: { category: 'read', deferLoading: true },
      resolveUser: { category: 'read', deferLoading: true },
      getCurrentUser: { category: 'read', deferLoading: true },
      getMappings: { category: 'read', deferLoading: true },
      getConfig: { category: 'read', deferLoading: true },
      listProjectIds: { category: 'read', deferLoading: true },
      getProjectFull: { category: 'read', deferLoading: true },
      searchProjectIds: { category: 'read', deferLoading: true },
      listRelations: { category: 'read', deferLoading: true },
      createRelation: { category: 'write', deferLoading: true },
      deleteRelation: { category: 'delete', deferLoading: true },
    } satisfies Record<string, ToolPolicy>),

    // ═══════════════════════════════════════════════════════════════════════════
    // GitLab (46 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    gitlab: Object.freeze({
      // Projects
      listProjectIds: { category: 'read', deferLoading: true },
      getProjectFull: { category: 'read', deferLoading: true },
      searchCode: { category: 'read', deferLoading: true },
      // Merge Requests
      listMrIds: { category: 'read', deferLoading: false },
      getMrFull: { category: 'read', deferLoading: true },
      createMergeRequest: { category: 'write', deferLoading: true },
      approveMergeRequest: { category: 'write', deferLoading: true },
      mergeMergeRequest: { category: 'write', deferLoading: true },
      updateMergeRequest: { category: 'write', deferLoading: true },
      getMrChanges: { category: 'read', deferLoading: true },
      listMrCommits: { category: 'read', deferLoading: true },
      listMrPipelines: { category: 'read', deferLoading: true },
      listMrNotes: { category: 'read', deferLoading: true },
      createMrNote: { category: 'write', deferLoading: true },
      // Discussions
      listMrDiscussions: { category: 'read', deferLoading: true },
      createMrDiscussion: { category: 'write', deferLoading: true },
      // Branches
      listBranches: { category: 'read', deferLoading: true },
      getBranch: { category: 'read', deferLoading: true },
      createBranch: { category: 'write', deferLoading: true },
      deleteBranch: { category: 'delete', deferLoading: true },
      compareBranches: { category: 'read', deferLoading: true },
      // Commits
      listBranchCommits: { category: 'read', deferLoading: true },
      listCommits: { category: 'read', deferLoading: true },
      searchCommits: { category: 'read', deferLoading: true },
      getCommitDiff: { category: 'read', deferLoading: true },
      // Pipelines
      listPipelineIds: { category: 'read', deferLoading: true },
      getPipelineFull: { category: 'read', deferLoading: true },
      getJobLog: { category: 'read', deferLoading: true },
      retryPipeline: { category: 'write', deferLoading: true },
      triggerPipeline: { category: 'write', deferLoading: true },
      // Repository
      getTree: { category: 'read', deferLoading: true },
      getFile: { category: 'read', deferLoading: true },
      getBlame: { category: 'read', deferLoading: true },
      // Artifacts
      listArtifacts: { category: 'read', deferLoading: true },
      downloadArtifact: { category: 'read', deferLoading: true },
      deleteArtifacts: { category: 'delete', deferLoading: true },
      // Issues
      listIssues: { category: 'read', deferLoading: true },
      getIssue: { category: 'read', deferLoading: true },
      createIssue: { category: 'write', deferLoading: true },
      updateIssue: { category: 'write', deferLoading: true },
      closeIssue: { category: 'write', deferLoading: true },
      // Labels
      listLabels: { category: 'read', deferLoading: true },
      createLabel: { category: 'write', deferLoading: true },
      // Releases
      createTag: { category: 'write', deferLoading: true },
      deleteTag: { category: 'delete', deferLoading: true },
      createRelease: { category: 'write', deferLoading: true },
    } satisfies Record<string, ToolPolicy>),

    // ═══════════════════════════════════════════════════════════════════════════
    // OS (25 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    os: Object.freeze({
      // Reminders
      listReminderLists: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      listReminders: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      getReminder: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      createReminder: {
        category: 'write',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      completeReminder: {
        category: 'write',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      // Calendar
      listCalendars: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      listEvents: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      getEvent: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      createEvent: {
        category: 'write',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      updateEvent: {
        category: 'write',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      deleteEvent: {
        category: 'delete',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      // Mail
      detectMailClients: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'mail',
      },
      listMailboxes: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'mail',
      },
      listEmails: { category: 'read', deferLoading: false, timeoutMs: 30_000, osCategory: 'mail' },
      getEmail: { category: 'read', deferLoading: false, timeoutMs: 30_000, osCategory: 'mail' },
      searchEmails: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'mail',
      },
      sendEmail: { category: 'write', deferLoading: false, timeoutMs: 30_000, osCategory: 'mail' },
      replyToEmail: {
        category: 'write',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'mail',
      },
      // Notes
      listNoteFolders: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
      listNotes: { category: 'read', deferLoading: false, timeoutMs: 30_000, osCategory: 'notes' },
      getNote: { category: 'read', deferLoading: false, timeoutMs: 30_000, osCategory: 'notes' },
      searchNotes: {
        category: 'read',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
      createNote: {
        category: 'write',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
      updateNote: {
        category: 'write',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
      deleteNote: {
        category: 'delete',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
    } satisfies Record<string, ToolPolicy>),
  });

/**
 * Look up policy for a tool by service and camelCase method name.
 * @param service - Service name (e.g., 'slack', 'redmine')
 * @param methodName - camelCase method name (e.g., 'createIssue')
 */
export function getToolPolicy(service: string, methodName: string): ToolPolicy | undefined {
  return TOOL_POLICIES[service]?.[methodName];
}

/**
 * Get all tool policies for a given service.
 * @param service - Service name (e.g., 'slack', 'redmine')
 */
export function getServicePolicies(service: string): Readonly<Record<string, ToolPolicy>> {
  return TOOL_POLICIES[service] ?? {};
}

/**
 * Get tool policy for a plugin tool.
 * Uses the worker-provided Tool.category field (types.ts:228) if available,
 * defaults to 'read' for safety. Plugin tools are always eagerly loaded
 * (deferLoading: false) since we have no hub-side policy data for them.
 * @param workerTool - Optional worker Tool definition with category field
 *
 * **Trust boundary:** Plugin tools inherit their audit category from the
 * worker's self-reported `Tool.category` field (default: 'read'). Built-in
 * services have categories hardcoded in TOOL_POLICIES. A plugin that
 * misreports its category (e.g. 'write' as 'read') would produce incorrect
 * audit trails. This is an accepted trade-off — the Ed25519 signature
 * requirement means only Speednet-signed plugins are loaded.
 */
export function getPluginToolPolicy(workerTool?: Tool): ToolPolicy {
  const category: ToolCategory = workerTool?.category ?? 'read';
  return {
    category,
    deferLoading: false,
  };
}

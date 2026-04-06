/**
 * Hub Tool Policy - Hub-side policy metadata for all tools
 * @module hub-tool-policy
 *
 * Contains policy data that is hub-specific and NOT part of the tool contract:
 * - deferLoading (progressive disclosure)
 * - timeoutClass (execution timeout)
 * - timeoutMs (custom per-tool timeout)
 * - osCategory (OS sub-integration filtering)
 *
 * Workers own the tool contract (name, description, inputSchema, annotations, etc.).
 * Hub owns the policy (how to present/execute tools).
 */

import { TimeoutClass } from './hub-types.js';
import { TIMEOUTS } from '@speedwave/mcp-shared';
import { BUILT_IN_SERVICES as _BUILT_IN_SERVICES } from './service-list.js';

/**
 * Hub-side policy for a single tool.
 * These fields control how the hub presents and executes tools,
 * but are NOT part of the worker's tool contract.
 */
export interface ToolPolicy {
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
      sendChannel: { deferLoading: false },
      getChannelMessages: { deferLoading: true },
      listChannelIds: { deferLoading: false },
      getUsers: { deferLoading: true },
    } satisfies Record<string, ToolPolicy>),

    // ═══════════════════════════════════════════════════════════════════════════
    // SharePoint (5 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    sharepoint: Object.freeze({
      listFileIds: { deferLoading: false },
      getFileFull: { deferLoading: true, timeoutMs: TIMEOUTS.LONG_OPERATION_MS },
      downloadFile: { deferLoading: true, timeoutClass: 'long' },
      uploadFile: { deferLoading: true, timeoutClass: 'long' },
      getCurrentUser: { deferLoading: true },
    } satisfies Record<string, ToolPolicy>),

    // ═══════════════════════════════════════════════════════════════════════════
    // Redmine (23 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    redmine: Object.freeze({
      listIssueIds: { deferLoading: false },
      getIssueFull: { deferLoading: false },
      searchIssueIds: { deferLoading: true },
      createIssue: { deferLoading: false },
      updateIssue: { deferLoading: true },
      commentIssue: { deferLoading: true },
      listJournals: { deferLoading: true },
      updateJournal: { deferLoading: true },
      deleteJournal: { deferLoading: true },
      listTimeEntries: { deferLoading: true },
      createTimeEntry: { deferLoading: true },
      updateTimeEntry: { deferLoading: true },
      listUsers: { deferLoading: true },
      resolveUser: { deferLoading: true },
      getCurrentUser: { deferLoading: true },
      getMappings: { deferLoading: true },
      getConfig: { deferLoading: true },
      listProjectIds: { deferLoading: true },
      getProjectFull: { deferLoading: true },
      searchProjectIds: { deferLoading: true },
      listRelations: { deferLoading: true },
      createRelation: { deferLoading: true },
      deleteRelation: { deferLoading: true },
    } satisfies Record<string, ToolPolicy>),

    // ═══════════════════════════════════════════════════════════════════════════
    // GitLab (46 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    gitlab: Object.freeze({
      // Projects
      listProjectIds: { deferLoading: true },
      getProjectFull: { deferLoading: true },
      searchCode: { deferLoading: true },
      // Merge Requests
      listMrIds: { deferLoading: false },
      getMrFull: { deferLoading: true },
      createMergeRequest: { deferLoading: true },
      approveMergeRequest: { deferLoading: true },
      mergeMergeRequest: { deferLoading: true },
      updateMergeRequest: { deferLoading: true },
      getMrChanges: { deferLoading: true },
      listMrCommits: { deferLoading: true },
      listMrPipelines: { deferLoading: true },
      listMrNotes: { deferLoading: true },
      createMrNote: { deferLoading: true },
      // Discussions
      listMrDiscussions: { deferLoading: true },
      createMrDiscussion: { deferLoading: true },
      // Branches
      listBranches: { deferLoading: true },
      getBranch: { deferLoading: true },
      createBranch: { deferLoading: true },
      deleteBranch: { deferLoading: true },
      compareBranches: { deferLoading: true },
      // Commits
      listBranchCommits: { deferLoading: true },
      listCommits: { deferLoading: true },
      searchCommits: { deferLoading: true },
      getCommitDiff: { deferLoading: true },
      // Pipelines
      listPipelineIds: { deferLoading: true },
      getPipelineFull: { deferLoading: true },
      getJobLog: { deferLoading: true },
      retryPipeline: { deferLoading: true },
      triggerPipeline: { deferLoading: true },
      // Repository
      getTree: { deferLoading: true },
      getFile: { deferLoading: true },
      getBlame: { deferLoading: true },
      // Artifacts
      listArtifacts: { deferLoading: true },
      downloadArtifact: { deferLoading: true },
      deleteArtifacts: { deferLoading: true },
      // Issues
      listIssues: { deferLoading: true },
      getIssue: { deferLoading: true },
      createIssue: { deferLoading: true },
      updateIssue: { deferLoading: true },
      closeIssue: { deferLoading: true },
      // Labels
      listLabels: { deferLoading: true },
      createLabel: { deferLoading: true },
      // Releases
      createTag: { deferLoading: true },
      deleteTag: { deferLoading: true },
      createRelease: { deferLoading: true },
    } satisfies Record<string, ToolPolicy>),

    // ═══════════════════════════════════════════════════════════════════════════
    // OS (25 tools)
    // ═══════════════════════════════════════════════════════════════════════════
    os: Object.freeze({
      // Reminders
      listReminderLists: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      listReminders: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      getReminder: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      createReminder: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      completeReminder: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'reminders',
      },
      // Calendar
      listCalendars: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      listEvents: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      getEvent: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      createEvent: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      updateEvent: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      deleteEvent: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      },
      // Mail
      detectMailClients: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'mail',
      },
      listMailboxes: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'mail',
      },
      listEmails: { deferLoading: false, timeoutMs: 30_000, osCategory: 'mail' },
      getEmail: { deferLoading: false, timeoutMs: 30_000, osCategory: 'mail' },
      searchEmails: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'mail',
      },
      sendEmail: { deferLoading: false, timeoutMs: 30_000, osCategory: 'mail' },
      replyToEmail: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'mail',
      },
      // Notes
      listNoteFolders: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
      listNotes: { deferLoading: false, timeoutMs: 30_000, osCategory: 'notes' },
      getNote: { deferLoading: false, timeoutMs: 30_000, osCategory: 'notes' },
      searchNotes: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
      createNote: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
      updateNote: {
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'notes',
      },
      deleteNote: {
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
 * Plugin tools are always eagerly loaded (deferLoading: false)
 * since we have no hub-side policy data for them.
 */
export function getPluginToolPolicy(): ToolPolicy {
  return { deferLoading: false };
}

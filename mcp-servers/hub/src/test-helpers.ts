/**
 * Shared test helpers for hub tests.
 * @module test-helpers
 */

import { vi } from 'vitest';
import {
  TOOL_REGISTRY,
  _resetRegistryForTesting,
  _setServiceNamesForTesting,
} from './tool-registry.js';
import type { ToolMetadata } from './hub-types.js';
import type { AllBridges } from './http-bridge.js';

/**
 * Representative mock tools per service with correct deferLoading/timeoutClass/osCategory values.
 */
const MOCK_SERVICE_TOOLS: Record<string, Record<string, Partial<ToolMetadata>>> = {
  slack: {
    sendChannel: { deferLoading: false, description: 'Send a message to a Slack channel' },
    getChannelMessages: { deferLoading: true, description: 'Get messages from a Slack channel' },
    listChannelIds: { deferLoading: false, description: 'List Slack channel IDs' },
    getUsers: { deferLoading: true, description: 'Get Slack users' },
  },
  sharepoint: {
    listFileIds: { deferLoading: false, description: 'List SharePoint file IDs' },
    getFileFull: {
      deferLoading: true,
      timeoutMs: 600_000,
      description: 'Get full SharePoint file content',
    },
    downloadFile: {
      deferLoading: true,
      timeoutClass: 'long',
      description: 'Download a SharePoint file',
    },
    uploadFile: {
      deferLoading: true,
      timeoutClass: 'long',
      description: 'Upload a file to SharePoint',
    },
    getCurrentUser: { deferLoading: true, description: 'Get current SharePoint user' },
  },
  redmine: {
    listIssueIds: { deferLoading: false, description: 'List Redmine issue IDs' },
    getIssueFull: { deferLoading: false, description: 'Get full Redmine issue details' },
    searchIssueIds: { deferLoading: true, description: 'Search Redmine issue IDs' },
    createIssue: { deferLoading: false, description: 'Create a Redmine issue' },
    updateIssue: { deferLoading: true, description: 'Update a Redmine issue' },
    commentIssue: { deferLoading: true, description: 'Comment on a Redmine issue' },
    listJournals: { deferLoading: true, description: 'List issue journals' },
    updateJournal: { deferLoading: true, description: 'Update a journal entry' },
    deleteJournal: { deferLoading: true, description: 'Delete a journal entry' },
    listTimeEntries: { deferLoading: true, description: 'List time entries' },
    createTimeEntry: { deferLoading: true, description: 'Create a time entry' },
    updateTimeEntry: { deferLoading: true, description: 'Update a time entry' },
    listUsers: { deferLoading: true, description: 'List Redmine users' },
    resolveUser: { deferLoading: true, description: 'Resolve a Redmine user' },
    getCurrentUser: { deferLoading: true, description: 'Get current Redmine user' },
    getMappings: { deferLoading: true, description: 'Get Redmine mappings' },
    getConfig: { deferLoading: true, description: 'Get Redmine configuration' },
    listProjectIds: { deferLoading: true, description: 'List Redmine project IDs' },
    getProjectFull: { deferLoading: true, description: 'Get full project details' },
    searchProjectIds: { deferLoading: true, description: 'Search Redmine project IDs' },
    listRelations: { deferLoading: true, description: 'List issue relations' },
    createRelation: { deferLoading: true, description: 'Create an issue relation' },
    deleteRelation: { deferLoading: true, description: 'Delete an issue relation' },
  },
  gitlab: {
    listProjectIds: { deferLoading: true, description: 'List GitLab project IDs' },
    getProjectFull: { deferLoading: true, description: 'Get full project details' },
    searchCode: { deferLoading: true, description: 'Search GitLab code' },
    listMrIds: { deferLoading: false, description: 'List merge request IDs' },
    getMrFull: { deferLoading: true, description: 'Get full merge request details' },
    createMergeRequest: { deferLoading: true, description: 'Create a merge request' },
    approveMergeRequest: { deferLoading: true, description: 'Approve a merge request' },
    mergeMergeRequest: { deferLoading: true, description: 'Merge a merge request' },
    updateMergeRequest: { deferLoading: true, description: 'Update a merge request' },
    getMrChanges: { deferLoading: true, description: 'Get merge request changes' },
    listMrCommits: { deferLoading: true, description: 'List merge request commits' },
    listMrPipelines: { deferLoading: true, description: 'List merge request pipelines' },
    listMrNotes: { deferLoading: true, description: 'List merge request notes' },
    createMrNote: { deferLoading: true, description: 'Create a merge request note' },
    listMrDiscussions: { deferLoading: true, description: 'List merge request discussions' },
    createMrDiscussion: { deferLoading: true, description: 'Create a merge request discussion' },
    listBranches: { deferLoading: true, description: 'List branches' },
    getBranch: { deferLoading: true, description: 'Get branch details' },
    createBranch: { deferLoading: true, description: 'Create a branch' },
    deleteBranch: { deferLoading: true, description: 'Delete a branch' },
    compareBranches: { deferLoading: true, description: 'Compare branches' },
    listBranchCommits: { deferLoading: true, description: 'List branch commits' },
    listCommits: { deferLoading: true, description: 'List commits' },
    searchCommits: { deferLoading: true, description: 'Search commits' },
    getCommitDiff: { deferLoading: true, description: 'Get commit diff' },
    listPipelineIds: { deferLoading: true, description: 'List pipeline IDs' },
    getPipelineFull: { deferLoading: true, description: 'Get full pipeline details' },
    getJobLog: { deferLoading: true, description: 'Get job log' },
    retryPipeline: { deferLoading: true, description: 'Retry a pipeline' },
    triggerPipeline: { deferLoading: true, description: 'Trigger a pipeline' },
    getTree: { deferLoading: true, description: 'Get repository tree' },
    getFile: { deferLoading: true, description: 'Get repository file' },
    getBlame: { deferLoading: true, description: 'Get file blame' },
    listArtifacts: { deferLoading: true, description: 'List artifacts' },
    downloadArtifact: { deferLoading: true, description: 'Download an artifact' },
    deleteArtifacts: { deferLoading: true, description: 'Delete artifacts' },
    listIssues: { deferLoading: true, description: 'List issues' },
    getIssue: { deferLoading: true, description: 'Get issue details' },
    createIssue: { deferLoading: true, description: 'Create an issue' },
    updateIssue: { deferLoading: true, description: 'Update an issue' },
    closeIssue: { deferLoading: true, description: 'Close an issue' },
    listLabels: { deferLoading: true, description: 'List labels' },
    createLabel: { deferLoading: true, description: 'Create a label' },
    createTag: { deferLoading: true, description: 'Create a tag' },
    deleteTag: { deferLoading: true, description: 'Delete a tag' },
    createRelease: { deferLoading: true, description: 'Create a release' },
  },
  os: {
    listReminderLists: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'reminders',
      description: 'List reminder lists',
    },
    listReminders: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'reminders',
      description: 'List reminders',
    },
    getReminder: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'reminders',
      description: 'Get a reminder',
    },
    createReminder: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'reminders',
      description: 'Create a reminder',
    },
    completeReminder: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'reminders',
      description: 'Complete a reminder',
    },
    listCalendars: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'calendar',
      description: 'List calendars',
    },
    listEvents: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'calendar',
      description: 'List calendar events',
    },
    getEvent: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'calendar',
      description: 'Get a calendar event',
    },
    createEvent: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'calendar',
      description: 'Create a calendar event',
    },
    updateEvent: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'calendar',
      description: 'Update a calendar event',
    },
    deleteEvent: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'calendar',
      description: 'Delete a calendar event',
    },
    detectMailClients: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'mail',
      description: 'Detect mail clients',
    },
    listMailboxes: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'mail',
      description: 'List mailboxes',
    },
    listEmails: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'mail',
      description: 'List emails',
    },
    getEmail: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'mail',
      description: 'Get an email',
    },
    searchEmails: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'mail',
      description: 'Search emails',
    },
    sendEmail: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'mail',
      description: 'Send an email',
    },
    replyToEmail: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'mail',
      description: 'Reply to an email',
    },
    listNoteFolders: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'notes',
      description: 'List note folders',
    },
    listNotes: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'notes',
      description: 'List notes',
    },
    getNote: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'notes',
      description: 'Get a note',
    },
    searchNotes: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'notes',
      description: 'Search notes',
    },
    createNote: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'notes',
      description: 'Create a note',
    },
    updateNote: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'notes',
      description: 'Update a note',
    },
    deleteNote: {
      deferLoading: false,
      timeoutMs: 30_000,
      osCategory: 'notes',
      description: 'Delete a note',
    },
  },
};

/**
 * Build a full ToolMetadata from partial mock data.
 * @param service - Service name (e.g., 'redmine')
 * @param methodName - Tool method name (e.g., 'listIssueIds')
 * @param partial - Partial tool metadata to merge with defaults
 */
function buildMockToolMetadata(
  service: string,
  methodName: string,
  partial: Partial<ToolMetadata>
): ToolMetadata {
  return {
    name: methodName,
    description: partial.description ?? `${methodName} tool`,
    keywords: partial.keywords ?? [],
    inputSchema: partial.inputSchema ?? { type: 'object', properties: {} },
    example: partial.example ?? '',
    service,
    deferLoading: partial.deferLoading ?? true,
    timeoutClass: partial.timeoutClass,
    timeoutMs: partial.timeoutMs,
    osCategory: partial.osCategory,
    outputSchema: partial.outputSchema,
    inputExamples: partial.inputExamples,
  };
}

/**
 * Populate registry with mock tool data inline.
 * Replaces the old populateRegistryFromPolicies() that depended on TOOL_POLICIES.
 * Must be called after _resetRegistryForTesting().
 *
 * Also sets SERVICE_NAMES so tests that iterate SERVICE_NAMES see all 5 built-in services.
 */
export function populateRegistryWithMockTools(): void {
  const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
  const serviceNames: string[] = [];

  for (const [service, tools] of Object.entries(MOCK_SERVICE_TOOLS)) {
    mutableRegistry[service] = {};
    serviceNames.push(service);
    for (const [methodName, partial] of Object.entries(tools)) {
      mutableRegistry[service][methodName] = buildMockToolMetadata(service, methodName, partial);
    }
  }

  _setServiceNamesForTesting(serviceNames);
}

/**
 * Create a full mock AllBridges object with all service methods as vi.fn().
 * Eliminates ~425 lines of duplicated mock definitions across test files.
 */
export function createMockBridges(): AllBridges {
  return {
    slack: {
      listChannelIds: vi.fn(),
      getChannelMessages: vi.fn(),
      sendChannel: vi.fn(),
      getUsers: vi.fn(),
    },
    sharepoint: {
      listFileIds: vi.fn(),
      getFileFull: vi.fn(),
      downloadFile: vi.fn(),
      uploadFile: vi.fn(),
      getCurrentUser: vi.fn(),
    },
    redmine: {
      listIssueIds: vi.fn(),
      getIssueFull: vi.fn(),
      createIssue: vi.fn(),
      updateIssue: vi.fn(),
      searchIssueIds: vi.fn(),
      commentIssue: vi.fn(),
      listTimeEntries: vi.fn(),
      createTimeEntry: vi.fn(),
      updateTimeEntry: vi.fn(),
      listJournals: vi.fn(),
      updateJournal: vi.fn(),
      deleteJournal: vi.fn(),
      listUsers: vi.fn(),
      resolveUser: vi.fn(),
      getMappings: vi.fn(),
      getCurrentUser: vi.fn(),
      getConfig: vi.fn(),
      listProjectIds: vi.fn(),
      getProjectFull: vi.fn(),
      searchProjectIds: vi.fn(),
      listRelations: vi.fn(),
      createRelation: vi.fn(),
      deleteRelation: vi.fn(),
    },
    gitlab: {
      listProjectIds: vi.fn(),
      getProjectFull: vi.fn(),
      searchCode: vi.fn(),
      listMrIds: vi.fn(),
      getMrFull: vi.fn(),
      createMergeRequest: vi.fn(),
      updateMergeRequest: vi.fn(),
      approveMergeRequest: vi.fn(),
      mergeMergeRequest: vi.fn(),
      getMrChanges: vi.fn(),
      listMrCommits: vi.fn(),
      listMrPipelines: vi.fn(),
      listMrNotes: vi.fn(),
      createMrNote: vi.fn(),
      listMrDiscussions: vi.fn(),
      createMrDiscussion: vi.fn(),
      listBranches: vi.fn(),
      getBranch: vi.fn(),
      createBranch: vi.fn(),
      deleteBranch: vi.fn(),
      compareBranches: vi.fn(),
      listCommits: vi.fn(),
      searchCommits: vi.fn(),
      getCommitDiff: vi.fn(),
      listBranchCommits: vi.fn(),
      listPipelineIds: vi.fn(),
      getPipelineFull: vi.fn(),
      retryPipeline: vi.fn(),
      triggerPipeline: vi.fn(),
      getJobLog: vi.fn(),
      getTree: vi.fn(),
      getFile: vi.fn(),
      getBlame: vi.fn(),
      listArtifacts: vi.fn(),
      downloadArtifact: vi.fn(),
      deleteArtifacts: vi.fn(),
      listIssues: vi.fn(),
      getIssue: vi.fn(),
      createIssue: vi.fn(),
      updateIssue: vi.fn(),
      closeIssue: vi.fn(),
      listLabels: vi.fn(),
      createLabel: vi.fn(),
      createTag: vi.fn(),
      deleteTag: vi.fn(),
      createRelease: vi.fn(),
    },
  };
}

export { _resetRegistryForTesting };

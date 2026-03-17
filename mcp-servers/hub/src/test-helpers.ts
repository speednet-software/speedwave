/**
 * Shared test helpers for hub tests.
 * @module test-helpers
 */

import { vi } from 'vitest';
import { TOOL_REGISTRY, _resetRegistryForTesting } from './tool-registry.js';
import { SUPPORTED_SERVICES, getServicePolicies } from './hub-tool-policy.js';
import { buildSkeletonFromPolicy } from './tool-discovery.js';
import type { ToolMetadata } from './hub-types.js';
import type { AllBridges } from './http-bridge.js';

/**
 * Populate registry with skeleton entries from policies.
 * Simulates what initializeRegistry() does when workers are unavailable.
 * Must be called after _resetRegistryForTesting().
 */
export function populateRegistryFromPolicies(): void {
  // Cast to mutable for test setup — production code uses Readonly export
  const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
  for (const service of SUPPORTED_SERVICES) {
    const policies = getServicePolicies(service);
    mutableRegistry[service] = {};
    for (const [methodName, policy] of Object.entries(policies)) {
      mutableRegistry[service][methodName] = buildSkeletonFromPolicy(service, methodName, policy);
    }
  }
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

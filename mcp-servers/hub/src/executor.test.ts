import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { executeCode, _setBridgesForTesting, _formatErrorMessage } from './executor.js';
import type { AllBridges } from './http-bridge.js';
import { resetServiceCaches, stopBackgroundRefresh } from './tool-registry.js';
import { populateRegistryFromPolicies, _resetRegistryForTesting } from './test-helpers.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Code Executor
//
// Purpose: Test sandbox execution (security and basic functionality)
// - Verify security restrictions (forbidden patterns)
// - Verify basic code execution without tool dependencies
//
// Note: These tests focus on code validation and security.
// Full integration tests with tool availability, audit logging, and PII tokenization
// are tested separately with proper mocking/fixtures to avoid bridge initialization issues.
//═══════════════════════════════════════════════════════════════════════════════

describe('executor', () => {
  beforeAll(() => {
    _resetRegistryForTesting();
    populateRegistryFromPolicies();
  });

  afterAll(() => {
    stopBackgroundRefresh();
  });

  describe('security restrictions', () => {
    it('should reject code with eval', async () => {
      const code = `
        eval('console.log("hello")');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('eval');
    });

    it('should reject code with Function constructor', async () => {
      const code = `
        const fn = new Function('return 1');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('Function');
    });

    it('should reject code with require', async () => {
      const code = `
        const fs = require('fs');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('require');
    });

    it('should reject code accessing process', async () => {
      const code = `
        console.log(process.env);
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('process');
    });

    it('should reject code accessing globalThis', async () => {
      const code = `
        console.log(globalThis);
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('globalThis');
    });

    it('should reject code with dynamic import', async () => {
      const code = `
        const module = await import('./something');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('import');
    });

    it('should reject code accessing fs', async () => {
      const code = `
        const content = fs.readFileSync('/etc/passwd');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('fs');
    });

    it('should reject code accessing net', async () => {
      const code = `
        const server = net.createServer();
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('net');
    });

    it('should reject code accessing http', async () => {
      const code = `
        http.get('http://example.com');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('http');
    });

    it('should enforce timeout on async operations', async () => {
      // Setup mock bridges for this test
      const mockBridges: AllBridges = {
        slack: {
          listChannelIds: vi.fn(),
          getChannelMessages: vi.fn(),
          sendChannel: vi.fn(),
          getUsers: vi.fn(),
        },
        sharepoint: {
          listFileIds: vi.fn(),
          getFileFull: vi.fn(),
          sync: vi.fn(),
          syncDirectory: vi.fn(),
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
      _setBridgesForTesting(mockBridges);

      // Note: Synchronous infinite loops cannot be interrupted by Promise.race timeout
      // This tests async timeout which is the realistic scenario
      const code = `
        await new Promise(resolve => setTimeout(resolve, 5000));
        return { done: true };
      `;

      const result = await executeCode({ code, timeoutMs: 50 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toContain('timeout');

      // Cleanup
      _setBridgesForTesting(null);
    }, 1000);
  });

  describe('code validation only (no bridge required)', () => {
    it('should validate eval pattern', async () => {
      const code = `eval('1 + 1')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('eval');
    });

    it('should validate Function pattern', async () => {
      const code = `new Function('return 1')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Function');
    });

    it('should validate require pattern', async () => {
      const code = `require('fs')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('require');
    });

    it('should validate dynamic import pattern', async () => {
      const code = `import('./module')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('import');
    });

    it('should validate process access', async () => {
      const code = `process.env.PATH`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('process');
    });

    it('should validate globalThis access', async () => {
      const code = `globalThis.console`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('globalThis');
    });

    it('should validate __dirname access', async () => {
      const code = `console.log(__dirname)`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('__dirname');
    });

    it('should validate __filename access', async () => {
      const code = `console.log(__filename)`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('__filename');
    });

    it('should validate child_process access', async () => {
      const code = `child_process.exec('ls')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('child_process');
    });

    it('should validate fs access', async () => {
      const code = `fs.readFileSync('/etc/passwd')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('fs');
    });
  });

  describe('smart error enhancement', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;

    beforeEach(() => {
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,gitlab,os';
    });

    afterEach(() => {
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      resetServiceCaches();
    });

    it('should show available methods when calling non-existent function', async () => {
      // Setup mock bridges
      const mockBridges: AllBridges = {
        slack: {
          listChannelIds: vi.fn(),
          getChannelMessages: vi.fn(),
          sendChannel: vi.fn(),
          getUsers: vi.fn(),
        },
        sharepoint: {
          listFileIds: vi.fn(),
          getFileFull: vi.fn(),
          sync: vi.fn(),
          syncDirectory: vi.fn(),
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
      _setBridgesForTesting(mockBridges);

      // Call a non-existent method on redmine
      const code = `await redmine.listProjects()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toContain('listProjects is not a function');
      expect(result.error?.message).toContain('Available redmine methods');
      expect(result.error?.message).toContain('listIssueIds');
      expect(result.error?.message).toContain('updateIssue');

      // Cleanup
      _setBridgesForTesting(null);
    });

    it('should show available methods for gitlab when calling non-existent function', async () => {
      const mockBridges: AllBridges = {
        slack: {
          listChannelIds: vi.fn(),
          getChannelMessages: vi.fn(),
          sendChannel: vi.fn(),
          getUsers: vi.fn(),
        },
        sharepoint: {
          listFileIds: vi.fn(),
          getFileFull: vi.fn(),
          sync: vi.fn(),
          syncDirectory: vi.fn(),
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
      _setBridgesForTesting(mockBridges);

      const code = `await gitlab.getRepositories()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('getRepositories is not a function');
      expect(result.error?.message).toContain('Available gitlab methods');
      expect(result.error?.message).toContain('listProjectIds');

      _setBridgesForTesting(null);
    });

    it('should show available methods when underscore method does not match any real method', async () => {
      const mockBridges: AllBridges = {
        slack: {
          listChannelIds: vi.fn(),
          getChannelMessages: vi.fn(),
          sendChannel: vi.fn(),
          getUsers: vi.fn(),
        },
        sharepoint: {
          listFileIds: vi.fn(),
          getFileFull: vi.fn(),
          sync: vi.fn(),
          syncDirectory: vi.fn(),
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
      _setBridgesForTesting(mockBridges);

      // Code using underscore notation for a method that doesn't exist
      const code = `slack_nonExistentMethod()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toContain('slack_nonExistentMethod is not defined');
      expect(result.error?.message).toContain('Use dot notation');
      expect(result.error?.message).toContain('Available methods');

      _setBridgesForTesting(null);
    });
  });

  describe('formatErrorMessage', () => {
    it('should handle string message from Error', () => {
      const error = new Error('Simple error');
      expect(_formatErrorMessage(error)).toBe('Simple error');
    });

    it('should handle object message (GitBeaker style)', () => {
      // GitBeaker sometimes returns errors with object messages
      const error = new Error('ignored');
      (error as unknown as { message: object }).message = {
        error: 'API failed',
        details: 'Invalid token',
      };
      expect(_formatErrorMessage(error)).toBe('{"error":"API failed","details":"Invalid token"}');
    });

    it('should handle plain object error', () => {
      const error = { code: 'ERR', reason: 'timeout' };
      expect(_formatErrorMessage(error)).toBe('{"code":"ERR","reason":"timeout"}');
    });

    it('should return "Unknown error" for empty Error message', () => {
      const error = new Error();
      error.message = '';
      expect(_formatErrorMessage(error)).toBe('Unknown error');
    });

    it('should handle string primitive', () => {
      expect(_formatErrorMessage('string error')).toBe('string error');
    });

    it('should handle number primitive', () => {
      expect(_formatErrorMessage(42)).toBe('42');
    });

    it('should handle null', () => {
      expect(_formatErrorMessage(null)).toBe('null');
    });

    it('should handle undefined', () => {
      expect(_formatErrorMessage(undefined)).toBe('undefined');
    });

    it('should handle nested object message', () => {
      const error = new Error('ignored');
      (error as unknown as { message: object }).message = {
        response: {
          status: 400,
          body: { message: 'Bad Request' },
        },
      };
      const result = _formatErrorMessage(error);
      expect(result).toContain('400');
      expect(result).toContain('Bad Request');
    });
  });

  // Note: sanitizeParamsForLogging tests removed - functionality moved to PII Tokenizer
  // Sensitive data protection for Claude is handled by pii-tokenizer.ts (SENSITIVE_FIELD type)
  // Local Docker logs are not sanitized as they don't leave the container

  describe('batch helper (through executeCode)', () => {
    const mockBridges: AllBridges = {
      slack: {
        listChannelIds: vi.fn(),
        getChannelMessages: vi.fn(),
        sendChannel: vi.fn(),
        getUsers: vi.fn(),
      },
      sharepoint: {
        listFileIds: vi.fn(),
        getFileFull: vi.fn(),
        sync: vi.fn(),
        syncDirectory: vi.fn(),
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

    beforeEach(() => {
      _setBridgesForTesting(mockBridges);
    });

    afterEach(() => {
      _setBridgesForTesting(null);
    });

    it('should return results and errors separately for partial failures', async () => {
      const code = `
        const promises = [
          Promise.resolve({ id: 1 }),
          Promise.reject(new Error('Failed')),
          Promise.resolve({ id: 3 }),
        ];
        return await batch(promises);
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('results');
      expect(result.data).toHaveProperty('errors');
      expect((result.data as { results: unknown[] }).results).toHaveLength(2);
      expect((result.data as { errors: unknown[] }).errors).toHaveLength(1);
    });

    it('should return all results when no failures', async () => {
      const code = `
        const promises = [
          Promise.resolve({ id: 1 }),
          Promise.resolve({ id: 2 }),
          Promise.resolve({ id: 3 }),
        ];
        return await batch(promises);
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect((result.data as { results: unknown[] }).results).toHaveLength(3);
      expect((result.data as { errors: unknown[] }).errors).toHaveLength(0);
    });

    it('should include error index for failed operations', async () => {
      const code = `
        const promises = [
          Promise.resolve({ id: 1 }),
          Promise.reject(new Error('Second failed')),
        ];
        return await batch(promises);
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      const errors = (result.data as { errors: Array<{ index: number; error: string }> }).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(1);
      expect(errors[0].error).toContain('Second failed');
    });
  });

  describe('plugin service in sandbox', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;

    beforeEach(() => {
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,presale';
    });

    afterEach(() => {
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      resetServiceCaches();
    });

    it('should include plugin service tools in sandbox context', async () => {
      // Register a plugin service in the registry
      const { TOOL_REGISTRY, SERVICE_NAMES } = await import('./tool-registry.js');
      const mutableRegistry = TOOL_REGISTRY as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      mutableRegistry['presale'] = {
        searchCustomers: {
          name: 'searchCustomers',
          service: 'presale',
          category: 'read',
          description: 'Search CRM customers',
          inputSchema: { type: 'object', properties: {} },
          keywords: [],
          example: '',
          deferLoading: false,
        },
      };

      // Set up mock bridges
      const mockBridges: AllBridges = {
        slack: {
          listChannelIds: vi.fn(),
          getChannelMessages: vi.fn(),
          sendChannel: vi.fn(),
          getUsers: vi.fn(),
        },
        presale: null,
        sharepoint: null,
        redmine: null,
        gitlab: null,
        os: null,
      };
      _setBridgesForTesting(mockBridges);

      // Code that accesses the sandbox to check what's available
      const code = `typeof presale`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      // presale is in sandbox but has no bridge, so it's undefined
      expect(result.success).toBe(true);
      expect(result.data).toBe('undefined');

      // Cleanup
      delete mutableRegistry['presale'];
      _setBridgesForTesting(null);
    });
  });

  describe('auto-return transformation', () => {
    // These tests verify that the auto-return transformation correctly prepends
    // 'return' to expressions without causing syntax errors.
    // We test using pure JavaScript that doesn't require HTTP bridges.

    it('should handle multiline expression with object parameter', async () => {
      // Simulates: await sharepoint.sync({ local_path: "/path", mode: "pull" });
      // The multiline object literal should not break the auto-return transformation
      const code = `({
        local_path: "/path",
        mode: "pull"
      })`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ local_path: '/path', mode: 'pull' });
    });

    it('should handle single-line expression (regression test)', async () => {
      const code = `1 + 2`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(3);
    });

    it('should not add return to const declarations', async () => {
      const code = `const x = 42;`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      // const doesn't return a value, result is undefined
      expect(result.data).toBeUndefined();
    });

    it('should preserve explicit return', async () => {
      const code = `return 42;`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(42);
    });

    it('should handle multiline with nested objects', async () => {
      const code = `({
        local_path: "/path",
        options: {
          mode: "pull",
          delete: true
        }
      })`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        local_path: '/path',
        options: { mode: 'pull', delete: true },
      });
    });

    it('should handle empty code', async () => {
      const code = ``;
      const result = await executeCode({ code, timeoutMs: 5000 });
      // Empty code should not crash
      expect(result.success).toBe(true);
    });

    it('should handle whitespace-only code', async () => {
      const code = `   \n   `;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
    });

    it('should handle multiline async await expression', async () => {
      // This simulates the actual failing case: multiline await with object param
      const code = `await Promise.resolve({
        success: true,
        data: "test"
      })`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ success: true, data: 'test' });
    });

    it('should handle array expression', async () => {
      const code = `[
        "item1",
        "item2",
        "item3"
      ]`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual(['item1', 'item2', 'item3']);
    });

    it('should handle multiple statements and return last one', async () => {
      const code = `const x = 1;
        const y = 2;
        x + y`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(3);
    });

    it('should handle code with leading comment', async () => {
      const code = `// This is a comment
        42`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(42);
    });

    it('should handle multiline const with await', async () => {
      const code = `const result = await Promise.resolve({
        success: true
      });`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      // const doesn't return, result is undefined
      expect(result.data).toBeUndefined();
    });

    it('should not add return to if statement', async () => {
      const code = `if (true) { 42 }`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      // if statement doesn't return a value
      expect(result.data).toBeUndefined();
    });

    it('should not add return to for loop', async () => {
      const code = `for (let i = 0; i < 3; i++) { i }`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it('should not add return to while loop', async () => {
      const code = `while (false) { 1 }`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });
  });
});

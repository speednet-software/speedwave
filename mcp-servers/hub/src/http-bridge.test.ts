import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  createGitLabBridge,
  createSlackBridge,
  createSharePointBridge,
  createRedmineBridge,
  createOsBridge,
  callWorker,
  isWorkerAvailable,
  getAvailableServices,
  clearWorkerCache,
  parseServiceError,
  getRequestTimeout,
} from './http-bridge.js';
import { getServiceMethods, stopBackgroundRefresh } from './tool-registry.js';
import { SERVICES } from './http-bridge.js';
import { populateRegistryFromPolicies, _resetRegistryForTesting } from './test-helpers.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for HTTP Bridge
//
// Purpose: Test bridge creation and method delegation to workers
// - Verify all methods exist on bridges
// - Verify correct method names (camelCase) are passed to workers
// - Verify parameters are passed correctly
//═══════════════════════════════════════════════════════════════════════════════

describe('http-bridge', () => {
  beforeAll(() => {
    _resetRegistryForTesting();
    populateRegistryFromPolicies();
  });

  afterAll(() => {
    stopBackgroundRefresh();
  });

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const svc of SERVICES) {
      const key = `WORKER_${svc.toUpperCase()}_URL`;
      savedEnv[key] = process.env[key];
      process.env[key] = `http://mcp-${svc}:${3001 + SERVICES.indexOf(svc)}`;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('callWorker', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Mock global fetch
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should call worker with correct JSON-RPC format', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: '{"success":true}' }],
          },
        }),
      });

      await callWorker('gitlab', 'list_branches', { project_id: '1' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('gitlab'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('list_branches'),
        })
      );

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.method).toBe('tools/call');
      expect(callBody.params.name).toBe('list_branches');
      expect(callBody.params.arguments).toEqual({ project_id: '1' });
    });

    it('should parse JSON response from worker', async () => {
      const mockData = { branches: ['main', 'develop'] };
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: JSON.stringify(mockData) }],
          },
        }),
      });

      const result = await callWorker('gitlab', 'list_branches', {});

      expect(result).toEqual(mockData);
    });

    it('should handle worker errors', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          error: {
            code: -32000,
            message: 'Worker error: GitLab not configured',
          },
        }),
      });

      await expect(callWorker('gitlab', 'list_branches', {})).rejects.toThrow(
        'Worker gitlab error: Worker error: GitLab not configured'
      );
    });

    it('should handle HTTP errors', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(callWorker('gitlab', 'list_branches', {})).rejects.toThrow(
        'Worker gitlab returned 500: Internal Server Error'
      );
    });

    it('should handle timeout', async () => {
      // Mock fetch to listen to abort signal (like real fetch does)
      fetchMock.mockImplementation((_url: string, options?: { signal?: AbortSignal }) => {
        return new Promise((_, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }
        });
      });

      await expect(callWorker('gitlab', 'list_branches', {}, { timeoutMs: 50 })).rejects.toThrow(
        'timeout after 50ms'
      );
    }, 1000);
  });

  describe('REQUEST_TIMEOUT configuration', () => {
    it('should return current timeout value via getRequestTimeout()', () => {
      const timeout = getRequestTimeout();
      expect(typeof timeout).toBe('number');
      expect(timeout).toBeGreaterThan(0);
    });

    it('should use default 120000ms (2 min) when WORKER_REQUEST_TIMEOUT env not set', () => {
      // Note: This test assumes env var is not set during test run
      // If env var is set, the test verifies the getter works correctly
      const timeout = getRequestTimeout();
      // Default is 120000ms unless overridden by env var
      if (!process.env.WORKER_REQUEST_TIMEOUT) {
        expect(timeout).toBe(120000);
      } else {
        expect(timeout).toBe(parseInt(process.env.WORKER_REQUEST_TIMEOUT, 10));
      }
    });

    it('should use timeout from callWorker options over default', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      // Mock fetch to listen to abort signal
      fetchMock.mockImplementation((_url: string, options?: { signal?: AbortSignal }) => {
        return new Promise((_, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }
        });
      });

      // Use very short custom timeout (50ms)
      const customTimeout = 50;
      await expect(callWorker('gitlab', 'test', {}, { timeoutMs: customTimeout })).rejects.toThrow(
        `timeout after ${customTimeout}ms`
      );

      vi.restoreAllMocks();
    }, 1000);
  });

  describe('isWorkerAvailable', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      clearWorkerCache();
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return true when worker health check succeeds', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      const result = await isWorkerAvailable('gitlab');

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/health'),
        expect.any(Object)
      );
    });

    it('should return false when worker health check fails', async () => {
      fetchMock.mockResolvedValue({ ok: false });

      const result = await isWorkerAvailable('slack');

      expect(result).toBe(false);
    });

    it('should return false on network error', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const result = await isWorkerAvailable('redmine');

      expect(result).toBe(false);
    });

    it('should use cache when available', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      await isWorkerAvailable('sharepoint');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await isWorkerAvailable('sharepoint');
      expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, used cache
    });
  });

  describe('getAvailableServices', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      clearWorkerCache();
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return list of available services', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      const services = await getAvailableServices();

      expect(services.length).toBe(5);
      expect(services).toContain('gitlab');
      expect(services).toContain('slack');
      expect(services).toContain('os');
    });

    it('should filter out unavailable services', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('gitlab') || url.includes('slack')) {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: false });
      });

      const services = await getAvailableServices();

      expect(services).toContain('gitlab');
      expect(services).toContain('slack');
      expect(services).not.toContain('redmine');
      expect(services).not.toContain('sharepoint');
    });
  });

  describe('createGitLabBridge', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let bridge: ReturnType<typeof createGitLabBridge>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      bridge = createGitLabBridge();

      // Default mock response
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: '{}' }],
          },
        }),
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should define all GitLab methods from registry', () => {
      const expectedMethods = getServiceMethods('gitlab');

      // Bridge should have exactly the methods defined in registry
      expect(Object.keys(bridge).sort()).toEqual(expectedMethods.sort());

      // Each method should be a function
      expectedMethods.forEach((method) => {
        expect(bridge).toHaveProperty(method);
        expect(typeof bridge[method as keyof typeof bridge]).toBe('function');
      });
    });

    it('should include essential MR methods', () => {
      expect(bridge).toHaveProperty('listMrIds');
      expect(bridge).toHaveProperty('getMrFull');
      expect(bridge).toHaveProperty('createMergeRequest');
      expect(bridge).toHaveProperty('approveMergeRequest');
      expect(bridge).toHaveProperty('mergeMergeRequest');
    });

    it('should include branch methods', () => {
      expect(bridge).toHaveProperty('listBranches');
      expect(bridge).toHaveProperty('createBranch');
      expect(bridge).toHaveProperty('deleteBranch');
    });

    it('should call worker with correct method name for listBranches', async () => {
      await bridge.listBranches({ project_id: '1' });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('listBranches');
      expect(callBody.params.arguments).toEqual({ project_id: '1' });
    });

    it('should call worker with correct method name for getBranch', async () => {
      await bridge.getBranch({ project_id: '1', branch: 'main' });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('getBranch');
      expect(callBody.params.arguments).toEqual({ project_id: '1', branch: 'main' });
    });

    it('should call worker with correct method name for createBranch', async () => {
      await bridge.createBranch({ project_id: '1', branch: 'feature', ref: 'main' });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('createBranch');
      expect(callBody.params.arguments).toEqual({
        project_id: '1',
        branch: 'feature',
        ref: 'main',
      });
    });

    it('should call worker with correct method name for deleteBranch', async () => {
      await bridge.deleteBranch({ project_id: '1', branch: 'old-feature' });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('deleteBranch');
      expect(callBody.params.arguments).toEqual({ project_id: '1', branch: 'old-feature' });
    });

    it('should call worker with correct method name for compareBranches', async () => {
      await bridge.compareBranches({ project_id: '1', from: 'main', to: 'develop' });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('compareBranches');
      expect(callBody.params.arguments).toEqual({ project_id: '1', from: 'main', to: 'develop' });
    });

    it('should call worker with correct method name for listMrNotes', async () => {
      await bridge.listMrNotes({ project_id: '1', mr_iid: 123 });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('listMrNotes');
      expect(callBody.params.arguments).toEqual({ project_id: '1', mr_iid: 123 });
    });

    it('should call worker with correct method name for createMrNote', async () => {
      await bridge.createMrNote({ project_id: '1', mr_iid: 123, body: 'LGTM' });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('createMrNote');
      expect(callBody.params.arguments).toEqual({
        project_id: '1',
        mr_iid: 123,
        body: 'LGTM',
      });
    });

    it('should call worker with correct method name for getTree', async () => {
      await bridge.getTree({ project_id: '1', path: 'src', recursive: true });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('getTree');
      expect(callBody.params.arguments).toEqual({ project_id: '1', path: 'src', recursive: true });
    });

    it('should call worker with correct method name for getFile', async () => {
      await bridge.getFile({ project_id: '1', file_path: 'README.md', ref: 'main' });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('getFile');
      expect(callBody.params.arguments).toEqual({
        project_id: '1',
        file_path: 'README.md',
        ref: 'main',
      });
    });

    it('should call worker with correct method name for listArtifacts', async () => {
      await bridge.listArtifacts({ project_id: '1', pipeline_id: 456 });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('listArtifacts');
      expect(callBody.params.arguments).toEqual({ project_id: '1', pipeline_id: 456 });
    });

    it('should call worker with correct method name for deleteArtifacts', async () => {
      await bridge.deleteArtifacts({ project_id: '1', job_id: 789 });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('deleteArtifacts');
      expect(callBody.params.arguments).toEqual({ project_id: '1', job_id: 789 });
    });

    it('should call worker with correct method name for listCommits', async () => {
      await bridge.listCommits({ project_id: '1', ref: 'main', limit: 10 });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('listCommits');
      expect(callBody.params.arguments).toEqual({ project_id: '1', ref: 'main', limit: 10 });
    });

    it('should call worker with correct method name for searchCommits', async () => {
      await bridge.searchCommits({ project_id: '1', query: 'fix bug', limit: 5 });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('searchCommits');
      expect(callBody.params.arguments).toEqual({ project_id: '1', query: 'fix bug', limit: 5 });
    });

    it('should call worker with correct method name for listIssues', async () => {
      await bridge.listIssues({ project_id: '1', state: 'opened', limit: 20 });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('listIssues');
      expect(callBody.params.arguments).toEqual({ project_id: '1', state: 'opened', limit: 20 });
    });

    it('should call worker with correct method name for createIssue', async () => {
      await bridge.createIssue({
        project_id: '1',
        title: 'Bug report',
        description: 'Found a bug',
      });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('createIssue');
      expect(callBody.params.arguments).toEqual({
        project_id: '1',
        title: 'Bug report',
        description: 'Found a bug',
      });
    });

    it('should call worker with correct method name for closeIssue', async () => {
      await bridge.closeIssue({ project_id: '1', issue_iid: 42 });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('closeIssue');
      expect(callBody.params.arguments).toEqual({ project_id: '1', issue_iid: 42 });
    });

    it('should call worker with correct method name for createLabel', async () => {
      await bridge.createLabel({
        project_id: '1',
        name: 'bug',
        color: '#FF0000',
        description: 'Bug reports',
      });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.name).toBe('createLabel');
      expect(callBody.params.arguments).toEqual({
        project_id: '1',
        name: 'bug',
        color: '#FF0000',
        description: 'Bug reports',
      });
    });

    it('should pass parameters correctly for complex objects', async () => {
      await bridge.triggerPipeline({
        project_id: '1',
        ref: 'main',
        variables: [
          { key: 'ENV', value: 'production' },
          { key: 'VERSION', value: '1.0.0' },
        ],
      });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.params.arguments.variables).toEqual([
        { key: 'ENV', value: 'production' },
        { key: 'VERSION', value: '1.0.0' },
      ]);
    });
  });

  describe('createSlackBridge', () => {
    it('should define all Slack methods', () => {
      const bridge = createSlackBridge();

      expect(bridge).toHaveProperty('listChannelIds');
      expect(bridge).toHaveProperty('getChannelMessages');
      expect(bridge).toHaveProperty('sendChannel');
      expect(bridge).toHaveProperty('getUsers');
      expect(Object.keys(bridge).length).toBe(4);
    });
  });

  describe('createSharePointBridge', () => {
    it('should define all SharePoint methods', () => {
      const bridge = createSharePointBridge();

      expect(bridge).toHaveProperty('listFileIds');
      expect(bridge).toHaveProperty('getFileFull');
      expect(bridge).toHaveProperty('sync');
      expect(bridge).toHaveProperty('syncDirectory');
      expect(bridge).toHaveProperty('getCurrentUser');
      expect(Object.keys(bridge).length).toBe(5);
    });
  });

  describe('createRedmineBridge', () => {
    it('should define all Redmine methods from registry', () => {
      const bridge = createRedmineBridge();
      const expectedMethods = getServiceMethods('redmine');

      // Bridge should have exactly the methods defined in registry
      expect(Object.keys(bridge).sort()).toEqual(expectedMethods.sort());

      // Each method should be a function
      expectedMethods.forEach((method) => {
        expect(bridge).toHaveProperty(method);
        expect(typeof bridge[method as keyof typeof bridge]).toBe('function');
      });
    });

    it('should include essential issue methods', () => {
      const bridge = createRedmineBridge();
      // Core methods that must always exist
      expect(bridge).toHaveProperty('listIssueIds');
      expect(bridge).toHaveProperty('getIssueFull');
      expect(bridge).toHaveProperty('createIssue');
      expect(bridge).toHaveProperty('updateIssue');
    });

    it('should include relation methods (regression test)', () => {
      const bridge = createRedmineBridge();
      // These were missing before SSOT refactor
      expect(bridge).toHaveProperty('listRelations');
      expect(bridge).toHaveProperty('createRelation');
      expect(bridge).toHaveProperty('deleteRelation');
    });
  });

  describe('createOsBridge', () => {
    it('should define all 25 OS methods', () => {
      const bridge = createOsBridge();

      expect(Object.keys(bridge).length).toBe(25);

      // Reminders
      expect(bridge).toHaveProperty('listReminderLists');
      expect(bridge).toHaveProperty('listReminders');
      expect(bridge).toHaveProperty('getReminder');
      expect(bridge).toHaveProperty('createReminder');
      expect(bridge).toHaveProperty('completeReminder');

      // Calendar
      expect(bridge).toHaveProperty('listCalendars');
      expect(bridge).toHaveProperty('listEvents');
      expect(bridge).toHaveProperty('getEvent');
      expect(bridge).toHaveProperty('createEvent');
      expect(bridge).toHaveProperty('updateEvent');
      expect(bridge).toHaveProperty('deleteEvent');

      // Mail
      expect(bridge).toHaveProperty('detectMailClients');
      expect(bridge).toHaveProperty('listMailboxes');
      expect(bridge).toHaveProperty('listEmails');
      expect(bridge).toHaveProperty('getEmail');
      expect(bridge).toHaveProperty('searchEmails');
      expect(bridge).toHaveProperty('sendEmail');
      expect(bridge).toHaveProperty('replyToEmail');

      // Notes
      expect(bridge).toHaveProperty('listNoteFolders');
      expect(bridge).toHaveProperty('listNotes');
      expect(bridge).toHaveProperty('getNote');
      expect(bridge).toHaveProperty('searchNotes');
      expect(bridge).toHaveProperty('createNote');
      expect(bridge).toHaveProperty('updateNote');
      expect(bridge).toHaveProperty('deleteNote');
    });
  });

  describe('callWorker - additional edge cases', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should handle worker response with isError flag', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: 'Error: Service not configured' }],
            isError: true,
          },
        }),
      });

      await expect(callWorker('gitlab', 'list_branches', {})).rejects.toThrow(
        'Error: Service not configured'
      );
    });

    it('should handle non-JSON text response', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: 'plain text response' }],
          },
        }),
      });

      // Now throws error instead of silently returning text as wrong type
      await expect(callWorker('slack', 'send_channel', {})).rejects.toThrow(
        'Worker slack returned invalid response format. Expected JSON but received: plain text response'
      );
    });

    it('should handle empty content array', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [],
          },
        }),
      });

      const result = await callWorker('slack', 'list_channels', {});
      expect(result).toEqual({ content: [] });
    });

    it('should handle missing content text', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text' }],
          },
        }),
      });

      const result = await callWorker('slack', 'test', {});
      expect(result).toEqual({ content: [{ type: 'text' }] });
    });

    it('should handle unknown service', async () => {
      await expect(callWorker('unknown-service', 'test', {})).rejects.toThrow(
        'Unknown service: unknown-service'
      );
    });

    it('should use custom timeout when provided', async () => {
      fetchMock.mockImplementation((_url: string, options?: { signal?: AbortSignal }) => {
        return new Promise((_, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }
        });
      });

      await expect(callWorker('gitlab', 'test', {}, { timeoutMs: 100 })).rejects.toThrow(
        'timeout after 100ms'
      );
    }, 1000);

    it('should handle complex nested JSON response', async () => {
      const complexData = {
        nested: {
          deep: {
            data: [1, 2, 3],
            meta: { count: 3 },
          },
        },
      };

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: JSON.stringify(complexData) }],
          },
        }),
      });

      const result = await callWorker('gitlab', 'test', {});
      expect(result).toEqual(complexData);
    });

    it('should clear timeout on successful response', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: '{}' }],
          },
        }),
      });

      await callWorker('slack', 'test', {});
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it('should log error message on failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      fetchMock.mockRejectedValue(new Error('Network failure'));

      await expect(callWorker('gitlab', 'test', {})).rejects.toThrow('Network failure');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[http-bridge]'),
        'Network failure'
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle non-Error thrown values', async () => {
      fetchMock.mockRejectedValue('string error');

      await expect(callWorker('gitlab', 'test', {})).rejects.toBe('string error');
    });
  });

  describe('SSRF protection', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      clearWorkerCache();
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should reject cloud metadata URL in callWorker', async () => {
      process.env.WORKER_GITLAB_URL = 'http://169.254.169.254:80';

      await expect(callWorker('gitlab', 'list_branches', {})).rejects.toThrow(
        'Unknown service: gitlab'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject external hostname in isWorkerAvailable', async () => {
      process.env.WORKER_SLACK_URL = 'http://evil.com:4001';

      const result = await isWorkerAvailable('slack');

      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject URL with pathname in callWorker', async () => {
      process.env.WORKER_REDMINE_URL = 'http://mcp-redmine:4001/admin/exec';

      await expect(callWorker('redmine', 'list_issues', {})).rejects.toThrow(
        'Unknown service: redmine'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should accept host gateway URL for OS worker', async () => {
      process.env.WORKER_OS_URL = 'http://host.lima.internal:4007';

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: '{"ok":true}' }],
          },
        }),
      });

      const result = await callWorker('os', 'listReminders', {});

      expect(fetchMock).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });

    it('should pass redirect: error in callWorker fetch', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: '123',
          result: {
            content: [{ type: 'text', text: '{}' }],
          },
        }),
      });

      await callWorker('gitlab', 'test', {});

      expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    });

    it('should pass redirect: error in isWorkerAvailable fetch', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      await isWorkerAvailable('gitlab');

      expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    });
  });

  describe('parseServiceError', () => {
    it('should extract GitBeaker cause.description', () => {
      const error = { cause: { description: 'Invalid parameter: ref' } };
      expect(parseServiceError(error, 'gitlab')).toBe('gitlab: Invalid parameter: ref');
    });

    it('should extract response.body.message', () => {
      const error = { response: { body: { message: 'Branch not found' } } };
      expect(parseServiceError(error, 'gitlab')).toBe('gitlab: Branch not found');
    });

    it('should extract response.body.error', () => {
      const error = { response: { body: { error: 'Invalid request' } } };
      expect(parseServiceError(error, 'slack')).toBe('slack: Invalid request');
    });

    it('should handle HTTP 404 status', () => {
      const error = { response: { status: 404 } };
      expect(parseServiceError(error, 'gitlab')).toBe('gitlab: Resource not found');
    });

    it('should handle HTTP 401 status', () => {
      const error = { response: { status: 401 } };
      expect(parseServiceError(error, 'gitlab')).toBe(
        'gitlab: Authentication failed - check token'
      );
    });

    it('should handle HTTP 403 status', () => {
      const error = { response: { status: 403 } };
      expect(parseServiceError(error, 'sharepoint')).toBe(
        'sharepoint: Permission denied - insufficient privileges'
      );
    });

    it('should handle HTTP 429 status', () => {
      const error = { response: { status: 429 } };
      expect(parseServiceError(error, 'gitlab')).toBe(
        'gitlab: Rate limit exceeded - try again later'
      );
    });

    it('should handle unknown HTTP status', () => {
      const error = { response: { status: 418 } };
      expect(parseServiceError(error, 'api')).toBe('api: HTTP error 418');
    });

    it('should handle ECONNREFUSED network error', () => {
      const error = { code: 'ECONNREFUSED' };
      expect(parseServiceError(error, 'slack')).toBe(
        'slack: Connection refused - service not reachable'
      );
    });

    it('should handle ETIMEDOUT network error', () => {
      const error = { code: 'ETIMEDOUT' };
      expect(parseServiceError(error, 'gitlab')).toBe(
        'gitlab: Connection timeout - service not responding'
      );
    });

    it('should handle ENOTFOUND network error', () => {
      const error = { code: 'ENOTFOUND' };
      expect(parseServiceError(error, 'redmine')).toBe('redmine: Host not found - check URL');
    });

    it('should handle object message (GitBeaker style)', () => {
      const error = new Error('ignored');
      (error as unknown as { message: object }).message = { error: 'API failed' };
      expect(parseServiceError(error, 'gitlab')).toBe('gitlab: {"error":"API failed"}');
    });

    it('should handle standard Error message', () => {
      const error = new Error('Something went wrong');
      expect(parseServiceError(error, 'api')).toBe('api: Something went wrong');
    });

    it('should work without service prefix', () => {
      const error = { message: 'test error' };
      expect(parseServiceError(error, '')).toBe('test error');
    });

    it('should handle primitive string error', () => {
      expect(parseServiceError('string error', 'service')).toBe('service: string error');
    });

    it('should handle primitive number error', () => {
      expect(parseServiceError(42, 'service')).toBe('service: 42');
    });

    it('should return "Unknown error" for empty object', () => {
      expect(parseServiceError({}, 'api')).toBe('api: Unknown error');
    });

    it('should prioritize cause.description over response.body', () => {
      const error = {
        cause: { description: 'Cause error' },
        response: { body: { message: 'Body error' } },
      };
      expect(parseServiceError(error, 'gitlab')).toBe('gitlab: Cause error');
    });

    it('should prioritize response.body.message over status code', () => {
      const error = {
        response: {
          status: 400,
          body: { message: 'Specific error message' },
        },
      };
      expect(parseServiceError(error, 'api')).toBe('api: Specific error message');
    });
  });
});

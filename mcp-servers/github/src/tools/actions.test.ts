/**
 * Actions Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, META_KEYS } from '@speedwave/mcp-shared';
import { createActionsTools } from './actions-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  listWorkflowRuns: Mock;
  getWorkflowRun: Mock;
  getRunLogs: Mock;
  rerunWorkflow: Mock;
  triggerWorkflow: Mock;
  listWorkflowRunArtifacts: Mock;
  downloadArtifact: Mock;
};

const createMockClient = (): MockClient => ({
  listWorkflowRuns: vi.fn(),
  getWorkflowRun: vi.fn(),
  getRunLogs: vi.fn(),
  rerunWorkflow: vi.fn(),
  triggerWorkflow: vi.fn(),
  listWorkflowRunArtifacts: vi.fn(),
  downloadArtifact: vi.fn(),
});

const findHandler = (tools: ReturnType<typeof createActionsTools>, name: string) =>
  tools.find((t) => t.tool.name === name)!.handler;

const json = (data: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const notConfigured = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

const rawRun = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `run ${id}`,
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: `sha${id}`,
  html_url: `https://github.com/octocat/hello-world/actions/runs/${id}`,
  ...overrides,
});

const runSummary = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `run ${id}`,
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: `sha${id}`,
  html_url: `https://github.com/octocat/hello-world/actions/runs/${id}`,
  ...overrides,
});

const ALL_TOOLS = [
  'listWorkflowRuns',
  'getWorkflowRun',
  'getRunLogs',
  'rerunWorkflow',
  'triggerWorkflow',
  'listWorkflowRunArtifacts',
  'downloadArtifact',
];

describe('actions-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes exactly the 7 expected tools', () => {
    expect(createActionsTools(null).map((t) => t.tool.name)).toEqual(ALL_TOOLS);
  });

  it('eagerly loads only listWorkflowRuns', () => {
    const tools = createActionsTools(null);
    expect(tools.find((t) => t.tool.name === 'listWorkflowRuns')!.tool._meta).toEqual({
      [META_KEYS.DEFER_LOADING]: false,
    });
    expect(
      tools
        .filter((t) => t.tool.name !== 'listWorkflowRuns')
        .every((t) => t.tool._meta![META_KEYS.DEFER_LOADING] === true)
    ).toBe(true);
  });

  describe('unconfigured client', () => {
    it.each(ALL_TOOLS)('returns not-configured error for %s', async (name) => {
      const handler = findHandler(createActionsTools(null), name);
      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        run_id: 1,
        workflow_id: 'ci.yml',
        ref: 'main',
        artifact_id: 1,
      });
      expect(result).toEqual(notConfigured);
    });
  });

  describe('listWorkflowRuns', () => {
    it('returns mapped run summaries with count for minimal input', async () => {
      const client = createMockClient();
      client.listWorkflowRuns.mockResolvedValue([
        rawRun(10),
        rawRun(11, { conclusion: null, name: undefined }),
      ]);
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'listWorkflowRuns'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual(
        json({
          runs: [runSummary(10), runSummary(11, { conclusion: null, name: undefined })],
          count: 2,
        })
      );
      expect(client.listWorkflowRuns).toHaveBeenCalledWith('octocat', 'hello-world', {});
    });

    it('forwards branch/status/limit filters', async () => {
      const client = createMockClient();
      client.listWorkflowRuns.mockResolvedValue([]);
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'listWorkflowRuns'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        branch: 'main',
        status: 'completed',
        limit: 20,
      });

      expect(client.listWorkflowRuns).toHaveBeenCalledWith('octocat', 'hello-world', {
        branch: 'main',
        status: 'completed',
        limit: 20,
      });
    });

    it('returns an empty list with count 0', async () => {
      const client = createMockClient();
      client.listWorkflowRuns.mockResolvedValue([]);
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'listWorkflowRuns'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual(json({ runs: [], count: 0 }));
    });

    it('maps a 401 error via the client formatter', async () => {
      const client = createMockClient();
      client.listWorkflowRuns.mockRejectedValue({ status: 401, message: 'Bad credentials' });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'listWorkflowRuns'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Authentication failed');
    });
  });

  describe('getWorkflowRun', () => {
    it('returns the mapped run and passes run_id through', async () => {
      const client = createMockClient();
      const run = {
        ...rawRun(42),
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };
      client.getWorkflowRun.mockResolvedValue(run);
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'getWorkflowRun'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', run_id: 42 });

      expect(result).toEqual(json(run));
      expect(client.getWorkflowRun).toHaveBeenCalledWith('octocat', 'hello-world', 42);
    });

    it('returns an error result on 404', async () => {
      const client = createMockClient();
      client.getWorkflowRun.mockRejectedValue({ status: 404 });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'getWorkflowRun'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', run_id: 99 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found');
    });
  });

  describe('getRunLogs', () => {
    it('returns the download URL payload', async () => {
      const client = createMockClient();
      client.getRunLogs.mockResolvedValue({
        download_url: 'https://logs.example/abc',
        note: 'ZIP, valid ~1 min',
      });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'getRunLogs'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', run_id: 42 });

      expect(result).toEqual(
        json({ download_url: 'https://logs.example/abc', note: 'ZIP, valid ~1 min' })
      );
      expect(client.getRunLogs).toHaveBeenCalledWith('octocat', 'hello-world', 42);
    });

    it('returns an error result when the client throws', async () => {
      const client = createMockClient();
      client.getRunLogs.mockRejectedValue(new Error('no logs'));
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'getRunLogs'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', run_id: 42 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: no logs' }],
        isError: true,
      });
    });
  });

  describe('rerunWorkflow', () => {
    it('returns the rerun confirmation', async () => {
      const client = createMockClient();
      client.rerunWorkflow.mockResolvedValue({ rerun: true });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'rerunWorkflow'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', run_id: 42 });

      expect(result).toEqual(json({ rerun: true }));
      expect(client.rerunWorkflow).toHaveBeenCalledWith('octocat', 'hello-world', 42);
    });

    it('returns an error result on permission denied', async () => {
      const client = createMockClient();
      client.rerunWorkflow.mockRejectedValue({ status: 403, response: { headers: {} } });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'rerunWorkflow'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', run_id: 42 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });
  });

  describe('triggerWorkflow', () => {
    it('passes workflow_id and ref without inputs', async () => {
      const client = createMockClient();
      client.triggerWorkflow.mockResolvedValue({
        triggered: true,
        workflow_id: 'ci.yml',
        ref: 'main',
      });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'triggerWorkflow'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        workflow_id: 'ci.yml',
        ref: 'main',
      });

      expect(result).toEqual(json({ triggered: true, workflow_id: 'ci.yml', ref: 'main' }));
      expect(client.triggerWorkflow).toHaveBeenCalledWith('octocat', 'hello-world', {
        workflow_id: 'ci.yml',
        ref: 'main',
      });
    });

    it('forwards dispatch inputs and a numeric workflow_id', async () => {
      const client = createMockClient();
      client.triggerWorkflow.mockResolvedValue({
        triggered: true,
        workflow_id: 12345,
        ref: 'release/1.0',
      });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'triggerWorkflow'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        workflow_id: 12345,
        ref: 'release/1.0',
        inputs: { environment: 'staging' },
      });

      expect(client.triggerWorkflow).toHaveBeenCalledWith('octocat', 'hello-world', {
        workflow_id: 12345,
        ref: 'release/1.0',
        inputs: { environment: 'staging' },
      });
    });

    it('returns an error result on 422', async () => {
      const client = createMockClient();
      client.triggerWorkflow.mockRejectedValue({
        status: 422,
        message: 'no workflow_dispatch trigger',
      });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'triggerWorkflow'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        workflow_id: 'ci.yml',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: GitHub validation error: no workflow_dispatch trigger' },
        ],
        isError: true,
      });
    });
  });

  describe('listWorkflowRunArtifacts', () => {
    it('returns mapped artifacts with count and an undefined limit', async () => {
      const client = createMockClient();
      client.listWorkflowRunArtifacts.mockResolvedValue([
        { id: 1, name: 'build', size_in_bytes: 1024, archive_download_url: 'u1', expired: false },
        { id: 2, name: 'coverage', size_in_bytes: 2048, archive_download_url: 'u2', expired: true },
      ]);
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'listWorkflowRunArtifacts'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', run_id: 42 });

      expect(result).toEqual(
        json({
          artifacts: [
            { id: 1, name: 'build', size_in_bytes: 1024, expired: false },
            { id: 2, name: 'coverage', size_in_bytes: 2048, expired: true },
          ],
          count: 2,
        })
      );
      expect(client.listWorkflowRunArtifacts).toHaveBeenCalledWith('octocat', 'hello-world', 42, {
        limit: undefined,
      });
    });

    it('forwards the limit option', async () => {
      const client = createMockClient();
      client.listWorkflowRunArtifacts.mockResolvedValue([]);
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'listWorkflowRunArtifacts'
      );

      await handler({ owner: 'octocat', repo: 'hello-world', run_id: 42, limit: 10 });

      expect(client.listWorkflowRunArtifacts).toHaveBeenCalledWith('octocat', 'hello-world', 42, {
        limit: 10,
      });
    });

    it('returns an empty list with count 0', async () => {
      const client = createMockClient();
      client.listWorkflowRunArtifacts.mockResolvedValue([]);
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'listWorkflowRunArtifacts'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', run_id: 42 });

      expect(result).toEqual(json({ artifacts: [], count: 0 }));
    });
  });

  describe('downloadArtifact', () => {
    it('returns the download URL payload and passes artifact_id', async () => {
      const client = createMockClient();
      client.downloadArtifact.mockResolvedValue({
        download_url: 'https://artifacts.example/zip',
        note: 'ZIP, valid ~1 min',
      });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'downloadArtifact'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', artifact_id: 7 });

      expect(result).toEqual(
        json({ download_url: 'https://artifacts.example/zip', note: 'ZIP, valid ~1 min' })
      );
      expect(client.downloadArtifact).toHaveBeenCalledWith('octocat', 'hello-world', 7);
    });

    it('returns an error result on 404', async () => {
      const client = createMockClient();
      client.downloadArtifact.mockRejectedValue({ status: 404 });
      const handler = findHandler(
        createActionsTools(client as unknown as GitHubClient),
        'downloadArtifact'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', artifact_id: 7 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found');
    });
  });
});

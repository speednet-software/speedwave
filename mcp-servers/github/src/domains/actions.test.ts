import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createActionsClient } from './actions.js';

function createMockOctokit() {
  return {
    rest: {
      actions: {
        listWorkflowRunsForRepo: vi.fn(),
        getWorkflowRun: vi.fn(),
        downloadWorkflowRunLogs: vi.fn(),
        reRunWorkflow: vi.fn(),
        createWorkflowDispatch: vi.fn(),
        listWorkflowRunArtifacts: vi.fn(),
        downloadArtifact: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
}

const rawRun = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'CI',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: 'abc',
  html_url: 'https://github.com/octocat/hello/actions/runs/1',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
  ...overrides,
});

describe('ActionsClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createActionsClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createActionsClient(mock as unknown as Octokit);
  });

  describe('listRuns', () => {
    it('lists workflow runs and maps them', async () => {
      mock.paginate.mockResolvedValue([rawRun(), rawRun({ id: 2 })]);

      const result = await client.listRuns('octocat', 'hello');

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.actions.listWorkflowRunsForRepo, {
        owner: 'octocat',
        repo: 'hello',
        branch: undefined,
        status: undefined,
        per_page: 100,
      });
      expect(result[0]).toEqual({
        id: 1,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        head_branch: 'main',
        head_sha: 'abc',
        html_url: 'https://github.com/octocat/hello/actions/runs/1',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      });
    });

    it('passes branch/status filters and truncates to the limit', async () => {
      mock.paginate.mockResolvedValue(Array.from({ length: 10 }, (_, i) => rawRun({ id: i })));

      const result = await client.listRuns('octocat', 'hello', {
        branch: 'main',
        status: 'in_progress',
        limit: 3,
      });

      expect(result).toHaveLength(3);
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.actions.listWorkflowRunsForRepo, {
        owner: 'octocat',
        repo: 'hello',
        branch: 'main',
        status: 'in_progress',
        per_page: 3,
      });
    });

    it('defends against missing fields and a null conclusion', async () => {
      mock.paginate.mockResolvedValue([{ id: 9, conclusion: null }]);

      const result = await client.listRuns('octocat', 'hello');

      expect(result[0]).toEqual({
        id: 9,
        name: undefined,
        status: '',
        conclusion: null,
        head_branch: '',
        head_sha: '',
        html_url: '',
        created_at: '',
        updated_at: '',
      });
    });
  });

  describe('getRun', () => {
    it('gets a workflow run by id', async () => {
      mock.rest.actions.getWorkflowRun.mockResolvedValue({ data: rawRun() });

      const result = await client.getRun('octocat', 'hello', 1);

      expect(mock.rest.actions.getWorkflowRun).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        run_id: 1,
      });
      expect(result.id).toBe(1);
    });

    it('propagates API errors', async () => {
      mock.rest.actions.getWorkflowRun.mockRejectedValue(new Error('not_found'));

      await expect(client.getRun('octocat', 'hello', 99)).rejects.toThrow('not_found');
    });
  });

  describe('getRunLogsUrl', () => {
    it('returns the redirect URL for the logs archive', async () => {
      mock.rest.actions.downloadWorkflowRunLogs.mockResolvedValue({
        headers: { location: 'https://logs.example/zip' },
      });

      const result = await client.getRunLogsUrl('octocat', 'hello', 1);

      expect(mock.rest.actions.downloadWorkflowRunLogs).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        run_id: 1,
        request: { redirect: 'manual' },
      });
      expect(result).toBe('https://logs.example/zip');
    });

    it('falls back to res.url when the Location header is absent', async () => {
      mock.rest.actions.downloadWorkflowRunLogs.mockResolvedValue({
        url: 'https://fallback/zip',
      });

      const result = await client.getRunLogsUrl('octocat', 'hello', 1);

      expect(result).toBe('https://fallback/zip');
    });

    it('returns an empty string when no URL is present', async () => {
      mock.rest.actions.downloadWorkflowRunLogs.mockResolvedValue({});

      const result = await client.getRunLogsUrl('octocat', 'hello', 1);

      expect(result).toBe('');
    });
  });

  describe('rerun', () => {
    it('re-runs a workflow run', async () => {
      mock.rest.actions.reRunWorkflow.mockResolvedValue({});

      await client.rerun('octocat', 'hello', 1);

      expect(mock.rest.actions.reRunWorkflow).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        run_id: 1,
      });
    });
  });

  describe('triggerDispatch', () => {
    it('triggers a workflow_dispatch event with inputs', async () => {
      mock.rest.actions.createWorkflowDispatch.mockResolvedValue({});

      await client.triggerDispatch('octocat', 'hello', {
        workflow_id: 'ci.yml',
        ref: 'main',
        inputs: { env: 'prod' },
      });

      expect(mock.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        workflow_id: 'ci.yml',
        ref: 'main',
        inputs: { env: 'prod' },
      });
    });

    it('accepts a numeric workflow id and no inputs', async () => {
      mock.rest.actions.createWorkflowDispatch.mockResolvedValue({});

      await client.triggerDispatch('octocat', 'hello', { workflow_id: 42, ref: 'main' });

      expect(mock.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        workflow_id: 42,
        ref: 'main',
        inputs: undefined,
      });
    });
  });

  describe('listArtifacts', () => {
    it('lists run artifacts and maps them', async () => {
      mock.paginate.mockResolvedValue([
        {
          id: 1,
          name: 'build-output',
          size_in_bytes: 1024,
          archive_download_url: 'https://api.github.com/.../zip',
          expired: false,
        },
      ]);

      const result = await client.listArtifacts('octocat', 'hello', 1);

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.actions.listWorkflowRunArtifacts, {
        owner: 'octocat',
        repo: 'hello',
        run_id: 1,
        per_page: 100,
      });
      expect(result[0]).toEqual({
        id: 1,
        name: 'build-output',
        size_in_bytes: 1024,
        archive_download_url: 'https://api.github.com/.../zip',
        expired: false,
      });
    });

    it('truncates to the limit and defends against missing fields', async () => {
      mock.paginate.mockResolvedValue(Array.from({ length: 5 }, () => ({})));

      const result = await client.listArtifacts('octocat', 'hello', 1, { limit: 2 });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: NaN,
        name: '',
        size_in_bytes: 0,
        archive_download_url: '',
        expired: false,
      });
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.actions.listWorkflowRunArtifacts, {
        owner: 'octocat',
        repo: 'hello',
        run_id: 1,
        per_page: 2,
      });
    });
  });

  describe('getArtifactDownloadUrl', () => {
    it('returns the redirect URL for the artifact archive', async () => {
      mock.rest.actions.downloadArtifact.mockResolvedValue({
        headers: { location: 'https://artifact.example/zip' },
      });

      const result = await client.getArtifactDownloadUrl('octocat', 'hello', 5);

      expect(mock.rest.actions.downloadArtifact).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        artifact_id: 5,
        archive_format: 'zip',
        request: { redirect: 'manual' },
      });
      expect(result).toBe('https://artifact.example/zip');
    });

    it('falls back to res.url when the Location header is absent', async () => {
      mock.rest.actions.downloadArtifact.mockResolvedValue({ url: 'https://fallback/zip' });

      const result = await client.getArtifactDownloadUrl('octocat', 'hello', 5);

      expect(result).toBe('https://fallback/zip');
    });

    it('returns an empty string when no URL is present', async () => {
      mock.rest.actions.downloadArtifact.mockResolvedValue({});

      const result = await client.getArtifactDownloadUrl('octocat', 'hello', 5);

      expect(result).toBe('');
    });
  });
});

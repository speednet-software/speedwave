import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPipelinesClient } from './pipelines.js';

// Create inline mock
function createMockGitlab() {
  return {
    Pipelines: {
      all: vi.fn(),
      show: vi.fn(),
      retry: vi.fn(),
      create: vi.fn(),
    },
    Jobs: {
      all: vi.fn(),
      showLog: vi.fn(),
    },
  };
}

describe('PipelinesClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ReturnType<typeof createPipelinesClient>;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createPipelinesClient(mockGitlab as any);
  });

  describe('list', () => {
    it('should list pipelines with default options', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'success',
          ref: 'main',
          sha: 'abc123',
          webUrl: 'https://gitlab.com/pipeline/1',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T01:00:00Z',
        },
        {
          id: 2,
          status: 'running',
          ref: 'develop',
          sha: 'def456',
          web_url: 'https://gitlab.com/pipeline/2',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T01:00:00Z',
        },
      ];
      mockGitlab.Pipelines.all.mockResolvedValue(mockPipelines);

      const result = await client.list('project-123');

      expect(mockGitlab.Pipelines.all).toHaveBeenCalledWith('project-123', {
        status: undefined,
        ref: undefined,
        perPage: 5,
        page: 1,
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 1,
        status: 'success',
        ref: 'main',
        sha: 'abc123',
      });
    });

    it('should list pipelines with filters', async () => {
      const mockPipelines = [
        {
          id: 3,
          status: 'failed',
          ref: 'feature-branch',
          sha: 'ghi789',
          webUrl: 'https://gitlab.com/pipeline/3',
          created_at: '2024-01-03T00:00:00Z',
          updated_at: '2024-01-03T01:00:00Z',
        },
      ];
      mockGitlab.Pipelines.all.mockResolvedValue(mockPipelines);

      const result = await client.list('project-123', {
        status: 'failed',
        ref: 'feature-branch',
        limit: 10,
        page: 2,
      });

      expect(mockGitlab.Pipelines.all).toHaveBeenCalledWith('project-123', {
        status: 'failed',
        ref: 'feature-branch',
        perPage: 10,
        page: 2,
      });
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('failed');
    });

    it('should handle different status values', async () => {
      const statuses = ['running', 'pending', 'success', 'failed', 'canceled', 'skipped'];

      for (const status of statuses) {
        const mockPipelines = [
          {
            id: 100,
            status,
            ref: 'main',
            sha: 'abc123',
            webUrl: 'https://gitlab.com/pipeline/100',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T01:00:00Z',
          },
        ];
        mockGitlab.Pipelines.all.mockResolvedValue(mockPipelines);

        const result = await client.list('project-123', { status });

        expect(result[0].status).toBe(status);
      }
    });
  });

  describe('show', () => {
    it('should show pipeline details with jobs', async () => {
      const mockPipeline = {
        id: 1,
        status: 'success',
        ref: 'main',
        sha: 'abc123',
      };
      const mockJobs = [
        {
          id: 10,
          name: 'test',
          status: 'success',
        },
        {
          id: 11,
          name: 'build',
          status: 'success',
        },
      ];
      mockGitlab.Pipelines.show.mockResolvedValue(mockPipeline);
      mockGitlab.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.show('project-123', 1);

      expect(mockGitlab.Pipelines.show).toHaveBeenCalledWith('project-123', 1);
      expect(mockGitlab.Jobs.all).toHaveBeenCalledWith('project-123', { pipelineId: 1 });
      expect(result).toEqual({
        pipeline: mockPipeline,
        jobs: mockJobs,
      });
    });

    it('should handle numeric project IDs', async () => {
      const mockPipeline = { id: 2, status: 'failed' };
      const mockJobs: unknown[] = [];
      mockGitlab.Pipelines.show.mockResolvedValue(mockPipeline);
      mockGitlab.Jobs.all.mockResolvedValue(mockJobs);

      const result = (await client.show(12345, 2)) as { pipeline: unknown; jobs: unknown[] };

      expect(mockGitlab.Pipelines.show).toHaveBeenCalledWith(12345, 2);
      expect(result.pipeline).toEqual(mockPipeline);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('getJobLog', () => {
    it('should get full job log', async () => {
      const mockLog = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      mockGitlab.Jobs.showLog.mockResolvedValue(mockLog);

      const result = await client.getJobLog('project-123', 100);

      expect(mockGitlab.Jobs.showLog).toHaveBeenCalledWith('project-123', 100);
      expect(result).toBe(mockLog);
    });

    it('should tail job log to specified number of lines', async () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
      const mockLog = lines.join('\n');
      mockGitlab.Jobs.showLog.mockResolvedValue(mockLog);

      const result = await client.getJobLog('project-123', 100, 50);

      expect(result.split('\n')).toHaveLength(50);
      expect(result).toContain('Line 200');
      expect(result).toContain('Line 151');
      expect(result).not.toContain('Line 150');
    });

    it('should return full log if shorter than tail limit', async () => {
      const mockLog = 'Line 1\nLine 2\nLine 3';
      mockGitlab.Jobs.showLog.mockResolvedValue(mockLog);

      const result = await client.getJobLog('project-123', 100, 100);

      expect(result).toBe(mockLog);
    });

    it('should use default tail limit of 100 lines', async () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
      const mockLog = lines.join('\n');
      mockGitlab.Jobs.showLog.mockResolvedValue(mockLog);

      const result = await client.getJobLog('project-123', 100);

      expect(result.split('\n')).toHaveLength(100);
      expect(result).toContain('Line 200');
      expect(result).toContain('Line 101');
    });
  });

  describe('retry', () => {
    it('should retry a failed pipeline', async () => {
      const mockPipeline = {
        id: 5,
        status: 'pending',
        ref: 'main',
        sha: 'abc123',
        webUrl: 'https://gitlab.com/pipeline/5',
        createdAt: '2024-01-05T00:00:00Z',
        updatedAt: '2024-01-05T01:00:00Z',
      };
      mockGitlab.Pipelines.retry.mockResolvedValue(mockPipeline);

      const result = await client.retry('project-123', 5);

      expect(mockGitlab.Pipelines.retry).toHaveBeenCalledWith('project-123', 5);
      expect(result).toMatchObject({
        id: 5,
        status: 'pending',
        ref: 'main',
        sha: 'abc123',
        web_url: 'https://gitlab.com/pipeline/5',
      });
    });

    it('should handle numeric project IDs', async () => {
      const mockPipeline = {
        id: 6,
        status: 'running',
        ref: 'develop',
        sha: 'def456',
        webUrl: 'https://gitlab.com/pipeline/6',
        createdAt: '2024-01-06T00:00:00Z',
        updatedAt: '2024-01-06T01:00:00Z',
      };
      mockGitlab.Pipelines.retry.mockResolvedValue(mockPipeline);

      const result = await client.retry(12345, 6);

      expect(mockGitlab.Pipelines.retry).toHaveBeenCalledWith(12345, 6);
      expect(result.id).toBe(6);
    });
  });

  describe('trigger', () => {
    it('should trigger a pipeline without variables', async () => {
      const mockPipeline = {
        id: 7,
        status: 'pending',
        ref: 'main',
        sha: 'xyz789',
        webUrl: 'https://gitlab.com/pipeline/7',
        createdAt: '2024-01-07T00:00:00Z',
        updatedAt: '2024-01-07T00:00:00Z',
      };
      mockGitlab.Pipelines.create.mockResolvedValue(mockPipeline);

      const result = await client.trigger('project-123', { ref: 'main' });

      expect(mockGitlab.Pipelines.create).toHaveBeenCalledWith('project-123', 'main', {
        variables: undefined,
      });
      expect(result).toMatchObject({
        id: 7,
        status: 'pending',
        ref: 'main',
        sha: 'xyz789',
      });
    });

    it('should trigger a pipeline with variables', async () => {
      const mockPipeline = {
        id: 8,
        status: 'pending',
        ref: 'feature-branch',
        sha: 'uvw012',
        webUrl: 'https://gitlab.com/pipeline/8',
        createdAt: '2024-01-08T00:00:00Z',
        updatedAt: '2024-01-08T00:00:00Z',
      };
      mockGitlab.Pipelines.create.mockResolvedValue(mockPipeline);

      const result = await client.trigger('project-123', {
        ref: 'feature-branch',
        variables: [
          { key: 'DEPLOY_ENV', value: 'staging' },
          { key: 'DEBUG', value: 'true' },
        ],
      });

      expect(mockGitlab.Pipelines.create).toHaveBeenCalledWith('project-123', 'feature-branch', {
        variables: [
          { key: 'DEPLOY_ENV', value: 'staging' },
          { key: 'DEBUG', value: 'true' },
        ],
      });
      expect(result.ref).toBe('feature-branch');
    });

    it('should handle numeric project IDs', async () => {
      const mockPipeline = {
        id: 9,
        status: 'pending',
        ref: 'develop',
        sha: 'rst345',
        webUrl: 'https://gitlab.com/pipeline/9',
        createdAt: '2024-01-09T00:00:00Z',
        updatedAt: '2024-01-09T00:00:00Z',
      };
      mockGitlab.Pipelines.create.mockResolvedValue(mockPipeline);

      const result = await client.trigger(12345, {
        ref: 'develop',
        variables: [{ key: 'VERSION', value: '1.0.0' }],
      });

      expect(mockGitlab.Pipelines.create).toHaveBeenCalledWith(12345, 'develop', {
        variables: [{ key: 'VERSION', value: '1.0.0' }],
      });
      expect(result.id).toBe(9);
    });
  });
});

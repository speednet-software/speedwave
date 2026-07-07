import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, withSetupGuidance } from '@speedwave/mcp-shared';
import { createPipelineTools } from './pipeline-tools.js';
import type { GitLabClient } from '../client.js';

type MockClient = {
  listPipelines: Mock;
  showPipeline: Mock;
  getJobLog: Mock;
  retryPipeline: Mock;
  triggerPipeline: Mock;
};

const createMockClient = (): MockClient => ({
  listPipelines: vi.fn(),
  showPipeline: vi.fn(),
  getJobLog: vi.fn(),
  retryPipeline: vi.fn(),
  triggerPipeline: vi.fn(),
});

describe('pipeline-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  describe('listPipelineIds', () => {
    it('lists pipeline IDs successfully', async () => {
      mockClient.listPipelines.mockResolvedValue([
        { id: 1, ref: 'main', status: 'success' },
        { id: 2, ref: 'develop', status: 'running' },
        { id: 3, ref: 'feature', status: 'failed' },
      ]);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      const result = await handler!({ project_id: 'test-project' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                pipelines: [
                  { id: 1, ref: 'main', status: 'success' },
                  { id: 2, ref: 'develop', status: 'running' },
                  { id: 3, ref: 'feature', status: 'failed' },
                ],
                count: 3,
              },
              null,
              2
            ),
          },
        ],
      });
      expect(mockClient.listPipelines).toHaveBeenCalledWith('test-project', {});
    });

    it('handles numeric project_id', async () => {
      mockClient.listPipelines.mockResolvedValue([]);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      await handler!({ project_id: 123 });

      expect(mockClient.listPipelines).toHaveBeenCalledWith(123, {});
    });

    it('filters by ref parameter', async () => {
      mockClient.listPipelines.mockResolvedValue([{ id: 1, ref: 'main', status: 'success' }]);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      await handler!({ project_id: 'test-project', ref: 'main' });

      expect(mockClient.listPipelines).toHaveBeenCalledWith('test-project', { ref: 'main' });
    });

    it('filters by status parameter', async () => {
      mockClient.listPipelines.mockResolvedValue([{ id: 1, ref: 'main', status: 'success' }]);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      await handler!({ project_id: 'test-project', status: 'success' });

      expect(mockClient.listPipelines).toHaveBeenCalledWith('test-project', { status: 'success' });
    });

    it('handles limit parameter', async () => {
      mockClient.listPipelines.mockResolvedValue([]);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      await handler!({ project_id: 'test-project', limit: 50 });

      expect(mockClient.listPipelines).toHaveBeenCalledWith('test-project', { limit: 50 });
    });

    it('handles multiple filters together', async () => {
      mockClient.listPipelines.mockResolvedValue([]);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      await handler!({
        project_id: 'test-project',
        ref: 'develop',
        status: 'running',
        limit: 20,
      });

      expect(mockClient.listPipelines).toHaveBeenCalledWith('test-project', {
        ref: 'develop',
        status: 'running',
        limit: 20,
      });
    });

    it('handles empty results', async () => {
      mockClient.listPipelines.mockResolvedValue([]);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      const result = await handler!({ project_id: 'test-project' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ pipelines: [], count: 0 }, null, 2),
          },
        ],
      });
    });

    it('handles API errors gracefully', async () => {
      mockClient.listPipelines.mockRejectedValue(new Error('Network error'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      const result = await handler!({ project_id: 'test-project' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Network error. Check your GitLab URL.')}`,
          },
        ],
        isError: true,
      });
    });

    it('references getPipelineFull (not the non-existent get_pipeline_full) for details', () => {
      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listPipelineIds')?.tool;

      expect(tool?.description).toContain('getPipelineFull');
      expect(tool?.description).not.toContain('get_pipeline_full');
    });

    it('declares a status enum on input and output that includes "skipped"', () => {
      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listPipelineIds')?.tool;

      const inputStatus = tool?.inputSchema.properties.status as { enum?: string[] };
      expect(inputStatus.enum).toContain('skipped');

      const outputProps = tool?.outputSchema?.properties as Record<string, unknown>;
      const pipelinesItemProps = (
        outputProps.pipelines as { items: { properties: Record<string, unknown> } }
      ).items.properties;
      const outputStatus = pipelinesItemProps.status as { enum?: string[] };
      expect(outputStatus.enum).toContain('skipped');
    });
  });

  describe('getPipelineFull', () => {
    it('retrieves full pipeline data successfully', async () => {
      const mockPipeline = {
        id: 123,
        iid: 45,
        project_id: 1,
        status: 'success',
        ref: 'main',
        sha: 'abc123def456',
        web_url: 'https://gitlab.com/project/pipelines/123',
        created_at: '2025-01-01T10:00:00.000Z',
        updated_at: '2025-01-01T10:30:00.000Z',
        user: { id: 1, username: 'testuser', name: 'Test User' },
        coverage: '95.5',
        duration: 1800,
      };

      mockClient.showPipeline.mockResolvedValue(mockPipeline);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getPipelineFull')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockPipeline, null, 2),
          },
        ],
      });
      expect(mockClient.showPipeline).toHaveBeenCalledWith('test-project', 123);
    });

    it('handles numeric project_id', async () => {
      mockClient.showPipeline.mockResolvedValue({ id: 123, status: 'success' });

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getPipelineFull')?.handler;

      await handler!({ project_id: 456, pipeline_id: 123 });

      expect(mockClient.showPipeline).toHaveBeenCalledWith(456, 123);
    });

    it('documents that duration can be absent/null while the pipeline is running', () => {
      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getPipelineFull')?.tool;

      const outputProps = tool?.outputSchema?.properties as Record<string, unknown>;
      const pipelineProps = (outputProps.pipeline as { properties: Record<string, unknown> })
        .properties;
      const durationProp = pipelineProps.duration as { description?: string };
      expect(durationProp.description).toContain('running');
    });

    it('handles non-existent pipeline', async () => {
      mockClient.showPipeline.mockRejectedValue(new Error('404 Pipeline not found'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getPipelineFull')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 9999 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
    });

    it('handles permission errors', async () => {
      mockClient.showPipeline.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getPipelineFull')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 123 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });

    it('accepts a "#"-prefixed pipeline_id', async () => {
      mockClient.showPipeline.mockResolvedValue({ id: 123, status: 'success' });

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getPipelineFull')?.handler;

      await handler!({ project_id: 'test-project', pipeline_id: '#123' });

      expect(mockClient.showPipeline).toHaveBeenCalledWith('test-project', 123);
    });

    it('returns a teaching error for a non-numeric pipeline_id without calling the client', async () => {
      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getPipelineFull')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 'bad' });

      expect(result.isError).toBe(true);
      expect(mockClient.showPipeline).not.toHaveBeenCalled();
    });
  });

  describe('getJobLog', () => {
    it('retrieves job log successfully as structured JSON (not a bare text string)', async () => {
      const mockLog = 'Running tests...\nAll tests passed!\nBuild complete.';

      mockClient.getJobLog.mockResolvedValue(mockLog);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      const result = await handler!({ project_id: 'test-project', job_id: 456 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ log: mockLog }, null, 2) }],
      });
      expect(mockClient.getJobLog).toHaveBeenCalledWith('test-project', 456, undefined);
    });

    it('handles numeric project_id', async () => {
      mockClient.getJobLog.mockResolvedValue('Log output');

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      await handler!({ project_id: 789, job_id: 456 });

      expect(mockClient.getJobLog).toHaveBeenCalledWith(789, 456, undefined);
    });

    it('handles tail_lines parameter', async () => {
      const mockLog = 'Line 1\nLine 2\nLine 3';

      mockClient.getJobLog.mockResolvedValue(mockLog);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      await handler!({ project_id: 'test-project', job_id: 456, tail_lines: 50 });

      expect(mockClient.getJobLog).toHaveBeenCalledWith('test-project', 456, 50);
    });

    it('returns a structured result for an empty log', async () => {
      mockClient.getJobLog.mockResolvedValue('');

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      const result = await handler!({ project_id: 'test-project', job_id: 456 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ log: '' }, null, 2) }],
      });
    });

    it('accepts a numeric-string job_id', async () => {
      mockClient.getJobLog.mockResolvedValue('log');

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      await handler!({ project_id: 'test-project', job_id: '456' });

      expect(mockClient.getJobLog).toHaveBeenCalledWith('test-project', 456, undefined);
    });

    it('returns a teaching error for a non-numeric job_id without calling the client', async () => {
      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      const result = await handler!({ project_id: 'test-project', job_id: 'nope' });

      expect(result.isError).toBe(true);
      expect(mockClient.getJobLog).not.toHaveBeenCalled();
    });

    it('handles non-existent job', async () => {
      mockClient.getJobLog.mockRejectedValue(new Error('404 Job not found'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      const result = await handler!({ project_id: 'test-project', job_id: 9999 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
    });

    it('handles log retrieval errors', async () => {
      mockClient.getJobLog.mockRejectedValue(new Error('Log file not available'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      const result = await handler!({ project_id: 'test-project', job_id: 456 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Log file not available' }],
        isError: true,
      });
    });
  });

  describe('retryPipeline', () => {
    it('retries pipeline successfully', async () => {
      const mockRetryResult = {
        id: 123,
        status: 'pending',
        ref: 'main',
        sha: 'abc123def456',
        web_url: 'https://gitlab.com/project/pipelines/123',
        created_at: '2025-01-01T11:00:00.000Z',
        updated_at: '2025-01-01T11:00:00.000Z',
      };

      mockClient.retryPipeline.mockResolvedValue(mockRetryResult);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'retryPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockRetryResult, null, 2),
          },
        ],
      });
      expect(mockClient.retryPipeline).toHaveBeenCalledWith('test-project', 123);
    });

    it('handles numeric project_id', async () => {
      mockClient.retryPipeline.mockResolvedValue({ id: 123, status: 'pending' });

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'retryPipeline')?.handler;

      await handler!({ project_id: 999, pipeline_id: 123 });

      expect(mockClient.retryPipeline).toHaveBeenCalledWith(999, 123);
    });

    it('handles non-existent pipeline', async () => {
      mockClient.retryPipeline.mockRejectedValue(new Error('404 Pipeline not found'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'retryPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 9999 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
    });

    it('handles permission errors', async () => {
      mockClient.retryPipeline.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'retryPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 123 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });

    it('handles already running pipeline', async () => {
      mockClient.retryPipeline.mockRejectedValue(new Error('400 Pipeline is already running'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'retryPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 123 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: 400 Pipeline is already running' }],
        isError: true,
      });
    });

    it('accepts a numeric-string pipeline_id', async () => {
      mockClient.retryPipeline.mockResolvedValue({ id: 123, status: 'pending' });

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'retryPipeline')?.handler;

      await handler!({ project_id: 'test-project', pipeline_id: '123' });

      expect(mockClient.retryPipeline).toHaveBeenCalledWith('test-project', 123);
    });

    it('returns a teaching error for a non-numeric pipeline_id without calling the client', async () => {
      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'retryPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', pipeline_id: 'oops' });

      expect(result.isError).toBe(true);
      expect(mockClient.retryPipeline).not.toHaveBeenCalled();
    });
  });

  describe('triggerPipeline', () => {
    it('triggers pipeline successfully without variables', async () => {
      const mockTriggeredPipeline = {
        id: 124,
        status: 'pending',
        ref: 'main',
        sha: 'abc123def456',
        web_url: 'https://gitlab.com/project/pipelines/124',
        created_at: '2025-01-01T12:00:00.000Z',
        updated_at: '2025-01-01T12:00:00.000Z',
      };

      mockClient.triggerPipeline.mockResolvedValue(mockTriggeredPipeline);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'triggerPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', ref: 'main' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockTriggeredPipeline, null, 2),
          },
        ],
      });
      expect(mockClient.triggerPipeline).toHaveBeenCalledWith('test-project', {
        ref: 'main',
        variables: undefined,
      });
    });

    it('triggers pipeline with variables', async () => {
      const mockTriggeredPipeline = {
        id: 125,
        status: 'pending',
        ref: 'develop',
        sha: 'def456ghi789',
      };

      mockClient.triggerPipeline.mockResolvedValue(mockTriggeredPipeline);

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'triggerPipeline')?.handler;

      const variables = [
        { key: 'ENVIRONMENT', value: 'staging' },
        { key: 'DEPLOY_VERSION', value: '1.2.3' },
      ];

      await handler!({ project_id: 'test-project', ref: 'develop', variables });

      expect(mockClient.triggerPipeline).toHaveBeenCalledWith('test-project', {
        ref: 'develop',
        variables,
      });
    });

    it('handles numeric project_id', async () => {
      mockClient.triggerPipeline.mockResolvedValue({ id: 125, status: 'pending' });

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'triggerPipeline')?.handler;

      await handler!({ project_id: 888, ref: 'main' });

      expect(mockClient.triggerPipeline).toHaveBeenCalledWith(888, {
        ref: 'main',
        variables: undefined,
      });
    });

    it('triggers pipeline on tag', async () => {
      mockClient.triggerPipeline.mockResolvedValue({ id: 126, status: 'pending' });

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'triggerPipeline')?.handler;

      await handler!({ project_id: 'test-project', ref: 'v1.0.0' });

      expect(mockClient.triggerPipeline).toHaveBeenCalledWith('test-project', {
        ref: 'v1.0.0',
        variables: undefined,
      });
    });

    it('handles non-existent branch/tag', async () => {
      mockClient.triggerPipeline.mockRejectedValue(new Error('404 Reference not found'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'triggerPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', ref: 'nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
    });

    it('handles permission errors', async () => {
      mockClient.triggerPipeline.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'triggerPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', ref: 'main' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });

    it('handles pipeline configuration errors', async () => {
      mockClient.triggerPipeline.mockRejectedValue(new Error('400 .gitlab-ci.yml not found'));

      const tools = createPipelineTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'triggerPipeline')?.handler;

      const result = await handler!({ project_id: 'test-project', ref: 'main' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createPipelineTools(null);

      expect(tools).toHaveLength(5);

      for (const { tool, handler } of tools) {
        const result = await handler({});
        expect(result).toEqual({
          content: [
            {
              type: 'text',
              text: `Error: ${notConfiguredMessage('GitLab')}`,
            },
          ],
          isError: true,
        });
      }
    });

    it('returns specific error for list_pipeline_ids when unconfigured', async () => {
      const tools = createPipelineTools(null);
      const handler = tools.find((t) => t.tool.name === 'listPipelineIds')?.handler;

      const result = await handler!({ project_id: 'test' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns specific error for get_pipeline_full when unconfigured', async () => {
      const tools = createPipelineTools(null);
      const handler = tools.find((t) => t.tool.name === 'getPipelineFull')?.handler;

      const result = await handler!({ project_id: 'test', pipeline_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns specific error for get_job_log when unconfigured', async () => {
      const tools = createPipelineTools(null);
      const handler = tools.find((t) => t.tool.name === 'getJobLog')?.handler;

      const result = await handler!({ project_id: 'test', job_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns specific error for retry_pipeline when unconfigured', async () => {
      const tools = createPipelineTools(null);
      const handler = tools.find((t) => t.tool.name === 'retryPipeline')?.handler;

      const result = await handler!({ project_id: 'test', pipeline_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns specific error for trigger_pipeline when unconfigured', async () => {
      const tools = createPipelineTools(null);
      const handler = tools.find((t) => t.tool.name === 'triggerPipeline')?.handler;

      const result = await handler!({ project_id: 'test', ref: 'main' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });
  });
});

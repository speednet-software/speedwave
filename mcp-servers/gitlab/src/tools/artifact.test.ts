import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createArtifactTools } from './artifact-tools.js';
import { expectNotFoundTeachingError, expectPermissionTeachingError } from './test-helpers.js';
import type { GitLabClient } from '../client.js';

type MockClient = {
  listArtifacts: Mock;
  downloadArtifact: Mock;
  deleteArtifacts: Mock;
};

const createMockClient = (): MockClient => ({
  listArtifacts: vi.fn(),
  downloadArtifact: vi.fn(),
  deleteArtifacts: vi.fn(),
});

describe('artifact-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  describe('listArtifacts', () => {
    it('lists artifacts successfully', async () => {
      const mockArtifacts = [
        {
          job_id: 123,
          job_name: 'build',
          artifacts: [{ filename: 'build.zip', size: 1024 }],
        },
        {
          job_id: 124,
          job_name: 'test',
          artifacts: [{ filename: 'coverage.html', size: 2048 }],
        },
      ];

      mockClient.listArtifacts.mockResolvedValue({ artifacts: mockArtifacts, truncated: false });

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', pipeline_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, artifacts: mockArtifacts, truncated: false },
              null,
              2
            ),
          },
        ],
      });
      expect(mockClient.listArtifacts).toHaveBeenCalledWith('my-project', 456);
    });

    it('lists artifacts with numeric project_id', async () => {
      const mockArtifacts = [
        {
          job_id: 123,
          job_name: 'build',
          artifacts: [{ filename: 'app.zip', size: 512 }],
        },
      ];

      mockClient.listArtifacts.mockResolvedValue({ artifacts: mockArtifacts, truncated: false });

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 789, pipeline_id: 101 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, artifacts: mockArtifacts, truncated: false },
              null,
              2
            ),
          },
        ],
      });
      expect(mockClient.listArtifacts).toHaveBeenCalledWith(789, 101);
    });

    it('handles empty artifacts list', async () => {
      mockClient.listArtifacts.mockResolvedValue({ artifacts: [], truncated: false });

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', pipeline_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, artifacts: [], truncated: false }, null, 2),
          },
        ],
      });
    });

    it('surfaces truncated: true when the pipeline has more than 100 jobs', async () => {
      mockClient.listArtifacts.mockResolvedValue({ artifacts: [], truncated: true });

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', pipeline_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, artifacts: [], truncated: true }, null, 2),
          },
        ],
      });
    });

    it('handles API errors gracefully', async () => {
      mockClient.listArtifacts.mockRejectedValue(new Error('404 not found'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', pipeline_id: 999 });

      expectNotFoundTeachingError(result);
    });

    it('handles permission errors', async () => {
      mockClient.listArtifacts.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'private-project', pipeline_id: 456 });

      expectPermissionTeachingError(result);
    });

    it('accepts a numeric-string pipeline_id', async () => {
      mockClient.listArtifacts.mockResolvedValue({ artifacts: [], truncated: false });

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      await handler!({ project_id: 'my-project', pipeline_id: '456' });

      expect(mockClient.listArtifacts).toHaveBeenCalledWith('my-project', 456);
    });

    it('returns a teaching error for a non-numeric pipeline_id without calling the client', async () => {
      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', pipeline_id: 'bad' });

      expect(result.isError).toBe(true);
      expect(mockClient.listArtifacts).not.toHaveBeenCalled();
    });

    it('describes the real per-job-grouped output shape and points at the correct pipeline_id source', () => {
      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listArtifacts')?.tool;

      expect(tool?.description).toContain('listPipelineIds');
      expect(tool?.description).toContain('listMrPipelines');
      const outputProps = tool?.outputSchema?.properties as Record<string, unknown>;
      const itemProps = (
        outputProps.artifacts as { items: { properties: Record<string, unknown> } }
      ).items.properties;
      expect(itemProps).toHaveProperty('job_id');
      expect(itemProps).toHaveProperty('job_name');
      expect(itemProps).toHaveProperty('artifacts');
      expect(outputProps).toHaveProperty('truncated');
      expect(tool?.description).toContain('truncated');
    });
  });

  describe('downloadArtifact', () => {
    it('downloads artifact successfully', async () => {
      const mockArtifact = {
        content: 'artifact content',
        size: 17,
        filename: 'job-123-log.txt',
      };

      mockClient.downloadArtifact.mockResolvedValue(mockArtifact);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, ...mockArtifact }, null, 2),
          },
        ],
      });
      expect(mockClient.downloadArtifact).toHaveBeenCalledWith('my-project', 123, undefined);
    });

    it('downloads artifact with numeric project_id', async () => {
      const mockArtifact = {
        content: 'test data',
        size: 9,
        filename: 'job-456-log.txt',
      };

      mockClient.downloadArtifact.mockResolvedValue(mockArtifact);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 789, job_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, ...mockArtifact }, null, 2),
          },
        ],
      });
      expect(mockClient.downloadArtifact).toHaveBeenCalledWith(789, 456, undefined);
    });

    it('passes tail_lines through to the client', async () => {
      mockClient.downloadArtifact.mockResolvedValue({
        content: 'tail',
        size: 4,
        filename: 'job-789-log.txt',
      });

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      await handler!({ project_id: 'my-project', job_id: 789, tail_lines: 50 });

      expect(mockClient.downloadArtifact).toHaveBeenCalledWith('my-project', 789, 50);
    });

    it('handles a large full size while returning capped content', async () => {
      const mockArtifact = {
        content: 'last lines only',
        size: 1048576,
        filename: 'large-artifact.zip',
      };

      mockClient.downloadArtifact.mockResolvedValue(mockArtifact);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 789 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, ...mockArtifact }, null, 2),
          },
        ],
      });
    });

    it('handles download errors gracefully', async () => {
      mockClient.downloadArtifact.mockRejectedValue(new Error('404 not found'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 999 });

      expectNotFoundTeachingError(result);
    });

    it('accepts a "#"-prefixed job_id', async () => {
      mockClient.downloadArtifact.mockResolvedValue({
        content: 'log',
        size: 3,
        filename: 'job-42-log.txt',
      });

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      await handler!({ project_id: 'my-project', job_id: '#42' });

      expect(mockClient.downloadArtifact).toHaveBeenCalledWith('my-project', 42, undefined);
    });

    it('returns a teaching error and skips the client call for an invalid job_id', async () => {
      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 'abc' });

      expect(result.isError).toBe(true);
      expect(mockClient.downloadArtifact).not.toHaveBeenCalled();
    });

    it('describes accurately that this fetches a job log, not the CI artifact bundle', () => {
      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'downloadArtifact')?.tool;

      expect(tool?.description).toContain('job');
      expect(tool?.description).toContain('log');
      const outputProps = tool?.outputSchema?.properties as Record<string, unknown>;
      expect(outputProps).toHaveProperty('content');
      expect(outputProps).toHaveProperty('filename');
      expect(outputProps).toHaveProperty('size');
      expect(outputProps).not.toHaveProperty('artifact');
      const inputProps = tool?.inputSchema?.properties as Record<string, { minimum?: number }>;
      expect(inputProps.tail_lines.minimum).toBe(0);
    });

    it('handles non-existent job', async () => {
      mockClient.downloadArtifact.mockRejectedValue(new Error('404 Job Not Found'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 9999 });

      expectNotFoundTeachingError(result);
    });
  });

  describe('deleteArtifacts', () => {
    it('deletes artifacts successfully', async () => {
      mockClient.deleteArtifacts.mockResolvedValue(undefined);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'Artifacts deleted' }, null, 2),
          },
        ],
      });
      expect(mockClient.deleteArtifacts).toHaveBeenCalledWith('my-project', 123);
    });

    it('deletes artifacts with numeric project_id', async () => {
      mockClient.deleteArtifacts.mockResolvedValue(undefined);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 789, job_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'Artifacts deleted' }, null, 2),
          },
        ],
      });
      expect(mockClient.deleteArtifacts).toHaveBeenCalledWith(789, 456);
    });

    it('handles deletion errors gracefully', async () => {
      mockClient.deleteArtifacts.mockRejectedValue(new Error('Cannot delete artifacts'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 123 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Cannot delete artifacts' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.deleteArtifacts.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 123 });

      expectPermissionTeachingError(result);
    });

    it('handles non-existent job', async () => {
      mockClient.deleteArtifacts.mockRejectedValue(new Error('404 Job Not Found'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 9999 });

      expectNotFoundTeachingError(result);
    });

    it('accepts a numeric-string job_id', async () => {
      mockClient.deleteArtifacts.mockResolvedValue(undefined);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      await handler!({ project_id: 'my-project', job_id: '123' });

      expect(mockClient.deleteArtifacts).toHaveBeenCalledWith('my-project', 123);
    });

    it('returns a teaching error for a non-numeric job_id without calling the client', async () => {
      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 'oops' });

      expect(result.isError).toBe(true);
      expect(mockClient.deleteArtifacts).not.toHaveBeenCalled();
    });

    it('describes that erase removes the job log too, not just artifacts', () => {
      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'deleteArtifacts')?.tool;

      expect(tool?.description).toContain('job log');
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createArtifactTools(null);

      expect(tools).toHaveLength(3);

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

    it('returns error for list_artifacts when client is null', async () => {
      const tools = createArtifactTools(null);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'test', pipeline_id: 1 });

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

    it('returns error for download_artifact when client is null', async () => {
      const tools = createArtifactTools(null);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'test', job_id: 1 });

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

    it('returns error for delete_artifacts when client is null', async () => {
      const tools = createArtifactTools(null);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'test', job_id: 1 });

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

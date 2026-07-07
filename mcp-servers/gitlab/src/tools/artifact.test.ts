import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createArtifactTools } from './artifact-tools.js';
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

      mockClient.listArtifacts.mockResolvedValue(mockArtifacts);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', pipeline_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockArtifacts, null, 2),
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

      mockClient.listArtifacts.mockResolvedValue(mockArtifacts);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 789, pipeline_id: 101 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockArtifacts, null, 2),
          },
        ],
      });
      expect(mockClient.listArtifacts).toHaveBeenCalledWith(789, 101);
    });

    it('handles empty artifacts list', async () => {
      mockClient.listArtifacts.mockResolvedValue([]);

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', pipeline_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify([], null, 2),
          },
        ],
      });
    });

    it('handles API errors gracefully', async () => {
      mockClient.listArtifacts.mockRejectedValue(new Error('404 not found'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', pipeline_id: 999 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
    });

    it('handles permission errors', async () => {
      mockClient.listArtifacts.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'private-project', pipeline_id: 456 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });

    it('accepts a numeric-string pipeline_id', async () => {
      mockClient.listArtifacts.mockResolvedValue([]);

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

    it('describes the real per-job-grouped output shape and references getPipelineFull', () => {
      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listArtifacts')?.tool;

      expect(tool?.description).toContain('getPipelineFull');
      const outputProps = tool?.outputSchema?.properties as Record<string, unknown>;
      const itemProps = (
        outputProps.artifacts as { items: { properties: Record<string, unknown> } }
      ).items.properties;
      expect(itemProps).toHaveProperty('job_id');
      expect(itemProps).toHaveProperty('job_name');
      expect(itemProps).toHaveProperty('artifacts');
    });
  });

  describe('downloadArtifact', () => {
    it('downloads artifact successfully', async () => {
      const mockArtifact = {
        data: Buffer.from('artifact content'),
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
            text: JSON.stringify({ filename: 'job-123-log.txt', size: 16 }, null, 2),
          },
        ],
      });
      expect(mockClient.downloadArtifact).toHaveBeenCalledWith('my-project', 123);
    });

    it('downloads artifact with numeric project_id', async () => {
      const mockArtifact = {
        data: Buffer.from('test data'),
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
            text: JSON.stringify({ filename: 'job-456-log.txt', size: 9 }, null, 2),
          },
        ],
      });
      expect(mockClient.downloadArtifact).toHaveBeenCalledWith(789, 456);
    });

    it('handles large artifact downloads', async () => {
      const largeData = Buffer.alloc(1024 * 1024); // 1MB
      const mockArtifact = {
        data: largeData,
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
            text: JSON.stringify({ filename: 'large-artifact.zip', size: 1048576 }, null, 2),
          },
        ],
      });
    });

    it('handles download errors gracefully', async () => {
      mockClient.downloadArtifact.mockRejectedValue(new Error('404 not found'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 999 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
    });

    it('accepts a "#"-prefixed job_id', async () => {
      mockClient.downloadArtifact.mockResolvedValue({
        data: Buffer.from('log'),
        filename: 'job-42-log.txt',
      });

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      await handler!({ project_id: 'my-project', job_id: '#42' });

      expect(mockClient.downloadArtifact).toHaveBeenCalledWith('my-project', 42);
    });

    it('describes accurately that this fetches a job log, not the CI artifact bundle', () => {
      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'downloadArtifact')?.tool;

      expect(tool?.description).toContain('job log');
      const outputProps = tool?.outputSchema?.properties as Record<string, unknown>;
      expect(outputProps).toHaveProperty('filename');
      expect(outputProps).toHaveProperty('size');
      expect(outputProps).not.toHaveProperty('artifact');
    });

    it('handles non-existent job', async () => {
      mockClient.downloadArtifact.mockRejectedValue(new Error('404 Job Not Found'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 9999 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
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

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });

    it('handles non-existent job', async () => {
      mockClient.deleteArtifacts.mockRejectedValue(new Error('404 Job Not Found'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 9999 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found in GitLab.');
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

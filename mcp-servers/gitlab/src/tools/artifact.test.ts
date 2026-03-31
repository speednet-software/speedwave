import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
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

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.listArtifacts.mockRejectedValue(
        new Error('Permission denied. Your GitLab token may not have sufficient permissions.')
      );

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listArtifacts')?.handler;

      const result = await handler!({ project_id: 'private-project', pipeline_id: 456 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
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

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles non-existent job', async () => {
      mockClient.downloadArtifact.mockRejectedValue(new Error('Resource not found in GitLab.'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'downloadArtifact')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 9999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
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
      mockClient.deleteArtifacts.mockRejectedValue(
        new Error('Permission denied. Your GitLab token may not have sufficient permissions.')
      );

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });

    it('handles non-existent job', async () => {
      mockClient.deleteArtifacts.mockRejectedValue(new Error('Resource not found in GitLab.'));

      const tools = createArtifactTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteArtifacts')?.handler;

      const result = await handler!({ project_id: 'my-project', job_id: 9999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
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
              text: 'Error: GitLab not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
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
            text: 'Error: GitLab not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
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
            text: 'Error: GitLab not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
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
            text: 'Error: GitLab not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
          },
        ],
        isError: true,
      });
    });
  });
});

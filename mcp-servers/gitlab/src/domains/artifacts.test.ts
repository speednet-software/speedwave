import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createArtifactsClient } from './artifacts.js';

// Create inline mock
function createMockGitlab() {
  return {
    Jobs: {
      all: vi.fn(),
    },
    JobArtifacts: {
      downloadArchive: vi.fn(),
      remove: vi.fn(),
    },
  };
}

describe('ArtifactsClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ReturnType<typeof createArtifactsClient>;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createArtifactsClient(mockGitlab as any);
  });

  describe('listJobsWithArtifacts', () => {
    it('should list jobs that have artifacts', async () => {
      const mockJobs = [
        {
          id: 1,
          name: 'build-job',
          status: 'success',
          stage: 'build',
          artifactsFile: {
            filename: 'artifacts.zip',
            size: 1024,
          },
          webUrl: 'https://gitlab.com/project/repo/-/jobs/1',
        },
        {
          id: 2,
          name: 'test-job',
          status: 'success',
          stage: 'test',
          // No artifacts
          webUrl: 'https://gitlab.com/project/repo/-/jobs/2',
        },
        {
          id: 3,
          name: 'deploy-job',
          status: 'success',
          stage: 'deploy',
          artifactsFile: {
            filename: 'deploy.tar.gz',
            size: 2048,
          },
          webUrl: 'https://gitlab.com/project/repo/-/jobs/3',
        },
      ];

      mockGitlab.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.listJobsWithArtifacts('project-1', 123);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(1);
      expect(result[0].name).toBe('build-job');
      expect(result[0].artifacts[0].filename).toBe('artifacts.zip');
      expect(result[0].artifacts[0].size).toBe(1024);
      expect(result[1].id).toBe(3);
      expect(result[1].name).toBe('deploy-job');
      expect(mockGitlab.Jobs.all).toHaveBeenCalledWith('project-1', { pipelineId: 123 });
    });

    it('should handle snake_case properties', async () => {
      const mockJobs = [
        {
          id: 1,
          name: 'build-job',
          status: 'success',
          stage: 'build',
          artifacts_file: {
            filename: 'artifacts.zip',
            size: 1024,
          },
          web_url: 'https://gitlab.com/project/repo/-/jobs/1',
        },
      ];

      mockGitlab.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.listJobsWithArtifacts('project-1', 123);

      expect(result).toHaveLength(1);
      expect(result[0].web_url).toBe('https://gitlab.com/project/repo/-/jobs/1');
      expect(result[0].artifacts[0].filename).toBe('artifacts.zip');
    });

    it('should return empty array when no jobs have artifacts', async () => {
      const mockJobs = [
        {
          id: 1,
          name: 'test-job',
          status: 'success',
          stage: 'test',
          webUrl: 'https://gitlab.com/project/repo/-/jobs/1',
        },
      ];

      mockGitlab.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.listJobsWithArtifacts('project-1', 123);

      expect(result).toHaveLength(0);
    });

    it('should handle jobs with missing artifact properties', async () => {
      const mockJobs = [
        {
          id: 1,
          name: 'build-job',
          status: 'success',
          stage: 'build',
          artifactsFile: {
            // Missing filename and size
          },
          webUrl: 'https://gitlab.com/project/repo/-/jobs/1',
        },
      ];

      mockGitlab.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.listJobsWithArtifacts('project-1', 123);

      expect(result).toHaveLength(1);
      expect(result[0].artifacts[0].size).toBe(0);
      expect(result[0].artifacts[0].filename).toBe('artifacts.zip');
    });

    it('should set correct artifact metadata', async () => {
      const mockJobs = [
        {
          id: 1,
          name: 'build-job',
          status: 'success',
          stage: 'build',
          artifactsFile: {
            filename: 'custom.zip',
            size: 5000,
          },
          webUrl: 'https://gitlab.com/project/repo/-/jobs/1',
        },
      ];

      mockGitlab.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.listJobsWithArtifacts('project-1', 123);

      expect(result[0].artifacts[0].file_type).toBe('archive');
      expect(result[0].artifacts[0].file_format).toBeUndefined();
    });
  });

  describe('download', () => {
    it('should download artifact as Buffer from Blob', async () => {
      const mockBlob = new Blob(['artifact content'], { type: 'application/zip' });

      mockGitlab.JobArtifacts.downloadArchive.mockResolvedValue(mockBlob);

      const result = await client.download('project-1', 123);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe('artifact content');
      expect(mockGitlab.JobArtifacts.downloadArchive).toHaveBeenCalledWith('project-1', {
        jobId: 123,
      });
    });

    it('should return Buffer directly if not a Blob', async () => {
      const mockBuffer = Buffer.from('direct buffer content');

      mockGitlab.JobArtifacts.downloadArchive.mockResolvedValue(mockBuffer);

      const result = await client.download('project-1', 456);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe('direct buffer content');
    });

    it('should handle binary data correctly', async () => {
      const binaryData = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP header
      const mockBlob = new Blob([binaryData], { type: 'application/zip' });

      mockGitlab.JobArtifacts.downloadArchive.mockResolvedValue(mockBlob);

      const result = await client.download('project-1', 789);

      expect(result).toBeInstanceOf(Buffer);
      expect(result[0]).toBe(0x50);
      expect(result[1]).toBe(0x4b);
    });
  });

  describe('delete', () => {
    it('should delete job artifacts', async () => {
      mockGitlab.JobArtifacts.remove.mockResolvedValue(undefined);

      await client.delete('project-1', 123);

      expect(mockGitlab.JobArtifacts.remove).toHaveBeenCalledWith('project-1', {
        jobId: 123,
      });
    });

    it('should handle deletion errors gracefully', async () => {
      mockGitlab.JobArtifacts.remove.mockRejectedValue(new Error('Not found'));

      await expect(client.delete('project-1', 999)).rejects.toThrow('Not found');
    });
  });
});

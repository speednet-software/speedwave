import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReleasesClient } from './releases.js';

// Create inline mock
function createMockGitlab() {
  return {
    Tags: {
      create: vi.fn(),
    },
    ProjectReleases: {
      create: vi.fn(),
    },
  };
}

describe('ReleasesClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ReturnType<typeof createReleasesClient>;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createReleasesClient(mockGitlab as any);
  });

  describe('createTag', () => {
    it('should create a tag with minimal options', async () => {
      const mockTag = {
        name: 'v1.0.0',
        message: null,
        target: 'abc123',
        commit: {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Commit message',
        },
      };
      mockGitlab.Tags.create.mockResolvedValue(mockTag);

      const result = await client.createTag('project-123', {
        tag_name: 'v1.0.0',
        ref: 'main',
      });

      expect(mockGitlab.Tags.create).toHaveBeenCalledWith('project-123', 'v1.0.0', 'main', {
        message: undefined,
      });
      expect(result).toEqual(mockTag);
    });

    it('should create a tag with a message', async () => {
      const mockTag = {
        name: 'v1.1.0',
        message: 'Release version 1.1.0',
        target: 'def456',
        commit: {
          id: 'def456',
          short_id: 'def456',
          title: 'Commit message',
        },
      };
      mockGitlab.Tags.create.mockResolvedValue(mockTag);

      const result = await client.createTag('project-123', {
        tag_name: 'v1.1.0',
        ref: 'main',
        message: 'Release version 1.1.0',
      });

      expect(mockGitlab.Tags.create).toHaveBeenCalledWith('project-123', 'v1.1.0', 'main', {
        message: 'Release version 1.1.0',
      });
      expect(result).toEqual(mockTag);
    });

    it('should create a tag from a specific commit SHA', async () => {
      const mockTag = {
        name: 'v2.0.0',
        message: 'Major release',
        target: 'ghi789',
        commit: {
          id: 'ghi789',
          short_id: 'ghi789',
          title: 'Major changes',
        },
      };
      mockGitlab.Tags.create.mockResolvedValue(mockTag);

      const result = await client.createTag('project-123', {
        tag_name: 'v2.0.0',
        ref: 'ghi789',
        message: 'Major release',
      });

      expect(mockGitlab.Tags.create).toHaveBeenCalledWith('project-123', 'v2.0.0', 'ghi789', {
        message: 'Major release',
      });
      expect((result as { name: string }).name).toBe('v2.0.0');
    });

    it('should handle numeric project IDs', async () => {
      const mockTag = {
        name: 'v1.2.0',
        message: null,
        target: 'jkl012',
      };
      mockGitlab.Tags.create.mockResolvedValue(mockTag);

      const result = await client.createTag(12345, {
        tag_name: 'v1.2.0',
        ref: 'develop',
      });

      expect(mockGitlab.Tags.create).toHaveBeenCalledWith(12345, 'v1.2.0', 'develop', {
        message: undefined,
      });
      expect(result).toEqual(mockTag);
    });

    it('should create a tag from a branch name', async () => {
      const mockTag = {
        name: 'v1.3.0',
        message: 'Release from feature branch',
        target: 'mno345',
      };
      mockGitlab.Tags.create.mockResolvedValue(mockTag);

      const result = await client.createTag('project-123', {
        tag_name: 'v1.3.0',
        ref: 'feature/new-feature',
        message: 'Release from feature branch',
      });

      expect(mockGitlab.Tags.create).toHaveBeenCalledWith(
        'project-123',
        'v1.3.0',
        'feature/new-feature',
        {
          message: 'Release from feature branch',
        }
      );
      expect((result as { name: string }).name).toBe('v1.3.0');
    });
  });

  describe('createRelease', () => {
    it('should create a release with minimal options', async () => {
      const mockRelease = {
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        description: null,
        created_at: '2024-01-01T00:00:00Z',
        released_at: '2024-01-01T00:00:00Z',
      };
      mockGitlab.ProjectReleases.create.mockResolvedValue(mockRelease);

      const result = await client.createRelease('project-123', {
        tag_name: 'v1.0.0',
      });

      expect(mockGitlab.ProjectReleases.create).toHaveBeenCalledWith('project-123', {
        tagName: 'v1.0.0',
        name: 'v1.0.0',
        description: undefined,
      });
      expect(result).toEqual(mockRelease);
    });

    it('should create a release with custom name', async () => {
      const mockRelease = {
        tag_name: 'v1.1.0',
        name: 'Version 1.1.0 - Bug Fixes',
        description: null,
        created_at: '2024-01-02T00:00:00Z',
        released_at: '2024-01-02T00:00:00Z',
      };
      mockGitlab.ProjectReleases.create.mockResolvedValue(mockRelease);

      const result = await client.createRelease('project-123', {
        tag_name: 'v1.1.0',
        name: 'Version 1.1.0 - Bug Fixes',
      });

      expect(mockGitlab.ProjectReleases.create).toHaveBeenCalledWith('project-123', {
        tagName: 'v1.1.0',
        name: 'Version 1.1.0 - Bug Fixes',
        description: undefined,
      });
      expect((result as { name: string }).name).toBe('Version 1.1.0 - Bug Fixes');
    });

    it('should create a release with description', async () => {
      const mockRelease = {
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0',
        description:
          "## What's New\n\n- Feature A\n- Feature B\n\n## Bug Fixes\n\n- Fix X\n- Fix Y",
        created_at: '2024-01-03T00:00:00Z',
        released_at: '2024-01-03T00:00:00Z',
      };
      mockGitlab.ProjectReleases.create.mockResolvedValue(mockRelease);

      const result = await client.createRelease('project-123', {
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0',
        description:
          "## What's New\n\n- Feature A\n- Feature B\n\n## Bug Fixes\n\n- Fix X\n- Fix Y",
      });

      expect(mockGitlab.ProjectReleases.create).toHaveBeenCalledWith('project-123', {
        tagName: 'v2.0.0',
        name: 'Version 2.0.0',
        description:
          "## What's New\n\n- Feature A\n- Feature B\n\n## Bug Fixes\n\n- Fix X\n- Fix Y",
      });
      expect((result as { description: string }).description).toContain("What's New");
    });

    it('should handle numeric project IDs', async () => {
      const mockRelease = {
        tag_name: 'v1.2.0',
        name: 'v1.2.0',
        description: 'Minor update',
        created_at: '2024-01-04T00:00:00Z',
        released_at: '2024-01-04T00:00:00Z',
      };
      mockGitlab.ProjectReleases.create.mockResolvedValue(mockRelease);

      const result = await client.createRelease(12345, {
        tag_name: 'v1.2.0',
        description: 'Minor update',
      });

      expect(mockGitlab.ProjectReleases.create).toHaveBeenCalledWith(12345, {
        tagName: 'v1.2.0',
        name: 'v1.2.0',
        description: 'Minor update',
      });
      expect(result).toEqual(mockRelease);
    });

    it('should default name to tag_name when name is not provided', async () => {
      const mockRelease = {
        tag_name: 'v1.3.0',
        name: 'v1.3.0',
        description: 'Automated release',
        created_at: '2024-01-05T00:00:00Z',
        released_at: '2024-01-05T00:00:00Z',
      };
      mockGitlab.ProjectReleases.create.mockResolvedValue(mockRelease);

      const result = await client.createRelease('project-123', {
        tag_name: 'v1.3.0',
        description: 'Automated release',
      });

      expect(mockGitlab.ProjectReleases.create).toHaveBeenCalledWith('project-123', {
        tagName: 'v1.3.0',
        name: 'v1.3.0',
        description: 'Automated release',
      });
      expect((result as { name: string }).name).toBe('v1.3.0');
    });

    it('should create a release with markdown description', async () => {
      const markdownDescription = `# Release v3.0.0

## Breaking Changes
- Changed API endpoint structure
- Removed deprecated methods

## New Features
- Added GraphQL support
- Improved performance

## Bug Fixes
- Fixed memory leak in cache
- Resolved authentication issues`;

      const mockRelease = {
        tag_name: 'v3.0.0',
        name: 'Release v3.0.0',
        description: markdownDescription,
        created_at: '2024-01-06T00:00:00Z',
        released_at: '2024-01-06T00:00:00Z',
      };
      mockGitlab.ProjectReleases.create.mockResolvedValue(mockRelease);

      const result = await client.createRelease('project-123', {
        tag_name: 'v3.0.0',
        name: 'Release v3.0.0',
        description: markdownDescription,
      });

      expect(mockGitlab.ProjectReleases.create).toHaveBeenCalledWith('project-123', {
        tagName: 'v3.0.0',
        name: 'Release v3.0.0',
        description: markdownDescription,
      });
      expect((result as { description: string }).description).toContain('Breaking Changes');
      expect((result as { description: string }).description).toContain('GraphQL support');
    });
  });
});

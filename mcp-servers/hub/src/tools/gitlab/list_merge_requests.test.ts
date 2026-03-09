import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './list_merge_requests.js';

//===============================================================================
// Tests for GitLab List Merge Requests Tool
//
// Purpose: Test merge request listing functionality
// - Verify metadata (name, category, service, schema)
// - Test successful MR listing scenarios
// - Test parameter validation
// - Test error handling (404, 403, 401, network errors, etc.)
// - Test edge cases (empty results, non-array results)
//===============================================================================

describe('gitlab/list_merge_requests', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('listMrIds');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('read');
    });

    it('should have correct service', () => {
      expect(metadata.service).toBe('gitlab');
    });

    it('should have non-empty description', () => {
      expect(metadata.description).toBeTruthy();
      expect(typeof metadata.description).toBe('string');
      expect(metadata.description.length).toBeGreaterThan(0);
    });

    it('should have keywords array', () => {
      expect(Array.isArray(metadata.keywords)).toBe(true);
      expect(metadata.keywords.length).toBeGreaterThan(0);
      expect(metadata.keywords).toContain('gitlab');
      expect(metadata.keywords).toContain('merge');
      expect(metadata.keywords).toContain('list');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['project_id']);
    });

    it('should define project_id in schema with number or string type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const projectIdSchema = properties.project_id;
      expect(projectIdSchema).toBeDefined();
      expect(projectIdSchema.type).toEqual(['number', 'string']);
      expect(projectIdSchema.description).toBeTruthy();
    });

    it('should define optional state in schema with enum', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; enum?: string[]; description: string }
      >;
      const stateSchema = properties.state;
      expect(stateSchema).toBeDefined();
      expect(stateSchema.type).toBe('string');
      expect(stateSchema.enum).toEqual(['opened', 'closed', 'merged', 'all']);
    });

    it('should define optional author_username in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const authorSchema = properties.author_username;
      expect(authorSchema).toBeDefined();
      expect(authorSchema.type).toBe('string');
    });

    it('should have valid outputSchema', () => {
      expect(metadata.outputSchema).toBeDefined();
      const outputSchema = metadata.outputSchema!;
      expect(outputSchema.type).toBe('object');
      expect(outputSchema.properties).toBeDefined();
      const outputProps = outputSchema.properties as Record<string, { type: string }>;
      expect(outputProps.success).toEqual({ type: 'boolean' });
      expect(outputProps.error).toEqual({ type: 'string' });
      expect(outputSchema.required).toEqual(['success']);
    });

    it('should have example code', () => {
      expect(metadata.example).toBeTruthy();
      expect(typeof metadata.example).toBe('string');
      expect(metadata.example).toContain('gitlab.listMrIds');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.project_id).toBeDefined();
      });
    });

    it('should have deferLoading disabled', () => {
      expect(metadata.deferLoading).toBe(false);
    });
  });

  describe('execute - success cases', () => {
    let mockGitlab: { listMergeRequests: ReturnType<typeof vi.fn> };

    const mockMRs = [
      {
        id: 1,
        iid: 10,
        title: 'Feature A',
        state: 'opened',
        source_branch: 'feature/a',
        target_branch: 'main',
        author: { username: 'alice' },
        web_url: 'https://gitlab.com/merge_requests/10',
      },
      {
        id: 2,
        iid: 11,
        title: 'Feature B',
        state: 'merged',
        source_branch: 'feature/b',
        target_branch: 'main',
        author: { username: 'bob' },
        web_url: 'https://gitlab.com/merge_requests/11',
      },
    ];

    beforeEach(() => {
      mockGitlab = {
        listMergeRequests: vi.fn().mockResolvedValue(mockMRs),
      };
    });

    it('should list merge requests with project path', async () => {
      const params = {
        project_id: 'my-group/my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.merge_requests).toEqual(mockMRs);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledTimes(1);
    });

    it('should list merge requests with numeric project ID', async () => {
      const params = {
        project_id: 12345,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.merge_requests).toEqual(mockMRs);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
    });

    it('should list merge requests with state filter', async () => {
      const params = {
        project_id: 'speedwave/core',
        state: 'opened',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
    });

    it('should list merge requests with author filter', async () => {
      const params = {
        project_id: 'my-project',
        author_username: 'john.doe',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
    });

    it('should list merge requests with all optional filters', async () => {
      const params = {
        project_id: 'my-project',
        state: 'opened',
        author_username: 'alice',
        limit: 50,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
    });

    it('should return empty array when API returns non-array', async () => {
      mockGitlab.listMergeRequests.mockResolvedValue({ data: [] });

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.merge_requests).toEqual([]);
    });

    it('should return empty array when API returns empty array', async () => {
      mockGitlab.listMergeRequests.mockResolvedValue([]);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.merge_requests).toEqual([]);
    });
  });

  describe('execute - parameter validation', () => {
    let mockGitlab: { listMergeRequests: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        listMergeRequests: vi.fn().mockResolvedValue([]),
      };
    });

    it('should fail when project_id is missing', async () => {
      const params = {} as { project_id: string };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listMergeRequests).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string', async () => {
      const params = {
        project_id: '',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listMergeRequests).not.toHaveBeenCalled();
    });

    it('should fail when project_id is null', async () => {
      const params = {
        project_id: null as unknown as string,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listMergeRequests).not.toHaveBeenCalled();
    });

    it('should fail when project_id is undefined', async () => {
      const params = {
        project_id: undefined as unknown as string,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listMergeRequests).not.toHaveBeenCalled();
    });

    it('should fail when project_id is 0 (falsy number)', async () => {
      const params = {
        project_id: 0,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listMergeRequests).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockGitlab: { listMergeRequests: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        listMergeRequests: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('gitlab: Resource not found');
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'nonexistent/project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Resource not found');
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('gitlab: Permission denied - insufficient privileges');
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'restricted/project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Permission denied - insufficient privileges');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('gitlab: Authentication failed - check token');
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Authentication failed - check token');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('gitlab: Connection timeout - service not responding');
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Connection timeout - service not responding');
    });

    it('should handle non-Error thrown objects with message', async () => {
      const error = { message: 'Custom error object' };
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Custom error object');
    });

    it('should handle non-Error thrown objects with description (GitLab API style)', async () => {
      const error = { description: 'Project access denied' };
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project access denied');
    });

    it('should handle non-Error thrown objects without message or description', async () => {
      const error = { code: 'ERR_UNKNOWN', details: 'Something went wrong' };
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('code');
      expect(result.error).toContain('ERR_UNKNOWN');
    });

    it('should handle string thrown errors', async () => {
      const error = 'String error';
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error');
    });

    it('should handle undefined thrown errors', async () => {
      mockGitlab.listMergeRequests.mockRejectedValue(undefined);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: undefined');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockGitlab.listMergeRequests.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockGitlab: { listMergeRequests: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        listMergeRequests: vi.fn().mockResolvedValue([]),
      };
    });

    it('should handle deeply nested project path', async () => {
      const params = {
        project_id: 'org/team/subteam/group/project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
    });

    it('should handle project path with special characters', async () => {
      const params = {
        project_id: 'my-org/my-project-2024',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
    });

    it('should handle very large numeric project ID', async () => {
      const params = {
        project_id: 999999999,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listMergeRequests).toHaveBeenCalledWith(params);
    });

    it('should handle null returned from API as empty array', async () => {
      mockGitlab.listMergeRequests.mockResolvedValue(null);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.merge_requests).toEqual([]);
    });

    it('should handle string returned from API as empty array', async () => {
      mockGitlab.listMergeRequests.mockResolvedValue('not an array');

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.merge_requests).toEqual([]);
    });
  });
});

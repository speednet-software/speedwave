import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './show_merge_request.js';

//===============================================================================
// Tests for GitLab Show Merge Request Tool
//
// Purpose: Test merge request detail retrieval functionality
// - Verify metadata (name, category, service, schema)
// - Test successful MR retrieval scenarios
// - Test parameter validation
// - Test error handling (404, 403, 401, network errors, etc.)
// - Test edge cases (special characters, nested paths)
//===============================================================================

describe('gitlab/show_merge_request', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('getMrFull');
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
      expect(metadata.keywords).toContain('show');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['project_id', 'mr_iid']);
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

    it('should define mr_iid in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const mrIidSchema = properties.mr_iid;
      expect(mrIidSchema).toBeDefined();
      expect(mrIidSchema.type).toBe('number');
      expect(mrIidSchema.description).toBeTruthy();
    });

    it('should define optional include in schema', () => {
      const properties = metadata.inputSchema.properties as Record<string, unknown>;
      const includeSchema = properties.include as { type: string; items: { type: string } };
      expect(includeSchema).toBeDefined();
      expect(includeSchema.type).toBe('array');
      expect(includeSchema.items.type).toBe('string');
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
      expect(metadata.example).toContain('gitlab.getMrFull');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.project_id).toBeDefined();
        expect(example.input.mr_iid).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockGitlab: { showMergeRequest: ReturnType<typeof vi.fn> };

    const mockMR = {
      id: 300,
      iid: 42,
      title: 'Add feature X',
      description: 'Feature description',
      state: 'opened',
      source_branch: 'feature/x',
      target_branch: 'main',
      author: { username: 'john.doe' },
      assignees: [],
      reviewers: [],
      web_url: 'https://gitlab.com/group/project/-/merge_requests/42',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      changes_count: '5',
    };

    beforeEach(() => {
      mockGitlab = {
        showMergeRequest: vi.fn().mockResolvedValue(mockMR),
      };
    });

    it('should show merge request with project path', async () => {
      const params = {
        project_id: 'my-group/my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.merge_request).toEqual(mockMR);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledTimes(1);
    });

    it('should show merge request with numeric project ID', async () => {
      const params = {
        project_id: 12345,
        mr_iid: 99,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.merge_request).toEqual(mockMR);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should show merge request with nested project path', async () => {
      const params = {
        project_id: 'group/subgroup/project',
        mr_iid: 1,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should show merge request with large MR IID', async () => {
      const params = {
        project_id: 'speedwave/core',
        mr_iid: 99999,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockGitlab: { showMergeRequest: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        showMergeRequest: vi.fn().mockResolvedValue({}),
      };
    });

    it('should fail when project_id is missing', async () => {
      const params = {
        mr_iid: 42,
      } as { project_id: string; mr_iid: number };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when mr_iid is missing', async () => {
      const params = {
        project_id: 'my-project',
      } as { project_id: string; mr_iid: number };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when both parameters are missing', async () => {
      const params = {} as { project_id: string; mr_iid: number };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string', async () => {
      const params = {
        project_id: '',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when project_id is null', async () => {
      const params = {
        project_id: null as unknown as string,
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when project_id is undefined', async () => {
      const params = {
        project_id: undefined as unknown as string,
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when mr_iid is null', async () => {
      const params = {
        project_id: 'my-project',
        mr_iid: null as unknown as number,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when mr_iid is undefined', async () => {
      const params = {
        project_id: 'my-project',
        mr_iid: undefined as unknown as number,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when mr_iid is 0 (falsy number)', async () => {
      const params = {
        project_id: 'my-project',
        mr_iid: 0,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when project_id is 0 (falsy number)', async () => {
      const params = {
        project_id: 0,
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, mr_iid');
      expect(mockGitlab.showMergeRequest).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockGitlab: { showMergeRequest: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        showMergeRequest: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('gitlab: Resource not found');
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'nonexistent/project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Resource not found');
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('gitlab: Permission denied - insufficient privileges');
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'restricted/project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Permission denied - insufficient privileges');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('gitlab: Authentication failed - check token');
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Authentication failed - check token');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('gitlab: Connection timeout - service not responding');
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Connection timeout - service not responding');
    });

    it('should handle non-Error thrown objects with message', async () => {
      const error = { message: 'Custom error object' };
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Custom error object');
    });

    it('should handle non-Error thrown objects with description (GitLab API style)', async () => {
      const error = { description: 'Merge request not found' };
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Merge request not found');
    });

    it('should handle non-Error thrown objects without message or description', async () => {
      const error = { code: 'ERR_UNKNOWN', details: 'Something went wrong' };
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('code');
      expect(result.error).toContain('ERR_UNKNOWN');
    });

    it('should handle string thrown errors', async () => {
      const error = 'String error';
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error');
    });

    it('should handle undefined thrown errors', async () => {
      mockGitlab.showMergeRequest.mockRejectedValue(undefined);

      const params = {
        project_id: 'my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: undefined');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockGitlab.showMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockGitlab: { showMergeRequest: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        showMergeRequest: vi.fn().mockResolvedValue({ id: 1, iid: 1 }),
      };
    });

    it('should handle deeply nested project path', async () => {
      const params = {
        project_id: 'org/team/subteam/group/project',
        mr_iid: 1,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle project path with special characters', async () => {
      const params = {
        project_id: 'my-org/my-project-2024',
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle very large numeric project ID', async () => {
      const params = {
        project_id: 999999999,
        mr_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle very large MR IID', async () => {
      const params = {
        project_id: 'my-project',
        mr_iid: 999999,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle MR IID of 1', async () => {
      const params = {
        project_id: 'speedwave/core',
        mr_iid: 1,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.showMergeRequest).toHaveBeenCalledWith(params);
    });
  });
});

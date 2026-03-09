import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './create_merge_request.js';

//===============================================================================
// Tests for GitLab Create Merge Request Tool
//
// Purpose: Test merge request creation functionality
// - Verify metadata (name, category, service, schema)
// - Test successful MR creation scenarios
// - Test parameter validation
// - Test error handling (404, 403, 401, network errors, etc.)
// - Test edge cases (special characters, optional params)
//===============================================================================

describe('gitlab/create_merge_request', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('createMergeRequest');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('write');
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
      expect(metadata.keywords).toContain('create');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual([
        'project_id',
        'source_branch',
        'target_branch',
        'title',
      ]);
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

    it('should define source_branch in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const srcSchema = properties.source_branch;
      expect(srcSchema).toBeDefined();
      expect(srcSchema.type).toBe('string');
      expect(srcSchema.description).toBeTruthy();
    });

    it('should define target_branch in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const tgtSchema = properties.target_branch;
      expect(tgtSchema).toBeDefined();
      expect(tgtSchema.type).toBe('string');
      expect(tgtSchema.description).toBeTruthy();
    });

    it('should define title in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const titleSchema = properties.title;
      expect(titleSchema).toBeDefined();
      expect(titleSchema.type).toBe('string');
      expect(titleSchema.description).toBeTruthy();
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
      expect(metadata.example).toContain('gitlab.createMergeRequest');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.project_id).toBeDefined();
        expect(example.input.source_branch).toBeDefined();
        expect(example.input.target_branch).toBeDefined();
        expect(example.input.title).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockGitlab: { createMergeRequest: ReturnType<typeof vi.fn> };

    const mockMR = {
      id: 200,
      iid: 42,
      title: 'Add feature X',
      web_url: 'https://gitlab.com/group/project/-/merge_requests/42',
      source_branch: 'feature/x',
      target_branch: 'main',
    };

    beforeEach(() => {
      mockGitlab = {
        createMergeRequest: vi.fn().mockResolvedValue(mockMR),
      };
    });

    it('should create merge request with required fields only', async () => {
      const params = {
        project_id: 'my-group/my-project',
        source_branch: 'feature/auth',
        target_branch: 'main',
        title: 'Add authentication flow',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.merge_request).toEqual(mockMR);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledTimes(1);
    });

    it('should create merge request with numeric project ID', async () => {
      const params = {
        project_id: 12345,
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'New feature',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.merge_request).toEqual(mockMR);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should create merge request with description', async () => {
      const params = {
        project_id: 'speedwave/core',
        source_branch: 'feature/auth',
        target_branch: 'develop',
        title: 'feat: Add JWT auth',
        description: '## Summary\n\n- Implemented JWT\n- Added tests',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should create merge request with nested project path', async () => {
      const params = {
        project_id: 'group/subgroup/project',
        source_branch: 'fix/bug',
        target_branch: 'main',
        title: 'Fix critical bug',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockGitlab: { createMergeRequest: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        createMergeRequest: vi.fn().mockResolvedValue({}),
      };
    });

    it('should fail when project_id is missing', async () => {
      const params = {
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      } as any;

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when source_branch is missing', async () => {
      const params = {
        project_id: 'my-project',
        target_branch: 'main',
        title: 'Test',
      } as any;

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when target_branch is missing', async () => {
      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        title: 'Test',
      } as any;

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when title is missing', async () => {
      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
      } as any;

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when all parameters are missing', async () => {
      const params = {} as any;

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string', async () => {
      const params = {
        project_id: '',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when source_branch is empty string', async () => {
      const params = {
        project_id: 'my-project',
        source_branch: '',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when project_id is null', async () => {
      const params = {
        project_id: null as unknown as string,
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when project_id is undefined', async () => {
      const params = {
        project_id: undefined as unknown as string,
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });

    it('should fail when project_id is 0 (falsy number)', async () => {
      const params = {
        project_id: 0,
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Missing required fields: project_id, source_branch, target_branch, title'
      );
      expect(mockGitlab.createMergeRequest).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockGitlab: { createMergeRequest: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        createMergeRequest: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('gitlab: Resource not found');
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'nonexistent/project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Resource not found');
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('gitlab: Permission denied - insufficient privileges');
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'restricted/project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Permission denied - insufficient privileges');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('gitlab: Authentication failed - check token');
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Authentication failed - check token');
    });

    it('should handle branch not found error', async () => {
      const error = new Error('gitlab: Source branch not found');
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        source_branch: 'nonexistent-branch',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Source branch not found');
    });

    it('should handle non-Error thrown objects with message', async () => {
      const error = { message: 'Custom error object' };
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Custom error object');
    });

    it('should handle non-Error thrown objects with description (GitLab API style)', async () => {
      const error = { description: 'Another open merge request already exists' };
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Another open merge request already exists');
    });

    it('should handle non-Error thrown objects without message or description', async () => {
      const error = { code: 'ERR_UNKNOWN', details: 'Something went wrong' };
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('code');
      expect(result.error).toContain('ERR_UNKNOWN');
    });

    it('should handle string thrown errors', async () => {
      const error = 'String error';
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error');
    });

    it('should handle undefined thrown errors', async () => {
      mockGitlab.createMergeRequest.mockRejectedValue(undefined);

      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: undefined');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockGitlab.createMergeRequest.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockGitlab: { createMergeRequest: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        createMergeRequest: vi.fn().mockResolvedValue({ id: 1, iid: 1 }),
      };
    });

    it('should handle deeply nested project path', async () => {
      const params = {
        project_id: 'org/team/subteam/group/project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test MR',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle branch names with slashes', async () => {
      const params = {
        project_id: 'my-project',
        source_branch: 'feature/user/auth-flow',
        target_branch: 'release/v2.0',
        title: 'Test MR',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle very large numeric project ID', async () => {
      const params = {
        project_id: 999999999,
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'Test MR',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle title with special characters', async () => {
      const params = {
        project_id: 'my-project',
        source_branch: 'feature/x',
        target_branch: 'main',
        title: 'feat: Add "quotes" & <special> chars',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });

    it('should handle project path with special characters', async () => {
      const params = {
        project_id: 'my-org/my-project-2024',
        source_branch: 'fix/bug-123',
        target_branch: 'main',
        title: 'Fix bug #123',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createMergeRequest).toHaveBeenCalledWith(params);
    });
  });
});

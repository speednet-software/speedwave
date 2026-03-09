import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './get_issue.js';

//===============================================================================
// Tests for GitLab Get Issue Tool
//
// Purpose: Test issue detail retrieval functionality
// - Verify metadata (name, category, service, schema)
// - Test successful issue retrieval scenarios
// - Test parameter validation
// - Test error handling (404, 403, 401, network errors, etc.)
// - Test edge cases (special characters, nested paths)
//===============================================================================

describe('gitlab/get_issue', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('getIssue');
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
      expect(metadata.keywords).toContain('issue');
      expect(metadata.keywords).toContain('get');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['project_id', 'issue_iid']);
    });

    it('should define project_id in schema with string or number type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const projectIdSchema = properties.project_id;
      expect(projectIdSchema).toBeDefined();
      expect(projectIdSchema.type).toEqual(['string', 'number']);
      expect(projectIdSchema.description).toBeTruthy();
    });

    it('should define issue_iid in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const issueIidSchema = properties.issue_iid;
      expect(issueIidSchema).toBeDefined();
      expect(issueIidSchema.type).toBe('number');
      expect(issueIidSchema.description).toBeTruthy();
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
      expect(metadata.example).toContain('gitlab.getIssue');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.project_id).toBeDefined();
        expect(example.input.issue_iid).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockGitlab: { getIssue: ReturnType<typeof vi.fn> };

    const mockIssue = {
      id: 100,
      iid: 42,
      title: 'Fix login bug',
      description: 'Steps to reproduce...',
      state: 'opened',
      labels: ['bug'],
      assignees: [{ username: 'john.doe' }],
      web_url: 'https://gitlab.com/group/project/-/issues/42',
    };

    beforeEach(() => {
      mockGitlab = {
        getIssue: vi.fn().mockResolvedValue(mockIssue),
      };
    });

    it('should get issue with project path', async () => {
      const params = {
        project_id: 'my-group/my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.issue).toEqual(mockIssue);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
      expect(mockGitlab.getIssue).toHaveBeenCalledTimes(1);
    });

    it('should get issue with numeric project ID', async () => {
      const params = {
        project_id: 12345,
        issue_iid: 99,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.issue).toEqual(mockIssue);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });

    it('should get issue with nested project path', async () => {
      const params = {
        project_id: 'group/subgroup/project',
        issue_iid: 1,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });

    it('should get issue with large issue IID', async () => {
      const params = {
        project_id: 'speedwave/core',
        issue_iid: 99999,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockGitlab: { getIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        getIssue: vi.fn().mockResolvedValue({}),
      };
    });

    it('should fail when project_id is missing', async () => {
      const params = {
        issue_iid: 42,
      } as { project_id: string; issue_iid: number };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when issue_iid is missing', async () => {
      const params = {
        project_id: 'my-project',
      } as { project_id: string; issue_iid: number };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when both parameters are missing', async () => {
      const params = {} as { project_id: string; issue_iid: number };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string', async () => {
      const params = {
        project_id: '',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is null', async () => {
      const params = {
        project_id: null as unknown as string,
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is undefined', async () => {
      const params = {
        project_id: undefined as unknown as string,
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when issue_iid is null', async () => {
      const params = {
        project_id: 'my-project',
        issue_iid: null as unknown as number,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when issue_iid is undefined', async () => {
      const params = {
        project_id: 'my-project',
        issue_iid: undefined as unknown as number,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when issue_iid is 0 (falsy number)', async () => {
      const params = {
        project_id: 'my-project',
        issue_iid: 0,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is 0 (falsy number)', async () => {
      const params = {
        project_id: 0,
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, issue_iid');
      expect(mockGitlab.getIssue).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockGitlab: { getIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        getIssue: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('gitlab: Resource not found');
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'nonexistent/project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Resource not found');
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('gitlab: Permission denied - insufficient privileges');
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'restricted/project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Permission denied - insufficient privileges');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('gitlab: Authentication failed - check token');
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Authentication failed - check token');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('gitlab: Connection timeout - service not responding');
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Connection timeout - service not responding');
    });

    it('should handle non-Error thrown objects with message', async () => {
      const error = { message: 'Custom error object' };
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Custom error object');
    });

    it('should handle non-Error thrown objects with description (GitLab API style)', async () => {
      const error = { description: 'Issue not found' };
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Issue not found');
    });

    it('should handle non-Error thrown objects without message or description', async () => {
      const error = { code: 'ERR_UNKNOWN', details: 'Something went wrong' };
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('code');
      expect(result.error).toContain('ERR_UNKNOWN');
    });

    it('should handle string thrown errors', async () => {
      const error = 'String error';
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error');
    });

    it('should handle undefined thrown errors', async () => {
      mockGitlab.getIssue.mockRejectedValue(undefined);

      const params = {
        project_id: 'my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: undefined');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockGitlab.getIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockGitlab: { getIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        getIssue: vi.fn().mockResolvedValue({ id: 1, iid: 1 }),
      };
    });

    it('should handle deeply nested project path', async () => {
      const params = {
        project_id: 'org/team/subteam/group/project',
        issue_iid: 1,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });

    it('should handle project path with special characters', async () => {
      const params = {
        project_id: 'my-org/my-project-2024',
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });

    it('should handle very large numeric project ID', async () => {
      const params = {
        project_id: 999999999,
        issue_iid: 42,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });

    it('should handle very large issue IID', async () => {
      const params = {
        project_id: 'my-project',
        issue_iid: 999999,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });

    it('should handle issue IID of 1', async () => {
      const params = {
        project_id: 'speedwave/core',
        issue_iid: 1,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.getIssue).toHaveBeenCalledWith(params);
    });
  });
});

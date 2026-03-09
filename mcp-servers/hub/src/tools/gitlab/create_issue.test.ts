import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './create_issue.js';

//===============================================================================
// Tests for GitLab Create Issue Tool
//
// Purpose: Test issue creation functionality
// - Verify metadata (name, category, service, schema)
// - Test successful issue creation scenarios
// - Test parameter validation
// - Test error handling (404, 403, 401, network errors, etc.)
// - Test edge cases (special characters, optional params)
//===============================================================================

describe('gitlab/create_issue', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('createIssue');
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
      expect(metadata.keywords).toContain('issue');
      expect(metadata.keywords).toContain('create');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['project_id', 'title']);
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

    it('should define optional description in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const descSchema = properties.description;
      expect(descSchema).toBeDefined();
      expect(descSchema.type).toBe('string');
    });

    it('should define optional labels in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const labelsSchema = properties.labels;
      expect(labelsSchema).toBeDefined();
      expect(labelsSchema.type).toBe('string');
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
      expect(metadata.example).toContain('gitlab.createIssue');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.project_id).toBeDefined();
        expect(example.input.title).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockGitlab: { createIssue: ReturnType<typeof vi.fn> };

    const mockIssue = {
      id: 100,
      iid: 1,
      title: 'Test issue',
      web_url: 'https://gitlab.com/group/project/-/issues/1',
    };

    beforeEach(() => {
      mockGitlab = {
        createIssue: vi.fn().mockResolvedValue(mockIssue),
      };
    });

    it('should create issue with required fields only', async () => {
      const params = {
        project_id: 'my-group/my-project',
        title: 'Fix login bug',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.issue).toEqual(mockIssue);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
      expect(mockGitlab.createIssue).toHaveBeenCalledTimes(1);
    });

    it('should create issue with numeric project ID', async () => {
      const params = {
        project_id: 12345,
        title: 'New feature request',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.issue).toEqual(mockIssue);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should create issue with all optional fields', async () => {
      const params = {
        project_id: 'speedwave/core',
        title: 'Bug: Login fails',
        description: 'Steps to reproduce...',
        labels: 'bug,priority',
        assignee_ids: [1, 2],
        milestone_id: 5,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should create issue with nested project path', async () => {
      const params = {
        project_id: 'group/subgroup/project',
        title: 'Test issue',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should create issue with markdown description', async () => {
      const params = {
        project_id: 'my-project',
        title: 'Feature request',
        description: '## Summary\n\n- Item 1\n- Item 2\n\n```js\nconsole.log("hello");\n```',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockGitlab: { createIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        createIssue: vi.fn().mockResolvedValue({}),
      };
    });

    it('should fail when project_id is missing', async () => {
      const params = {
        title: 'Test',
      } as { project_id: string; title: string };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when title is missing', async () => {
      const params = {
        project_id: 'my-project',
      } as { project_id: string; title: string };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when both parameters are missing', async () => {
      const params = {} as { project_id: string; title: string };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string', async () => {
      const params = {
        project_id: '',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when title is empty string', async () => {
      const params = {
        project_id: 'my-project',
        title: '',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is null', async () => {
      const params = {
        project_id: null as unknown as string,
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when title is null', async () => {
      const params = {
        project_id: 'my-project',
        title: null as unknown as string,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is undefined', async () => {
      const params = {
        project_id: undefined as unknown as string,
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when title is undefined', async () => {
      const params = {
        project_id: 'my-project',
        title: undefined as unknown as string,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is 0 (falsy number)', async () => {
      const params = {
        project_id: 0,
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, title');
      expect(mockGitlab.createIssue).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockGitlab: { createIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        createIssue: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('gitlab: Resource not found');
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'nonexistent/project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Resource not found');
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('gitlab: Permission denied - insufficient privileges');
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'restricted/project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Permission denied - insufficient privileges');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('gitlab: Authentication failed - check token');
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Authentication failed - check token');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('gitlab: Connection timeout - service not responding');
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Connection timeout - service not responding');
    });

    it('should handle non-Error thrown objects with message', async () => {
      const error = { message: 'Custom error object' };
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Custom error object');
    });

    it('should handle non-Error thrown objects with description (GitLab API style)', async () => {
      const error = { description: 'Title has already been taken' };
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Title has already been taken');
    });

    it('should handle non-Error thrown objects without message or description', async () => {
      const error = { code: 'ERR_UNKNOWN', details: 'Something went wrong' };
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('code');
      expect(result.error).toContain('ERR_UNKNOWN');
    });

    it('should handle string thrown errors', async () => {
      const error = 'String error';
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error');
    });

    it('should handle undefined thrown errors', async () => {
      mockGitlab.createIssue.mockRejectedValue(undefined);

      const params = {
        project_id: 'my-project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: undefined');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockGitlab.createIssue.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        title: 'Test',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockGitlab: { createIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        createIssue: vi.fn().mockResolvedValue({ id: 1, iid: 1, title: 'Test' }),
      };
    });

    it('should handle deeply nested project path', async () => {
      const params = {
        project_id: 'org/team/subteam/group/project',
        title: 'Test issue',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle project path with special characters', async () => {
      const params = {
        project_id: 'my-org/my-project-2024',
        title: 'Test issue',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle very large numeric project ID', async () => {
      const params = {
        project_id: 999999999,
        title: 'Test issue',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle title with special characters', async () => {
      const params = {
        project_id: 'my-project',
        title: 'Bug: Login fails with "special chars" & <html> tags',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle very long title', async () => {
      const params = {
        project_id: 'my-project',
        title: 'A'.repeat(500),
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle unicode characters in title', async () => {
      const params = {
        project_id: 'my-project',
        title: 'Issue with unicode: \u00e9\u00e8\u00ea \u00fc\u00f6\u00e4 \u2603 \u2764',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.createIssue).toHaveBeenCalledWith(params);
    });
  });
});

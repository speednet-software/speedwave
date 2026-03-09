import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './list_issues.js';

//===============================================================================
// Tests for GitLab List Issues Tool
//
// Purpose: Test issue listing functionality
// - Verify metadata (name, category, service, schema)
// - Test successful issue listing scenarios
// - Test parameter validation
// - Test error handling (404, 403, 401, network errors, etc.)
// - Test edge cases (empty results, non-array results)
//===============================================================================

describe('gitlab/list_issues', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('listIssues');
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
      expect(metadata.keywords).toContain('issues');
      expect(metadata.keywords).toContain('list');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['project_id']);
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

    it('should define optional state in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const stateSchema = properties.state;
      expect(stateSchema).toBeDefined();
      expect(stateSchema.type).toBe('string');
    });

    it('should define optional labels in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
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
      expect(metadata.example).toContain('gitlab.listIssues');
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

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockGitlab: { listIssues: ReturnType<typeof vi.fn> };

    const mockIssues = [
      {
        id: 1,
        iid: 1,
        title: 'Issue 1',
        state: 'opened',
        labels: ['bug'],
        web_url: 'https://gitlab.com/issues/1',
      },
      {
        id: 2,
        iid: 2,
        title: 'Issue 2',
        state: 'closed',
        labels: [],
        web_url: 'https://gitlab.com/issues/2',
      },
    ];

    beforeEach(() => {
      mockGitlab = {
        listIssues: vi.fn().mockResolvedValue(mockIssues),
      };
    });

    it('should list issues with project path', async () => {
      const params = {
        project_id: 'my-group/my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.issues).toEqual(mockIssues);
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
      expect(mockGitlab.listIssues).toHaveBeenCalledTimes(1);
    });

    it('should list issues with numeric project ID', async () => {
      const params = {
        project_id: 12345,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.issues).toEqual(mockIssues);
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
    });

    it('should list issues with state filter', async () => {
      const params = {
        project_id: 'speedwave/core',
        state: 'opened',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
    });

    it('should list issues with labels filter', async () => {
      const params = {
        project_id: 'my-project',
        labels: 'bug,urgent',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
    });

    it('should list issues with all optional filters', async () => {
      const params = {
        project_id: 'my-project',
        state: 'opened',
        labels: 'bug',
        assignee_username: 'john.doe',
        limit: 50,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
    });

    it('should return empty array when API returns non-array', async () => {
      mockGitlab.listIssues.mockResolvedValue({ data: [] });

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('should return empty array when API returns empty array', async () => {
      mockGitlab.listIssues.mockResolvedValue([]);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.issues).toEqual([]);
    });
  });

  describe('execute - parameter validation', () => {
    let mockGitlab: { listIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        listIssues: vi.fn().mockResolvedValue([]),
      };
    });

    it('should fail when project_id is missing', async () => {
      const params = {} as { project_id: string };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listIssues).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string', async () => {
      const params = {
        project_id: '',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listIssues).not.toHaveBeenCalled();
    });

    it('should fail when project_id is null', async () => {
      const params = {
        project_id: null as unknown as string,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listIssues).not.toHaveBeenCalled();
    });

    it('should fail when project_id is undefined', async () => {
      const params = {
        project_id: undefined as unknown as string,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listIssues).not.toHaveBeenCalled();
    });

    it('should fail when project_id is 0 (falsy number)', async () => {
      const params = {
        project_id: 0,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: project_id');
      expect(mockGitlab.listIssues).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockGitlab: { listIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        listIssues: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('gitlab: Resource not found');
      mockGitlab.listIssues.mockRejectedValue(error);

      const params = {
        project_id: 'nonexistent/project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Resource not found');
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('gitlab: Permission denied - insufficient privileges');
      mockGitlab.listIssues.mockRejectedValue(error);

      const params = {
        project_id: 'restricted/project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Permission denied - insufficient privileges');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('gitlab: Authentication failed - check token');
      mockGitlab.listIssues.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Authentication failed - check token');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('gitlab: Connection timeout - service not responding');
      mockGitlab.listIssues.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Connection timeout - service not responding');
    });

    it('should handle non-Error thrown objects with message', async () => {
      const error = { message: 'Custom error object' };
      mockGitlab.listIssues.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Custom error object');
    });

    it('should handle non-Error thrown objects with description (GitLab API style)', async () => {
      const error = { description: 'Project access denied' };
      mockGitlab.listIssues.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project access denied');
    });

    it('should handle non-Error thrown objects without message or description', async () => {
      const error = { code: 'ERR_UNKNOWN', details: 'Something went wrong' };
      mockGitlab.listIssues.mockRejectedValue(error);

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
      mockGitlab.listIssues.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error');
    });

    it('should handle undefined thrown errors', async () => {
      mockGitlab.listIssues.mockRejectedValue(undefined);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: undefined');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockGitlab.listIssues.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockGitlab: { listIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        listIssues: vi.fn().mockResolvedValue([]),
      };
    });

    it('should handle deeply nested project path', async () => {
      const params = {
        project_id: 'org/team/subteam/group/project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
    });

    it('should handle project path with special characters', async () => {
      const params = {
        project_id: 'my-org/my-project-2024',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
    });

    it('should handle very large numeric project ID', async () => {
      const params = {
        project_id: 999999999,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.listIssues).toHaveBeenCalledWith(params);
    });

    it('should handle null returned from API as empty array', async () => {
      mockGitlab.listIssues.mockResolvedValue(null);

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('should handle string returned from API as empty array', async () => {
      mockGitlab.listIssues.mockResolvedValue('not an array');

      const params = {
        project_id: 'my-project',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.issues).toEqual([]);
    });
  });
});

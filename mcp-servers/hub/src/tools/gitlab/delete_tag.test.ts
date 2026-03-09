import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './delete_tag.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for GitLab Delete Tag Tool
//
// Purpose: Test tag deletion functionality
// - Verify metadata (name, category, service, schema)
// - Test successful tag deletion scenarios
// - Test parameter validation
// - Test error handling (404, 403, 401, network errors, etc.)
// - Test edge cases (special characters, nested paths)
//═══════════════════════════════════════════════════════════════════════════════

describe('gitlab/delete_tag', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('deleteTag');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('delete');
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
      expect(metadata.keywords).toContain('tag');
      expect(metadata.keywords).toContain('delete');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['project_id', 'tag_name']);
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

    it('should define tag_name in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string | string[]; description: string }
      >;
      const tagNameSchema = properties.tag_name;
      expect(tagNameSchema).toBeDefined();
      expect(tagNameSchema.type).toBe('string');
      expect(tagNameSchema.description).toBeTruthy();
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
      expect(metadata.example).toContain('gitlab.deleteTag');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.project_id).toBeDefined();
        expect(example.input.tag_name).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockGitlab: { deleteTag: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        deleteTag: vi.fn().mockResolvedValue({}),
      };
    });

    it('should delete tag with project path', async () => {
      const params = {
        project_id: 'my-group/my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result).toHaveProperty('message', "Tag 'v1.0.0' deleted successfully");
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
      expect(mockGitlab.deleteTag).toHaveBeenCalledTimes(1);
    });

    it('should delete tag with numeric project ID', async () => {
      const params = {
        project_id: 12345,
        tag_name: 'v2.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should delete tag with special characters in tag name', async () => {
      const params = {
        project_id: 'speedwave/core',
        tag_name: 'v1.0.0-beta.1',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should delete tag with nested project path', async () => {
      const params = {
        project_id: 'group/subgroup/project',
        tag_name: 'release-2024',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should delete tag with underscores in name', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: 'release_v1_0_0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should delete tag with numeric-only name', async () => {
      const params = {
        project_id: 999,
        tag_name: '20240101',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockGitlab: { deleteTag: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        deleteTag: vi.fn().mockResolvedValue({}),
      };
    });

    it('should fail when project_id is missing', async () => {
      const params = {
        tag_name: 'v1.0.0',
      } as { project_id: string; tag_name: string };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when tag_name is missing', async () => {
      const params = {
        project_id: 'my-project',
      } as { project_id: string; tag_name: string };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when tag_name contains spaces', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0 beta',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid tag name');
      expect(result.error).toContain('cannot contain spaces');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when tag_name is only whitespace', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: '   ',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when both parameters are missing', async () => {
      const params = {} as { project_id: string; tag_name: string };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string', async () => {
      const params = {
        project_id: '',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when tag_name is empty string', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: '',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when project_id is null', async () => {
      const params = {
        project_id: null as unknown as string,
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when tag_name is null', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: null as unknown as string,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when project_id is undefined', async () => {
      const params = {
        project_id: undefined as unknown as string,
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when tag_name is undefined', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: undefined as unknown as string,
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });

    it('should fail when project_id is 0 (falsy number)', async () => {
      const params = {
        project_id: 0,
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: project_id, tag_name');
      expect(mockGitlab.deleteTag).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockGitlab: { deleteTag: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        deleteTag: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('gitlab: Resource not found');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'nonexistent/project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Resource not found');
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('gitlab: Permission denied - insufficient privileges');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'restricted/project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Permission denied - insufficient privileges');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('gitlab: Authentication failed - check token');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Authentication failed - check token');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('gitlab: Connection timeout - service not responding');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Connection timeout - service not responding');
    });

    it('should handle network connection refused error', async () => {
      const error = new Error('gitlab: Connection refused - service not reachable');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Connection refused - service not reachable');
    });

    it('should handle rate limiting (429) error', async () => {
      const error = new Error('gitlab: Rate limit exceeded - try again later');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Rate limit exceeded - try again later');
    });

    it('should handle tag not found specific error', async () => {
      const error = new Error("gitlab: Tag 'v1.0.0' not found");
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe("gitlab: Tag 'v1.0.0' not found");
    });

    it('should handle tag protected error', async () => {
      const error = new Error('gitlab: Cannot delete protected tag');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: Cannot delete protected tag');
    });

    it('should handle generic API error', async () => {
      const error = new Error('gitlab: API request failed');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('gitlab: API request failed');
    });

    it('should handle non-Error thrown objects with message', async () => {
      const error = { message: 'Custom error object' };
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Custom error object');
    });

    it('should handle non-Error thrown objects with description (GitLab API style)', async () => {
      const error = { description: 'Invalid tag reference' };
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid tag reference');
    });

    it('should handle non-Error thrown objects without message or description', async () => {
      const error = { code: 'ERR_UNKNOWN', details: 'Something went wrong' };
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('code');
      expect(result.error).toContain('ERR_UNKNOWN');
    });

    it('should handle string thrown errors', async () => {
      const error = 'String error';
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error');
    });

    it('should handle undefined thrown errors', async () => {
      mockGitlab.deleteTag.mockRejectedValue(undefined);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: undefined');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockGitlab.deleteTag.mockRejectedValue(error);

      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockGitlab: { deleteTag: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGitlab = {
        deleteTag: vi.fn().mockResolvedValue({}),
      };
    });

    it('should handle tag name with slashes', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: 'release/v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle tag name with dots and hyphens', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0-rc.1',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle tag name with plus signs', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0+build.123',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle deeply nested project path', async () => {
      const params = {
        project_id: 'org/team/subteam/group/project',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle project path with special characters', async () => {
      const params = {
        project_id: 'my-org/my-project-2024',
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle very long tag names', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: 'v1.0.0-beta.1+build.20240101.123456.abcdef1234567890',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle tag name with uppercase letters', async () => {
      const params = {
        project_id: 123,
        tag_name: 'Release-V1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle very large numeric project ID', async () => {
      const params = {
        project_id: 999999999,
        tag_name: 'v1.0.0',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle tag name with underscores and dates', async () => {
      const params = {
        project_id: 'my-project',
        tag_name: 'release_2024_01_15',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });

    it('should handle tag name with version metadata', async () => {
      const params = {
        project_id: 'speedwave/core',
        tag_name: 'v2.1.3-alpha.2+exp.sha.5114f85',
      };

      const result = await execute(params, { gitlab: mockGitlab } as any);

      expect(result.success).toBe(true);
      expect(mockGitlab.deleteTag).toHaveBeenCalledWith(params);
    });
  });
});

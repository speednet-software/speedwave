import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './create_issue.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine Create Issue Tool
//
// Purpose: Test issue creation functionality
// - Verify metadata (name, category, service, schema)
// - Test successful issue creation scenarios
// - Test parameter validation
// - Test error handling (Error, non-Error, string, undefined, empty message)
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/create_issue', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('createIssue');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('write');
    });

    it('should have correct service', () => {
      expect(metadata.service).toBe('redmine');
    });

    it('should have non-empty description', () => {
      expect(metadata.description).toBeTruthy();
      expect(typeof metadata.description).toBe('string');
      expect(metadata.description.length).toBeGreaterThan(0);
    });

    it('should have keywords array', () => {
      expect(Array.isArray(metadata.keywords)).toBe(true);
      expect(metadata.keywords.length).toBeGreaterThan(0);
      expect(metadata.keywords).toContain('redmine');
      expect(metadata.keywords).toContain('issue');
      expect(metadata.keywords).toContain('create');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['subject', 'project_id']);
    });

    it('should define subject in schema with string type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const subjectSchema = properties.subject;
      expect(subjectSchema).toBeDefined();
      expect(subjectSchema.type).toBe('string');
      expect(subjectSchema.description).toBeTruthy();
    });

    it('should define project_id in schema with string type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const projectIdSchema = properties.project_id;
      expect(projectIdSchema).toBeDefined();
      expect(projectIdSchema.type).toBe('string');
      expect(projectIdSchema.description).toBeTruthy();
    });

    it('should define optional fields in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      expect(properties.description).toBeDefined();
      expect(properties.tracker).toBeDefined();
      expect(properties.priority).toBeDefined();
      expect(properties.assigned_to).toBeDefined();
      expect(properties.parent_id).toBeDefined();
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
      expect(metadata.example).toContain('createIssue');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.subject).toBeDefined();
        expect(example.input.project_id).toBeDefined();
      });
    });

    it('should have deferLoading disabled', () => {
      expect(metadata.deferLoading).toBe(false);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { createIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createIssue: vi.fn(),
      };
    });

    it('should create issue with required fields only', async () => {
      const mockIssue = {
        id: 100,
        subject: 'Fix login bug',
        project: { id: 1, name: 'My Project' },
      };
      mockRedmine.createIssue.mockResolvedValue(mockIssue);

      const params = { subject: 'Fix login bug', project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.issue).toEqual(mockIssue);
      expect(mockRedmine.createIssue).toHaveBeenCalledWith(params);
      expect(mockRedmine.createIssue).toHaveBeenCalledTimes(1);
    });

    it('should create issue with all optional fields', async () => {
      const mockIssue = {
        id: 101,
        subject: 'Implement JWT validation',
        project: { id: 1, name: 'My Project' },
      };
      mockRedmine.createIssue.mockResolvedValue(mockIssue);

      const params = {
        subject: 'Implement JWT validation',
        project_id: 'my-project',
        description: 'Token expiry not validated.',
        tracker: 'task',
        priority: 'normal',
        assigned_to: 'jane.doe',
        parent_id: 12345,
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.issue).toEqual(mockIssue);
      expect(mockRedmine.createIssue).toHaveBeenCalledWith(params);
    });

    it('should create a bug with high priority', async () => {
      const mockIssue = {
        id: 102,
        subject: 'Users cannot reset password',
        project: { id: 1, name: 'My Project' },
      };
      mockRedmine.createIssue.mockResolvedValue(mockIssue);

      const params = {
        subject: 'Users cannot reset password',
        project_id: 'my-project',
        tracker: 'bug',
        priority: 'high',
        assigned_to: 'me',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.issue!.id).toBe(102);
    });

    it('should create a subtask with parent_id', async () => {
      const mockIssue = {
        id: 103,
        subject: 'Write unit tests',
        project: { id: 1, name: 'My Project' },
      };
      mockRedmine.createIssue.mockResolvedValue(mockIssue);

      const params = {
        subject: 'Write unit tests',
        project_id: 'my-project',
        parent_id: 100,
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createIssue).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockRedmine: { createIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createIssue: vi.fn(),
      };
    });

    it('should fail when subject is missing', async () => {
      const params = {
        project_id: 'my-project',
      } as { subject: string; project_id: string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is missing', async () => {
      const params = {
        subject: 'Fix bug',
      } as { subject: string; project_id: string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when both parameters are missing', async () => {
      const params = {} as { subject: string; project_id: string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when subject is empty string', async () => {
      const params = {
        subject: '',
        project_id: 'my-project',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string', async () => {
      const params = {
        subject: 'Fix bug',
        project_id: '',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when subject is null', async () => {
      const params = {
        subject: null as unknown as string,
        project_id: 'my-project',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is null', async () => {
      const params = {
        subject: 'Fix bug',
        project_id: null as unknown as string,
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when subject is undefined', async () => {
      const params = {
        subject: undefined as unknown as string,
        project_id: 'my-project',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });

    it('should fail when project_id is undefined', async () => {
      const params = {
        subject: 'Fix bug',
        project_id: undefined as unknown as string,
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: subject, project_id');
      expect(mockRedmine.createIssue).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { createIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createIssue: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Project not found');
      mockRedmine.createIssue.mockRejectedValue(error);

      const params = { subject: 'Fix bug', project_id: 'nonexistent' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Project not found');
      expect(mockRedmine.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.createIssue.mockRejectedValue(error);

      const params = { subject: 'Fix bug', project_id: 'restricted-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Permission denied');
    });

    it('should handle 422 Validation error', async () => {
      const error = new Error('redmine: Validation failed - Tracker is invalid');
      mockRedmine.createIssue.mockRejectedValue(error);

      const params = { subject: 'Fix bug', project_id: 'my-project', tracker: 'invalid' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Validation failed - Tracker is invalid');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.createIssue.mockRejectedValue(error);

      const params = { subject: 'Fix bug', project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Connection timeout');
    });

    it('should handle non-Error thrown objects', async () => {
      mockRedmine.createIssue.mockRejectedValue({ message: 'Custom error' });

      const params = { subject: 'Fix bug', project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown errors', async () => {
      mockRedmine.createIssue.mockRejectedValue('String error');

      const params = { subject: 'Fix bug', project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown errors', async () => {
      mockRedmine.createIssue.mockRejectedValue(undefined);

      const params = { subject: 'Fix bug', project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockRedmine.createIssue.mockRejectedValue(error);

      const params = { subject: 'Fix bug', project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { createIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createIssue: vi.fn(),
      };
    });

    it('should handle very long subject', async () => {
      const mockIssue = {
        id: 200,
        subject: 'A'.repeat(500),
        project: { id: 1, name: 'My Project' },
      };
      mockRedmine.createIssue.mockResolvedValue(mockIssue);

      const params = { subject: 'A'.repeat(500), project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle project_id with hyphens and numbers', async () => {
      const mockIssue = {
        id: 201,
        subject: 'Test',
        project: { id: 2, name: 'Speedwave Core 2024' },
      };
      mockRedmine.createIssue.mockResolvedValue(mockIssue);

      const params = { subject: 'Test', project_id: 'speedwave-core-2024' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle subject with special characters', async () => {
      const mockIssue = {
        id: 202,
        subject: 'Fix: Login fails with "special" & <chars>',
        project: { id: 1, name: 'My Project' },
      };
      mockRedmine.createIssue.mockResolvedValue(mockIssue);

      const params = {
        subject: 'Fix: Login fails with "special" & <chars>',
        project_id: 'my-project',
      };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createIssue).toHaveBeenCalledWith(params);
    });

    it('should handle description with Textile markup', async () => {
      const mockIssue = {
        id: 203,
        subject: 'Test Textile',
        project: { id: 1, name: 'My Project' },
      };
      mockRedmine.createIssue.mockResolvedValue(mockIssue);

      const params = {
        subject: 'Test Textile',
        project_id: 'my-project',
        description: 'h2. Context\n\n* Item 1\n* Item 2\n\n|col1|col2|\n|a|b|',
      };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createIssue).toHaveBeenCalledWith(params);
    });
  });
});

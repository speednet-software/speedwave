import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './list_issues.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine List Issues Tool
//
// Purpose: Test issue listing with optional filtering
// - Verify metadata (name, category, service, schema)
// - Test successful listing scenarios (no filters, with filters)
// - Test error handling (Error, non-Error, string, undefined, empty message)
// - Test edge cases (empty results, missing fields in response)
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/list_issues', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('listIssueIds');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('read');
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
      expect(metadata.keywords).toContain('issues');
      expect(metadata.keywords).toContain('list');
    });

    it('should have valid inputSchema with no required fields', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toBeUndefined();
    });

    it('should define optional filter fields in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      expect(properties.assigned_to).toBeDefined();
      expect(properties.status).toBeDefined();
      expect(properties.project_id).toBeDefined();
      expect(properties.parent_id).toBeDefined();
      expect(properties.limit).toBeDefined();
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
      expect(metadata.example).toContain('listIssueIds');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
      });
    });

    it('should have deferLoading disabled', () => {
      expect(metadata.deferLoading).toBe(false);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { listIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listIssues: vi.fn(),
      };
    });

    it('should list issues without filters', async () => {
      const mockData = {
        issues: [
          {
            id: 1,
            subject: 'Fix login bug',
            status: { id: 1, name: 'New' },
            priority: { id: 2, name: 'Normal' },
            project: { id: 1, name: 'My Project' },
          },
          {
            id: 2,
            subject: 'Add tests',
            status: { id: 2, name: 'In Progress' },
            priority: { id: 3, name: 'High' },
            project: { id: 1, name: 'My Project' },
          },
        ],
        total_count: 2,
      };
      mockRedmine.listIssues.mockResolvedValue(mockData);

      const params = {};
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.issues).toEqual(mockData.issues);
      expect(result.total_count).toBe(2);
      expect(mockRedmine.listIssues).toHaveBeenCalledWith(params);
      expect(mockRedmine.listIssues).toHaveBeenCalledTimes(1);
    });

    it('should list issues with assigned_to filter', async () => {
      const mockData = {
        issues: [
          {
            id: 1,
            subject: 'My task',
            status: { id: 1, name: 'New' },
            priority: { id: 2, name: 'Normal' },
            assigned_to: { id: 5, name: 'John' },
            project: { id: 1, name: 'My Project' },
          },
        ],
        total_count: 1,
      };
      mockRedmine.listIssues.mockResolvedValue(mockData);

      const params = { assigned_to: 'me', status: 'open' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.issues!.length).toBe(1);
      expect(mockRedmine.listIssues).toHaveBeenCalledWith(params);
    });

    it('should list issues with project_id and limit', async () => {
      const mockData = {
        issues: [
          {
            id: 10,
            subject: 'Task A',
            status: { id: 1, name: 'New' },
            priority: { id: 2, name: 'Normal' },
            project: { id: 2, name: 'Other' },
          },
        ],
        total_count: 50,
      };
      mockRedmine.listIssues.mockResolvedValue(mockData);

      const params = { project_id: 'my-project', limit: 1 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.total_count).toBe(50);
      expect(mockRedmine.listIssues).toHaveBeenCalledWith(params);
    });

    it('should list issues with parent_id filter', async () => {
      const mockData = {
        issues: [
          {
            id: 101,
            subject: 'Subtask 1',
            status: { id: 1, name: 'New' },
            priority: { id: 2, name: 'Normal' },
            project: { id: 1, name: 'My Project' },
          },
        ],
        total_count: 1,
      };
      mockRedmine.listIssues.mockResolvedValue(mockData);

      const params = { parent_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.listIssues).toHaveBeenCalledWith(params);
    });

    it('should handle empty issues array', async () => {
      mockRedmine.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.total_count).toBe(0);
    });

    it('should handle response without issues field', async () => {
      mockRedmine.listIssues.mockResolvedValue({ total_count: 0 });

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.issues).toEqual([]);
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { listIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listIssues: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Project not found');
      mockRedmine.listIssues.mockRejectedValue(error);

      const params = { project_id: 'nonexistent' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Project not found');
      expect(mockRedmine.listIssues).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.listIssues.mockRejectedValue(error);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Permission denied');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('redmine: Authentication failed');
      mockRedmine.listIssues.mockRejectedValue(error);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Authentication failed');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.listIssues.mockRejectedValue(error);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Connection timeout');
    });

    it('should handle non-Error thrown objects', async () => {
      mockRedmine.listIssues.mockRejectedValue({ message: 'Custom error' });

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown errors', async () => {
      mockRedmine.listIssues.mockRejectedValue('String error');

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown errors', async () => {
      mockRedmine.listIssues.mockRejectedValue(undefined);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockRedmine.listIssues.mockRejectedValue(error);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { listIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listIssues: vi.fn(),
      };
    });

    it('should handle all filter params at once', async () => {
      const mockData = { issues: [], total_count: 0 };
      mockRedmine.listIssues.mockResolvedValue(mockData);

      const params = {
        assigned_to: 'me',
        status: 'open',
        project_id: 'my-project',
        parent_id: 100,
        limit: 50,
      };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.listIssues).toHaveBeenCalledWith(params);
    });

    it('should handle large total_count', async () => {
      const mockData = {
        issues: [
          {
            id: 1,
            subject: 'First',
            status: { id: 1, name: 'New' },
            priority: { id: 2, name: 'Normal' },
            project: { id: 1, name: 'My Project' },
          },
        ],
        total_count: 10000,
      };
      mockRedmine.listIssues.mockResolvedValue(mockData);

      const result = await execute({ limit: 1 }, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.total_count).toBe(10000);
      expect(result.issues!.length).toBe(1);
    });

    it('should handle response with total_count undefined', async () => {
      mockRedmine.listIssues.mockResolvedValue({ issues: [] });

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.total_count).toBeUndefined();
    });

    it('should pass status filter as string', async () => {
      mockRedmine.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const params = { status: 'closed' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.listIssues).toHaveBeenCalledWith({ status: 'closed' });
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './create_time_entry.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine Create Time Entry Tool
//
// Purpose: Test time entry creation functionality
// - Verify metadata (name, category, service, schema)
// - Test successful time entry creation scenarios
// - Test parameter validation (hours required, issue_id or project_id required)
// - Test error handling (Error, non-Error, string, undefined, empty message)
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/create_time_entry', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('createTimeEntry');
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
      expect(metadata.keywords).toContain('time');
      expect(metadata.keywords).toContain('create');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['hours']);
    });

    it('should define hours in schema with number type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const hoursSchema = properties.hours;
      expect(hoursSchema).toBeDefined();
      expect(hoursSchema.type).toBe('number');
      expect(hoursSchema.description).toBeTruthy();
    });

    it('should define optional fields in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      expect(properties.issue_id).toBeDefined();
      expect(properties.project_id).toBeDefined();
      expect(properties.activity).toBeDefined();
      expect(properties.comments).toBeDefined();
      expect(properties.spent_on).toBeDefined();
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
      expect(metadata.example).toContain('createTimeEntry');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.hours).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { createTimeEntry: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createTimeEntry: vi.fn(),
      };
    });

    it('should create time entry with issue_id', async () => {
      const mockEntry = {
        id: 1,
        hours: 2.5,
        activity: { id: 9, name: 'Development' },
        spent_on: '2024-01-15',
      };
      mockRedmine.createTimeEntry.mockResolvedValue(mockEntry);

      const params = { hours: 2.5, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.entry).toEqual(mockEntry);
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledWith(params);
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledTimes(1);
    });

    it('should create time entry with project_id', async () => {
      const mockEntry = {
        id: 2,
        hours: 1.5,
        activity: { id: 10, name: 'Meeting' },
        spent_on: '2024-01-15',
      };
      mockRedmine.createTimeEntry.mockResolvedValue(mockEntry);

      const params = { hours: 1.5, project_id: 'speedwave-core' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.entry).toEqual(mockEntry);
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledWith(params);
    });

    it('should create time entry with all optional fields', async () => {
      const mockEntry = {
        id: 3,
        hours: 8.0,
        activity: { id: 9, name: 'Development' },
        spent_on: '2024-01-15',
      };
      mockRedmine.createTimeEntry.mockResolvedValue(mockEntry);

      const params = {
        hours: 8.0,
        issue_id: 12345,
        activity: 'development',
        comments: 'Full day refactoring',
        spent_on: '2024-01-15',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.entry).toEqual(mockEntry);
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledWith(params);
    });

    it('should create time entry with both issue_id and project_id', async () => {
      const mockEntry = {
        id: 4,
        hours: 3.0,
        activity: { id: 9, name: 'Development' },
        spent_on: '2024-01-15',
      };
      mockRedmine.createTimeEntry.mockResolvedValue(mockEntry);

      const params = { hours: 3.0, issue_id: 100, project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockRedmine: { createTimeEntry: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createTimeEntry: vi.fn(),
      };
    });

    it('should fail when hours is missing', async () => {
      const params = { issue_id: 12345 } as { hours: number; issue_id?: number };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: hours');
      expect(mockRedmine.createTimeEntry).not.toHaveBeenCalled();
    });

    it('should fail when hours is 0 (falsy number)', async () => {
      const params = { hours: 0, issue_id: 12345 };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: hours');
      expect(mockRedmine.createTimeEntry).not.toHaveBeenCalled();
    });

    it('should fail when hours is null', async () => {
      const params = { hours: null as unknown as number, issue_id: 12345 };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: hours');
      expect(mockRedmine.createTimeEntry).not.toHaveBeenCalled();
    });

    it('should fail when hours is undefined', async () => {
      const params = { hours: undefined as unknown as number, issue_id: 12345 };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: hours');
      expect(mockRedmine.createTimeEntry).not.toHaveBeenCalled();
    });

    it('should fail when neither issue_id nor project_id is provided', async () => {
      const params = { hours: 2.5 };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Either issue_id or project_id is required');
      expect(mockRedmine.createTimeEntry).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is 0 and no project_id', async () => {
      const params = { hours: 2.5, issue_id: 0 };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Either issue_id or project_id is required');
      expect(mockRedmine.createTimeEntry).not.toHaveBeenCalled();
    });

    it('should fail when project_id is empty string and no issue_id', async () => {
      const params = { hours: 2.5, project_id: '' };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Either issue_id or project_id is required');
      expect(mockRedmine.createTimeEntry).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { createTimeEntry: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createTimeEntry: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Issue not found');
      mockRedmine.createTimeEntry.mockRejectedValue(error);

      const params = { hours: 2.5, issue_id: 99999 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Issue not found');
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.createTimeEntry.mockRejectedValue(error);

      const params = { hours: 2.5, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Permission denied');
    });

    it('should handle 422 Validation error', async () => {
      const error = new Error('redmine: Activity is invalid');
      mockRedmine.createTimeEntry.mockRejectedValue(error);

      const params = { hours: 2.5, issue_id: 12345, activity: 'invalid_activity' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Activity is invalid');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.createTimeEntry.mockRejectedValue(error);

      const params = { hours: 2.5, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Connection timeout');
    });

    it('should handle non-Error thrown objects', async () => {
      mockRedmine.createTimeEntry.mockRejectedValue({ message: 'Custom error' });

      const params = { hours: 2.5, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown errors', async () => {
      mockRedmine.createTimeEntry.mockRejectedValue('String error');

      const params = { hours: 2.5, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown errors', async () => {
      mockRedmine.createTimeEntry.mockRejectedValue(undefined);

      const params = { hours: 2.5, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockRedmine.createTimeEntry.mockRejectedValue(error);

      const params = { hours: 2.5, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { createTimeEntry: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createTimeEntry: vi.fn(),
      };
    });

    it('should handle fractional hours', async () => {
      const mockEntry = {
        id: 10,
        hours: 0.25,
        activity: { id: 9, name: 'Development' },
        spent_on: '2024-01-15',
      };
      mockRedmine.createTimeEntry.mockResolvedValue(mockEntry);

      const params = { hours: 0.25, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.entry!.hours).toBe(0.25);
    });

    it('should handle very large hours value', async () => {
      const mockEntry = {
        id: 11,
        hours: 24.0,
        activity: { id: 9, name: 'Development' },
        spent_on: '2024-01-15',
      };
      mockRedmine.createTimeEntry.mockResolvedValue(mockEntry);

      const params = { hours: 24.0, issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledWith(params);
    });

    it('should handle very long comments', async () => {
      const mockEntry = {
        id: 12,
        hours: 1.0,
        activity: { id: 9, name: 'Development' },
        spent_on: '2024-01-15',
      };
      mockRedmine.createTimeEntry.mockResolvedValue(mockEntry);

      const params = {
        hours: 1.0,
        issue_id: 12345,
        comments: 'A'.repeat(5000),
      };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledWith(params);
    });

    it('should handle spent_on date format', async () => {
      const mockEntry = {
        id: 13,
        hours: 2.0,
        activity: { id: 9, name: 'Development' },
        spent_on: '2024-12-31',
      };
      mockRedmine.createTimeEntry.mockResolvedValue(mockEntry);

      const params = {
        hours: 2.0,
        issue_id: 12345,
        spent_on: '2024-12-31',
      };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createTimeEntry).toHaveBeenCalledWith(params);
    });
  });
});

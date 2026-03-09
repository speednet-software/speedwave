import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './delete_relation.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine Delete Relation Tool
//
// Purpose: Test deleting relations between issues
// - Verify metadata (name, category, service, schema)
// - Test successful relation deletion scenarios
// - Test parameter validation
// - Test error handling (404, 403, network errors, etc.)
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/delete_relation', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('deleteRelation');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('delete');
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
      expect(metadata.keywords).toContain('relation');
      expect(metadata.keywords).toContain('delete');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['relation_id']);
    });

    it('should define relation_id in schema with number type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const relationIdSchema = properties.relation_id;
      expect(relationIdSchema).toBeDefined();
      expect(relationIdSchema.type).toBe('number');
      expect(relationIdSchema.description).toBeTruthy();
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

    it('should have message field in outputSchema', () => {
      const outputSchema = metadata.outputSchema!;
      const outputProps = outputSchema.properties as Record<
        string,
        { type: string; description?: string }
      >;
      expect(outputProps.message).toBeDefined();
      expect(outputProps.message.type).toBe('string');
    });

    it('should have example code', () => {
      expect(metadata.example).toBeTruthy();
      expect(typeof metadata.example).toBe('string');
      expect(metadata.example).toContain('deleteRelation');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.relation_id).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { deleteRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        deleteRelation: vi.fn().mockResolvedValue({}),
      };
    });

    it('should delete relation successfully', async () => {
      const params = { relation_id: 123 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.message).toBe('Relation 123 deleted successfully');
      expect(mockRedmine.deleteRelation).toHaveBeenCalledWith({ relation_id: 123 });
      expect(mockRedmine.deleteRelation).toHaveBeenCalledTimes(1);
    });

    it('should delete relation with different ID', async () => {
      const params = { relation_id: 456 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Relation 456 deleted successfully');
      expect(mockRedmine.deleteRelation).toHaveBeenCalledWith({ relation_id: 456 });
    });

    it('should include relation_id in success message', async () => {
      const params = { relation_id: 999 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.message).toContain('999');
    });
  });

  describe('execute - parameter validation', () => {
    let mockRedmine: { deleteRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        deleteRelation: vi.fn().mockResolvedValue({}),
      };
    });

    it('should fail when relation_id is missing', async () => {
      const params = {} as { relation_id: number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: relation_id');
      expect(mockRedmine.deleteRelation).not.toHaveBeenCalled();
    });

    it('should fail when relation_id is 0', async () => {
      const params = { relation_id: 0 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: relation_id');
      expect(mockRedmine.deleteRelation).not.toHaveBeenCalled();
    });

    it('should fail when relation_id is null', async () => {
      const params = { relation_id: null as unknown as number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: relation_id');
      expect(mockRedmine.deleteRelation).not.toHaveBeenCalled();
    });

    it('should fail when relation_id is undefined', async () => {
      const params = { relation_id: undefined as unknown as number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: relation_id');
      expect(mockRedmine.deleteRelation).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { deleteRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        deleteRelation: vi.fn(),
      };
      // Suppress console.error during tests
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Relation not found');
      mockRedmine.deleteRelation.mockRejectedValue(error);

      const params = { relation_id: 99999 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to delete relation 99999');
      expect(result.error).toContain('Relation not found');
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.deleteRelation.mockRejectedValue(error);

      const params = { relation_id: 123 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('redmine: Authentication failed');
      mockRedmine.deleteRelation.mockRejectedValue(error);

      const params = { relation_id: 123 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Authentication failed');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.deleteRelation.mockRejectedValue(error);

      const params = { relation_id: 123 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection timeout');
    });

    it('should handle network connection refused error', async () => {
      const error = new Error('redmine: Connection refused');
      mockRedmine.deleteRelation.mockRejectedValue(error);

      const params = { relation_id: 123 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });

    it('should handle non-Error thrown objects', async () => {
      mockRedmine.deleteRelation.mockRejectedValue({ message: 'Custom error' });

      const params = { relation_id: 123 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown error');
    });

    it('should handle string thrown errors', async () => {
      mockRedmine.deleteRelation.mockRejectedValue('String error');

      const params = { relation_id: 123 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown error');
    });

    it('should handle undefined thrown errors', async () => {
      mockRedmine.deleteRelation.mockRejectedValue(undefined);

      const params = { relation_id: 123 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown error');
    });

    it('should include relation_id in error message', async () => {
      const error = new Error('Some API error');
      mockRedmine.deleteRelation.mockRejectedValue(error);

      const params = { relation_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('12345');
    });

    it('should log error details', async () => {
      const error = new Error('Test error');
      mockRedmine.deleteRelation.mockRejectedValue(error);

      const params = { relation_id: 123 };
      await execute(params, { redmine: mockRedmine } as any);

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { deleteRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        deleteRelation: vi.fn().mockResolvedValue({}),
      };
    });

    it('should handle very large relation_id', async () => {
      const params = { relation_id: 999999999 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.deleteRelation).toHaveBeenCalledWith({ relation_id: 999999999 });
    });

    it('should handle relation_id = 1', async () => {
      const params = { relation_id: 1 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.deleteRelation).toHaveBeenCalledWith({ relation_id: 1 });
    });

    it('should call deleteRelation exactly once', async () => {
      const params = { relation_id: 123 };
      await execute(params, { redmine: mockRedmine } as any);

      expect(mockRedmine.deleteRelation).toHaveBeenCalledTimes(1);
    });
  });
});

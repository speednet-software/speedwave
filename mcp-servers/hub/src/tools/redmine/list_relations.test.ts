import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute, IssueRelation } from './list_relations.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine List Relations Tool
//
// Purpose: Test listing issue relations functionality
// - Verify metadata (name, category, service, schema)
// - Test successful relation listing scenarios
// - Test parameter validation
// - Test error handling (404, 403, network errors, etc.)
// - Test edge cases (empty relations, missing data)
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/list_relations', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('listRelations');
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
      expect(metadata.keywords).toContain('relation');
      expect(metadata.keywords).toContain('list');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['issue_id']);
    });

    it('should define issue_id in schema with number type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const issueIdSchema = properties.issue_id;
      expect(issueIdSchema).toBeDefined();
      expect(issueIdSchema.type).toBe('number');
      expect(issueIdSchema.description).toBeTruthy();
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

    it('should have relation_type enum in output schema', () => {
      const outputSchema = metadata.outputSchema!;
      const outputProps = outputSchema.properties as Record<string, unknown>;
      const relationsSchema = outputProps.relations as {
        items: { properties: Record<string, { enum?: string[] }> };
      };
      expect(relationsSchema.items.properties.relation_type.enum).toEqual([
        'relates',
        'duplicates',
        'duplicated',
        'blocks',
        'blocked',
        'precedes',
        'follows',
        'copied_to',
        'copied_from',
      ]);
    });

    it('should have example code', () => {
      expect(metadata.example).toBeTruthy();
      expect(typeof metadata.example).toBe('string');
      expect(metadata.example).toContain('listRelations');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.issue_id).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { listRelations: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listRelations: vi.fn(),
      };
    });

    it('should list relations for an issue', async () => {
      const mockRelations: IssueRelation[] = [
        { id: 1, issue_id: 100, issue_to_id: 101, relation_type: 'blocks' },
        { id: 2, issue_id: 100, issue_to_id: 102, relation_type: 'relates' },
      ];
      mockRedmine.listRelations.mockResolvedValue({ relations: mockRelations });

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.relations).toHaveLength(2);
      expect(result.relations![0].relation_type).toBe('blocks');
      expect(mockRedmine.listRelations).toHaveBeenCalledWith({ issue_id: 100 });
      expect(mockRedmine.listRelations).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no relations exist', async () => {
      mockRedmine.listRelations.mockResolvedValue({ relations: [] });

      const params = { issue_id: 999 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relations).toEqual([]);
    });

    it('should handle relations with delay', async () => {
      const mockRelations: IssueRelation[] = [
        { id: 1, issue_id: 100, issue_to_id: 101, relation_type: 'precedes', delay: 3 },
        { id: 2, issue_id: 100, issue_to_id: 102, relation_type: 'follows', delay: 0 },
      ];
      mockRedmine.listRelations.mockResolvedValue({ relations: mockRelations });

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relations![0].delay).toBe(3);
      expect(result.relations![1].delay).toBe(0);
    });

    it('should handle all relation types', async () => {
      const relationTypes = [
        'relates',
        'duplicates',
        'duplicated',
        'blocks',
        'blocked',
        'precedes',
        'follows',
        'copied_to',
        'copied_from',
      ] as const;

      const mockRelations: IssueRelation[] = relationTypes.map((type, idx) => ({
        id: idx + 1,
        issue_id: 100,
        issue_to_id: 100 + idx + 1,
        relation_type: type,
      }));
      mockRedmine.listRelations.mockResolvedValue({ relations: mockRelations });

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relations).toHaveLength(9);
    });
  });

  describe('execute - parameter validation', () => {
    let mockRedmine: { listRelations: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listRelations: vi.fn().mockResolvedValue({ relations: [] }),
      };
    });

    it('should fail when issue_id is missing', async () => {
      const params = {} as { issue_id: number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: issue_id');
      expect(mockRedmine.listRelations).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is 0', async () => {
      const params = { issue_id: 0 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: issue_id');
      expect(mockRedmine.listRelations).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is null', async () => {
      const params = { issue_id: null as unknown as number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: issue_id');
      expect(mockRedmine.listRelations).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is undefined', async () => {
      const params = { issue_id: undefined as unknown as number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: issue_id');
      expect(mockRedmine.listRelations).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { listRelations: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listRelations: vi.fn(),
      };
      // Suppress console.error during tests
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Issue not found');
      mockRedmine.listRelations.mockRejectedValue(error);

      const params = { issue_id: 99999 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to list relations for issue #99999');
      expect(result.error).toContain('Issue not found');
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.listRelations.mockRejectedValue(error);

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('redmine: Authentication failed');
      mockRedmine.listRelations.mockRejectedValue(error);

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Authentication failed');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.listRelations.mockRejectedValue(error);

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection timeout');
    });

    it('should handle non-Error thrown objects', async () => {
      mockRedmine.listRelations.mockRejectedValue({ message: 'Custom error' });

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown error');
    });

    it('should handle string thrown errors', async () => {
      mockRedmine.listRelations.mockRejectedValue('String error');

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown error');
    });

    it('should handle undefined thrown errors', async () => {
      mockRedmine.listRelations.mockRejectedValue(undefined);

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown error');
    });

    it('should include issue_id in error message', async () => {
      const error = new Error('Some API error');
      mockRedmine.listRelations.mockRejectedValue(error);

      const params = { issue_id: 12345 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('#12345');
    });

    it('should log error details', async () => {
      const error = new Error('Test error');
      mockRedmine.listRelations.mockRejectedValue(error);

      const params = { issue_id: 100 };
      await execute(params, { redmine: mockRedmine } as any);

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { listRelations: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listRelations: vi.fn(),
      };
    });

    it('should handle very large issue_id', async () => {
      mockRedmine.listRelations.mockResolvedValue({ relations: [] });

      const params = { issue_id: 999999999 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.listRelations).toHaveBeenCalledWith({ issue_id: 999999999 });
    });

    it('should handle many relations', async () => {
      const mockRelations: IssueRelation[] = Array.from({ length: 100 }, (_, idx) => ({
        id: idx + 1,
        issue_id: 100,
        issue_to_id: 200 + idx,
        relation_type: 'relates',
      }));
      mockRedmine.listRelations.mockResolvedValue({ relations: mockRelations });

      const params = { issue_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relations).toHaveLength(100);
    });
  });
});

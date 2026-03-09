import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './create_relation.js';
import { IssueRelation } from './list_relations.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine Create Relation Tool
//
// Purpose: Test creating relations between issues
// - Verify metadata (name, category, service, schema)
// - Test successful relation creation scenarios
// - Test parameter validation
// - Test relation_type validation
// - Test error handling (404, 422, network errors, etc.)
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/create_relation', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('createRelation');
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
      expect(metadata.keywords).toContain('relation');
      expect(metadata.keywords).toContain('create');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['issue_id', 'issue_to_id']);
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

    it('should define issue_to_id in schema with number type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const issueToIdSchema = properties.issue_to_id;
      expect(issueToIdSchema).toBeDefined();
      expect(issueToIdSchema.type).toBe('number');
      expect(issueToIdSchema.description).toBeTruthy();
    });

    it('should define relation_type with valid enum values', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; enum: string[]; description: string }
      >;
      const relationTypeSchema = properties.relation_type;
      expect(relationTypeSchema).toBeDefined();
      expect(relationTypeSchema.type).toBe('string');
      expect(relationTypeSchema.enum).toEqual([
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

    it('should define delay in schema with number type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const delaySchema = properties.delay;
      expect(delaySchema).toBeDefined();
      expect(delaySchema.type).toBe('number');
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
      expect(metadata.example).toContain('createRelation');
    });

    it('should have multiple input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThanOrEqual(3);
      // Simple relation example
      expect(inputExamples[0].input.issue_id).toBeDefined();
      expect(inputExamples[0].input.issue_to_id).toBeDefined();
      // Blocking relation example
      expect(inputExamples[1].input.relation_type).toBe('blocks');
      // Sequence with delay example
      expect(inputExamples[2].input.relation_type).toBe('precedes');
      expect(inputExamples[2].input.delay).toBeDefined();
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { createRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createRelation: vi.fn(),
      };
    });

    it('should create relation with minimal params (default: relates)', async () => {
      const mockRelation: IssueRelation = {
        id: 1,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'relates',
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

      const params = { issue_id: 100, issue_to_id: 101 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.relation).toEqual(mockRelation);
      expect(mockRedmine.createRelation).toHaveBeenCalledWith({
        issue_id: 100,
        issue_to_id: 101,
        relation_type: undefined,
        delay: undefined,
      });
    });

    it('should create blocking relation', async () => {
      const mockRelation: IssueRelation = {
        id: 2,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'blocks',
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'blocks' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relation!.relation_type).toBe('blocks');
    });

    it('should create precedes relation with delay', async () => {
      const mockRelation: IssueRelation = {
        id: 3,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: 5,
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'precedes', delay: 5 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relation!.delay).toBe(5);
    });

    it('should create follows relation with zero delay', async () => {
      const mockRelation: IssueRelation = {
        id: 4,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'follows',
        delay: 0,
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'follows', delay: 0 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relation!.delay).toBe(0);
    });

    it('should create all valid relation types', async () => {
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

      for (const relationType of relationTypes) {
        const mockRelation: IssueRelation = {
          id: 1,
          issue_id: 100,
          issue_to_id: 101,
          relation_type: relationType,
        };
        mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

        const params = { issue_id: 100, issue_to_id: 101, relation_type: relationType };
        const result = await execute(params, { redmine: mockRedmine } as any);

        expect(result.success).toBe(true);
        expect(result.relation!.relation_type).toBe(relationType);
      }
    });
  });

  describe('execute - parameter validation', () => {
    let mockRedmine: { createRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createRelation: vi.fn(),
      };
    });

    it('should fail when issue_id is missing', async () => {
      const params = { issue_to_id: 101 } as { issue_id: number; issue_to_id: number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, issue_to_id');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should fail when issue_to_id is missing', async () => {
      const params = { issue_id: 100 } as { issue_id: number; issue_to_id: number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, issue_to_id');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should fail when both params are missing', async () => {
      const params = {} as { issue_id: number; issue_to_id: number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, issue_to_id');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is 0', async () => {
      const params = { issue_id: 0, issue_to_id: 101 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, issue_to_id');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should fail when issue_to_id is 0', async () => {
      const params = { issue_id: 100, issue_to_id: 0 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, issue_to_id');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is null', async () => {
      const params = { issue_id: null as unknown as number, issue_to_id: 101 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, issue_to_id');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should fail when issue_to_id is null', async () => {
      const params = { issue_id: 100, issue_to_id: null as unknown as number };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, issue_to_id');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });
  });

  describe('execute - relation_type validation', () => {
    let mockRedmine: { createRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createRelation: vi.fn(),
      };
    });

    it('should fail with invalid relation_type', async () => {
      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'invalid_type' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid relation_type "invalid_type"');
      expect(result.error).toContain('Valid types:');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should fail with typo in relation_type', async () => {
      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'bloks' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid relation_type "bloks"');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should fail with empty string relation_type', async () => {
      const params = { issue_id: 100, issue_to_id: 101, relation_type: '' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      // Empty string is falsy, so it passes the if check but should be validated
      // Actually, empty string is truthy in the validation check, so it should be validated
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid relation_type');
      expect(mockRedmine.createRelation).not.toHaveBeenCalled();
    });

    it('should succeed with valid relation_type', async () => {
      const mockRelation: IssueRelation = {
        id: 1,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'duplicates',
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'duplicates' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createRelation).toHaveBeenCalled();
    });

    it('should warn when delay is used with non-temporal relation', async () => {
      const mockRelation: IssueRelation = {
        id: 1,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'blocks',
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'blocks', delay: 5 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delay parameter'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('precedes/follows'));

      warnSpy.mockRestore();
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { createRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createRelation: vi.fn(),
      };
      // Suppress console.error during tests
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Issue not found');
      mockRedmine.createRelation.mockRejectedValue(error);

      const params = { issue_id: 99999, issue_to_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create relation from #99999 to #100');
      expect(result.error).toContain('Issue not found');
    });

    it('should handle 422 Validation error (relation already exists)', async () => {
      const error = new Error('redmine: Relation already exists');
      mockRedmine.createRelation.mockRejectedValue(error);

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'blocks' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Relation already exists');
    });

    it('should handle 422 Validation error (self-referential)', async () => {
      const error = new Error('redmine: Cannot relate to itself');
      mockRedmine.createRelation.mockRejectedValue(error);

      const params = { issue_id: 100, issue_to_id: 100 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot relate to itself');
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.createRelation.mockRejectedValue(error);

      const params = { issue_id: 100, issue_to_id: 101 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.createRelation.mockRejectedValue(error);

      const params = { issue_id: 100, issue_to_id: 101 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection timeout');
    });

    it('should handle non-Error thrown objects', async () => {
      mockRedmine.createRelation.mockRejectedValue({ message: 'Custom error' });

      const params = { issue_id: 100, issue_to_id: 101 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown error');
    });

    it('should include both issue IDs in error message', async () => {
      const error = new Error('Some API error');
      mockRedmine.createRelation.mockRejectedValue(error);

      const params = { issue_id: 12345, issue_to_id: 67890 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('#12345');
      expect(result.error).toContain('#67890');
    });

    it('should log error details with params', async () => {
      const error = new Error('Test error');
      mockRedmine.createRelation.mockRejectedValue(error);

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'blocks', delay: 3 };
      await execute(params, { redmine: mockRedmine } as any);

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { createRelation: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        createRelation: vi.fn(),
      };
    });

    it('should handle very large issue IDs', async () => {
      const mockRelation: IssueRelation = {
        id: 1,
        issue_id: 999999999,
        issue_to_id: 888888888,
        relation_type: 'relates',
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

      const params = { issue_id: 999999999, issue_to_id: 888888888 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.createRelation).toHaveBeenCalledWith({
        issue_id: 999999999,
        issue_to_id: 888888888,
        relation_type: undefined,
        delay: undefined,
      });
    });

    it('should handle negative delay', async () => {
      const mockRelation: IssueRelation = {
        id: 1,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: -1,
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'precedes', delay: -1 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relation!.delay).toBe(-1);
    });

    it('should handle very large delay', async () => {
      const mockRelation: IssueRelation = {
        id: 1,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: 365,
      };
      mockRedmine.createRelation.mockResolvedValue({ relation: mockRelation });

      const params = { issue_id: 100, issue_to_id: 101, relation_type: 'precedes', delay: 365 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.relation!.delay).toBe(365);
    });
  });
});

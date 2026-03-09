import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './comment_issue.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine Comment Issue Tool
//
// Purpose: Test adding comments/notes to issues
// - Verify metadata (name, category, service, schema)
// - Test successful comment creation scenarios
// - Test parameter validation
// - Test error handling (Error, non-Error, string, undefined, empty message)
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/comment_issue', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('commentIssue');
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
      expect(metadata.keywords).toContain('comment');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['issue_id', 'notes']);
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

    it('should define notes in schema with string type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const notesSchema = properties.notes;
      expect(notesSchema).toBeDefined();
      expect(notesSchema.type).toBe('string');
      expect(notesSchema.description).toBeTruthy();
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
      expect(metadata.example).toContain('commentIssue');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.issue_id).toBeDefined();
        expect(example.input.notes).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { commentIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        commentIssue: vi.fn().mockResolvedValue({}),
      };
    });

    it('should add a simple comment', async () => {
      const params = {
        issue_id: 12345,
        notes: 'Work in progress',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
      expect(mockRedmine.commentIssue).toHaveBeenCalledTimes(1);
    });

    it('should add a comment with Textile markup', async () => {
      const params = {
        issue_id: 12345,
        notes: 'h3. Update\n\n* Completed code review\n* Tests passing\n* Ready for merge',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
    });

    it('should add a comment with multiline text', async () => {
      const params = {
        issue_id: 100,
        notes: 'Line 1\nLine 2\nLine 3',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
    });

    it('should add a comment with special characters', async () => {
      const params = {
        issue_id: 999,
        notes: 'Fixed bug: `if (x > 0 && y < 10)` was incorrect',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockRedmine: { commentIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        commentIssue: vi.fn().mockResolvedValue({}),
      };
    });

    it('should fail when issue_id is missing', async () => {
      const params = {
        notes: 'Some comment',
      } as { issue_id: number; notes: string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });

    it('should fail when notes is missing', async () => {
      const params = {
        issue_id: 12345,
      } as { issue_id: number; notes: string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });

    it('should fail when both parameters are missing', async () => {
      const params = {} as { issue_id: number; notes: string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is 0 (falsy number)', async () => {
      const params = {
        issue_id: 0,
        notes: 'Some comment',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });

    it('should fail when notes is empty string', async () => {
      const params = {
        issue_id: 12345,
        notes: '',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is null', async () => {
      const params = {
        issue_id: null as unknown as number,
        notes: 'Some comment',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });

    it('should fail when notes is null', async () => {
      const params = {
        issue_id: 12345,
        notes: null as unknown as string,
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });

    it('should fail when issue_id is undefined', async () => {
      const params = {
        issue_id: undefined as unknown as number,
        notes: 'Some comment',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });

    it('should fail when notes is undefined', async () => {
      const params = {
        issue_id: 12345,
        notes: undefined as unknown as string,
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: issue_id, notes');
      expect(mockRedmine.commentIssue).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { commentIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        commentIssue: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Issue not found');
      mockRedmine.commentIssue.mockRejectedValue(error);

      const params = { issue_id: 99999, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Issue not found');
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.commentIssue.mockRejectedValue(error);

      const params = { issue_id: 12345, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Permission denied');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('redmine: Authentication failed');
      mockRedmine.commentIssue.mockRejectedValue(error);

      const params = { issue_id: 12345, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Authentication failed');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.commentIssue.mockRejectedValue(error);

      const params = { issue_id: 12345, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Connection timeout');
    });

    it('should handle generic API error', async () => {
      const error = new Error('redmine: API request failed');
      mockRedmine.commentIssue.mockRejectedValue(error);

      const params = { issue_id: 12345, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: API request failed');
    });

    it('should handle non-Error thrown objects with message', async () => {
      const error = { message: 'Custom error object' };
      mockRedmine.commentIssue.mockRejectedValue(error);

      const params = { issue_id: 12345, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown errors', async () => {
      mockRedmine.commentIssue.mockRejectedValue('String error');

      const params = { issue_id: 12345, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown errors', async () => {
      mockRedmine.commentIssue.mockRejectedValue(undefined);

      const params = { issue_id: 12345, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockRedmine.commentIssue.mockRejectedValue(error);

      const params = { issue_id: 12345, notes: 'Comment' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { commentIssue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        commentIssue: vi.fn().mockResolvedValue({}),
      };
    });

    it('should handle very large issue ID', async () => {
      const params = {
        issue_id: 999999999,
        notes: 'Comment on large ID issue',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
    });

    it('should handle very long comment text', async () => {
      const params = {
        issue_id: 12345,
        notes: 'A'.repeat(10000),
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
    });

    it('should handle comment with unicode characters', async () => {
      const params = {
        issue_id: 12345,
        notes: 'Fixed issue with UTF-8: \u00e4\u00f6\u00fc\u00df \u2014 \u2764\ufe0f',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
    });

    it('should handle comment with HTML-like content', async () => {
      const params = {
        issue_id: 12345,
        notes: 'The <div> tag was not closed properly in template.html',
      };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.commentIssue).toHaveBeenCalledWith(params);
    });
  });
});

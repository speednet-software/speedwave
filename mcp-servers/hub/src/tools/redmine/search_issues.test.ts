import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './search_issues.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine Search Issues Tool
//
// Purpose: Test full-text issue search functionality
// - Verify metadata (name, category, service, schema)
// - Test successful search scenarios
// - Test parameter validation (query required)
// - Test error handling (Error, non-Error, string, undefined, empty message)
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/search_issues', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('searchIssueIds');
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
      expect(metadata.keywords).toContain('issue');
      expect(metadata.keywords).toContain('search');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['query']);
    });

    it('should define query in schema with string type', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const querySchema = properties.query;
      expect(querySchema).toBeDefined();
      expect(querySchema.type).toBe('string');
      expect(querySchema.description).toBeTruthy();
    });

    it('should define optional fields in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      expect(properties.project_id).toBeDefined();
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
      expect(metadata.example).toContain('searchIssueIds');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.query).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { searchIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        searchIssues: vi.fn(),
      };
    });

    it('should search issues with query only', async () => {
      const mockResults = {
        results: [
          {
            id: 1,
            subject: 'Authentication error on login',
            status: { id: 1, name: 'New' },
            project: { id: 1, name: 'My Project' },
          },
          {
            id: 2,
            subject: 'Auth token expires too quickly',
            status: { id: 2, name: 'In Progress' },
            project: { id: 1, name: 'My Project' },
          },
        ],
      };
      mockRedmine.searchIssues.mockResolvedValue(mockResults);

      const params = { query: 'authentication error' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.results).toEqual(mockResults.results);
      expect(mockRedmine.searchIssues).toHaveBeenCalledWith(params);
      expect(mockRedmine.searchIssues).toHaveBeenCalledTimes(1);
    });

    it('should search issues with project_id filter', async () => {
      const mockResults = {
        results: [
          {
            id: 5,
            subject: 'Login fails',
            status: { id: 1, name: 'New' },
            project: { id: 2, name: 'Core' },
          },
        ],
      };
      mockRedmine.searchIssues.mockResolvedValue(mockResults);

      const params = { query: 'login fails', project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.results!.length).toBe(1);
      expect(mockRedmine.searchIssues).toHaveBeenCalledWith(params);
    });

    it('should search issues with limit', async () => {
      const mockResults = { results: [] };
      mockRedmine.searchIssues.mockResolvedValue(mockResults);

      const params = { query: 'test', limit: 50 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.searchIssues).toHaveBeenCalledWith(params);
    });

    it('should search issues with all params', async () => {
      const mockResults = { results: [] };
      mockRedmine.searchIssues.mockResolvedValue(mockResults);

      const params = { query: 'priority:high author:john', project_id: 'my-project', limit: 10 };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.searchIssues).toHaveBeenCalledWith(params);
    });

    it('should handle empty results', async () => {
      mockRedmine.searchIssues.mockResolvedValue({ results: [] });

      const params = { query: 'nonexistent-issue-xyz' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });

    it('should handle response without results field', async () => {
      mockRedmine.searchIssues.mockResolvedValue({});

      const params = { query: 'test' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });
  });

  describe('execute - parameter validation', () => {
    let mockRedmine: { searchIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        searchIssues: vi.fn(),
      };
    });

    it('should fail when query is missing', async () => {
      const params = {} as { query: string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: query');
      expect(mockRedmine.searchIssues).not.toHaveBeenCalled();
    });

    it('should fail when query is empty string', async () => {
      const params = { query: '' };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: query');
      expect(mockRedmine.searchIssues).not.toHaveBeenCalled();
    });

    it('should fail when query is null', async () => {
      const params = { query: null as unknown as string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: query');
      expect(mockRedmine.searchIssues).not.toHaveBeenCalled();
    });

    it('should fail when query is undefined', async () => {
      const params = { query: undefined as unknown as string };

      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: query');
      expect(mockRedmine.searchIssues).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { searchIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        searchIssues: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Project not found');
      mockRedmine.searchIssues.mockRejectedValue(error);

      const params = { query: 'test', project_id: 'nonexistent' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Project not found');
      expect(mockRedmine.searchIssues).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.searchIssues.mockRejectedValue(error);

      const params = { query: 'test' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Permission denied');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.searchIssues.mockRejectedValue(error);

      const params = { query: 'test' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Connection timeout');
    });

    it('should handle non-Error thrown objects', async () => {
      mockRedmine.searchIssues.mockRejectedValue({ message: 'Custom error' });

      const params = { query: 'test' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown errors', async () => {
      mockRedmine.searchIssues.mockRejectedValue('String error');

      const params = { query: 'test' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown errors', async () => {
      mockRedmine.searchIssues.mockRejectedValue(undefined);

      const params = { query: 'test' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockRedmine.searchIssues.mockRejectedValue(error);

      const params = { query: 'test' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { searchIssues: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        searchIssues: vi.fn(),
      };
    });

    it('should handle query with operators', async () => {
      mockRedmine.searchIssues.mockResolvedValue({ results: [] });

      const params = { query: 'priority:high author:john' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.searchIssues).toHaveBeenCalledWith(params);
    });

    it('should handle query with issue reference', async () => {
      mockRedmine.searchIssues.mockResolvedValue({
        results: [
          {
            id: 123,
            subject: 'Referenced issue',
            status: { id: 1, name: 'New' },
            project: { id: 1, name: 'My Project' },
          },
        ],
      });

      const params = { query: '#123' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.results!.length).toBe(1);
    });

    it('should handle very long query string', async () => {
      mockRedmine.searchIssues.mockResolvedValue({ results: [] });

      const params = { query: 'search term '.repeat(100) };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.searchIssues).toHaveBeenCalledWith(params);
    });

    it('should handle query with unicode characters', async () => {
      mockRedmine.searchIssues.mockResolvedValue({ results: [] });

      const params = { query: '\u00e4\u00f6\u00fc\u00df fehler' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.searchIssues).toHaveBeenCalledWith(params);
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './list_users.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Redmine List Users Tool
//
// Purpose: Test user listing functionality
// - Verify metadata (name, category, service, schema)
// - Test successful listing scenarios (all users, project members)
// - Test error handling (Error, non-Error, string, undefined, empty message)
// - Test edge cases (empty results, missing fields in response)
//═══════════════════════════════════════════════════════════════════════════════

describe('redmine/list_users', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('listUsers');
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
      expect(metadata.keywords).toContain('users');
      expect(metadata.keywords).toContain('list');
    });

    it('should have valid inputSchema with no required fields', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toBeUndefined();
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
      expect(metadata.example).toContain('listUsers');
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

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockRedmine: { listUsers: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listUsers: vi.fn(),
      };
    });

    it('should list all users without filters', async () => {
      const mockData = {
        users: [
          {
            id: 1,
            login: 'admin',
            firstname: 'Admin',
            lastname: 'User',
            mail: 'admin@example.com',
          },
          { id: 2, login: 'john', firstname: 'John', lastname: 'Doe', mail: 'john@example.com' },
        ],
      };
      mockRedmine.listUsers.mockResolvedValue(mockData);

      const params = {};
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.users).toEqual(mockData.users);
      expect(mockRedmine.listUsers).toHaveBeenCalledWith(params);
      expect(mockRedmine.listUsers).toHaveBeenCalledTimes(1);
    });

    it('should list project members with project_id filter', async () => {
      const mockData = {
        users: [
          { id: 3, login: 'jane', firstname: 'Jane', lastname: 'Smith', mail: 'jane@example.com' },
        ],
      };
      mockRedmine.listUsers.mockResolvedValue(mockData);

      const params = { project_id: 'my-project' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.users!.length).toBe(1);
      expect(mockRedmine.listUsers).toHaveBeenCalledWith(params);
    });

    it('should handle empty users array', async () => {
      mockRedmine.listUsers.mockResolvedValue({ users: [] });

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.users).toEqual([]);
    });

    it('should handle response without users field', async () => {
      mockRedmine.listUsers.mockResolvedValue({});

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.users).toEqual([]);
    });

    it('should handle users without email', async () => {
      const mockData = {
        users: [{ id: 4, login: 'noemail', firstname: 'No', lastname: 'Email' }],
      };
      mockRedmine.listUsers.mockResolvedValue(mockData);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.users!.length).toBe(1);
      expect(result.users![0].login).toBe('noemail');
    });
  });

  describe('execute - error scenarios', () => {
    let mockRedmine: { listUsers: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listUsers: vi.fn(),
      };
    });

    it('should handle 404 Not Found error', async () => {
      const error = new Error('redmine: Project not found');
      mockRedmine.listUsers.mockRejectedValue(error);

      const params = { project_id: 'nonexistent' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Project not found');
      expect(mockRedmine.listUsers).toHaveBeenCalledWith(params);
    });

    it('should handle 403 Forbidden error', async () => {
      const error = new Error('redmine: Permission denied');
      mockRedmine.listUsers.mockRejectedValue(error);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Permission denied');
    });

    it('should handle 401 Unauthorized error', async () => {
      const error = new Error('redmine: Authentication failed');
      mockRedmine.listUsers.mockRejectedValue(error);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Authentication failed');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('redmine: Connection timeout');
      mockRedmine.listUsers.mockRejectedValue(error);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('redmine: Connection timeout');
    });

    it('should handle non-Error thrown objects', async () => {
      mockRedmine.listUsers.mockRejectedValue({ message: 'Custom error' });

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown errors', async () => {
      mockRedmine.listUsers.mockRejectedValue('String error');

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown errors', async () => {
      mockRedmine.listUsers.mockRejectedValue(undefined);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockRedmine.listUsers.mockRejectedValue(error);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });
  });

  describe('execute - edge cases', () => {
    let mockRedmine: { listUsers: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockRedmine = {
        listUsers: vi.fn(),
      };
    });

    it('should handle large number of users', async () => {
      const users = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        login: `user${i + 1}`,
        firstname: `First${i + 1}`,
        lastname: `Last${i + 1}`,
        mail: `user${i + 1}@example.com`,
      }));
      mockRedmine.listUsers.mockResolvedValue({ users });

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.users!.length).toBe(100);
    });

    it('should handle project_id with hyphens and numbers', async () => {
      mockRedmine.listUsers.mockResolvedValue({ users: [] });

      const params = { project_id: 'speedwave-core-2024' };
      const result = await execute(params, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(mockRedmine.listUsers).toHaveBeenCalledWith(params);
    });

    it('should handle users with unicode names', async () => {
      const mockData = {
        users: [
          {
            id: 10,
            login: 'muller',
            firstname: 'M\u00fcller',
            lastname: '\u00d6zt\u00fcrk',
            mail: 'test@example.com',
          },
        ],
      };
      mockRedmine.listUsers.mockResolvedValue(mockData);

      const result = await execute({}, { redmine: mockRedmine } as any);

      expect(result.success).toBe(true);
      expect(result.users![0].firstname).toBe('M\u00fcller');
    });
  });
});

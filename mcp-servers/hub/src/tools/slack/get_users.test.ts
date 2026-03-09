import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './get_users.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Slack Get Users Tool
//
// Purpose: Test user lookup by email
// - Verify metadata (name, category, service, schema)
// - Test successful lookup scenarios
// - Test parameter validation (missing, empty, invalid email)
// - Test error handling
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('slack/get_users', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('getUsers');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('read');
    });

    it('should have correct service', () => {
      expect(metadata.service).toBe('slack');
    });

    it('should have non-empty description', () => {
      expect(metadata.description).toBeTruthy();
      expect(typeof metadata.description).toBe('string');
      expect(metadata.description.length).toBeGreaterThan(0);
    });

    it('should have keywords array', () => {
      expect(Array.isArray(metadata.keywords)).toBe(true);
      expect(metadata.keywords.length).toBeGreaterThan(0);
      expect(metadata.keywords).toContain('slack');
      expect(metadata.keywords).toContain('user');
      expect(metadata.keywords).toContain('email');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['email']);
    });

    it('should define email in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const emailSchema = properties.email;
      expect(emailSchema).toBeDefined();
      expect(emailSchema.type).toBe('string');
      expect(emailSchema.description).toBeTruthy();
    });

    it('should have valid outputSchema', () => {
      expect(metadata.outputSchema).toBeDefined();
      const outputSchema = metadata.outputSchema!;
      expect(outputSchema.type).toBe('object');
      expect(outputSchema.properties).toBeDefined();
      const outputProps = outputSchema.properties as Record<string, { type: string }>;
      expect(outputProps.success).toEqual({ type: 'boolean' });
      expect(outputSchema.required).toEqual(['success']);
    });

    it('should have example code', () => {
      expect(metadata.example).toBeTruthy();
      expect(typeof metadata.example).toBe('string');
      expect(metadata.example).toContain('slack.getUsers');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.email).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockSlack: { getUsers: ReturnType<typeof vi.fn> };

    const sampleUser = {
      id: 'U0123ABC',
      name: 'jdoe',
      real_name: 'John Doe',
      email: 'john@example.com',
    };

    beforeEach(() => {
      mockSlack = {
        getUsers: vi.fn().mockResolvedValue({ user: sampleUser }),
      };
    });

    it('should find user by email', async () => {
      const params = { email: 'john@example.com' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.user).toEqual(sampleUser);
      expect(mockSlack.getUsers).toHaveBeenCalledWith({ email: 'john@example.com' });
      expect(mockSlack.getUsers).toHaveBeenCalledTimes(1);
    });

    it('should handle corporate email', async () => {
      const params = { email: 'alice.smith@acme-corp.co.uk' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.getUsers).toHaveBeenCalledWith({ email: 'alice.smith@acme-corp.co.uk' });
    });

    it('should handle email with plus addressing', async () => {
      const params = { email: 'user+tag@example.com' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.getUsers).toHaveBeenCalledWith({ email: 'user+tag@example.com' });
    });

    it('should handle response without user field', async () => {
      mockSlack.getUsers.mockResolvedValue({});

      const params = { email: 'missing@example.com' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.user).toBeUndefined();
    });
  });

  describe('execute - parameter validation', () => {
    let mockSlack: { getUsers: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        getUsers: vi.fn().mockResolvedValue({ user: {} }),
      };
    });

    it('should fail when email is missing', async () => {
      const params = {} as { email: string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: email');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });

    it('should fail when email is empty string', async () => {
      const params = { email: '' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: email');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });

    it('should fail when email is null', async () => {
      const params = { email: null as unknown as string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: email');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });

    it('should fail when email is undefined', async () => {
      const params = { email: undefined as unknown as string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: email');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });

    it('should fail with invalid email format - no @', async () => {
      const params = { email: 'notanemail' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email format');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });

    it('should fail with invalid email format - no domain', async () => {
      const params = { email: 'user@' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email format');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });

    it('should fail with invalid email format - no TLD', async () => {
      const params = { email: 'user@domain' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email format');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });

    it('should fail with invalid email format - no local part', async () => {
      const params = { email: '@example.com' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email format');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });

    it('should fail with invalid email format - spaces', async () => {
      const params = { email: 'user @example.com' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email format');
      expect(mockSlack.getUsers).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockSlack: { getUsers: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        getUsers: vi.fn(),
      };
    });

    it('should handle Error thrown', async () => {
      const error = new Error('users_not_found');
      mockSlack.getUsers.mockRejectedValue(error);

      const params = { email: 'unknown@example.com' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('users_not_found');
    });

    it('should handle non-Error thrown as Unknown error', async () => {
      mockSlack.getUsers.mockRejectedValue({ code: 'invalid_auth' });

      const params = { email: 'test@example.com' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown as Unknown error', async () => {
      mockSlack.getUsers.mockRejectedValue('lookup_failed');

      const params = { email: 'test@example.com' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown as Unknown error', async () => {
      mockSlack.getUsers.mockRejectedValue(undefined);

      const params = { email: 'test@example.com' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockSlack.getUsers.mockRejectedValue(error);

      const params = { email: 'test@example.com' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });

    it('should handle network error', async () => {
      const error = new Error('Connection refused');
      mockSlack.getUsers.mockRejectedValue(error);

      const params = { email: 'test@example.com' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });

  describe('execute - edge cases', () => {
    let mockSlack: { getUsers: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        getUsers: vi.fn().mockResolvedValue({ user: { id: 'U001', name: 'test' } }),
      };
    });

    it('should handle email with numbers', async () => {
      const params = { email: 'user123@test456.com' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.getUsers).toHaveBeenCalledWith({ email: 'user123@test456.com' });
    });

    it('should handle email with dots in local part', async () => {
      const params = { email: 'first.last@example.com' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.getUsers).toHaveBeenCalledWith({ email: 'first.last@example.com' });
    });

    it('should handle email with subdomain', async () => {
      const params = { email: 'user@mail.company.co.uk' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.getUsers).toHaveBeenCalledWith({ email: 'user@mail.company.co.uk' });
    });

    it('should handle email with hyphens in domain', async () => {
      const params = { email: 'user@my-company.com' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.getUsers).toHaveBeenCalledWith({ email: 'user@my-company.com' });
    });
  });
});

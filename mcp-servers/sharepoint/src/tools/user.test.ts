/**
 * User Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleGetCurrentUser } from './user-tools.js';
import type { SharePointClient } from '../client.js';

type MockClient = {
  getCurrentUser: Mock;
  formatError: Mock;
};

interface UserData {
  displayName: string;
  email: string;
  userPrincipalName: string;
  id: string;
}

describe('user-tools', () => {
  const createMockClient = (): MockClient => ({
    getCurrentUser: vi.fn(),
    formatError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleGetCurrentUser', () => {
    it('returns current user successfully with complete data', async () => {
      const client = createMockClient();
      const userData = {
        displayName: 'John Doe',
        email: 'john.doe@example.com',
        userPrincipalName: 'john.doe@example.com',
        id: 'user-123-456-789',
      };
      client.getCurrentUser.mockResolvedValue(userData);

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(userData);
      expect(client.getCurrentUser).toHaveBeenCalledTimes(1);
      expect(client.getCurrentUser).toHaveBeenCalledWith();
    });

    it('returns current user with minimal data', async () => {
      const client = createMockClient();
      const userData = {
        displayName: 'Jane Smith',
        email: 'jane@example.com',
        userPrincipalName: 'jane@example.com',
        id: 'user-abc',
      };
      client.getCurrentUser.mockResolvedValue(userData);

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(true);
      expect((result.data as UserData)?.displayName).toBe('Jane Smith');
      expect((result.data as UserData)?.email).toBe('jane@example.com');
      expect((result.data as UserData)?.id).toBe('user-abc');
    });

    it('returns current user with default values for missing fields', async () => {
      const client = createMockClient();
      const userData = {
        displayName: 'Unknown User',
        email: 'unknown@example.com',
        userPrincipalName: 'unknown',
        id: 'unknown',
      };
      client.getCurrentUser.mockResolvedValue(userData);

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(userData);
    });

    it('handles user with long display name', async () => {
      const client = createMockClient();
      const userData = {
        displayName: 'Dr. Robert Alexander Montgomery III, PhD, MBA',
        email: 'robert.montgomery@corporation.example.com',
        userPrincipalName: 'robert.montgomery@corporation.example.com',
        id: 'user-long-name-123',
      };
      client.getCurrentUser.mockResolvedValue(userData);

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(true);
      expect((result.data as UserData)?.displayName).toBe(
        'Dr. Robert Alexander Montgomery III, PhD, MBA'
      );
    });

    it('handles user with special characters in name', async () => {
      const client = createMockClient();
      const userData = {
        displayName: "O'Brien-Müller, José",
        email: 'jose.obrien@example.com',
        userPrincipalName: 'jose.obrien@example.com',
        id: 'user-special-chars',
      };
      client.getCurrentUser.mockResolvedValue(userData);

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(true);
      expect((result.data as UserData)?.displayName).toBe("O'Brien-Müller, José");
    });

    it('returns error when API call fails', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('API error'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'USER_FAILED',
        message: 'API error',
      });
    });

    it('returns error for 401 unauthorized', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
      expect(result.error?.message).toContain('Authentication failed');
    });

    it('returns error for 403 forbidden', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('403 Forbidden'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
      expect(result.error?.message).toContain('Permission denied');
    });

    it('returns error for network timeout', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('Network timeout'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'USER_FAILED',
        message: 'Network timeout',
      });
    });

    it('returns error for token expiration', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('Token expired. Please re-authenticate.'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
      expect(result.error?.message).toContain('Token expired');
    });

    it('returns error for network error', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('Network error: ECONNREFUSED'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });

    it('returns error for service unavailable', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('503 Service Unavailable'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });

    it('returns error for rate limiting', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('429 Too Many Requests'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('429');
    });

    it('returns error for malformed response', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('Failed to parse user data from response'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });

    it('handles generic error without message', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error());

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });

    it('handles non-Error objects thrown', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue('String error');

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });

    it('returns user data with userPrincipalName different from email', async () => {
      const client = createMockClient();
      const userData = {
        displayName: 'External User',
        email: 'external@external.com',
        userPrincipalName: 'external_external.com#EXT#@tenant.onmicrosoft.com',
        id: 'user-external-123',
      };
      client.getCurrentUser.mockResolvedValue(userData);

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(true);
      expect((result.data as UserData)?.email).toBe('external@external.com');
      expect((result.data as UserData)?.userPrincipalName).toContain('#EXT#');
    });

    it('can be called multiple times independently', async () => {
      const client = createMockClient();
      const userData = {
        displayName: 'Test User',
        email: 'test@example.com',
        userPrincipalName: 'test@example.com',
        id: 'test-123',
      };
      client.getCurrentUser.mockResolvedValue(userData);

      const result1 = await handleGetCurrentUser(client as unknown as SharePointClient);
      const result2 = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(client.getCurrentUser).toHaveBeenCalledTimes(2);
    });
  });
});

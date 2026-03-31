/**
 * User Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createUserTools } from './user-tools.js';
import { RedmineClient, ProjectScopeError } from '../client.js';

type MockClient = {
  listUsers: Mock;
  resolveUser: Mock;
  getCurrentUser: Mock;
};

const createMockClient = (): MockClient => ({
  listUsers: vi.fn(),
  resolveUser: vi.fn(),
  getCurrentUser: vi.fn(),
});

describe('User Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.spyOn(RedmineClient, 'formatError').mockImplementation((error) => {
      if (error instanceof Error) return error.message;
      return String(error);
    });
  });

  describe('when client is null', () => {
    it('should return unconfigured error for list_users', async () => {
      const tools = createUserTools(null);
      const listUsersTool = tools.find((t) => t.tool.name === 'listUsers');
      expect(listUsersTool).toBeDefined();

      const result = await listUsersTool!.handler({});
      expect(result).toEqual({
        isError: true,
        content: [
          { type: 'text', text: 'Error: Redmine not configured. Run: speedwave setup redmine' },
        ],
      });
    });

    it('should return unconfigured error for resolve_user', async () => {
      const tools = createUserTools(null);
      const resolveUserTool = tools.find((t) => t.tool.name === 'resolveUser');
      expect(resolveUserTool).toBeDefined();

      const result = await resolveUserTool!.handler({ identifier: 'me' });
      expect(result).toEqual({
        isError: true,
        content: [
          { type: 'text', text: 'Error: Redmine not configured. Run: speedwave setup redmine' },
        ],
      });
    });

    it('should return unconfigured error for get_current_user', async () => {
      const tools = createUserTools(null);
      const getCurrentUserTool = tools.find((t) => t.tool.name === 'getCurrentUser');
      expect(getCurrentUserTool).toBeDefined();

      const result = await getCurrentUserTool!.handler({});
      expect(result).toEqual({
        isError: true,
        content: [
          { type: 'text', text: 'Error: Redmine not configured. Run: speedwave setup redmine' },
        ],
      });
    });
  });

  describe('listUsers', () => {
    it('should list all users when no project_id provided', async () => {
      const mockUsers = [
        {
          id: 1,
          login: 'user1',
          firstname: 'John',
          lastname: 'Doe',
          mail: 'john@example.com',
          created_on: '2024-01-01',
          updated_on: '2024-01-01',
        },
        {
          id: 2,
          login: 'user2',
          firstname: 'Jane',
          lastname: 'Smith',
          mail: 'jane@example.com',
          created_on: '2024-01-02',
          updated_on: '2024-01-02',
        },
      ];
      mockClient.listUsers.mockResolvedValue(mockUsers);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const listUsersTool = tools.find((t) => t.tool.name === 'listUsers');

      const result = await listUsersTool!.handler({});

      expect(mockClient.listUsers).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockUsers, null, 2) }],
      });
    });

    it('should list users filtered by project_id', async () => {
      const mockUsers = [
        {
          id: 1,
          login: 'user1',
          firstname: 'John',
          lastname: 'Doe',
          mail: 'john@example.com',
          created_on: '2024-01-01',
          updated_on: '2024-01-01',
        },
      ];
      mockClient.listUsers.mockResolvedValue(mockUsers);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const listUsersTool = tools.find((t) => t.tool.name === 'listUsers');

      const result = await listUsersTool!.handler({ project_id: 'my-project' });

      expect(mockClient.listUsers).toHaveBeenCalledWith('my-project');
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockUsers, null, 2) }],
      });
    });

    it('should handle empty user list', async () => {
      mockClient.listUsers.mockResolvedValue([]);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const listUsersTool = tools.find((t) => t.tool.name === 'listUsers');

      const result = await listUsersTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      });
    });

    it('should handle errors', async () => {
      mockClient.listUsers.mockRejectedValue(new Error('Network error'));

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const listUsersTool = tools.find((t) => t.tool.name === 'listUsers');

      const result = await listUsersTool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Network error' }],
      });
    });
  });

  describe('resolveUser', () => {
    it('should resolve user identifier to user_id', async () => {
      mockClient.resolveUser.mockResolvedValue(42);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const resolveUserTool = tools.find((t) => t.tool.name === 'resolveUser');

      const result = await resolveUserTool!.handler({ identifier: 'john.doe' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('john.doe');
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ user_id: 42 }, null, 2) }],
      });
    });

    it('should resolve "me" identifier', async () => {
      mockClient.resolveUser.mockResolvedValue(1);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const resolveUserTool = tools.find((t) => t.tool.name === 'resolveUser');

      const result = await resolveUserTool!.handler({ identifier: 'me' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('me');
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ user_id: 1 }, null, 2) }],
      });
    });

    it('should resolve numeric user ID', async () => {
      mockClient.resolveUser.mockResolvedValue(123);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const resolveUserTool = tools.find((t) => t.tool.name === 'resolveUser');

      const result = await resolveUserTool!.handler({ identifier: '123' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('123');
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ user_id: 123 }, null, 2) }],
      });
    });

    it('should handle null result (user not found)', async () => {
      mockClient.resolveUser.mockResolvedValue(null);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const resolveUserTool = tools.find((t) => t.tool.name === 'resolveUser');

      const result = await resolveUserTool!.handler({ identifier: 'nonexistent' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ user_id: null }, null, 2) }],
      });
    });

    it('should handle errors', async () => {
      mockClient.resolveUser.mockRejectedValue(new Error('API error'));

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const resolveUserTool = tools.find((t) => t.tool.name === 'resolveUser');

      const result = await resolveUserTool!.handler({ identifier: 'test' });

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: API error' }],
      });
    });
  });

  describe('getCurrentUser', () => {
    it('should get current user profile', async () => {
      const mockUser = {
        id: 1,
        login: 'current.user',
        firstname: 'Current',
        lastname: 'User',
        mail: 'current@example.com',
        created_on: '2024-01-01',
        updated_on: '2024-01-01',
      };
      mockClient.getCurrentUser.mockResolvedValue(mockUser);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const getCurrentUserTool = tools.find((t) => t.tool.name === 'getCurrentUser');

      const result = await getCurrentUserTool!.handler({});

      expect(mockClient.getCurrentUser).toHaveBeenCalledWith();
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockUser, null, 2) }],
      });
    });

    it('should handle errors', async () => {
      mockClient.getCurrentUser.mockRejectedValue(new Error('Unauthorized'));

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const getCurrentUserTool = tools.find((t) => t.tool.name === 'getCurrentUser');

      const result = await getCurrentUserTool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Unauthorized' }],
      });
    });

    it('should handle authentication failure', async () => {
      mockClient.getCurrentUser.mockRejectedValue(new Error('401 Unauthorized'));

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const getCurrentUserTool = tools.find((t) => t.tool.name === 'getCurrentUser');

      const result = await getCurrentUserTool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: 401 Unauthorized' }],
      });
    });
  });

  describe('ProjectScopeError propagation', () => {
    it('should surface ProjectScopeError for listUsers', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.listUsers.mockRejectedValue(scopeError);

      const tools = createUserTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'listUsers');
      const result = await tool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: "Error: Project scope violation: configured project is 'my-project', but requested resource belongs to 'other-project'",
          },
        ],
      });
    });
  });
});

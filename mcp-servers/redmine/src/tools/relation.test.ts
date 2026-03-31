/**
 * Relation Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createRelationTools } from './relation-tools.js';
import { RedmineClient, ProjectScopeError } from '../client.js';

type MockClient = {
  listRelations: Mock;
  createRelation: Mock;
  deleteRelation: Mock;
};

const createMockClient = (): MockClient => ({
  listRelations: vi.fn(),
  createRelation: vi.fn(),
  deleteRelation: vi.fn(),
});

describe('Relation Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.spyOn(RedmineClient, 'formatError').mockImplementation((error) => {
      if (error instanceof Error) return error.message;
      return String(error);
    });
  });

  describe('when client is null', () => {
    it('should return unconfigured error for list_relations', async () => {
      const tools = createRelationTools(null);
      const listRelationsTool = tools.find((t) => t.tool.name === 'listRelations');
      expect(listRelationsTool).toBeDefined();

      const result = await listRelationsTool!.handler({ issue_id: 1 });
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('Redmine')}`,
          },
        ],
      });
    });

    it('should return unconfigured error for create_relation', async () => {
      const tools = createRelationTools(null);
      const createRelationTool = tools.find((t) => t.tool.name === 'createRelation');
      expect(createRelationTool).toBeDefined();

      const result = await createRelationTool!.handler({ issue_id: 1, issue_to_id: 2 });
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('Redmine')}`,
          },
        ],
      });
    });

    it('should return unconfigured error for delete_relation', async () => {
      const tools = createRelationTools(null);
      const deleteRelationTool = tools.find((t) => t.tool.name === 'deleteRelation');
      expect(deleteRelationTool).toBeDefined();

      const result = await deleteRelationTool!.handler({ relation_id: 1 });
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('Redmine')}`,
          },
        ],
      });
    });
  });

  describe('listRelations', () => {
    it('should list all relations for an issue', async () => {
      const mockRelations = {
        relations: [
          { id: 1, issue_id: 10, issue_to_id: 20, relation_type: 'relates' as const },
          { id: 2, issue_id: 10, issue_to_id: 30, relation_type: 'blocks' as const },
        ],
      };
      mockClient.listRelations.mockResolvedValue(mockRelations);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const listRelationsTool = tools.find((t) => t.tool.name === 'listRelations');

      const result = await listRelationsTool!.handler({ issue_id: 10 });

      expect(mockClient.listRelations).toHaveBeenCalledWith(10);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockRelations, null, 2) }],
      });
    });

    it('should handle empty relations list', async () => {
      const mockRelations = { relations: [] };
      mockClient.listRelations.mockResolvedValue(mockRelations);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const listRelationsTool = tools.find((t) => t.tool.name === 'listRelations');

      const result = await listRelationsTool!.handler({ issue_id: 99 });

      expect(mockClient.listRelations).toHaveBeenCalledWith(99);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockRelations, null, 2) }],
      });
    });

    it('should handle relations with delay', async () => {
      const mockRelations = {
        relations: [
          { id: 1, issue_id: 10, issue_to_id: 20, relation_type: 'precedes' as const, delay: 5 },
        ],
      };
      mockClient.listRelations.mockResolvedValue(mockRelations);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const listRelationsTool = tools.find((t) => t.tool.name === 'listRelations');

      const result = await listRelationsTool!.handler({ issue_id: 10 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockRelations, null, 2) }],
      });
    });

    it('should handle errors', async () => {
      mockClient.listRelations.mockRejectedValue(new Error('Issue not found'));

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const listRelationsTool = tools.find((t) => t.tool.name === 'listRelations');

      const result = await listRelationsTool!.handler({ issue_id: 404 });

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Issue not found' }],
      });
    });
  });

  describe('createRelation', () => {
    it('should create a relation with default type (relates)', async () => {
      const mockRelation = {
        relation: {
          id: 1,
          issue_id: 10,
          issue_to_id: 20,
          relation_type: 'relates' as const,
        },
      };
      mockClient.createRelation.mockResolvedValue(mockRelation);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const createRelationTool = tools.find((t) => t.tool.name === 'createRelation');

      const result = await createRelationTool!.handler({ issue_id: 10, issue_to_id: 20 });

      expect(mockClient.createRelation).toHaveBeenCalledWith({
        issue_id: 10,
        issue_to_id: 20,
        relation_type: undefined,
        delay: undefined,
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockRelation, null, 2) }],
      });
    });

    it('should create a blocks relation', async () => {
      const mockRelation = {
        relation: {
          id: 2,
          issue_id: 10,
          issue_to_id: 20,
          relation_type: 'blocks' as const,
        },
      };
      mockClient.createRelation.mockResolvedValue(mockRelation);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const createRelationTool = tools.find((t) => t.tool.name === 'createRelation');

      const result = await createRelationTool!.handler({
        issue_id: 10,
        issue_to_id: 20,
        relation_type: 'blocks',
      });

      expect(mockClient.createRelation).toHaveBeenCalledWith({
        issue_id: 10,
        issue_to_id: 20,
        relation_type: 'blocks',
        delay: undefined,
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockRelation, null, 2) }],
      });
    });

    it('should create a precedes relation with delay', async () => {
      const mockRelation = {
        relation: {
          id: 3,
          issue_id: 10,
          issue_to_id: 20,
          relation_type: 'precedes' as const,
          delay: 7,
        },
      };
      mockClient.createRelation.mockResolvedValue(mockRelation);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const createRelationTool = tools.find((t) => t.tool.name === 'createRelation');

      const result = await createRelationTool!.handler({
        issue_id: 10,
        issue_to_id: 20,
        relation_type: 'precedes',
        delay: 7,
      });

      expect(mockClient.createRelation).toHaveBeenCalledWith({
        issue_id: 10,
        issue_to_id: 20,
        relation_type: 'precedes',
        delay: 7,
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockRelation, null, 2) }],
      });
    });

    it('should create a duplicates relation', async () => {
      const mockRelation = {
        relation: {
          id: 4,
          issue_id: 10,
          issue_to_id: 20,
          relation_type: 'duplicates' as const,
        },
      };
      mockClient.createRelation.mockResolvedValue(mockRelation);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const createRelationTool = tools.find((t) => t.tool.name === 'createRelation');

      const result = await createRelationTool!.handler({
        issue_id: 10,
        issue_to_id: 20,
        relation_type: 'duplicates',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockRelation, null, 2) }],
      });
    });

    it('should handle follows relation', async () => {
      const mockRelation = {
        relation: {
          id: 5,
          issue_id: 10,
          issue_to_id: 20,
          relation_type: 'follows' as const,
          delay: 3,
        },
      };
      mockClient.createRelation.mockResolvedValue(mockRelation);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const createRelationTool = tools.find((t) => t.tool.name === 'createRelation');

      const result = await createRelationTool!.handler({
        issue_id: 10,
        issue_to_id: 20,
        relation_type: 'follows',
        delay: 3,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockRelation, null, 2) }],
      });
    });

    it('should handle errors', async () => {
      mockClient.createRelation.mockRejectedValue(new Error('Invalid relation'));

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const createRelationTool = tools.find((t) => t.tool.name === 'createRelation');

      const result = await createRelationTool!.handler({ issue_id: 10, issue_to_id: 20 });

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Invalid relation' }],
      });
    });

    it('should handle validation errors', async () => {
      mockClient.createRelation.mockRejectedValue(new Error('Issue cannot be related to itself'));

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const createRelationTool = tools.find((t) => t.tool.name === 'createRelation');

      const result = await createRelationTool!.handler({ issue_id: 10, issue_to_id: 10 });

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Issue cannot be related to itself' }],
      });
    });
  });

  describe('deleteRelation', () => {
    it('should delete a relation', async () => {
      mockClient.deleteRelation.mockResolvedValue(undefined);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const deleteRelationTool = tools.find((t) => t.tool.name === 'deleteRelation');

      const result = await deleteRelationTool!.handler({ relation_id: 1 });

      expect(mockClient.deleteRelation).toHaveBeenCalledWith(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
      });
    });

    it('should delete relation with large ID', async () => {
      mockClient.deleteRelation.mockResolvedValue(undefined);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const deleteRelationTool = tools.find((t) => t.tool.name === 'deleteRelation');

      const result = await deleteRelationTool!.handler({ relation_id: 999999 });

      expect(mockClient.deleteRelation).toHaveBeenCalledWith(999999);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
      });
    });

    it('should handle errors when relation not found', async () => {
      mockClient.deleteRelation.mockRejectedValue(new Error('Relation not found'));

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const deleteRelationTool = tools.find((t) => t.tool.name === 'deleteRelation');

      const result = await deleteRelationTool!.handler({ relation_id: 404 });

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Relation not found' }],
      });
    });

    it('should handle permission errors', async () => {
      mockClient.deleteRelation.mockRejectedValue(new Error('Permission denied'));

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const deleteRelationTool = tools.find((t) => t.tool.name === 'deleteRelation');

      const result = await deleteRelationTool!.handler({ relation_id: 1 });

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Permission denied' }],
      });
    });
  });

  describe('ProjectScopeError propagation', () => {
    it('should surface ProjectScopeError for listRelations', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.listRelations.mockRejectedValue(scopeError);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'listRelations');
      const result = await tool!.handler({ issue_id: 10 });

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

    it('should surface ProjectScopeError for createRelation', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.createRelation.mockRejectedValue(scopeError);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'createRelation');
      const result = await tool!.handler({ issue_id: 10, issue_to_id: 20 });

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

    it('should surface ProjectScopeError for deleteRelation', async () => {
      const scopeError = new ProjectScopeError('my-project', 'other-project');
      mockClient.deleteRelation.mockRejectedValue(scopeError);

      const tools = createRelationTools(mockClient as unknown as RedmineClient);
      const tool = tools.find((t) => t.tool.name === 'deleteRelation');
      const result = await tool!.handler({ relation_id: 1 });

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

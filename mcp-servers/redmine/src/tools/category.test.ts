import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createCategoryTools } from './category-tools.js';
import { expectEmittedKeysDeclared } from './test-helpers.js';
import { RedmineClient, ProjectScopeError } from '../client.js';

type MockClient = {
  listCategories: Mock;
  showCategory: Mock;
  createCategory: Mock;
  updateCategory: Mock;
  deleteCategory: Mock;
  getProjectScope: Mock;
};

const createMockClient = (): MockClient => ({
  listCategories: vi.fn(),
  showCategory: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  getProjectScope: vi.fn().mockReturnValue(null),
});

const category = {
  id: 5,
  project: { id: 3, name: 'My project' },
  name: 'Backend',
  assigned_to: { id: 7, name: 'Jan Kowalski' },
};

const textOf = (result: ToolsCallResult): string => (result.content[0] as { text: string }).text;

describe('Category tools', () => {
  let mockClient: MockClient;

  const tool = (name: string) =>
    createCategoryTools(mockClient as unknown as RedmineClient).find((t) => t.tool.name === name)!;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.spyOn(RedmineClient, 'formatError').mockImplementation((error) =>
      error instanceof Error ? error.message : String(error)
    );
  });

  it.each([
    ['listCategories', {}],
    ['getCategory', { category_id: 5 }],
    ['createCategory', { name: 'Backend' }],
    ['updateCategory', { category_id: 5, name: 'API' }],
    ['deleteCategory', { category_id: 5 }],
  ])('%s returns the unconfigured error when the client is null', async (name, params) => {
    const def = createCategoryTools(null).find((t) => t.tool.name === name)!;

    expect(await def.handler(params)).toEqual({
      isError: true,
      content: [{ type: 'text', text: `Error: ${notConfiguredMessage('Redmine')}` }],
    });
  });

  describe('listCategories', () => {
    it('returns { categories, total_count } with every key declared', async () => {
      mockClient.listCategories.mockResolvedValue({ categories: [category], total_count: 1 });
      const def = tool('listCategories');

      const emitted = expectEmittedKeysDeclared(
        def.tool,
        await def.handler({ project_id: 'my-project' })
      );

      expect(mockClient.listCategories).toHaveBeenCalledWith('my-project');
      expect(emitted).toEqual({ categories: [category], total_count: 1 });
      const itemProps = (
        def.tool.outputSchema!.properties as Record<
          string,
          { items: { properties: Record<string, unknown> } }
        >
      ).categories.items.properties;
      expect(Object.keys(itemProps)).toEqual(expect.arrayContaining(Object.keys(category)));
    });

    it('passes a numeric project id through unchanged', async () => {
      mockClient.listCategories.mockResolvedValue({ categories: [], total_count: 0 });

      await tool('listCategories').handler({ project_id: 3 });

      expect(mockClient.listCategories).toHaveBeenCalledWith(3);
    });

    it('defaults to the configured project when project_id is omitted or empty', async () => {
      mockClient.getProjectScope.mockReturnValue('my-project');
      mockClient.listCategories.mockResolvedValue({ categories: [], total_count: 0 });

      await tool('listCategories').handler({});
      await tool('listCategories').handler({ project_id: '' });

      expect(mockClient.listCategories).toHaveBeenCalledTimes(2);
      expect(mockClient.listCategories).toHaveBeenNthCalledWith(1, 'my-project');
      expect(mockClient.listCategories).toHaveBeenNthCalledWith(2, 'my-project');
    });

    it('returns a teaching error when no project_id is given and none is configured', async () => {
      const result = await tool('listCategories').handler({});

      expect(mockClient.listCategories).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Error: Invalid project_id (received: undefined). Get a valid value from listProjectIds. ' +
          'No default project is configured, so pass project_id explicitly.'
      );
    });

    it('surfaces a ProjectScopeError for a project outside the configured scope', async () => {
      mockClient.listCategories.mockRejectedValue(
        new ProjectScopeError('my-project', 'other-project')
      );

      const result = await tool('listCategories').handler({ project_id: 'other-project' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Project scope violation');
      expect(RedmineClient.formatError).toHaveBeenCalledWith(expect.any(ProjectScopeError), {
        project_id: 'other-project',
      });
    });
  });

  describe('getCategory', () => {
    it('returns the category with every key declared', async () => {
      mockClient.showCategory.mockResolvedValue(category);
      const def = tool('getCategory');

      const emitted = expectEmittedKeysDeclared(def.tool, await def.handler({ category_id: 5 }));

      expect(mockClient.showCategory).toHaveBeenCalledWith(5);
      expect(emitted).toEqual(category);
    });

    it('does not consult the configured project', async () => {
      mockClient.showCategory.mockResolvedValue(category);

      await tool('getCategory').handler({ category_id: 5 });

      expect(mockClient.getProjectScope).not.toHaveBeenCalled();
    });

    it('passes category_id as formatError context on failure', async () => {
      mockClient.showCategory.mockRejectedValue(new Error('404'));

      const result = await tool('getCategory').handler({ category_id: 999 });

      expect(result.isError).toBe(true);
      expect(RedmineClient.formatError).toHaveBeenCalledWith(expect.any(Error), {
        category_id: 999,
      });
    });
  });

  describe('createCategory', () => {
    it('creates the category and returns it with every key declared', async () => {
      mockClient.createCategory.mockResolvedValue(category);
      const def = tool('createCategory');

      const emitted = expectEmittedKeysDeclared(
        def.tool,
        await def.handler({ project_id: 'my-project', name: 'Backend', assigned_to_id: 7 })
      );

      expect(mockClient.createCategory).toHaveBeenCalledWith('my-project', {
        name: 'Backend',
        assigned_to_id: 7,
      });
      expect(emitted).toEqual(category);
    });

    it('defaults to the configured project and omits the assignee', async () => {
      mockClient.getProjectScope.mockReturnValue('my-project');
      mockClient.createCategory.mockResolvedValue(category);

      await tool('createCategory').handler({ name: 'Backend' });

      expect(mockClient.createCategory).toHaveBeenCalledWith('my-project', {
        name: 'Backend',
        assigned_to_id: undefined,
      });
    });

    it('returns a teaching error when no project is given or configured', async () => {
      const result = await tool('createCategory').handler({ name: 'Backend' });

      expect(mockClient.createCategory).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('No default project is configured');
    });

    it('surfaces the failure the client throws', async () => {
      mockClient.createCategory.mockRejectedValue(new Error('Permission denied.'));

      const result = await tool('createCategory').handler({
        project_id: 'my-project',
        name: 'Backend',
      });

      expect(textOf(result)).toBe('Error: Permission denied.');
    });
  });

  describe('updateCategory', () => {
    it('updates the category and returns { success: true }', async () => {
      mockClient.updateCategory.mockResolvedValue(undefined);
      const def = tool('updateCategory');

      const emitted = expectEmittedKeysDeclared(
        def.tool,
        await def.handler({ category_id: 5, name: 'API', assigned_to_id: null })
      );

      expect(mockClient.updateCategory).toHaveBeenCalledWith(5, {
        name: 'API',
        assigned_to_id: null,
      });
      expect(emitted).toEqual({ success: true });
    });

    it('passes a numeric assignee through', async () => {
      mockClient.updateCategory.mockResolvedValue(undefined);

      await tool('updateCategory').handler({ category_id: 5, assigned_to_id: 7 });

      expect(mockClient.updateCategory).toHaveBeenCalledWith(5, {
        name: undefined,
        assigned_to_id: 7,
      });
    });

    it('does not consult the configured project', async () => {
      mockClient.updateCategory.mockResolvedValue(undefined);

      await tool('updateCategory').handler({ category_id: 5, name: 'API' });

      expect(mockClient.getProjectScope).not.toHaveBeenCalled();
    });

    it('reports the failure instead of { success: true }', async () => {
      mockClient.updateCategory.mockRejectedValue(new Error('Nothing to update on category 5'));

      const result = await tool('updateCategory').handler({ category_id: 5 });

      expect(textOf(result)).toBe('Error: Nothing to update on category 5');
      expect(RedmineClient.formatError).toHaveBeenCalledWith(expect.any(Error), {
        category_id: 5,
      });
    });
  });

  describe('deleteCategory', () => {
    it('deletes with a reassignment and returns { success: true }', async () => {
      mockClient.deleteCategory.mockResolvedValue(undefined);
      const def = tool('deleteCategory');

      const emitted = expectEmittedKeysDeclared(
        def.tool,
        await def.handler({ category_id: 5, reassign_to_id: 6 })
      );

      expect(mockClient.deleteCategory).toHaveBeenCalledWith(5, 6);
      expect(emitted).toEqual({ success: true });
    });

    it('deletes without a reassignment when none is given', async () => {
      mockClient.deleteCategory.mockResolvedValue(undefined);

      await tool('deleteCategory').handler({ category_id: 5 });

      expect(mockClient.deleteCategory).toHaveBeenCalledWith(5, undefined);
    });

    it('does not consult the configured project', async () => {
      mockClient.deleteCategory.mockResolvedValue(undefined);

      await tool('deleteCategory').handler({ category_id: 5 });

      expect(mockClient.getProjectScope).not.toHaveBeenCalled();
    });

    it('reports the failure instead of { success: true }', async () => {
      mockClient.deleteCategory.mockRejectedValue(new Error('404'));

      const result = await tool('deleteCategory').handler({ category_id: 999 });

      expect(result.isError).toBe(true);
      expect(RedmineClient.formatError).toHaveBeenCalledWith(expect.any(Error), {
        category_id: 999,
      });
    });
  });
});

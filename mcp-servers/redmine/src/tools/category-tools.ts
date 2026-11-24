/**
 * Category Tools - 5 tools for Redmine issue category operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import { withRedmineErrors, withTargetProject } from './error-handling.js';
import { successResultSchema } from './schema-helpers.js';

const NAMED_REF = {
  type: 'object',
  properties: { id: { type: 'number' }, name: { type: 'string' } },
};

const CATEGORY_PROPERTIES = {
  id: { type: 'number', description: 'Category ID, the value category_id takes' },
  project: { ...NAMED_REF, description: 'Project the category belongs to' },
  name: { type: 'string' },
  assigned_to: { ...NAMED_REF, description: 'Default assignee; absent when none is set' },
};

const PROJECT_ID_PROPERTY = {
  type: ['string', 'number'],
  description:
    'Project ID or identifier — obtained from listProjectIds; defaults to the configured project',
};

const MANAGE_CATEGORIES_NOTE =
  'Needs the Redmine permission "Manage issue categories" in the project.';

const listCategoriesTool: Tool = {
  name: 'listCategories',
  description:
    "List a project's issue categories. Pass a category's id as category_id to createIssue or updateIssue (the category must belong to the issue's project), or to listIssueIds to filter by it. project_id defaults to the configured project and accepts its numeric ID or identifier; if scoped to a single project, another project fails with a scope error.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'categories', 'category', 'issue_categories', 'list', 'component', 'area'],
  example: `const { categories } = await redmine.listCategories({ project_id: 'my-project' })`,
  inputSchema: {
    type: 'object',
    properties: { project_id: PROJECT_ID_PROPERTY },
  },
  outputSchema: successResultSchema({
    categories: { type: 'array', items: { type: 'object', properties: CATEGORY_PROPERTIES } },
    total_count: { type: 'number' },
  }),
  inputExamples: [
    { description: 'Minimal: categories of the configured project', input: {} },
    { description: 'Full: categories of a named project', input: { project_id: 'my-project' } },
  ],
};

const getCategoryTool: Tool = {
  name: 'getCategory',
  description:
    "Get one issue category by ID: its project, name and default assignee. The category's project is not checked against the configured project.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'category', 'issue_category', 'get', 'show', 'assignee'],
  example: `const category = await redmine.getCategory({ category_id: 5 })`,
  inputSchema: {
    type: 'object',
    properties: {
      category_id: {
        type: 'number',
        description: 'Category ID — obtained from listCategories',
      },
    },
    required: ['category_id'],
  },
  outputSchema: successResultSchema(CATEGORY_PROPERTIES),
  inputExamples: [{ description: 'Minimal: get a category', input: { category_id: 5 } }],
};

const createCategoryTool: Tool = {
  name: 'createCategory',
  description: `Create an issue category in a project. The name must be unique within the project. assigned_to_id sets the default assignee: an issue created in this category without an assignee gets that user. ${MANAGE_CATEGORIES_NOTE} project_id defaults to the configured project; if scoped to a single project, another project fails with a scope error.`,
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['redmine', 'category', 'issue_category', 'create', 'new', 'add'],
  example: `const category = await redmine.createCategory({ project_id: 'my-project', name: 'Backend', assigned_to_id: 7 })`,
  inputSchema: {
    type: 'object',
    properties: {
      project_id: PROJECT_ID_PROPERTY,
      name: { type: 'string', description: 'Category name, unique within the project' },
      assigned_to_id: {
        type: 'number',
        description: 'Default assignee user ID — obtained from resolveUser or listUsers',
      },
    },
    required: ['name'],
  },
  outputSchema: successResultSchema(CATEGORY_PROPERTIES),
  inputExamples: [
    { description: 'Minimal: category in the configured project', input: { name: 'Backend' } },
    {
      description: 'Full: category with a default assignee',
      input: { project_id: 'my-project', name: 'Backend', assigned_to_id: 7 },
    },
  ],
};

const updateCategoryTool: Tool = {
  name: 'updateCategory',
  description: `Rename an issue category or change its default assignee; assigned_to_id: null clears the default assignee. Pass at least one of name and assigned_to_id. ${MANAGE_CATEGORIES_NOTE} The category's project is not checked against the configured project.`,
  annotations: WRITE_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['redmine', 'category', 'issue_category', 'update', 'rename', 'assignee', 'edit'],
  example: `await redmine.updateCategory({ category_id: 5, name: 'API', assigned_to_id: null })`,
  inputSchema: {
    type: 'object',
    properties: {
      category_id: {
        type: 'number',
        description: 'Category ID — obtained from listCategories',
      },
      name: { type: 'string', description: 'New category name' },
      assigned_to_id: {
        type: ['number', 'null'],
        description: 'New default assignee user ID, or null to clear it',
      },
    },
    required: ['category_id'],
  },
  outputSchema: successResultSchema({}),
  inputExamples: [
    { description: 'Minimal: rename a category', input: { category_id: 5, name: 'API' } },
    {
      description: 'Full: rename and clear the default assignee',
      input: { category_id: 5, name: 'API', assigned_to_id: null },
    },
  ],
};

const deleteCategoryTool: Tool = {
  name: 'deleteCategory',
  description: `Delete an issue category (irreversible). Issues in the category lose their category unless reassign_to_id names another category of the same project, which takes them over. ${MANAGE_CATEGORIES_NOTE} The category's project is not checked against the configured project.`,
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'category', 'issue_category', 'delete', 'remove', 'reassign'],
  example: `await redmine.deleteCategory({ category_id: 5, reassign_to_id: 6 })`,
  inputSchema: {
    type: 'object',
    properties: {
      category_id: {
        type: 'number',
        description: 'Category ID to delete — obtained from listCategories',
      },
      reassign_to_id: {
        type: 'number',
        description:
          'Category of the same project that takes over the issues; without it they lose their category',
      },
    },
    required: ['category_id'],
  },
  outputSchema: successResultSchema({}),
  inputExamples: [
    {
      description: 'Minimal: delete a category, its issues lose their category',
      input: { category_id: 5 },
    },
    {
      description: 'Full: delete a category and move its issues to another one',
      input: { category_id: 5, reassign_to_id: 6 },
    },
  ],
};

/**
 * Tool handler function.
 * @param client - Redmine client instance
 */
export function createCategoryTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
  if (!client) {
    return [
      { tool: listCategoriesTool, handler: unconfigured },
      { tool: getCategoryTool, handler: unconfigured },
      { tool: createCategoryTool, handler: unconfigured },
      { tool: updateCategoryTool, handler: unconfigured },
      { tool: deleteCategoryTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listCategoriesTool,
      handler: async (params) => {
        const { project_id } = params as { project_id?: string | number };
        return withTargetProject(client, project_id, async (target) => {
          const result = await client.listCategories(target);
          return jsonResult({ categories: result.categories, total_count: result.total_count });
        });
      },
    },
    {
      tool: getCategoryTool,
      handler: async (params) => {
        const { category_id } = params as { category_id: number };
        return withRedmineErrors({ category_id }, async () =>
          jsonResult(await client.showCategory(category_id))
        );
      },
    },
    {
      tool: createCategoryTool,
      handler: async (params) => {
        const { project_id, name, assigned_to_id } = params as {
          project_id?: string | number;
          name: string;
          assigned_to_id?: number;
        };
        return withTargetProject(client, project_id, async (target) =>
          jsonResult(await client.createCategory(target, { name, assigned_to_id }))
        );
      },
    },
    {
      tool: updateCategoryTool,
      handler: async (params) => {
        const { category_id, name, assigned_to_id } = params as {
          category_id: number;
          name?: string;
          assigned_to_id?: number | null;
        };
        return withRedmineErrors({ category_id }, async () => {
          await client.updateCategory(category_id, { name, assigned_to_id });
          return jsonResult({ success: true });
        });
      },
    },
    {
      tool: deleteCategoryTool,
      handler: async (params) => {
        const { category_id, reassign_to_id } = params as {
          category_id: number;
          reassign_to_id?: number;
        };
        return withRedmineErrors({ category_id }, async () => {
          await client.deleteCategory(category_id, reassign_to_id);
          return jsonResult({ success: true });
        });
      },
    },
  ];
}

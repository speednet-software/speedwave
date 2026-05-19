/**
 * Repo Tools - 3 tools for GitHub repositories
 */

import { Tool, ToolDefinition, jsonResult, READ_ONLY_ANNOTATIONS } from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { withValidation } from './validation.js';

const listReposTool: Tool = {
  name: 'listRepos',
  description:
    'List repositories accessible to the authenticated user, or search repositories when a search query is given.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['github', 'repos', 'repositories', 'list', 'search'],
  example:
    'const { repos, count } = await github.listRepos({ search: "language:rust org:speednet" })',
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: "GitHub search query, e.g. 'language:rust'" },
      affiliation: {
        type: 'string',
        description: 'owner | collaborator | organization_member; comma-separated',
      },
      limit: { type: 'number', description: 'Max results, default 100' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      repos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            full_name: { type: 'string' },
            description: { type: 'string' },
            html_url: { type: 'string' },
            default_branch: { type: 'string' },
            private: { type: 'boolean' },
          },
        },
      },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Minimal: all repos for the authenticated user', input: {} },
    { description: 'Partial: search by language', input: { search: 'language:typescript' } },
    {
      description: 'Full: search scoped, only repos you own, limited',
      input: { search: 'speedwave in:name', affiliation: 'owner', limit: 20 },
    },
  ],
};

const getRepoTool: Tool = {
  name: 'getRepo',
  description: 'Get detailed information about a specific repository.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'repo', 'repository', 'get', 'show', 'detail'],
  example: 'const repo = await github.getRepo({ owner: "octocat", repo: "hello-world" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'number' },
      name: { type: 'string' },
      full_name: { type: 'string' },
      owner: { type: 'object', properties: { login: { type: 'string' } } },
      description: { type: 'string' },
      html_url: { type: 'string' },
      default_branch: { type: 'string' },
      private: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'Get a public repository', input: { owner: 'octocat', repo: 'hello-world' } },
  ],
};

const searchCodeTool: Tool = {
  name: 'searchCode',
  description: 'Search code across GitHub, optionally scoped to a single repository.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'code', 'search', 'grep', 'find'],
  example:
    'const { results, count } = await github.searchCode({ query: "createMCPServer", owner: "octocat", repo: "hello" })',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Code search query (GitHub code-search syntax)' },
      owner: {
        type: 'string',
        description: 'Repository owner to scope the search to (requires repo)',
      },
      repo: {
        type: 'string',
        description: 'Repository name to scope the search to (requires owner)',
      },
      limit: { type: 'number', description: 'Max results, default 100' },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            repository: { type: 'string' },
            html_url: { type: 'string' },
          },
        },
      },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: search all of GitHub',
      input: { query: 'addEventListener language:js' },
    },
    {
      description: 'Partial: scope to a repository',
      input: { query: 'TODO', owner: 'octocat', repo: 'hello-world' },
    },
    {
      description: 'Full: scoped search with a result limit',
      input: { query: 'function in:file', owner: 'octocat', repo: 'hello-world', limit: 10 },
    },
  ],
};

/**
 * Builds the repository tool definitions.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createRepoTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: listReposTool,
      handler: withValidation(client, async (c, params) => {
        const options = params as { search?: string; limit?: number; affiliation?: string };
        const result = await c.listRepos(options);
        return jsonResult({
          repos: result.map((r) => ({
            full_name: r.full_name,
            description: r.description,
            html_url: r.html_url,
            default_branch: r.default_branch,
            private: r.private,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: getRepoTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo } = params as { owner: string; repo: string };
        const result = await c.getRepo(owner, repo);
        return jsonResult({
          full_name: result.full_name,
          description: result.description,
          html_url: result.html_url,
          default_branch: result.default_branch,
          private: result.private,
        });
      }),
    },
    {
      tool: searchCodeTool,
      handler: withValidation(client, async (c, params) => {
        const { query, ...options } = params as {
          query: string;
          owner?: string;
          repo?: string;
          limit?: number;
        };
        const result = await c.searchCode(query, options);
        return jsonResult({ results: result, count: result.length });
      }),
    },
  ];
}

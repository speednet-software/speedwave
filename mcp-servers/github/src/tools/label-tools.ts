/**
 * Label Tools - 2 tools for GitHub repository labels
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { withValidation } from './validation.js';

const listLabelsTool: Tool = {
  name: 'listLabels',
  description: 'List labels defined in a repository.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: false },
  keywords: ['github', 'labels', 'list', 'tags'],
  example: 'const { labels, count } = await github.listLabels({ owner: "octocat", repo: "hello" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['owner', 'repo'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            color: { type: 'string' },
            description: { type: 'string' },
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
      description: 'Minimal: list repository labels',
      input: { owner: 'octocat', repo: 'hello-world' },
    },
    {
      description: 'Partial: list labels for another repo',
      input: { owner: 'octocat', repo: 'spoon-knife' },
    },
    {
      description: 'Full: list labels with a result limit',
      input: { owner: 'octocat', repo: 'hello-world', limit: 10 },
    },
  ],
};

const createLabelTool: Tool = {
  name: 'createLabel',
  description: 'Create a new label in a repository.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['github', 'label', 'create', 'new', 'tag'],
  example:
    'const label = await github.createLabel({ owner: "octocat", repo: "hello", name: "urgent", color: "FF0000" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      name: { type: 'string', description: 'Label name' },
      color: { type: 'string', description: '6-char hex, with or without leading #' },
      description: { type: 'string', description: 'Label description' },
    },
    required: ['owner', 'repo', 'name', 'color'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'number' },
      name: { type: 'string' },
      color: { type: 'string' },
      description: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: create a label',
      input: { owner: 'octocat', repo: 'hello-world', name: 'bug', color: 'FF0000' },
    },
    {
      description: 'Partial: create a label with a leading-# color',
      input: { owner: 'octocat', repo: 'hello-world', name: 'feature', color: '#00FF00' },
    },
    {
      description: 'Full: create a label with a description',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        name: 'documentation',
        color: 'FFA500',
        description: 'Improvements or additions to documentation',
      },
    },
  ],
};

/**
 * Builds the label tool definitions for the GitHub worker.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createLabelTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: listLabelsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, limit } = params as { owner: string; repo: string; limit?: number };
        const result = await c.listLabels(owner, repo, { limit });
        return jsonResult({
          labels: result.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
            description: l.description,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: createLabelTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...rest } = params as {
          owner: string;
          repo: string;
          name: string;
          color: string;
          description?: string;
        };
        const result = await c.createLabel(owner, repo, rest);
        return jsonResult(result);
      }),
    },
  ];
}

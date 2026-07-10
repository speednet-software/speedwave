/**
 * Repository Content Tools - 3 tools for GitHub repository file operations
 */

import {
  META_KEYS,
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { withValidation } from './validation.js';
import { TOOL_NAMES } from '../tool-names.js';

const getTreeTool: Tool = {
  name: TOOL_NAMES.GET_TREE,
  description: 'Get a repository file tree (file/directory listing), optionally recursive.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'tree', 'files', 'repository', 'ls', 'directory'],
  example:
    'const { tree, count } = await github.getTree({ owner: "octocat", repo: "hello", recursive: true })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      ref: { type: 'string', description: "Branch/tag/SHA; default is the repo's default branch" },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories' },
    },
    required: ['owner', 'repo'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      tree: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            type: { type: 'string', enum: ['blob', 'tree'] },
            sha: { type: 'string' },
            size: { type: 'number' },
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
      description: 'Minimal: top-level tree of the default branch',
      input: { owner: 'octocat', repo: 'hello-world' },
    },
    {
      description: 'Partial: tree at a specific ref',
      input: { owner: 'octocat', repo: 'hello-world', ref: 'develop' },
    },
    {
      description: 'Full: recursive tree at a tag',
      input: { owner: 'octocat', repo: 'hello-world', ref: 'v1.0.0', recursive: true },
    },
  ],
};

const getFileContentsTool: Tool = {
  name: 'getFileContents',
  description:
    "Reads a file's contents from a repository. Text files are decoded to UTF-8; binary files " +
    "(images, archives, ...) are returned as raw base64 with encoding: 'base64' so content is " +
    'never corrupted. Errors if the path is a directory.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'file', 'content', 'read', 'cat', 'source'],
  example:
    'const file = await github.getFileContents({ owner: "octocat", repo: "hello", path: "README.md" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File path from the repository root' },
      ref: { type: 'string', description: "Branch/tag/SHA; default is the repo's default branch" },
    },
    required: ['owner', 'repo', 'path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      path: { type: 'string' },
      content: {
        type: 'string',
        description: "Decoded UTF-8 text, or raw base64 for binary files (see 'encoding')",
      },
      encoding: {
        type: 'string',
        description: "'utf-8' for decoded text, 'base64' for binary content",
      },
      sha: { type: 'string', description: 'Blob SHA' },
      size: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: read a file from the default branch',
      input: { owner: 'octocat', repo: 'hello-world', path: 'package.json' },
    },
    {
      description: 'Partial: read a nested file',
      input: { owner: 'octocat', repo: 'hello-world', path: 'src/index.ts' },
    },
    {
      description: 'Full: read a file at a specific ref',
      input: { owner: 'octocat', repo: 'hello-world', path: 'src/index.ts', ref: 'develop' },
    },
  ],
};

const createOrUpdateFileTool: Tool = {
  name: 'createOrUpdateFile',
  description: 'Creates a new file or updates an existing one with a commit.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'file', 'create', 'update', 'write', 'commit'],
  example:
    'const { commit_sha } = await github.createOrUpdateFile({ owner: "octocat", repo: "hello", path: "docs/x.md", content: "# Hi", message: "add doc" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File path from the repository root' },
      content: { type: 'string', description: 'File content (UTF-8)' },
      message: { type: 'string', description: 'Commit message' },
      branch: {
        type: 'string',
        description: "Target branch; default is the repo's default branch",
      },
      sha: {
        type: 'string',
        description:
          'Blob SHA of the file being replaced — required when updating an existing file; the worker fetches it automatically if omitted',
      },
    },
    required: ['owner', 'repo', 'path', 'content', 'message'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      commit_sha: { type: 'string' },
      path: { type: 'string' },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: create a new file on the default branch',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        path: 'NOTES.md',
        content: '# Notes',
        message: 'Add notes',
      },
    },
    {
      description: 'Partial: create a file on a specific branch',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        path: 'docs/guide.md',
        content: '# Guide',
        message: 'Add guide',
        branch: 'docs',
      },
    },
    {
      description: 'Full: update an existing file with its blob SHA',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        path: 'README.md',
        content: '# Hello World (updated)',
        message: 'Update README',
        branch: 'main',
        sha: 'a1b2c3d4',
      },
    },
  ],
};

/**
 * Builds the repository-content tool definitions for the GitHub worker.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createRepositoryTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: getTreeTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...options } = params as {
          owner: string;
          repo: string;
          ref?: string;
          recursive?: boolean;
        };
        const result = await c.getTree(owner, repo, options);
        return jsonResult({
          tree: result.map((t) => ({ path: t.path, type: t.type, sha: t.sha, size: t.size })),
          count: result.length,
        });
      }),
    },
    {
      tool: getFileContentsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, path, ...options } = params as {
          owner: string;
          repo: string;
          path: string;
          ref?: string;
        };
        const result = await c.getFileContents(owner, repo, path, options);
        return jsonResult({
          path: result.path,
          content: result.content,
          encoding: result.encoding,
          sha: result.sha,
          size: result.size,
        });
      }),
    },
    {
      tool: createOrUpdateFileTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...rest } = params as {
          owner: string;
          repo: string;
          path: string;
          content: string;
          message: string;
          branch?: string;
          sha?: string;
        };
        const result = await c.createOrUpdateFile(owner, repo, rest);
        return jsonResult(result);
      }),
    },
  ];
}

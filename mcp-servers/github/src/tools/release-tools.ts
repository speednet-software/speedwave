/**
 * Release Tools - 3 tools for GitHub tags and releases
 */

import {
  META_KEYS,
  Tool,
  ToolDefinition,
  jsonResult,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { withValidation } from './validation.js';

const createTagTool: Tool = {
  name: 'createTag',
  description:
    'Creates a Git tag pointing at a commit. If a message is given, an annotated tag is created.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'tag', 'create', 'release', 'version', 'git'],
  example:
    'const { tag, ref } = await github.createTag({ owner: "octocat", repo: "hello", tag: "v1.2.0", sha: "abc123" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      tag: { type: 'string', description: "Tag name, e.g. 'v1.2.0'" },
      sha: { type: 'string', description: 'Commit SHA to tag' },
      message: {
        type: 'string',
        description: 'Annotation message; if given, creates an annotated tag',
      },
    },
    required: ['owner', 'repo', 'tag', 'sha'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      tag: { type: 'string' },
      sha: { type: 'string' },
      ref: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: lightweight tag pointing at a commit',
      input: { owner: 'octocat', repo: 'hello-world', tag: 'v1.0.0', sha: 'abc123' },
    },
    {
      description: 'Partial: tag a different commit',
      input: { owner: 'octocat', repo: 'hello-world', tag: 'v2.1.0', sha: 'def456' },
    },
    {
      description: 'Full: annotated tag with a message',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        tag: 'v1.5.0',
        sha: 'abc123',
        message: 'Release v1.5.0',
      },
    },
  ],
};

const deleteTagTool: Tool = {
  name: 'deleteTag',
  description: 'Deletes a Git tag from the repository.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'tag', 'delete', 'remove', 'version', 'git'],
  example: 'await github.deleteTag({ owner: "octocat", repo: "hello", tag: "v1.0.0" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      tag: { type: 'string', description: 'Tag name to delete' },
    },
    required: ['owner', 'repo', 'tag'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      deleted: { type: 'boolean' },
      tag: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: delete a tag',
      input: { owner: 'octocat', repo: 'hello-world', tag: 'v1.0.0' },
    },
    {
      description: 'Partial: delete a pre-release tag',
      input: { owner: 'octocat', repo: 'hello-world', tag: 'v2.0.0-rc1' },
    },
    {
      description: 'Full: delete a test tag',
      input: { owner: 'octocat', repo: 'hello-world', tag: 'v0.0.1-test' },
    },
  ],
};

const createReleaseTool: Tool = {
  name: 'createRelease',
  description: 'Creates a release associated with a tag (creating the tag if it does not exist).',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'release', 'create', 'changelog', 'version', 'publish'],
  example:
    'const release = await github.createRelease({ owner: "octocat", repo: "hello", tag_name: "v1.0.0", name: "First release" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      tag_name: { type: 'string', description: 'Tag name for the release' },
      name: { type: 'string', description: 'Release title' },
      body: { type: 'string', description: 'Release notes, markdown' },
      draft: { type: 'boolean', description: 'Create the release as a draft' },
      prerelease: { type: 'boolean', description: 'Mark the release as a pre-release' },
      target_commitish: {
        type: 'string',
        description: "Branch or SHA the tag should point at if it doesn't exist",
      },
    },
    required: ['owner', 'repo', 'tag_name'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'number' },
      tag_name: { type: 'string' },
      name: { type: 'string' },
      body: { type: 'string' },
      draft: { type: 'boolean' },
      prerelease: { type: 'boolean' },
      html_url: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: release for an existing tag',
      input: { owner: 'octocat', repo: 'hello-world', tag_name: 'v1.0.0' },
    },
    {
      description: 'Partial: release with a custom name',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        tag_name: 'v2.1.3',
        name: 'Security update v2.1.3',
      },
    },
    {
      description: 'Full: draft pre-release with notes and a target branch',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        tag_name: 'v1.5.0',
        name: 'Release v1.5.0',
        body: '## Features\n- New auth flow\n\n## Fixes\n- Memory leak',
        draft: true,
        prerelease: true,
        target_commitish: 'main',
      },
    },
  ],
};

/**
 * Builds the tag/release tool definitions for the GitHub worker.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createReleaseTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: createTagTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...rest } = params as {
          owner: string;
          repo: string;
          tag: string;
          sha: string;
          message?: string;
        };
        const result = await c.createTag(owner, repo, rest);
        return jsonResult(result);
      }),
    },
    {
      tool: deleteTagTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, tag } = params as { owner: string; repo: string; tag: string };
        const result = await c.deleteTag(owner, repo, tag);
        return jsonResult(result);
      }),
    },
    {
      tool: createReleaseTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...rest } = params as {
          owner: string;
          repo: string;
          tag_name: string;
          name?: string;
          body?: string;
          draft?: boolean;
          prerelease?: boolean;
          target_commitish?: string;
        };
        const result = await c.createRelease(owner, repo, rest);
        return jsonResult(result);
      }),
    },
  ];
}

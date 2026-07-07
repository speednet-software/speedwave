/**
 * Actions Tools - 7 tools for GitHub Actions workflows, runs, and artifacts
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
import { GitHubWorkflowRun } from '../types.js';
import { withValidation } from './validation.js';

/**
 * Maps a normalized workflow run to the compact summary returned by `listWorkflowRuns`
 * (drops `created_at`/`updated_at` — those are exposed by `getWorkflowRun`).
 * @param r - Normalized workflow run from the GitHub client
 * @returns Compact `{ id, name, status, conclusion, head_branch, head_sha, html_url }` summary
 */
function runSummary(r: GitHubWorkflowRun): Omit<GitHubWorkflowRun, 'created_at' | 'updated_at'> {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    head_branch: r.head_branch,
    head_sha: r.head_sha,
    html_url: r.html_url,
  };
}

const listWorkflowRunsTool: Tool = {
  name: 'listWorkflowRuns',
  description:
    'List GitHub Actions workflow runs for a repository, optionally filtered by branch or status.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['github', 'actions', 'workflow', 'runs', 'ci', 'cd', 'list', 'builds'],
  example:
    'const { runs, count } = await github.listWorkflowRuns({ owner: "octocat", repo: "hello", status: "failure" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'Filter to runs on this branch' },
      status: {
        type: 'string',
        description: 'e.g. queued, in_progress, completed, success, failure',
      },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['owner', 'repo'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      runs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            status: { type: 'string' },
            conclusion: { type: ['string', 'null'] },
            head_branch: { type: 'string' },
            head_sha: { type: 'string' },
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
      description: 'Minimal: recent workflow runs',
      input: { owner: 'octocat', repo: 'hello-world' },
    },
    {
      description: 'Partial: failed runs',
      input: { owner: 'octocat', repo: 'hello-world', status: 'failure' },
    },
    {
      description: 'Full: completed runs on a branch',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        branch: 'main',
        status: 'completed',
        limit: 20,
      },
    },
  ],
};

const getWorkflowRunTool: Tool = {
  name: 'getWorkflowRun',
  description: 'Get detailed information about a single workflow run.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'actions', 'workflow', 'run', 'get', 'details', 'ci'],
  example:
    'const run = await github.getWorkflowRun({ owner: "octocat", repo: "hello", run_id: 123456 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      run_id: {
        type: 'number',
        description: 'Workflow run ID. Obtain from listWorkflowRuns.',
      },
    },
    required: ['owner', 'repo', 'run_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'number' },
      name: { type: 'string' },
      status: { type: 'string' },
      conclusion: { type: ['string', 'null'] },
      head_branch: { type: 'string' },
      head_sha: { type: 'string' },
      html_url: { type: 'string' },
      created_at: { type: 'string' },
      updated_at: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: get run details',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 98765 },
    },
    {
      description: 'Partial: get a different run',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 11111 },
    },
    {
      description: 'Full: get a run by numeric ID',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 54321 },
    },
  ],
};

const getRunLogsTool: Tool = {
  name: 'getRunLogs',
  description:
    "Returns a URL to download the run's logs as a ZIP archive (the URL is short-lived). The worker does not fetch or unpack the archive.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'actions', 'workflow', 'run', 'logs', 'download', 'debug'],
  example:
    'const { download_url } = await github.getRunLogs({ owner: "octocat", repo: "hello", run_id: 123456 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      run_id: {
        type: 'number',
        description: 'Workflow run ID. Obtain from listWorkflowRuns.',
      },
    },
    required: ['owner', 'repo', 'run_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      download_url: { type: 'string' },
      note: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: logs URL for a run',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 98765 },
    },
    {
      description: 'Partial: logs URL for another run',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 11111 },
    },
    {
      description: 'Full: logs URL by numeric ID',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 54321 },
    },
  ],
};

const rerunWorkflowTool: Tool = {
  name: 'rerunWorkflow',
  description: 'Re-runs a workflow run.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'actions', 'workflow', 'run', 'rerun', 'retry', 'ci'],
  example: 'await github.rerunWorkflow({ owner: "octocat", repo: "hello", run_id: 123456 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      run_id: {
        type: 'number',
        description: 'Workflow run ID. Obtain from listWorkflowRuns.',
      },
    },
    required: ['owner', 'repo', 'run_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      rerun: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: re-run a workflow run',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 98765 },
    },
    {
      description: 'Partial: re-run another run',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 11111 },
    },
    {
      description: 'Full: re-run by numeric ID',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 54321 },
    },
  ],
};

const triggerWorkflowTool: Tool = {
  name: 'triggerWorkflow',
  description: 'Triggers a workflow_dispatch event for a workflow that supports manual runs.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'actions', 'workflow', 'trigger', 'dispatch', 'run', 'ci'],
  example:
    'await github.triggerWorkflow({ owner: "octocat", repo: "hello", workflow_id: "ci.yml", ref: "main" })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      workflow_id: {
        type: 'string',
        description: "Workflow file name like 'ci.yml' or its numeric ID",
      },
      ref: { type: 'string', description: 'Branch or tag to run on' },
      inputs: { type: 'object', description: 'Inputs for the workflow_dispatch event' },
    },
    required: ['owner', 'repo', 'workflow_id', 'ref'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      triggered: { type: 'boolean' },
      workflow_id: { type: ['string', 'number'] },
      ref: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: trigger ci.yml on main',
      input: { owner: 'octocat', repo: 'hello-world', workflow_id: 'ci.yml', ref: 'main' },
    },
    {
      description: 'Partial: trigger a workflow on a branch',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        workflow_id: 'deploy.yml',
        ref: 'release/1.0',
      },
    },
    {
      description: 'Full: trigger with dispatch inputs',
      input: {
        owner: 'octocat',
        repo: 'hello-world',
        workflow_id: 'deploy.yml',
        ref: 'main',
        inputs: { environment: 'staging' },
      },
    },
  ],
};

const listWorkflowRunArtifactsTool: Tool = {
  name: 'listWorkflowRunArtifacts',
  description: 'List the artifacts produced by a workflow run.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'actions', 'artifacts', 'workflow', 'run', 'list', 'downloads'],
  example:
    'const { artifacts, count } = await github.listWorkflowRunArtifacts({ owner: "octocat", repo: "hello", run_id: 123456 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      run_id: {
        type: 'number',
        description: 'Workflow run ID. Obtain from listWorkflowRuns.',
      },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['owner', 'repo', 'run_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            size_in_bytes: { type: 'number' },
            expired: { type: 'boolean' },
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
      description: 'Minimal: list artifacts for a run',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 98765 },
    },
    {
      description: 'Partial: artifacts for another run',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 11111 },
    },
    {
      description: 'Full: artifacts with a result limit',
      input: { owner: 'octocat', repo: 'hello-world', run_id: 54321, limit: 10 },
    },
  ],
};

const downloadArtifactTool: Tool = {
  name: 'downloadArtifact',
  description:
    'Returns a short-lived URL to download an artifact ZIP. The worker does not fetch the archive.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['github', 'actions', 'artifact', 'download', 'zip', 'url'],
  example:
    'const { download_url } = await github.downloadArtifact({ owner: "octocat", repo: "hello", artifact_id: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
      artifact_id: {
        type: 'number',
        description: 'Artifact ID. Obtain from listWorkflowRunArtifacts.',
      },
    },
    required: ['owner', 'repo', 'artifact_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      download_url: { type: 'string' },
      note: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: download URL for an artifact',
      input: { owner: 'octocat', repo: 'hello-world', artifact_id: 42 },
    },
    {
      description: 'Partial: download URL for another artifact',
      input: { owner: 'octocat', repo: 'hello-world', artifact_id: 100 },
    },
    {
      description: 'Full: download URL by numeric ID',
      input: { owner: 'octocat', repo: 'hello-world', artifact_id: 999 },
    },
  ],
};

/**
 * Builds the GitHub Actions tool definitions for the GitHub worker.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createActionsTools(client: GitHubClient | null): ToolDefinition[] {
  return [
    {
      tool: listWorkflowRunsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...options } = params as {
          owner: string;
          repo: string;
          branch?: string;
          status?: string;
          limit?: number;
        };
        const result = await c.listWorkflowRuns(owner, repo, options);
        return jsonResult({ runs: result.map(runSummary), count: result.length });
      }),
    },
    {
      tool: getWorkflowRunTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, run_id } = params as { owner: string; repo: string; run_id: number };
        const result = await c.getWorkflowRun(owner, repo, run_id);
        return jsonResult(result);
      }),
    },
    {
      tool: getRunLogsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, run_id } = params as { owner: string; repo: string; run_id: number };
        const result = await c.getRunLogs(owner, repo, run_id);
        return jsonResult(result);
      }),
    },
    {
      tool: rerunWorkflowTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, run_id } = params as { owner: string; repo: string; run_id: number };
        const result = await c.rerunWorkflow(owner, repo, run_id);
        return jsonResult(result);
      }),
    },
    {
      tool: triggerWorkflowTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, ...rest } = params as {
          owner: string;
          repo: string;
          workflow_id: string | number;
          ref: string;
          inputs?: Record<string, unknown>;
        };
        const result = await c.triggerWorkflow(owner, repo, rest);
        return jsonResult(result);
      }),
    },
    {
      tool: listWorkflowRunArtifactsTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, run_id, limit } = params as {
          owner: string;
          repo: string;
          run_id: number;
          limit?: number;
        };
        const result = await c.listWorkflowRunArtifacts(owner, repo, run_id, { limit });
        return jsonResult({
          artifacts: result.map((a) => ({
            id: a.id,
            name: a.name,
            size_in_bytes: a.size_in_bytes,
            expired: a.expired,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: downloadArtifactTool,
      handler: withValidation(client, async (c, params) => {
        const { owner, repo, artifact_id } = params as {
          owner: string;
          repo: string;
          artifact_id: number;
        };
        const result = await c.downloadArtifact(owner, repo, artifact_id);
        return jsonResult(result);
      }),
    },
  ];
}

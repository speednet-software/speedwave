/**
 * Comprehensive tests for GitHub API Client
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { GitHubConfig, GitHubClient as GitHubClientType } from './client.js';

// ── Mock functions shared across tests ───────────────────────────────────────
const mockLoadTokenFile = vi.fn();

/** Mutable holder so each test can swap the Octokit instance the mocked constructor returns. */
const octokitHolder: { instance: Record<string, unknown> | null } = { instance: null };
/** Records the options passed to `new Octokit(...)` so tests can assert on auth/throttle wiring. */
const mockOctokitConstructor = vi.fn();

// Mock @octokit/rest — Octokit.plugin(...) returns a class whose instances delegate to octokitHolder.
vi.mock('@octokit/rest', () => {
  class MockOctokit {
    constructor(opts: unknown) {
      mockOctokitConstructor(opts);
      if (octokitHolder.instance) {
        Object.assign(this, octokitHolder.instance);
      }
    }
    static plugin() {
      return MockOctokit;
    }
  }
  return { Octokit: MockOctokit };
});
vi.mock('@octokit/plugin-throttling', () => ({ throttling: {} }));
vi.mock('@octokit/plugin-retry', () => ({ retry: {} }));

// Mock shared module — keep real exports, override loadTokenFile + ts.
vi.mock('@speedwave/mcp-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@speedwave/mcp-shared')>();
  return {
    ...actual,
    loadTokenFile: mockLoadTokenFile,
    ts: () => '[00:00:00]',
  };
});

// Import helpers after mocks are set up (dynamic import avoids hoisting conflict)
const { withSetupGuidance } = await import('@speedwave/mcp-shared');

/** Builds a fresh mock Octokit instance with all REST namespaces used by GitHubClient. */
function buildMockOctokit(): {
  rest: {
    users: { getAuthenticated: Mock };
    repos: {
      get: Mock;
      listForAuthenticatedUser: Mock;
      listBranches: Mock;
      getBranch: Mock;
      listCommits: Mock;
      getCommit: Mock;
      compareCommitsWithBasehead: Mock;
      getContent: Mock;
      createOrUpdateFileContents: Mock;
      createRelease: Mock;
    };
    pulls: {
      list: Mock;
      get: Mock;
      create: Mock;
      merge: Mock;
      update: Mock;
      listFiles: Mock;
      listCommits: Mock;
      listReviews: Mock;
      createReview: Mock;
      createReviewComment: Mock;
    };
    issues: {
      listForRepo: Mock;
      get: Mock;
      create: Mock;
      update: Mock;
      listComments: Mock;
      createComment: Mock;
      listLabelsForRepo: Mock;
      createLabel: Mock;
    };
    git: { createRef: Mock; deleteRef: Mock; getTree: Mock; createTag: Mock };
    actions: {
      listWorkflowRunsForRepo: Mock;
      getWorkflowRun: Mock;
      downloadWorkflowRunLogs: Mock;
      reRunWorkflow: Mock;
      createWorkflowDispatch: Mock;
      listWorkflowRunArtifacts: Mock;
      downloadArtifact: Mock;
    };
    search: { repos: Mock; code: Mock; commits: Mock };
  };
  paginate: Mock;
} {
  return {
    rest: {
      users: { getAuthenticated: vi.fn() },
      repos: {
        get: vi.fn(),
        listForAuthenticatedUser: vi.fn(),
        listBranches: vi.fn(),
        getBranch: vi.fn(),
        listCommits: vi.fn(),
        getCommit: vi.fn(),
        compareCommitsWithBasehead: vi.fn(),
        getContent: vi.fn(),
        createOrUpdateFileContents: vi.fn(),
        createRelease: vi.fn(),
      },
      pulls: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        merge: vi.fn(),
        update: vi.fn(),
        listFiles: vi.fn(),
        listCommits: vi.fn(),
        listReviews: vi.fn(),
        createReview: vi.fn(),
        createReviewComment: vi.fn(),
      },
      issues: {
        listForRepo: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        listComments: vi.fn(),
        createComment: vi.fn(),
        listLabelsForRepo: vi.fn(),
        createLabel: vi.fn(),
      },
      git: { createRef: vi.fn(), deleteRef: vi.fn(), getTree: vi.fn(), createTag: vi.fn() },
      actions: {
        listWorkflowRunsForRepo: vi.fn(),
        getWorkflowRun: vi.fn(),
        downloadWorkflowRunLogs: vi.fn(),
        reRunWorkflow: vi.fn(),
        createWorkflowDispatch: vi.fn(),
        listWorkflowRunArtifacts: vi.fn(),
        downloadArtifact: vi.fn(),
      },
      search: { repos: vi.fn(), code: vi.fn(), commits: vi.fn() },
    },
    paginate: vi.fn(),
  };
}

type MockOctokit = ReturnType<typeof buildMockOctokit>;

describe('GitHubClient', () => {
  let GitHubClientClass: typeof GitHubClientType;
  let client: InstanceType<typeof GitHubClientType>;
  let octokit: MockOctokit;
  let config: GitHubConfig;
  let isExpectedError: typeof import('./client.js').isExpectedError;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    octokit = buildMockOctokit();
    octokitHolder.instance = octokit as unknown as Record<string, unknown>;

    config = { token: 'test-token' };

    const module = await import('./client.js');
    GitHubClientClass = module.GitHubClient;
    isExpectedError = module.isExpectedError;
    client = new GitHubClientClass(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── constructor ────────────────────────────────────────────────────────────
  describe('constructor', () => {
    it('creates an Octokit instance with the provided auth token', () => {
      expect(mockOctokitConstructor).toHaveBeenCalled();
      const opts = mockOctokitConstructor.mock.calls[0][0] as { auth: string; throttle: unknown };
      expect(opts.auth).toBe('test-token');
      expect(opts.throttle).toBeDefined();
    });

    it('passes baseUrl through when provided', async () => {
      mockOctokitConstructor.mockClear();
      new GitHubClientClass({ token: 't', baseUrl: 'https://ghe.example.com/api/v3' });
      const opts = mockOctokitConstructor.mock.calls[0][0] as { baseUrl?: string };
      expect(opts.baseUrl).toBe('https://ghe.example.com/api/v3');
    });

    it('rejects an empty or whitespace-only token', () => {
      expect(() => new GitHubClientClass({ token: '' })).toThrow('non-empty authentication token');
      expect(() => new GitHubClientClass({ token: '   ' })).toThrow(
        'non-empty authentication token'
      );
    });

    it('throttle.onRateLimit warns and retries up to twice', () => {
      const opts = mockOctokitConstructor.mock.calls[0][0] as {
        throttle: {
          onRateLimit: (a: number, b: unknown, c: unknown, d: number) => boolean;
          onSecondaryRateLimit: (a: number, b: unknown, c: unknown, d: number) => boolean;
        };
      };
      const optionsArg = { method: 'GET', url: '/repos' };
      expect(opts.throttle.onRateLimit(1, optionsArg, {}, 0)).toBe(true);
      expect(opts.throttle.onRateLimit(1, optionsArg, {}, 2)).toBe(false);
      expect(opts.throttle.onSecondaryRateLimit(1, optionsArg, {}, 0)).toBe(true);
      expect(opts.throttle.onSecondaryRateLimit(1, optionsArg, {}, 5)).toBe(false);
      expect(console.warn).toHaveBeenCalled();
    });
  });

  // ── formatError ────────────────────────────────────────────────────────────
  describe('formatError', () => {
    it('formats 401 with authentication guidance', () => {
      const msg = GitHubClientClass.formatError({ status: 401 });
      expect(msg).toBe(withSetupGuidance('Authentication failed. Check your GitHub token.'));
    });

    it('formats "Bad credentials" message as auth error', () => {
      const msg = GitHubClientClass.formatError({ message: 'Bad credentials' });
      expect(msg).toContain('Authentication failed');
    });

    it('formats 403 with x-ratelimit-remaining 0 as rate limit', () => {
      const msg = GitHubClientClass.formatError({
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
      expect(msg).toBe('GitHub API rate limit exceeded. Try again later.');
    });

    it('formats 403 without rate-limit header as permission error', () => {
      const msg = GitHubClientClass.formatError({ status: 403 });
      expect(msg).toContain('Permission denied');
      // Generic post-OAuth-cutover message: mentions both reconnect (OAuth) and PAT.
      expect(msg).toContain('reconnect');
      expect(msg).toContain('PAT');
    });

    it('formats 403 with remaining > 0 as permission error', () => {
      const msg = GitHubClientClass.formatError({
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '42' } },
      });
      expect(msg).toContain('Permission denied');
    });

    it('formats 404', () => {
      const msg = GitHubClientClass.formatError({ status: 404 });
      expect(msg).toBe(
        'Resource not found in GitHub. Check the owner/repo and that your token has access.'
      );
    });

    it('formats 422 validation error with the message', () => {
      const msg = GitHubClientClass.formatError({
        status: 422,
        message: 'Reference already exists',
      });
      expect(msg).toBe('GitHub validation error: Reference already exists');
    });

    it('formats 422 without a message', () => {
      const msg = GitHubClientClass.formatError({ status: 422 });
      expect(msg).toBe('GitHub validation error: invalid request');
    });

    it('formats 500', () => {
      expect(GitHubClientClass.formatError({ status: 500 })).toBe(
        'GitHub server error. Please try again later.'
      );
    });

    it('formats 502', () => {
      expect(GitHubClientClass.formatError({ status: 502 })).toBe(
        'GitHub bad gateway. The server may be overloaded.'
      );
    });

    it('formats 503', () => {
      expect(GitHubClientClass.formatError({ status: 503 })).toBe(
        'GitHub service unavailable. The server is temporarily down.'
      );
    });

    it('formats 504', () => {
      expect(GitHubClientClass.formatError({ status: 504 })).toBe(
        'GitHub gateway timeout. The request took too long.'
      );
    });

    it('formats other 5xx with generic message', () => {
      expect(GitHubClientClass.formatError({ status: 599 })).toBe(
        'GitHub server error (599). Please try again later.'
      );
    });

    it('formats getaddrinfo network errors', () => {
      const msg = GitHubClientClass.formatError({
        message: 'getaddrinfo ENOTFOUND api.github.com',
      });
      expect(msg).toBe(withSetupGuidance('Network error reaching GitHub.'));
    });

    it('formats ECONNREFUSED network errors', () => {
      const msg = GitHubClientClass.formatError({ message: 'connect ECONNREFUSED 140.82.0.1:443' });
      expect(msg).toContain('Network error');
    });

    it('formats ETIMEDOUT network errors', () => {
      const msg = GitHubClientClass.formatError({ message: 'connect ETIMEDOUT' });
      expect(msg).toContain('Network error');
    });

    it('formats "network timeout" phrasing', () => {
      const msg = GitHubClientClass.formatError({
        message: 'network timeout at: https://api.github.com',
      });
      expect(msg).toContain('Network error');
    });

    it('falls back to error.message', () => {
      expect(GitHubClientClass.formatError({ message: 'something odd' })).toBe('something odd');
    });

    it('falls back to a generic message when nothing matches', () => {
      expect(GitHubClientClass.formatError({})).toBe('GitHub API error');
    });

    it('handles null/undefined error', () => {
      expect(GitHubClientClass.formatError(null)).toBe('GitHub API error');
      expect(GitHubClientClass.formatError(undefined)).toBe('GitHub API error');
    });
  });

  // ── testConnection ─────────────────────────────────────────────────────────
  describe('testConnection', () => {
    it('returns success when getAuthenticated resolves', async () => {
      octokit.rest.users.getAuthenticated.mockResolvedValue({ data: { login: 'octocat' } });
      const result = await client.testConnection();
      expect(result).toEqual({ success: true });
    });

    it('categorizes 401 as auth', async () => {
      octokit.rest.users.getAuthenticated.mockRejectedValue({
        status: 401,
        message: 'Bad credentials',
      });
      const result = await client.testConnection();
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('auth');
      expect(result.error).toContain('Authentication failed');
    });

    it('categorizes 403 as permission', async () => {
      octokit.rest.users.getAuthenticated.mockRejectedValue({ status: 403 });
      const result = await client.testConnection();
      expect(result.errorType).toBe('permission');
    });

    it('categorizes 404 as not_found', async () => {
      octokit.rest.users.getAuthenticated.mockRejectedValue({ status: 404 });
      const result = await client.testConnection();
      expect(result.errorType).toBe('not_found');
    });

    it('categorizes network errors as network', async () => {
      octokit.rest.users.getAuthenticated.mockRejectedValue({
        message: 'getaddrinfo ENOTFOUND api.github.com',
      });
      const result = await client.testConnection();
      expect(result.errorType).toBe('network');
    });

    it('categorizes everything else as unknown', async () => {
      octokit.rest.users.getAuthenticated.mockRejectedValue({ message: 'weird' });
      const result = await client.testConnection();
      expect(result.errorType).toBe('unknown');
    });

    it('folds a 5xx (server) error into errorType "unknown"', async () => {
      octokit.rest.users.getAuthenticated.mockRejectedValue({ status: 503 });
      const result = await client.testConnection();
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('unknown');
      expect(result.error).toContain('service unavailable');
    });

    it('folds a 422 (validation) error into errorType "unknown"', async () => {
      octokit.rest.users.getAuthenticated.mockRejectedValue({ status: 422, message: 'bad' });
      const result = await client.testConnection();
      expect(result.errorType).toBe('unknown');
    });
  });

  // ── users ──────────────────────────────────────────────────────────────────
  describe('getCurrentUser', () => {
    it('returns the normalized authenticated user', async () => {
      octokit.rest.users.getAuthenticated.mockResolvedValue({
        data: { login: 'octocat', name: 'The Octocat', email: 'octocat@github.com', html_url: 'h' },
      });
      const user = await client.getCurrentUser();
      expect(user).toEqual({
        login: 'octocat',
        name: 'The Octocat',
        email: 'octocat@github.com',
        html_url: 'h',
      });
    });

    it('omits name/email when absent', async () => {
      octokit.rest.users.getAuthenticated.mockResolvedValue({
        data: { login: 'octocat', html_url: 'h' },
      });
      const user = await client.getCurrentUser();
      expect(user).toEqual({ login: 'octocat', name: undefined, email: undefined, html_url: 'h' });
    });

    it('propagates an authentication failure', async () => {
      octokit.rest.users.getAuthenticated.mockRejectedValue({
        status: 401,
        message: 'Bad credentials',
      });
      await expect(client.getCurrentUser()).rejects.toMatchObject({ status: 401 });
    });
  });

  // ── repos ──────────────────────────────────────────────────────────────────
  describe('listRepos', () => {
    it('lists the authenticated user repos via paginate', async () => {
      octokit.paginate.mockResolvedValue([
        {
          id: 1,
          name: 'a',
          full_name: 'me/a',
          owner: { login: 'me' },
          html_url: 'u',
          default_branch: 'main',
          private: false,
        },
      ]);
      const repos = await client.listRepos();
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.repos.listForAuthenticatedUser,
        expect.objectContaining({ per_page: 100 }),
        expect.any(Function)
      );
      expect(repos).toEqual([
        {
          id: 1,
          name: 'a',
          full_name: 'me/a',
          owner: { login: 'me' },
          description: undefined,
          html_url: 'u',
          default_branch: 'main',
          private: false,
        },
      ]);
    });

    it('uses search.repos when a search term is given and respects limit', async () => {
      octokit.rest.search.repos.mockResolvedValue({
        data: {
          items: [
            {
              id: 2,
              name: 'b',
              full_name: 'x/b',
              owner: { login: 'x' },
              html_url: 'u',
              default_branch: 'main',
              private: true,
            },
            {
              id: 3,
              name: 'c',
              full_name: 'x/c',
              owner: { login: 'x' },
              html_url: 'u',
              default_branch: 'main',
              private: true,
            },
          ],
        },
      });
      const repos = await client.listRepos({ search: 'topic:speedwave', limit: 1 });
      expect(octokit.rest.search.repos).toHaveBeenCalledWith({ q: 'topic:speedwave', per_page: 1 });
      expect(repos).toHaveLength(1);
      expect(repos[0].full_name).toBe('x/b');
    });

    it('passes affiliation through', async () => {
      octokit.paginate.mockResolvedValue([]);
      await client.listRepos({ affiliation: 'owner' });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.repos.listForAuthenticatedUser,
        expect.objectContaining({ affiliation: 'owner' }),
        expect.any(Function)
      );
    });

    it('treats a negative limit as the default (no cap), not a floor of 1', async () => {
      octokit.paginate.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      const repos = await client.listRepos({ limit: -5 });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.repos.listForAuthenticatedUser,
        expect.objectContaining({ per_page: 100 }),
        expect.any(Function)
      );
      expect(repos).toHaveLength(2);
    });

    it('caps per_page at the GitHub maximum of 100 for an oversized limit', async () => {
      octokit.paginate.mockResolvedValue([{ id: 1 }]);
      await client.listRepos({ limit: 999999 });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.repos.listForAuthenticatedUser,
        expect.objectContaining({ per_page: 100 }),
        expect.any(Function)
      );
    });

    it('honors a limit above 100 by returning that many items (per_page still capped)', async () => {
      octokit.paginate.mockResolvedValue(Array.from({ length: 150 }, (_, i) => ({ id: i + 1 })));
      const repos = await client.listRepos({ limit: 120 });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.repos.listForAuthenticatedUser,
        expect.objectContaining({ per_page: 100 }),
        expect.any(Function)
      );
      expect(repos).toHaveLength(120);
    });

    it('falls back to the default 100 when limit is 0', async () => {
      octokit.paginate.mockResolvedValue(Array.from({ length: 130 }, (_, i) => ({ id: i + 1 })));
      const repos = await client.listRepos({ limit: 0 });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.repos.listForAuthenticatedUser,
        expect.objectContaining({ per_page: 100 }),
        expect.any(Function)
      );
      expect(repos).toHaveLength(100);
    });

    it('stops fetching pages via done() once the limit is reached', async () => {
      const page = (start: number) => Array.from({ length: 100 }, (_, i) => ({ id: start + i }));
      const pages = [page(1), page(101), page(201), page(301)];
      let pagesFetched = 0;
      octokit.paginate.mockImplementation(
        async (
          _route: unknown,
          _params: unknown,
          mapFn: (r: { data: unknown }, done: () => void) => unknown[]
        ) => {
          const collected: unknown[] = [];
          let stop = false;
          const done = (): void => {
            stop = true;
          };
          for (const p of pages) {
            pagesFetched++;
            collected.push(...mapFn({ data: p }, done));
            if (stop) break;
          }
          return collected;
        }
      );

      const repos = await client.listRepos({ limit: 120 });

      expect(repos).toHaveLength(120);
      // per_page is 100, so 120 items are reached after the 2nd page; the 3rd/4th are never fetched.
      expect(pagesFetched).toBe(2);
    });
  });

  describe('getRepo', () => {
    it('returns a normalized repo', async () => {
      octokit.rest.repos.get.mockResolvedValue({
        data: {
          id: 9,
          name: 'r',
          full_name: 'o/r',
          owner: { login: 'o' },
          description: 'd',
          html_url: 'h',
          default_branch: 'main',
          private: false,
        },
      });
      const repo = await client.getRepo('o', 'r');
      expect(octokit.rest.repos.get).toHaveBeenCalledWith({ owner: 'o', repo: 'r' });
      expect(repo).toEqual({
        id: 9,
        name: 'r',
        full_name: 'o/r',
        owner: { login: 'o' },
        description: 'd',
        html_url: 'h',
        default_branch: 'main',
        private: false,
      });
    });

    it('throws when owner is missing', async () => {
      await expect(client.getRepo('', 'r')).rejects.toThrow('Missing required parameter');
    });
  });

  describe('searchCode', () => {
    it('scopes the query to a repo when owner+repo given', async () => {
      octokit.rest.search.code.mockResolvedValue({
        data: { items: [{ path: 'src/a.ts', repository: { full_name: 'o/r' }, html_url: 'h' }] },
      });
      const results = await client.searchCode('addr', { owner: 'o', repo: 'r' });
      expect(octokit.rest.search.code).toHaveBeenCalledWith({ q: 'repo:o/r addr', per_page: 100 });
      expect(results).toEqual([{ path: 'src/a.ts', repository: 'o/r', html_url: 'h' }]);
    });

    it('searches globally without owner/repo', async () => {
      octokit.rest.search.code.mockResolvedValue({ data: { items: [] } });
      await client.searchCode('foo');
      expect(octokit.rest.search.code).toHaveBeenCalledWith({ q: 'foo', per_page: 100 });
    });

    it('throws when query is empty', async () => {
      await expect(client.searchCode('')).rejects.toThrow('Missing required parameter');
    });
  });

  // ── pull requests ──────────────────────────────────────────────────────────
  describe('listPullRequests', () => {
    it('lists PRs via paginate with defaults', async () => {
      octokit.paginate.mockResolvedValue([
        {
          number: 1,
          title: 't',
          state: 'open',
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main' },
          user: { login: 'me' },
          html_url: 'h',
          created_at: 'c',
          updated_at: 'u',
        },
      ]);
      const prs = await client.listPullRequests('o', 'r');
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.pulls.list,
        expect.objectContaining({ owner: 'o', repo: 'r', state: 'open', per_page: 100 }),
        expect.any(Function)
      );
      expect(prs[0]).toMatchObject({
        number: 1,
        head: { ref: 'feature', sha: 'abc' },
        base: { ref: 'main' },
      });
    });

    it('passes state/head/base/limit through', async () => {
      octokit.paginate.mockResolvedValue([]);
      await client.listPullRequests('o', 'r', {
        state: 'all',
        head: 'me:f',
        base: 'main',
        limit: 5,
      });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.pulls.list,
        expect.objectContaining({ state: 'all', head: 'me:f', base: 'main', per_page: 5 }),
        expect.any(Function)
      );
    });
  });

  describe('getPullRequest', () => {
    it('maps draft and merged flags', async () => {
      octokit.rest.pulls.get.mockResolvedValue({
        data: {
          number: 7,
          title: 't',
          body: 'b',
          state: 'closed',
          merged: true,
          draft: false,
          head: { ref: 'f', sha: 's' },
          base: { ref: 'main' },
          user: { login: 'u' },
          html_url: 'h',
          created_at: 'c',
          updated_at: 'd',
        },
      });
      const pr = await client.getPullRequest('o', 'r', 7);
      expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        pull_number: 7,
      });
      expect(pr).toMatchObject({ number: 7, state: 'closed', merged: true, draft: false });
    });

    it('throws a teaching 404 naming the PR number and source tools', async () => {
      octokit.rest.pulls.get.mockRejectedValue({ status: 404 });
      await expect(client.getPullRequest('o', 'r', 999)).rejects.toThrow(
        'PR #999 not found in o/r. Check the number with listPullRequests, or the owner/repo with getRepo, or your token may lack access.'
      );
    });

    it('rethrows a non-404 error unchanged and unmarked', async () => {
      const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 });
      octokit.rest.pulls.get.mockRejectedValue(serverError);
      await expect(client.getPullRequest('o', 'r', 7)).rejects.toThrow(serverError);
      await client.getPullRequest('o', 'r', 7).catch((error) => {
        expect(isExpectedError(error)).toBe(false);
      });
    });
  });

  describe('createPullRequest', () => {
    it('creates a PR', async () => {
      octokit.rest.pulls.create.mockResolvedValue({
        data: {
          number: 11,
          title: 'New',
          state: 'open',
          head: { ref: 'f', sha: 's' },
          base: { ref: 'main' },
          user: { login: 'u' },
          html_url: 'h',
          created_at: 'c',
          updated_at: 'd',
        },
      });
      const pr = await client.createPullRequest('o', 'r', {
        title: 'New',
        head: 'f',
        base: 'main',
        body: 'b',
        draft: true,
      });
      expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'o',
          repo: 'r',
          title: 'New',
          head: 'f',
          base: 'main',
          body: 'b',
          draft: true,
        })
      );
      expect(pr.number).toBe(11);
    });

    it('throws when required params are missing', async () => {
      await expect(
        client.createPullRequest('o', 'r', { title: '', head: 'f', base: 'main' })
      ).rejects.toThrow('Missing required parameter');
    });
  });

  describe('mergePullRequest', () => {
    it('merges with the default method', async () => {
      octokit.rest.pulls.merge.mockResolvedValue({
        data: { merged: true, sha: 'm', message: 'Merged' },
      });
      const result = await client.mergePullRequest('o', 'r', 3);
      expect(octokit.rest.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'o', repo: 'r', pull_number: 3, merge_method: 'merge' })
      );
      expect(result).toEqual({ merged: true, sha: 'm', message: 'Merged' });
    });

    it('honors merge_method and commit_title', async () => {
      octokit.rest.pulls.merge.mockResolvedValue({
        data: { merged: true, sha: 'm', message: 'ok' },
      });
      await client.mergePullRequest('o', 'r', 3, { merge_method: 'squash', commit_title: 'CT' });
      expect(octokit.rest.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({ merge_method: 'squash', commit_title: 'CT' })
      );
    });
  });

  describe('updatePullRequest', () => {
    it('updates fields', async () => {
      octokit.rest.pulls.update.mockResolvedValue({
        data: {
          number: 4,
          title: 'Renamed',
          state: 'closed',
          head: { ref: 'f', sha: 's' },
          base: { ref: 'dev' },
          user: { login: 'u' },
          html_url: 'h',
          created_at: 'c',
          updated_at: 'd',
        },
      });
      const pr = await client.updatePullRequest('o', 'r', 4, {
        title: 'Renamed',
        state: 'closed',
        base: 'dev',
      });
      expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 4, title: 'Renamed', state: 'closed', base: 'dev' })
      );
      expect(pr).toMatchObject({ number: 4, state: 'closed', base: { ref: 'dev' } });
    });
  });

  describe('getPrDiff', () => {
    it('requests the diff media type and returns a string', async () => {
      octokit.rest.pulls.get.mockResolvedValue({ data: 'diff --git a/x b/x' });
      const diff = await client.getPrDiff('o', 'r', 2);
      expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        pull_number: 2,
        mediaType: { format: 'diff' },
      });
      expect(diff).toBe('diff --git a/x b/x');
    });

    it('decodes a Buffer response body to a UTF-8 string', async () => {
      octokit.rest.pulls.get.mockResolvedValue({ data: Buffer.from('diff text', 'utf-8') });
      const diff = await client.getPrDiff('o', 'r', 2);
      expect(diff).toBe('diff text');
    });

    it('decodes an ArrayBuffer response body to a UTF-8 string', async () => {
      octokit.rest.pulls.get.mockResolvedValue({ data: new TextEncoder().encode('hunk').buffer });
      const diff = await client.getPrDiff('o', 'r', 2);
      expect(diff).toBe('hunk');
    });

    it('decodes a typed-array response body to a UTF-8 string', async () => {
      octokit.rest.pulls.get.mockResolvedValue({ data: new Uint8Array([0x61, 0x62]) });
      const diff = await client.getPrDiff('o', 'r', 2);
      expect(diff).toBe('ab');
    });

    it('stringifies a Buffer-typed response body that is not a TypedArray view', async () => {
      // A real Buffer is also `ArrayBuffer.isView()`; synthesize a Buffer-prototyped object
      // lacking typed-array internal slots to reach the `Buffer.isBuffer` fallback path.
      const bufferLike: Buffer = Object.assign(Object.create(Buffer.prototype) as Buffer, {
        toString: () => 'buffer diff',
      });
      octokit.rest.pulls.get.mockResolvedValue({ data: bufferLike });
      expect(await client.getPrDiff('o', 'r', 2)).toBe('buffer diff');
    });

    it('coerces a non-buffer non-string response body and tolerates nullish data', async () => {
      octokit.rest.pulls.get.mockResolvedValue({ data: 12345 });
      expect(await client.getPrDiff('o', 'r', 2)).toBe('12345');
      octokit.rest.pulls.get.mockResolvedValue({ data: null });
      expect(await client.getPrDiff('o', 'r', 2)).toBe('');
    });
  });

  describe('getPrFiles', () => {
    it('lists changed files with stats', async () => {
      octokit.paginate.mockResolvedValue([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: '@@',
        },
        { filename: 'b.ts', status: 'added', additions: 10, deletions: 0, changes: 10 },
      ]);
      const files = await client.getPrFiles('o', 'r', 5, { limit: 1 });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.pulls.listFiles,
        expect.objectContaining({ pull_number: 5, per_page: 1 }),
        expect.any(Function)
      );
      expect(files).toEqual([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: '@@',
        },
      ]);
    });
  });

  // ── pr review ──────────────────────────────────────────────────────────────
  describe('listPrCommits', () => {
    it('lists PR commits', async () => {
      octokit.paginate.mockResolvedValue([
        {
          sha: 's1',
          commit: { message: 'm', author: { name: 'n', email: 'e', date: 'd' } },
          html_url: 'h',
        },
      ]);
      const commits = await client.listPrCommits('o', 'r', 3);
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.pulls.listCommits,
        expect.objectContaining({ pull_number: 3 }),
        expect.any(Function)
      );
      expect(commits[0]).toEqual({
        sha: 's1',
        commit: { message: 'm', author: { name: 'n', email: 'e', date: 'd' } },
        html_url: 'h',
      });
    });
  });

  describe('listPrReviews', () => {
    it('lists reviews', async () => {
      octokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'rev' },
          state: 'APPROVED',
          body: 'lgtm',
          submitted_at: 's',
          html_url: 'h',
        },
      ]);
      const reviews = await client.listPrReviews('o', 'r', 3);
      expect(reviews[0]).toMatchObject({ id: 1, state: 'APPROVED', user: { login: 'rev' } });
    });
  });

  describe('createPrReview', () => {
    it('creates a review with inline comments', async () => {
      octokit.rest.pulls.createReview.mockResolvedValue({
        data: {
          id: 5,
          user: { login: 'rev' },
          state: 'CHANGES_REQUESTED',
          body: 'pls fix',
          html_url: 'h',
        },
      });
      const review = await client.createPrReview('o', 'r', 3, {
        body: 'pls fix',
        event: 'REQUEST_CHANGES',
        comments: [{ path: 'a.ts', line: 10, body: 'nit' }],
      });
      expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          pull_number: 3,
          event: 'REQUEST_CHANGES',
          comments: [{ path: 'a.ts', line: 10, body: 'nit' }],
        })
      );
      expect(review).toMatchObject({ id: 5, state: 'CHANGES_REQUESTED' });
    });

    it('throws when event is missing', async () => {
      // @ts-expect-error intentionally omitting event to test validation
      await expect(client.createPrReview('o', 'r', 3, {})).rejects.toThrow(
        'Missing required parameter'
      );
    });
  });

  describe('listPrComments', () => {
    it('lists issue-style comments on the PR number', async () => {
      octokit.paginate.mockResolvedValue([
        { id: 1, user: { login: 'u' }, body: 'hi', created_at: 'c', html_url: 'h' },
      ]);
      const comments = await client.listPrComments('o', 'r', 3);
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.issues.listComments,
        expect.objectContaining({ issue_number: 3 }),
        expect.any(Function)
      );
      expect(comments[0]).toEqual({
        id: 1,
        user: { login: 'u' },
        body: 'hi',
        created_at: 'c',
        html_url: 'h',
      });
    });
  });

  describe('createPrComment', () => {
    it('creates an issue-style comment', async () => {
      octokit.rest.issues.createComment.mockResolvedValue({
        data: { id: 2, user: { login: 'u' }, body: 'gj', created_at: 'c', html_url: 'h' },
      });
      const comment = await client.createPrComment('o', 'r', 3, 'gj');
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        issue_number: 3,
        body: 'gj',
      });
      expect(comment.id).toBe(2);
    });

    it('throws when body is empty', async () => {
      await expect(client.createPrComment('o', 'r', 3, '')).rejects.toThrow(
        'Missing required parameter'
      );
    });
  });

  describe('createPrReviewComment', () => {
    it('creates a line-attached review comment', async () => {
      octokit.rest.pulls.createReviewComment.mockResolvedValue({
        data: {
          id: 3,
          user: { login: 'u' },
          body: 'note',
          path: 'a.ts',
          line: 12,
          created_at: 'c',
          html_url: 'h',
        },
      });
      const comment = await client.createPrReviewComment('o', 'r', 3, {
        body: 'note',
        commit_id: 'sha',
        path: 'a.ts',
        line: 12,
      });
      expect(octokit.rest.pulls.createReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({
          pull_number: 3,
          commit_id: 'sha',
          path: 'a.ts',
          line: 12,
          body: 'note',
        })
      );
      expect(comment).toMatchObject({ id: 3, path: 'a.ts', line: 12 });
    });
  });

  // ── branches ───────────────────────────────────────────────────────────────
  describe('listBranches', () => {
    it('lists branches', async () => {
      octokit.paginate.mockResolvedValue([
        { name: 'main', commit: { sha: 'abc' }, protected: true },
      ]);
      const branches = await client.listBranches('o', 'r');
      expect(branches).toEqual([{ name: 'main', commit: { sha: 'abc' }, protected: true }]);
    });
  });

  describe('getBranch', () => {
    it('gets a branch', async () => {
      octokit.rest.repos.getBranch.mockResolvedValue({
        data: { name: 'dev', commit: { sha: 'def' }, protected: false },
      });
      const branch = await client.getBranch('o', 'r', 'dev');
      expect(octokit.rest.repos.getBranch).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        branch: 'dev',
      });
      expect(branch).toEqual({ name: 'dev', commit: { sha: 'def' }, protected: false });
    });

    it('throws a teaching 404 naming the branch and source tools', async () => {
      octokit.rest.repos.getBranch.mockRejectedValue({ status: 404 });
      await expect(client.getBranch('o', 'r', 'ghost')).rejects.toThrow(
        "Branch 'ghost' not found in o/r. Check the name with listBranches, or the owner/repo with getRepo, or your token may lack access."
      );
    });
  });

  describe('createBranch', () => {
    it('creates a branch from an explicit SHA', async () => {
      octokit.rest.git.createRef.mockResolvedValue({ data: {} });
      octokit.rest.repos.getBranch.mockResolvedValue({
        data: { name: 'feat', commit: { sha: 'abc' }, protected: false },
      });
      const branch = await client.createBranch('o', 'r', { branch: 'feat', from_sha: 'abc' });
      expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        ref: 'refs/heads/feat',
        sha: 'abc',
      });
      expect(branch.name).toBe('feat');
    });

    it('throws a teaching 422 when the branch already exists', async () => {
      octokit.rest.git.createRef.mockRejectedValue({
        status: 422,
        message: 'Reference already exists',
      });
      await expect(
        client.createBranch('o', 'r', { branch: 'feat', from_sha: 'abc' })
      ).rejects.toThrow(
        "Could not create branch 'feat' in o/r (it may already exist; check with listBranches): Reference already exists"
      );
    });

    it('resolves from_branch to its head SHA', async () => {
      octokit.rest.repos.getBranch
        .mockResolvedValueOnce({
          data: { name: 'main', commit: { sha: 'baseSHA' }, protected: true },
        })
        .mockResolvedValueOnce({
          data: { name: 'feat', commit: { sha: 'baseSHA' }, protected: false },
        });
      octokit.rest.git.createRef.mockResolvedValue({ data: {} });
      await client.createBranch('o', 'r', { branch: 'feat', from_branch: 'main' });
      expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        ref: 'refs/heads/feat',
        sha: 'baseSHA',
      });
    });

    it('throws when neither from_sha nor from_branch is given', async () => {
      await expect(client.createBranch('o', 'r', { branch: 'feat' })).rejects.toThrow(
        'Missing required parameter: from_sha or from_branch'
      );
    });
  });

  describe('deleteBranch', () => {
    it('deletes a branch ref', async () => {
      octokit.rest.git.deleteRef.mockResolvedValue({});
      const result = await client.deleteBranch('o', 'r', 'old');
      expect(octokit.rest.git.deleteRef).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        ref: 'heads/old',
      });
      expect(result).toEqual({ deleted: true, branch: 'old' });
    });
  });

  describe('compareBranches', () => {
    it('compares two refs', async () => {
      octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
        data: {
          ahead_by: 3,
          behind_by: 1,
          total_commits: 3,
          status: 'ahead',
          commits: [
            {
              sha: 's',
              commit: { message: 'm', author: { name: 'n', email: 'e', date: 'd' } },
              html_url: 'h',
            },
          ],
        },
      });
      const cmp = await client.compareBranches('o', 'r', 'main', 'feat');
      expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        basehead: 'main...feat',
      });
      expect(cmp).toMatchObject({ ahead_by: 3, behind_by: 1, total_commits: 3, status: 'ahead' });
      expect(cmp.commits).toHaveLength(1);
    });
  });

  // ── commits ────────────────────────────────────────────────────────────────
  describe('listCommits', () => {
    it('lists commits with filters', async () => {
      octokit.paginate.mockResolvedValue([
        {
          sha: 's',
          commit: { message: 'm', author: { name: 'n', email: 'e', date: 'd' } },
          html_url: 'h',
        },
      ]);
      const commits = await client.listCommits('o', 'r', {
        sha: 'main',
        path: 'src',
        author: 'me',
        since: 'x',
        until: 'y',
        limit: 10,
      });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.repos.listCommits,
        expect.objectContaining({
          sha: 'main',
          path: 'src',
          author: 'me',
          since: 'x',
          until: 'y',
          per_page: 10,
        }),
        expect.any(Function)
      );
      expect(commits).toHaveLength(1);
    });
  });

  describe('listBranchCommits', () => {
    it('delegates to listCommits with sha=branch', async () => {
      octokit.paginate.mockResolvedValue([]);
      await client.listBranchCommits('o', 'r', 'dev', { limit: 5 });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.repos.listCommits,
        expect.objectContaining({ sha: 'dev', per_page: 5 }),
        expect.any(Function)
      );
    });
  });

  describe('searchCommits', () => {
    it('scopes to a repo and maps results', async () => {
      octokit.rest.search.commits.mockResolvedValue({
        data: {
          items: [
            {
              sha: 's',
              commit: { message: 'fix', author: { name: 'n', email: 'e', date: 'd' } },
              html_url: 'h',
            },
          ],
        },
      });
      const commits = await client.searchCommits('fix', { owner: 'o', repo: 'r', limit: 50 });
      expect(octokit.rest.search.commits).toHaveBeenCalledWith({ q: 'repo:o/r fix', per_page: 50 });
      expect(commits[0].sha).toBe('s');
    });

    it('searches globally without owner/repo', async () => {
      octokit.rest.search.commits.mockResolvedValue({ data: { items: [] } });
      await client.searchCommits('fix');
      expect(octokit.rest.search.commits).toHaveBeenCalledWith({ q: 'fix', per_page: 100 });
    });
  });

  describe('getCommitDiff', () => {
    it('requests the diff media type', async () => {
      octokit.rest.repos.getCommit.mockResolvedValue({ data: 'diff text' });
      const diff = await client.getCommitDiff('o', 'r', 'abc');
      expect(octokit.rest.repos.getCommit).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        ref: 'abc',
        mediaType: { format: 'diff' },
      });
      expect(diff).toBe('diff text');
    });

    it('decodes a Buffer response body to a UTF-8 string', async () => {
      octokit.rest.repos.getCommit.mockResolvedValue({ data: Buffer.from('diff text', 'utf-8') });
      const diff = await client.getCommitDiff('o', 'r', 'abc');
      expect(diff).toBe('diff text');
    });

    it('decodes an ArrayBuffer response body to a UTF-8 string', async () => {
      octokit.rest.repos.getCommit.mockResolvedValue({
        data: new TextEncoder().encode('hunk').buffer,
      });
      const diff = await client.getCommitDiff('o', 'r', 'abc');
      expect(diff).toBe('hunk');
    });

    it('decodes a typed-array response body to a UTF-8 string', async () => {
      octokit.rest.repos.getCommit.mockResolvedValue({ data: new Uint8Array([0x61, 0x62]) });
      const diff = await client.getCommitDiff('o', 'r', 'abc');
      expect(diff).toBe('ab');
    });
  });

  // ── repository content ─────────────────────────────────────────────────────
  describe('getTree', () => {
    it('resolves the default branch when ref omitted and returns tree items', async () => {
      octokit.rest.repos.get.mockResolvedValue({
        data: {
          id: 1,
          name: 'r',
          full_name: 'o/r',
          owner: { login: 'o' },
          html_url: 'h',
          default_branch: 'main',
          private: false,
        },
      });
      octokit.rest.git.getTree.mockResolvedValue({
        data: {
          tree: [
            { path: 'a.ts', mode: '100644', type: 'blob', sha: 's', size: 12 },
            { path: 'dir', mode: '040000', type: 'tree', sha: 't' },
          ],
        },
      });
      const tree = await client.getTree('o', 'r', { recursive: true });
      expect(octokit.rest.git.getTree).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        tree_sha: 'main',
        recursive: '1',
      });
      expect(tree).toEqual([
        { path: 'a.ts', mode: '100644', type: 'blob', sha: 's', size: 12 },
        { path: 'dir', mode: '040000', type: 'tree', sha: 't', size: undefined },
      ]);
    });

    it('uses the provided ref directly', async () => {
      octokit.rest.git.getTree.mockResolvedValue({ data: { tree: [] } });
      await client.getTree('o', 'r', { ref: 'abc123' });
      expect(octokit.rest.git.getTree).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        tree_sha: 'abc123',
        recursive: undefined,
      });
      expect(octokit.rest.repos.get).not.toHaveBeenCalled();
    });

    it('throws a clear error when ref is omitted and the repo has no default branch', async () => {
      // mapRepo normalises a missing default_branch to '' — getTree must not forward that.
      octokit.rest.repos.get.mockResolvedValue({ data: { id: 1 } });
      await expect(client.getTree('o', 'r')).rejects.toThrow('has no default branch');
      expect(octokit.rest.git.getTree).not.toHaveBeenCalled();
    });
  });

  describe('getFileContents', () => {
    it('decodes base64 content to UTF-8 text', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          path: 'README.md',
          content: 'aGVsbG8=',
          encoding: 'base64',
          sha: 'fsha',
          size: 5,
        },
      });
      const file = await client.getFileContents('o', 'r', 'README.md', { ref: 'main' });
      expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        path: 'README.md',
        ref: 'main',
      });
      expect(file).toEqual({
        path: 'README.md',
        content: 'hello',
        encoding: 'utf-8',
        sha: 'fsha',
        size: 5,
      });
    });

    it('throws a teaching 404 naming the path, owner/repo, and source tools', async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 404 });
      await expect(client.getFileContents('o', 'r', 'missing.txt', { ref: 'dev' })).rejects.toThrow(
        "File not found: 'missing.txt' in o/r at ref 'dev'. Check the path with getTree, or the ref with listBranches, or your token may lack access."
      );
    });

    it('throws when the path is a directory (array response)', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({ data: [{ type: 'file', path: 'a' }] });
      await expect(client.getFileContents('o', 'r', 'src')).rejects.toThrow(
        "Path 'src' is a directory, not a file."
      );
    });

    it('throws when the entry is not a file type', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({ data: { type: 'dir', path: 'src' } });
      await expect(client.getFileContents('o', 'r', 'src')).rejects.toThrow(
        "Path 'src' is a directory, not a file."
      );
    });

    it('marks the teaching 404 as an expected error', async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 404 });
      await client.getFileContents('o', 'r', 'missing.txt').catch((error) => {
        expect(isExpectedError(error)).toBe(true);
      });
    });

    it('rethrows a non-404 error unchanged and unmarked', async () => {
      const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 });
      octokit.rest.repos.getContent.mockRejectedValue(serverError);
      await expect(client.getFileContents('o', 'r', 'README.md')).rejects.toThrow(serverError);
      await client.getFileContents('o', 'r', 'README.md').catch((error) => {
        expect(isExpectedError(error)).toBe(false);
      });
    });

    it('returns raw base64 (not UTF-8) for binary content that does not round-trip', async () => {
      // A 1x1 PNG-like byte sequence with bytes invalid as UTF-8.
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8]);
      const base64 = binary.toString('base64');
      octokit.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          path: 'image.png',
          content: base64,
          encoding: 'base64',
          sha: 'imgsha',
          size: binary.length,
        },
      });

      const file = await client.getFileContents('o', 'r', 'image.png');

      expect(file).toEqual({
        path: 'image.png',
        content: base64,
        encoding: 'base64',
        sha: 'imgsha',
        size: binary.length,
      });
      // Round-trip: decoding the returned base64 must reproduce the original bytes exactly.
      expect(Buffer.from(file.content, 'base64').equals(binary)).toBe(true);
    });

    it('teaches an expected error for encoding "none" (1-100 MB) instead of an empty string', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          path: 'big.bin',
          content: '',
          encoding: 'none',
          sha: 's',
          size: 5_000_000,
        },
      });
      await expect(client.getFileContents('o', 'r', 'big.bin')).rejects.toThrow(
        'is 1-100 MB, so GitHub returns no inline content (encoding "none")'
      );
      await client.getFileContents('o', 'r', 'big.bin').catch((error) => {
        expect(isExpectedError(error)).toBe(true);
      });
    });
  });

  describe('createOrUpdateFile', () => {
    it('base64-encodes content and fetches the existing SHA when not provided', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          path: 'a.txt',
          content: 'old',
          encoding: 'base64',
          sha: 'oldsha',
          size: 3,
        },
      });
      octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({
        data: { commit: { sha: 'newsha' }, content: { path: 'a.txt', html_url: 'h' } },
      });
      const result = await client.createOrUpdateFile('o', 'r', {
        path: 'a.txt',
        content: 'new',
        message: 'update',
      });
      expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'a.txt',
          message: 'update',
          content: Buffer.from('new', 'utf-8').toString('base64'),
          sha: 'oldsha',
        })
      );
      expect(result).toEqual({ commit_sha: 'newsha', path: 'a.txt', html_url: 'h' });
    });

    it('ignores a 404 when the file does not exist yet', async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 404 });
      octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({
        data: { commit: { sha: 's' }, content: { path: 'new.txt', html_url: 'h' } },
      });
      const result = await client.createOrUpdateFile('o', 'r', {
        path: 'new.txt',
        content: 'x',
        message: 'create',
      });
      expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ sha: undefined })
      );
      expect(result.commit_sha).toBe('s');
    });

    it('wraps non-404 errors from the SHA lookup as an expected teaching error', async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 403, message: 'forbidden' });
      await expect(
        client.createOrUpdateFile('o', 'r', { path: 'a.txt', content: 'x', message: 'm' })
      ).rejects.toThrow("Could not check whether 'a.txt' already exists in o/r before writing");
      expect(octokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
      // The wrapped error carries the marker (and status) so withValidation never logs it as a bug.
      await client
        .createOrUpdateFile('o', 'r', { path: 'a.txt', content: 'x', message: 'm' })
        .catch((error) => {
          expect(isExpectedError(error)).toBe(true);
        });
    });

    it('teaches a directory target instead of writing over it', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({ data: [{ type: 'file', path: 'dir/a' }] });
      await expect(
        client.createOrUpdateFile('o', 'r', { path: 'dir', content: 'x', message: 'm' })
      ).rejects.toThrow("Path 'dir' is a directory, not a file.");
      expect(octokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('teaches instead of overwriting a symlink target', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: 'symlink', path: 'link', sha: 'linksha', target: '../other' },
      });
      await expect(
        client.createOrUpdateFile('o', 'r', { path: 'link', content: 'x', message: 'm' })
      ).rejects.toThrow("Path 'link' is a directory, not a file.");
      expect(octokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('teaches instead of overwriting a submodule target', async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: 'submodule', path: 'sub', sha: 'subsha' },
      });
      await expect(
        client.createOrUpdateFile('o', 'r', { path: 'sub', content: 'x', message: 'm' })
      ).rejects.toThrow("Path 'sub' is a directory, not a file.");
      expect(octokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('propagates a non-Octokit SHA-lookup error unchanged (no numeric status)', async () => {
      const bug = new TypeError('cannot read property of undefined');
      octokit.rest.repos.getContent.mockRejectedValue(bug);
      await expect(
        client.createOrUpdateFile('o', 'r', { path: 'a.txt', content: 'x', message: 'm' })
      ).rejects.toBe(bug);
      expect(octokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
      await client
        .createOrUpdateFile('o', 'r', { path: 'a.txt', content: 'x', message: 'm' })
        .catch((error) => {
          expect(isExpectedError(error)).toBe(false);
        });
    });

    it('uses the provided SHA without a lookup', async () => {
      octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({
        data: { commit: { sha: 's' }, content: { path: 'a.txt', html_url: 'h' } },
      });
      await client.createOrUpdateFile('o', 'r', {
        path: 'a.txt',
        content: 'x',
        message: 'm',
        sha: 'given',
        branch: 'dev',
      });
      expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
      expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ sha: 'given', branch: 'dev' })
      );
    });
  });

  // ── actions ────────────────────────────────────────────────────────────────
  describe('listWorkflowRuns', () => {
    it('lists workflow runs', async () => {
      octokit.paginate.mockResolvedValue([
        {
          id: 1,
          name: 'CI',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
          head_sha: 's',
          html_url: 'h',
          created_at: 'c',
          updated_at: 'u',
        },
      ]);
      const runs = await client.listWorkflowRuns('o', 'r', {
        branch: 'main',
        status: 'completed',
        limit: 5,
      });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.actions.listWorkflowRunsForRepo,
        expect.objectContaining({ branch: 'main', status: 'completed', per_page: 5 }),
        expect.any(Function)
      );
      expect(runs[0]).toMatchObject({ id: 1, conclusion: 'success' });
    });

    it('maps null conclusion for unfinished runs', async () => {
      octokit.paginate.mockResolvedValue([
        {
          id: 2,
          status: 'in_progress',
          conclusion: null,
          head_branch: 'main',
          head_sha: 's',
          html_url: 'h',
          created_at: 'c',
          updated_at: 'u',
        },
      ]);
      const runs = await client.listWorkflowRuns('o', 'r');
      expect(runs[0].conclusion).toBeNull();
    });
  });

  describe('getWorkflowRun', () => {
    it('returns a normalized run', async () => {
      octokit.rest.actions.getWorkflowRun.mockResolvedValue({
        data: {
          id: 9,
          status: 'completed',
          conclusion: 'failure',
          head_branch: 'b',
          head_sha: 's',
          html_url: 'h',
          created_at: 'c',
          updated_at: 'u',
        },
      });
      const run = await client.getWorkflowRun('o', 'r', 9);
      expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        run_id: 9,
      });
      expect(run).toMatchObject({ id: 9, conclusion: 'failure' });
    });
  });

  describe('getRunLogs', () => {
    it('returns the redirect URL and a note', async () => {
      octokit.rest.actions.downloadWorkflowRunLogs.mockResolvedValue({
        headers: { location: 'https://logs.example/zip' },
      });
      const result = await client.getRunLogs('o', 'r', 7);
      expect(octokit.rest.actions.downloadWorkflowRunLogs).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        run_id: 7,
        request: { redirect: 'manual' },
      });
      expect(result.download_url).toBe('https://logs.example/zip');
      expect(result.note).toContain('ZIP archive');
    });

    it('falls back to res.url when the Location header is absent', async () => {
      octokit.rest.actions.downloadWorkflowRunLogs.mockResolvedValue({
        url: 'https://fallback.example/zip',
      });
      const result = await client.getRunLogs('o', 'r', 7);
      expect(result.download_url).toBe('https://fallback.example/zip');
      expect(result.note).toContain('ZIP archive');
    });
  });

  describe('rerunWorkflow', () => {
    it('re-runs the workflow', async () => {
      octokit.rest.actions.reRunWorkflow.mockResolvedValue({});
      const result = await client.rerunWorkflow('o', 'r', 7);
      expect(octokit.rest.actions.reRunWorkflow).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        run_id: 7,
      });
      expect(result).toEqual({ rerun: true });
    });
  });

  describe('triggerWorkflow', () => {
    it('dispatches the workflow', async () => {
      octokit.rest.actions.createWorkflowDispatch.mockResolvedValue({});
      const result = await client.triggerWorkflow('o', 'r', {
        workflow_id: 'ci.yml',
        ref: 'main',
        inputs: { env: 'prod' },
      });
      expect(octokit.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ workflow_id: 'ci.yml', ref: 'main', inputs: { env: 'prod' } })
      );
      expect(result).toEqual({ triggered: true, workflow_id: 'ci.yml', ref: 'main' });
    });

    it('throws when ref is missing', async () => {
      // @ts-expect-error intentionally omitting ref to test validation
      await expect(client.triggerWorkflow('o', 'r', { workflow_id: 'ci.yml' })).rejects.toThrow(
        'Missing required parameter'
      );
    });
  });

  describe('listWorkflowRunArtifacts', () => {
    it('lists artifacts', async () => {
      octokit.paginate.mockResolvedValue([
        {
          id: 1,
          name: 'dist',
          size_in_bytes: 1024,
          archive_download_url: 'https://pipelines.actions.githubusercontent.com/abc/dist.zip',
          expired: false,
        },
      ]);
      const artifacts = await client.listWorkflowRunArtifacts('o', 'r', 7, { limit: 1 });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.actions.listWorkflowRunArtifacts,
        expect.objectContaining({ run_id: 7, per_page: 1 }),
        expect.any(Function)
      );
      expect(artifacts).toEqual([
        {
          id: 1,
          name: 'dist',
          size_in_bytes: 1024,
          archive_download_url: 'https://pipelines.actions.githubusercontent.com/abc/dist.zip',
          expired: false,
        },
      ]);
    });

    it('drops a non-HTTPS archive_download_url (SSRF guard)', async () => {
      octokit.paginate.mockResolvedValue([
        {
          id: 2,
          name: 'evil',
          size_in_bytes: 1,
          archive_download_url: 'file:///etc/passwd',
          expired: false,
        },
        {
          id: 3,
          name: 'meta',
          size_in_bytes: 1,
          archive_download_url: 'http://169.254.169.254/latest/meta-data',
          expired: false,
        },
        {
          id: 4,
          name: 'junk',
          size_in_bytes: 1,
          archive_download_url: 'not a url',
          expired: false,
        },
      ]);
      const artifacts = await client.listWorkflowRunArtifacts('o', 'r', 7);
      expect(artifacts.map((a) => a.archive_download_url)).toEqual(['', '', '']);
    });
  });

  describe('downloadArtifact', () => {
    it('returns the redirect URL and a note', async () => {
      octokit.rest.actions.downloadArtifact.mockResolvedValue({
        headers: { location: 'https://artifacts.example/zip' },
      });
      const result = await client.downloadArtifact('o', 'r', 42);
      expect(octokit.rest.actions.downloadArtifact).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        artifact_id: 42,
        archive_format: 'zip',
        request: { redirect: 'manual' },
      });
      expect(result.download_url).toBe('https://artifacts.example/zip');
      expect(result.note).toContain('ZIP archive');
    });

    it('falls back to res.url when the Location header is absent', async () => {
      octokit.rest.actions.downloadArtifact.mockResolvedValue({
        url: 'https://fallback.example/zip',
      });
      const result = await client.downloadArtifact('o', 'r', 42);
      expect(result.download_url).toBe('https://fallback.example/zip');
      expect(result.note).toContain('ZIP archive');
    });
  });

  // ── issues ─────────────────────────────────────────────────────────────────
  describe('listIssues', () => {
    it('filters out pull requests', async () => {
      octokit.paginate.mockResolvedValue([
        {
          number: 1,
          title: 'bug',
          state: 'open',
          user: { login: 'u' },
          labels: [{ name: 'bug' }],
          assignees: [],
          html_url: 'h',
          created_at: 'c',
          updated_at: 'u',
        },
        {
          number: 2,
          title: 'a PR',
          state: 'open',
          user: { login: 'u' },
          labels: [],
          assignees: [],
          html_url: 'h',
          created_at: 'c',
          updated_at: 'u',
          pull_request: { url: 'x' },
        },
      ]);
      const issues = await client.listIssues('o', 'r');
      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(1);
    });

    it('passes filters through', async () => {
      octokit.paginate.mockResolvedValue([]);
      await client.listIssues('o', 'r', {
        state: 'closed',
        labels: 'bug,p1',
        assignee: 'me',
        creator: 'them',
        limit: 5,
      });
      expect(octokit.paginate).toHaveBeenCalledWith(
        octokit.rest.issues.listForRepo,
        expect.objectContaining({
          state: 'closed',
          labels: 'bug,p1',
          assignee: 'me',
          creator: 'them',
          per_page: 5,
        }),
        expect.any(Function)
      );
    });

    it('stops paginating once enough non-PR issues are collected, mixed PR pages included', async () => {
      const page1 = [
        { number: 1, title: 'bug', state: 'open', user: {}, labels: [], assignees: [] },
        { number: 2, title: 'pr', state: 'open', user: {}, labels: [], pull_request: { url: 'x' } },
      ];
      const page2 = [
        { number: 3, title: 'feature', state: 'open', user: {}, labels: [], assignees: [] },
      ];
      const pages = [page1, page2];
      let pagesFetched = 0;
      octokit.paginate.mockImplementation(
        async (
          _route: unknown,
          _params: unknown,
          mapFn: (r: { data: unknown }, done: () => void) => unknown[]
        ) => {
          const collected: unknown[] = [];
          let stop = false;
          const done = (): void => {
            stop = true;
          };
          for (const p of pages) {
            pagesFetched++;
            collected.push(...mapFn({ data: p }, done));
            if (stop) break;
          }
          return collected;
        }
      );

      const issues = await client.listIssues('o', 'r', { limit: 1 });

      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(1);
      // Page 1 alone already yields 1 non-PR issue meeting the limit; page 2 is never fetched.
      expect(pagesFetched).toBe(1);
    });

    it('normalizes string labels', async () => {
      octokit.paginate.mockResolvedValue([
        {
          number: 3,
          title: 't',
          state: 'open',
          user: { login: 'u' },
          labels: ['quick'],
          assignees: [{ login: 'a' }],
          html_url: 'h',
          created_at: 'c',
          updated_at: 'u',
        },
      ]);
      const issues = await client.listIssues('o', 'r');
      expect(issues[0].labels).toEqual([{ name: 'quick' }]);
      expect(issues[0].assignees).toEqual([{ login: 'a' }]);
    });
  });

  describe('getIssue', () => {
    it('returns a normalized issue', async () => {
      octokit.rest.issues.get.mockResolvedValue({
        data: {
          number: 8,
          title: 't',
          body: 'b',
          state: 'open',
          user: { login: 'u' },
          labels: [],
          assignees: [],
          html_url: 'h',
          created_at: 'c',
          updated_at: 'd',
        },
      });
      const issue = await client.getIssue('o', 'r', 8);
      expect(octokit.rest.issues.get).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        issue_number: 8,
      });
      expect(issue.number).toBe(8);
    });

    it('throws a teaching 404 naming the issue number and source tools', async () => {
      octokit.rest.issues.get.mockRejectedValue({ status: 404 });
      await expect(client.getIssue('o', 'r', 404)).rejects.toThrow(
        'Issue #404 not found in o/r. Check the number with listIssues, or the owner/repo with getRepo, or your token may lack access.'
      );
    });
  });

  describe('createIssue', () => {
    it('creates an issue', async () => {
      octokit.rest.issues.create.mockResolvedValue({
        data: {
          number: 12,
          title: 'New',
          state: 'open',
          user: { login: 'u' },
          labels: [{ name: 'bug' }],
          assignees: [{ login: 'me' }],
          html_url: 'h',
          created_at: 'c',
          updated_at: 'd',
        },
      });
      const issue = await client.createIssue('o', 'r', {
        title: 'New',
        body: 'b',
        labels: ['bug'],
        assignees: ['me'],
      });
      expect(octokit.rest.issues.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'New', body: 'b', labels: ['bug'], assignees: ['me'] })
      );
      expect(issue.number).toBe(12);
    });

    it('throws when title is missing', async () => {
      await expect(client.createIssue('o', 'r', { title: '' })).rejects.toThrow(
        'Missing required parameter'
      );
    });
  });

  describe('updateIssue', () => {
    it('updates an issue', async () => {
      octokit.rest.issues.update.mockResolvedValue({
        data: {
          number: 4,
          title: 'Renamed',
          state: 'closed',
          user: { login: 'u' },
          labels: [],
          assignees: [],
          html_url: 'h',
          created_at: 'c',
          updated_at: 'd',
        },
      });
      const issue = await client.updateIssue('o', 'r', 4, {
        title: 'Renamed',
        state: 'closed',
        labels: ['x'],
        assignees: ['y'],
      });
      expect(octokit.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 4,
          title: 'Renamed',
          state: 'closed',
          labels: ['x'],
          assignees: ['y'],
        })
      );
      expect(issue.state).toBe('closed');
    });
  });

  describe('closeIssue', () => {
    it('updates the issue state to closed', async () => {
      octokit.rest.issues.update.mockResolvedValue({
        data: {
          number: 4,
          title: 't',
          state: 'closed',
          user: { login: 'u' },
          labels: [],
          assignees: [],
          html_url: 'h',
          created_at: 'c',
          updated_at: 'd',
        },
      });
      const issue = await client.closeIssue('o', 'r', 4);
      expect(octokit.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 4, state: 'closed' })
      );
      expect(issue.state).toBe('closed');
    });
  });

  // ── labels ─────────────────────────────────────────────────────────────────
  describe('listLabels', () => {
    it('lists labels', async () => {
      octokit.paginate.mockResolvedValue([
        { id: 1, name: 'bug', color: 'ff0000', description: 'a bug' },
      ]);
      const labels = await client.listLabels('o', 'r');
      expect(labels).toEqual([{ id: 1, name: 'bug', color: 'ff0000', description: 'a bug' }]);
    });
  });

  describe('createLabel', () => {
    it('strips the leading # from the color', async () => {
      octokit.rest.issues.createLabel.mockResolvedValue({
        data: { id: 2, name: 'p1', color: '00ff00', description: undefined },
      });
      const label = await client.createLabel('o', 'r', { name: 'p1', color: '#00ff00' });
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'p1', color: '00ff00' })
      );
      expect(label).toMatchObject({ id: 2, name: 'p1', color: '00ff00' });
    });

    it('accepts a bare hex color', async () => {
      octokit.rest.issues.createLabel.mockResolvedValue({
        data: { id: 3, name: 'p2', color: 'aabbcc' },
      });
      await client.createLabel('o', 'r', { name: 'p2', color: 'aabbcc', description: 'd' });
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'aabbcc', description: 'd' })
      );
    });

    it('throws when name or color is missing', async () => {
      await expect(client.createLabel('o', 'r', { name: '', color: 'fff' })).rejects.toThrow(
        'Missing required parameter'
      );
    });

    it('throws a teaching 422 when the label already exists', async () => {
      octokit.rest.issues.createLabel.mockRejectedValue({
        status: 422,
        message: 'Validation Failed',
      });
      await expect(client.createLabel('o', 'r', { name: 'bug', color: 'fff' })).rejects.toThrow(
        "Could not create label 'bug' in o/r (it may already exist; check with listLabels): Validation Failed"
      );
    });

    it('rethrows a non-422 error unchanged and unmarked', async () => {
      const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 });
      octokit.rest.issues.createLabel.mockRejectedValue(serverError);
      await expect(client.createLabel('o', 'r', { name: 'bug', color: 'fff' })).rejects.toThrow(
        serverError
      );
      await client.createLabel('o', 'r', { name: 'bug', color: 'fff' }).catch((error) => {
        expect(isExpectedError(error)).toBe(false);
      });
    });
  });

  // ── tags & releases ────────────────────────────────────────────────────────
  describe('createTag', () => {
    it('creates a lightweight tag ref pointing at the commit', async () => {
      octokit.rest.git.createRef.mockResolvedValue({ data: {} });
      const result = await client.createTag('o', 'r', { tag: 'v1.0.0', sha: 'abc' });
      expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        ref: 'refs/tags/v1.0.0',
        sha: 'abc',
      });
      expect(octokit.rest.git.createTag).not.toHaveBeenCalled();
      expect(result).toEqual({ tag: 'v1.0.0', sha: 'abc', ref: 'refs/tags/v1.0.0' });
    });

    it('creates an annotated tag object first when a message is given', async () => {
      octokit.rest.git.createTag.mockResolvedValue({ data: { sha: 'tagsha' } });
      octokit.rest.git.createRef.mockResolvedValue({ data: {} });
      const result = await client.createTag('o', 'r', {
        tag: 'v2.0.0',
        sha: 'abc',
        message: 'release 2.0',
      });
      expect(octokit.rest.git.createTag).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: 'v2.0.0',
          message: 'release 2.0',
          object: 'abc',
          type: 'commit',
        })
      );
      expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        ref: 'refs/tags/v2.0.0',
        sha: 'tagsha',
      });
      expect(result.sha).toBe('tagsha');
    });

    it('throws when tag or sha is missing', async () => {
      await expect(client.createTag('o', 'r', { tag: '', sha: 'abc' })).rejects.toThrow(
        'Missing required parameter'
      );
    });

    it('throws a teaching 404 naming the SHA and source tools when annotating', async () => {
      octokit.rest.git.createTag.mockRejectedValue({ status: 404 });
      await expect(
        client.createTag('o', 'r', { tag: 'v1.0.0', sha: 'bogus', message: 'm' })
      ).rejects.toThrow(
        "SHA 'bogus' not found in o/r. Check it with listCommits or getBranch. The owner/repo may also be wrong, or your token may lack access."
      );
    });

    it('throws a teaching 422 when the tag ref already exists', async () => {
      octokit.rest.git.createRef.mockRejectedValue({
        status: 422,
        message: 'Reference already exists',
      });
      await expect(client.createTag('o', 'r', { tag: 'v1.0.0', sha: 'abc' })).rejects.toThrow(
        "Could not create tag 'v1.0.0' in o/r (it may already exist): Reference already exists"
      );
    });
  });

  describe('deleteTag', () => {
    it('deletes a tag ref', async () => {
      octokit.rest.git.deleteRef.mockResolvedValue({});
      const result = await client.deleteTag('o', 'r', 'v1.0.0');
      expect(octokit.rest.git.deleteRef).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        ref: 'tags/v1.0.0',
      });
      expect(result).toEqual({ deleted: true, tag: 'v1.0.0' });
    });
  });

  describe('createRelease', () => {
    it('creates a release defaulting name to the tag', async () => {
      octokit.rest.repos.createRelease.mockResolvedValue({
        data: {
          id: 1,
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          body: 'notes',
          draft: false,
          prerelease: false,
          html_url: 'h',
          created_at: 'c',
        },
      });
      const release = await client.createRelease('o', 'r', { tag_name: 'v1.0.0', body: 'notes' });
      expect(octokit.rest.repos.createRelease).toHaveBeenCalledWith(
        expect.objectContaining({ tag_name: 'v1.0.0', name: 'v1.0.0', body: 'notes' })
      );
      expect(release).toMatchObject({ id: 1, tag_name: 'v1.0.0', draft: false, prerelease: false });
    });

    it('passes draft / prerelease / target_commitish through', async () => {
      octokit.rest.repos.createRelease.mockResolvedValue({
        data: {
          id: 2,
          tag_name: 'v2.0.0-rc1',
          name: 'RC1',
          draft: true,
          prerelease: true,
          html_url: 'h',
          created_at: 'c',
        },
      });
      await client.createRelease('o', 'r', {
        tag_name: 'v2.0.0-rc1',
        name: 'RC1',
        draft: true,
        prerelease: true,
        target_commitish: 'dev',
      });
      expect(octokit.rest.repos.createRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'RC1',
          draft: true,
          prerelease: true,
          target_commitish: 'dev',
        })
      );
    });

    it('throws when tag_name is missing', async () => {
      await expect(client.createRelease('o', 'r', { tag_name: '' })).rejects.toThrow(
        'Missing required parameter'
      );
    });

    it('throws a teaching 422 when a release for the tag already exists', async () => {
      octokit.rest.repos.createRelease.mockRejectedValue({
        status: 422,
        message: 'Validation Failed',
      });
      await expect(client.createRelease('o', 'r', { tag_name: 'v1.0.0' })).rejects.toThrow(
        "Could not create a release for tag 'v1.0.0' in o/r (a release for this tag may already exist): Validation Failed"
      );
    });
  });

  // ── error surfacing ────────────────────────────────────────────────────────
  describe('error propagation', () => {
    it('lets API errors bubble out of public methods (formatted by callers / withValidation)', async () => {
      octokit.rest.repos.get.mockRejectedValue({ status: 404, message: 'Not Found' });
      await expect(client.getRepo('o', 'r')).rejects.toMatchObject({ status: 404 });
    });

    it('bubbles errors from list endpoints', async () => {
      octokit.paginate.mockRejectedValue({ status: 403, message: 'forbidden' });
      await expect(client.listPullRequests('o', 'r')).rejects.toMatchObject({ status: 403 });
    });
  });
});

// ── initializeGitHubClient ───────────────────────────────────────────────────
describe('initializeGitHubClient', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let initializeGitHubClient: typeof import('./client.js').initializeGitHubClient;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const module = await import('./client.js');
    initializeGitHubClient = module.initializeGitHubClient;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns a client when the token is found and the connection test succeeds', async () => {
    mockLoadTokenFile.mockResolvedValue('test-token');
    octokitHolder.instance = {
      rest: {
        users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'octocat' } }) },
      },
    };
    const client = await initializeGitHubClient();
    expect(mockLoadTokenFile).toHaveBeenCalledWith('token');
    expect(client).not.toBeNull();
    const opts = mockOctokitConstructor.mock.calls[
      mockOctokitConstructor.mock.calls.length - 1
    ][0] as { auth: string };
    expect(opts.auth).toBe('test-token');
  });

  it('loads the token by name via loadTokenFile regardless of TOKENS_DIR', async () => {
    // The TOKENS_DIR-or-/tokens resolution now lives in the shared loadTokenFile
    // (tested in shared/security.test.ts), so the worker just passes the name.
    process.env.TOKENS_DIR = '/custom/tokens';
    mockLoadTokenFile.mockResolvedValue('test-token');
    octokitHolder.instance = {
      rest: { users: { getAuthenticated: vi.fn().mockResolvedValue({ data: {} }) } },
    };
    await initializeGitHubClient();
    expect(mockLoadTokenFile).toHaveBeenCalledWith('token');
  });

  it('returns null when the token is empty', async () => {
    mockLoadTokenFile.mockResolvedValue('');
    const result = await initializeGitHubClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns null when the token is null', async () => {
    mockLoadTokenFile.mockResolvedValue(null);
    const result = await initializeGitHubClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns client + schedules background test when testConnection fails', async () => {
    // testConnection runs in the background; the client is returned immediately.
    mockLoadTokenFile.mockResolvedValue('test-token');
    octokitHolder.instance = {
      rest: {
        users: {
          getAuthenticated: vi.fn().mockRejectedValue({ status: 401, message: 'Bad credentials' }),
        },
      },
    };
    const result = await initializeGitHubClient();
    expect(result).not.toBeNull();
    await vi.waitFor(() => expect(result!.statusTracker.getStatus()).toBe('failed'));
  });

  it('initializeGitHubClient resolves quickly when testConnection hangs', async () => {
    mockLoadTokenFile.mockResolvedValue('test-token');
    octokitHolder.instance = {
      rest: {
        users: {
          getAuthenticated: vi.fn().mockImplementation(() => new Promise(() => {})),
        },
      },
    };
    const t0 = Date.now();
    const result = await initializeGitHubClient();
    const elapsedMs = Date.now() - t0;
    expect(result).not.toBeNull();
    expect(elapsedMs).toBeLessThan(100);
  });

  it('status tracker drives makeStandardHealthCheck — bg failure makes hc throw', async () => {
    const { makeStandardHealthCheck } = await import('@speedwave/mcp-shared');
    mockLoadTokenFile.mockResolvedValue('test-token');
    octokitHolder.instance = {
      rest: {
        users: {
          getAuthenticated: vi.fn().mockRejectedValue({ status: 401, message: 'Bad credentials' }),
        },
      },
    };

    const result = await initializeGitHubClient();
    expect(result).not.toBeNull();
    await vi.waitFor(() => expect(result!.statusTracker.getStatus()).toBe('failed'));

    const hc = makeStandardHealthCheck(result!.statusTracker, 'GitHub');
    await expect(hc()).rejects.toThrow(/GitHub connection failed/);
  });

  it('status tracker drives makeStandardHealthCheck — unknown during warmup is healthy', async () => {
    const { makeStandardHealthCheck } = await import('@speedwave/mcp-shared');
    mockLoadTokenFile.mockResolvedValue('test-token');
    octokitHolder.instance = {
      rest: {
        users: {
          getAuthenticated: vi.fn().mockImplementation(() => new Promise(() => {})),
        },
      },
    };

    const result = await initializeGitHubClient();
    expect(result).not.toBeNull();
    expect(result!.statusTracker.getStatus()).toBe('unknown');

    const hc = makeStandardHealthCheck(result!.statusTracker, 'GitHub');
    await expect(hc()).resolves.toBeUndefined();
  });

  it('getHealthStatus delegates to the shared statusTracker', async () => {
    const { GitHubClient } = await import('./client.js');
    const c = new GitHubClient({ token: 'x' });
    expect(c.getHealthStatus()).toEqual({ connection: 'unknown', connectionError: null });
    c.statusTracker.setFailed(new Error('boom'));
    expect(c.getHealthStatus()).toEqual({ connection: 'failed', connectionError: 'boom' });
  });

  it('returns null when loadToken throws, logging the error detail', async () => {
    mockLoadTokenFile.mockRejectedValue(new Error('EACCES: permission denied, open /tokens/token'));
    const result = await initializeGitHubClient();
    expect(result).toBeNull();
    // The warning must carry the underlying error detail.
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(warned).toContain('Failed to initialize GitHub client');
    expect(warned).toContain('EACCES: permission denied');
  });

  it('falls back to error.message when the thrown Error has no stack', async () => {
    const e = new Error('no-stack error');
    e.stack = undefined;
    mockLoadTokenFile.mockRejectedValue(e);
    const result = await initializeGitHubClient();
    expect(result).toBeNull();
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(warned).toContain('no-stack error');
  });

  it('stringifies a non-Error thrown value', async () => {
    mockLoadTokenFile.mockRejectedValue('plain string failure');
    const result = await initializeGitHubClient();
    expect(result).toBeNull();
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(warned).toContain('plain string failure');
  });
});

// ── response mappers (via public methods, covering defensive fallbacks) ──────
describe('Response mappers — defensive fallbacks', () => {
  let GitHubClientClass: typeof GitHubClientType;
  let client: InstanceType<typeof GitHubClientType>;
  let octokit: MockOctokit;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    octokit = buildMockOctokit();
    octokitHolder.instance = octokit as unknown as Record<string, unknown>;
    const module = await import('./client.js');
    GitHubClientClass = module.GitHubClient;
    client = new GitHubClientClass({ token: 't' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills defaults for a sparse repo response', async () => {
    octokit.rest.repos.get.mockResolvedValue({ data: { id: 1 } });
    const repo = await client.getRepo('o', 'r');
    expect(repo).toEqual({
      id: 1,
      name: '',
      full_name: '',
      owner: { login: '' },
      description: undefined,
      html_url: '',
      default_branch: '',
      private: false,
    });
  });

  it('fills defaults for a sparse PR response and treats unknown state as open', async () => {
    octokit.rest.pulls.get.mockResolvedValue({ data: { number: 1 } });
    const pr = await client.getPullRequest('o', 'r', 1);
    expect(pr).toMatchObject({
      number: 1,
      title: '',
      state: 'open',
      merged: undefined,
      draft: undefined,
      head: { ref: '', sha: '' },
      base: { ref: '' },
      user: { login: '' },
    });
  });

  it('fills defaults for a sparse issue response', async () => {
    octokit.rest.issues.get.mockResolvedValue({ data: { number: 1 } });
    const issue = await client.getIssue('o', 'r', 1);
    expect(issue).toMatchObject({
      number: 1,
      title: '',
      state: 'open',
      labels: [],
      assignees: [],
      user: { login: '' },
    });
  });

  it('fills defaults for a sparse commit in compareBranches', async () => {
    octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { commits: [{}] } });
    const cmp = await client.compareBranches('o', 'r', 'a', 'b');
    expect(cmp).toMatchObject({ ahead_by: 0, behind_by: 0, total_commits: 0, status: '' });
    expect(cmp.commits[0]).toEqual({
      sha: '',
      commit: { message: '', author: { name: '', email: '', date: '' } },
      html_url: '',
    });
  });

  it('returns an empty commits list when compareBranches data omits commits', async () => {
    octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue({ data: {} });
    const cmp = await client.compareBranches('o', 'r', 'a', 'b');
    expect(cmp).toEqual({
      ahead_by: 0,
      behind_by: 0,
      total_commits: 0,
      status: '',
      commits: [],
    });
  });

  it('reports both missing params (plural) in validateRequired', async () => {
    await expect(client.getRepo('', '')).rejects.toThrow(
      'Missing required parameters: owner, repo'
    );
  });

  it('normalizes a sparse branch (mapBranch defaults)', async () => {
    octokit.rest.repos.getBranch.mockResolvedValue({ data: {} });
    const branch = await client.getBranch('o', 'r', 'main');
    expect(branch).toEqual({ name: '', commit: { sha: '' }, protected: false });
  });

  it('normalizes a sparse label (mapLabel defaults)', async () => {
    octokit.rest.issues.createLabel.mockResolvedValue({ data: { id: 1 } });
    const label = await client.createLabel('o', 'r', { name: 'bug', color: 'ff0000' });
    expect(label).toEqual({ id: 1, name: '', color: '', description: undefined });
  });

  it('normalizes a sparse release (mapRelease defaults)', async () => {
    octokit.rest.repos.createRelease.mockResolvedValue({ data: { id: 7 } });
    const release = await client.createRelease('o', 'r', { tag_name: 'v1.0.0' });
    expect(release).toEqual({
      id: 7,
      tag_name: '',
      name: undefined,
      body: undefined,
      draft: false,
      prerelease: false,
      html_url: '',
      created_at: '',
    });
  });

  it('normalizes a sparse workflow run (mapWorkflowRun defaults)', async () => {
    octokit.rest.actions.getWorkflowRun.mockResolvedValue({ data: { id: 9 } });
    const run = await client.getWorkflowRun('o', 'r', 9);
    expect(run).toEqual({
      id: 9,
      name: undefined,
      status: '',
      conclusion: null,
      head_branch: '',
      head_sha: '',
      html_url: '',
      created_at: '',
      updated_at: '',
    });
  });

  it('normalizes a sparse artifact (mapArtifact defaults)', async () => {
    octokit.paginate.mockResolvedValue([{ id: 1 }]);
    const artifacts = await client.listWorkflowRunArtifacts('o', 'r', 7);
    expect(artifacts).toEqual([
      { id: 1, name: '', size_in_bytes: 0, archive_download_url: '', expired: false },
    ]);
  });

  it('normalizes a sparse review (mapReview defaults)', async () => {
    octokit.rest.pulls.createReview.mockResolvedValue({ data: { id: 5 } });
    const review = await client.createPrReview('o', 'r', 3, { event: 'COMMENT' });
    expect(review).toEqual({
      id: 5,
      user: { login: '' },
      state: '',
      body: undefined,
      submitted_at: undefined,
      html_url: '',
    });
  });

  it('normalizes a sparse PR comment (mapComment defaults)', async () => {
    octokit.rest.issues.createComment.mockResolvedValue({ data: { id: 2 } });
    const comment = await client.createPrComment('o', 'r', 3, 'hi');
    expect(comment).toEqual({
      id: 2,
      user: { login: '' },
      body: '',
      created_at: '',
      html_url: '',
    });
  });

  it('normalizes a sparse review comment (mapReviewComment defaults, no line)', async () => {
    octokit.rest.pulls.createReviewComment.mockResolvedValue({ data: { id: 3 } });
    const comment = await client.createPrReviewComment('o', 'r', 3, {
      body: 'note',
      commit_id: 'sha',
      path: 'a.ts',
      line: 1,
    });
    expect(comment).toEqual({
      id: 3,
      user: { login: '' },
      body: '',
      path: '',
      line: undefined,
      created_at: '',
      html_url: '',
    });
  });

  it('normalizes sparse issue labels-as-strings and missing user/assignees (mapIssue)', async () => {
    octokit.rest.issues.get.mockResolvedValue({
      data: { number: 1, labels: ['plain', {}], assignees: [{}], state: 'closed' },
    });
    const issue = await client.getIssue('o', 'r', 1);
    expect(issue).toEqual({
      number: 1,
      title: '',
      body: undefined,
      state: 'closed',
      user: { login: '' },
      labels: [{ name: 'plain' }, { name: '' }],
      assignees: [{ login: '' }],
      html_url: '',
      created_at: '',
      updated_at: '',
    });
  });

  it('normalizes sparse tree entries and an empty tree (mapTreeItem + Array.isArray fallback)', async () => {
    octokit.rest.git.getTree.mockResolvedValueOnce({ data: { tree: [{}] } });
    const items = await client.getTree('o', 'r', { ref: 'main' });
    expect(items).toEqual([{ path: '', mode: '', type: 'blob', sha: '', size: undefined }]);

    octokit.rest.git.getTree.mockResolvedValueOnce({ data: {} });
    const empty = await client.getTree('o', 'r', { ref: 'main' });
    expect(empty).toEqual([]);
  });

  it('returns an empty list when listRepos search response omits items', async () => {
    octokit.rest.search.repos.mockResolvedValue({ data: {} });
    const repos = await client.listRepos({ search: 'nothing' });
    expect(repos).toEqual([]);
  });

  it('handles a sparse searchCode item and a response without items', async () => {
    octokit.rest.search.code.mockResolvedValueOnce({ data: { items: [{}] } });
    const matches = await client.searchCode('foo');
    expect(matches).toEqual([{ path: '', repository: '', html_url: '' }]);

    octokit.rest.search.code.mockResolvedValueOnce({ data: {} });
    const none = await client.searchCode('bar');
    expect(none).toEqual([]);
  });

  it('returns an empty list when searchCommits response omits items', async () => {
    octokit.rest.search.commits.mockResolvedValue({ data: {} });
    const commits = await client.searchCommits('fix');
    expect(commits).toEqual([]);
  });

  it('fills defaults for a sparse merge response (mergePullRequest)', async () => {
    octokit.rest.pulls.merge.mockResolvedValue({ data: {} });
    const result = await client.mergePullRequest('o', 'r', 3);
    expect(result).toEqual({ merged: false, sha: '', message: '' });
  });

  it('fills defaults for sparse PR file entries (getPrFiles)', async () => {
    octokit.paginate.mockResolvedValue([{}]);
    const files = await client.getPrFiles('o', 'r', 3);
    expect(files).toEqual([
      { filename: '', status: '', additions: 0, deletions: 0, changes: 0, patch: undefined },
    ]);
  });

  it('fills defaults for a sparse file-content response (getFileContents)', async () => {
    octokit.rest.repos.getContent.mockResolvedValue({ data: { type: 'file', content: '' } });
    const file = await client.getFileContents('o', 'r', 'docs/x.md');
    expect(file).toEqual({
      path: 'docs/x.md',
      content: '',
      encoding: 'utf-8',
      sha: '',
      size: 0,
    });
  });

  it('fills defaults for a sparse createOrUpdateFile response', async () => {
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({ data: {} });
    const result = await client.createOrUpdateFile('o', 'r', {
      path: 'x.md',
      content: 'c',
      message: 'm',
      sha: 'given',
    });
    expect(result).toEqual({ commit_sha: '', path: 'x.md', html_url: '' });
  });

  it('throws when getRunLogs gets no redirect url (neither Location header nor res.url)', async () => {
    octokit.rest.actions.downloadWorkflowRunLogs.mockResolvedValue({});
    await expect(client.getRunLogs('o', 'r', 7)).rejects.toThrow(
      'no download URL for workflow run logs'
    );
  });

  it('throws when downloadArtifact gets no redirect url (neither Location header nor res.url)', async () => {
    octokit.rest.actions.downloadArtifact.mockResolvedValue({});
    await expect(client.downloadArtifact('o', 'r', 42)).rejects.toThrow(
      'no download URL for workflow artifact'
    );
  });

  it('throws when getRunLogs is redirected to a non-HTTPS URL (SSRF guard)', async () => {
    octokit.rest.actions.downloadWorkflowRunLogs.mockResolvedValue({
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    });
    await expect(client.getRunLogs('o', 'r', 7)).rejects.toThrow(
      'non-HTTPS download URL for workflow run logs'
    );
  });

  it('throws when downloadArtifact is redirected to a non-HTTPS URL (SSRF guard)', async () => {
    octokit.rest.actions.downloadArtifact.mockResolvedValue({ url: 'file:///etc/passwd' });
    await expect(client.downloadArtifact('o', 'r', 42)).rejects.toThrow(
      'non-HTTPS download URL for workflow artifact'
    );
  });

  it('falls back to the commit SHA when an annotated tag object omits sha (createTag)', async () => {
    octokit.rest.git.createTag.mockResolvedValue({ data: {} });
    octokit.rest.git.createRef.mockResolvedValue({ data: {} });
    const result = await client.createTag('o', 'r', { tag: 'v3.0.0', sha: 'abc', message: 'rel' });
    expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      ref: 'refs/tags/v3.0.0',
      sha: 'abc',
    });
    expect(result).toEqual({ tag: 'v3.0.0', sha: 'abc', ref: 'refs/tags/v3.0.0' });
  });

  it('treats a connection error without a message as "unknown" (testConnection)', async () => {
    octokit.rest.users.getAuthenticated.mockRejectedValue({});
    const result = await client.testConnection();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('unknown');
  });

  it('handles a falsy thrown value in testConnection (error || {} fallback)', async () => {
    octokit.rest.users.getAuthenticated.mockRejectedValue(undefined);
    const result = await client.testConnection();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('unknown');
  });
});

/**
 * Tests for the withValidation wrapper (client null-check + error formatting).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { withValidation, withNumericForgiveness } from './validation.js';
import { GitHubClient } from '../client.js';
import {
  notConfiguredMessage,
  jsonResult,
  type Tool,
  type ToolDefinition,
  type ToolsCallResult,
} from '@speedwave/mcp-shared';

/** Builds a ToolDefinition whose inputSchema declares `properties`, tracking the params the handler sees. */
function defWith(
  properties: Record<string, unknown>,
  seen: { value?: Record<string, unknown> }
): ToolDefinition {
  const tool: Tool = {
    name: 'sample',
    description: 'sample tool',
    inputSchema: { type: 'object', properties, required: [] },
  };
  const handler = async (params: Record<string, unknown>): Promise<ToolsCallResult> => {
    seen.value = params;
    return jsonResult({ ok: true });
  };
  return { tool, handler };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withValidation', () => {
  it('returns a "not configured" error when the client is null (handler is never invoked)', async () => {
    let handlerCalled = false;
    const wrapped = withValidation<{ x: number }>(null, async () => {
      handlerCalled = true;
      return jsonResult({ ok: true });
    });

    const result = await wrapped({ x: 1 });

    expect(handlerCalled).toBe(false);
    expect(result).toEqual({
      content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
      isError: true,
    });
  });

  it('invokes the handler with the client and params and returns its result on success', async () => {
    // `new GitHubClient` makes no network calls until a method is invoked, so it is safe to construct.
    const client = new GitHubClient({ token: 'x' });
    let seenClient: GitHubClient | undefined;
    let seenParams: { name: string } | undefined;
    const wrapped = withValidation<{ name: string }>(client, async (c, params) => {
      seenClient = c;
      seenParams = params;
      return jsonResult({ greeting: `hi ${params.name}` });
    });

    const result = await wrapped({ name: 'octocat' });

    expect(seenClient).toBe(client);
    expect(seenParams).toEqual({ name: 'octocat' });
    expect(result).toEqual(jsonResult({ greeting: 'hi octocat' }));
  });

  it('formats errors thrown by the handler via GitHubClient.formatError, and logs non-Octokit errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new GitHubClient({ token: 'x' });
    const wrapped = withValidation<undefined>(client, async () => {
      throw new Error('boom from handler');
    });

    const result = await wrapped(undefined);

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: boom from handler' }],
      isError: true,
    });
    // A plain Error (no numeric `status`) is a programming bug — it must be logged.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected (non-Octokit) error'),
      expect.any(Error)
    );
  });

  it('formats categorized API errors (e.g. 401) thrown by the handler without logging them', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new GitHubClient({ token: 'x' });
    const wrapped = withValidation<undefined>(client, async () => {
      throw { status: 401, message: 'Bad credentials' };
    });

    const result = await wrapped(undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Authentication failed');
    // An Octokit-style error (numeric `status`) is expected — don't log it as a bug.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('does not log a translated 404 (already marked expected) rethrown by the handler', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new GitHubClient({ token: 'x' });
    const wrapped = withValidation<{ owner: string; repo: string; path: string }>(
      client,
      async (c, params) => {
        // getFileContents translates an Octokit 404 into a plain Error marked `expected`.
        await c.getFileContents(params.owner, params.repo, params.path);
        return jsonResult({ ok: true });
      }
    );
    (
      client as unknown as {
        octokit: { rest: { repos: { getContent: () => Promise<never> } } };
      }
    ).octokit.rest.repos.getContent = () => Promise.reject({ status: 404 });

    const result = await wrapped({ owner: 'o', repo: 'r', path: 'missing.txt' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found: 'missing.txt'");
    // A translated 404 is an expected, already-teaching error — never logged as a bug.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('still logs a genuinely foreign error even when it looks like a translated one', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new GitHubClient({ token: 'x' });
    const wrapped = withValidation<undefined>(client, async () => {
      throw new Error("File not found: 'x.txt' but never actually marked expected");
    });

    const result = await wrapped(undefined);

    expect(result.isError).toBe(true);
    // Same text shape as a translated 404, but a plain Error (not a TeachingError), so still a bug.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected (non-Octokit) error'),
      expect.any(Error)
    );
  });

  describe('owner/repo forgiveness', () => {
    it('splits a combined owner/repo string passed in repo when owner is omitted', async () => {
      const client = new GitHubClient({ token: 'x' });
      let seen: Record<string, unknown> | undefined;
      const wrapped = withValidation<{ repo: string }>(client, async (_c, params) => {
        seen = params as unknown as Record<string, unknown>;
        return jsonResult({ ok: true });
      });

      await wrapped({ repo: 'octocat/hello-world' });

      expect(seen).toEqual({ owner: 'octocat', repo: 'hello-world' });
    });

    it('leaves params untouched when owner is already present', async () => {
      const client = new GitHubClient({ token: 'x' });
      let seen: Record<string, unknown> | undefined;
      const wrapped = withValidation<{ owner: string; repo: string }>(
        client,
        async (_c, params) => {
          seen = params as unknown as Record<string, unknown>;
          return jsonResult({ ok: true });
        }
      );

      await wrapped({ owner: 'octocat', repo: 'octocat/hello-world' });

      expect(seen).toEqual({ owner: 'octocat', repo: 'octocat/hello-world' });
    });

    it('leaves repo untouched when it has no slash', async () => {
      const client = new GitHubClient({ token: 'x' });
      let seen: Record<string, unknown> | undefined;
      const wrapped = withValidation<{ repo: string }>(client, async (_c, params) => {
        seen = params as unknown as Record<string, unknown>;
        return jsonResult({ ok: true });
      });

      await wrapped({ repo: 'hello-world' });

      expect(seen).toEqual({ repo: 'hello-world' });
    });

    it('teaches instead of forwarding a repo with more than one slash (nested owner segment)', async () => {
      const client = new GitHubClient({ token: 'x' });
      let handlerCalled = false;
      const wrapped = withValidation<{ repo: string }>(client, async () => {
        handlerCalled = true;
        return jsonResult({ ok: true });
      });

      const result = await wrapped({ repo: 'octocat/hello/world' });

      expect(handlerCalled).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Pass repo as either a bare repository name (with a separate 'owner' param) or a single 'owner/repo' string"
      );
    });

    it('returns a teaching error and never calls the handler when the repo split yields an empty segment', async () => {
      const client = new GitHubClient({ token: 'x' });
      let handlerCalled = false;
      const wrapped = withValidation<{ repo: string }>(client, async () => {
        handlerCalled = true;
        return jsonResult({ ok: true });
      });

      const result = await wrapped({ repo: '/hello-world' });

      expect(handlerCalled).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Error: Invalid repo (received: "/hello-world"). Pass repo as either a bare repository name ' +
          "(with a separate 'owner' param) or a single 'owner/repo' string with exactly one slash and " +
          'non-empty segments on both sides.'
      );
    });
  });

  describe('numeric-id forgiveness (withNumericForgiveness, schema-driven)', () => {
    it.each(['number', 'run_id', 'artifact_id', 'line'] as const)(
      'strips a leading # and coerces %s (a numeric-typed input) to a number',
      async (key) => {
        const seen: { value?: Record<string, unknown> } = {};
        const def = defWith({ [key]: { type: 'number' } }, seen);
        const wrapped = withNumericForgiveness(def);

        await wrapped.handler({ [key]: '#42' });

        expect(seen.value).toEqual({ [key]: 42 });
      }
    );

    it('covers createPrReviewComment.line specifically (derived from its inputSchema)', async () => {
      const seen: { value?: Record<string, unknown> } = {};
      const def = defWith(
        { number: { type: 'number' }, line: { type: 'number' }, path: { type: 'string' } },
        seen
      );
      const wrapped = withNumericForgiveness(def);

      await wrapped.handler({ number: '7', line: '10', path: 'src/index.ts' });

      expect(seen.value).toEqual({ number: 7, line: 10, path: 'src/index.ts' });
    });

    it('leaves an already-numeric id untouched', async () => {
      const seen: { value?: Record<string, unknown> } = {};
      const wrapped = withNumericForgiveness(defWith({ number: { type: 'number' } }, seen));

      await wrapped.handler({ number: 42 });

      expect(seen.value).toEqual({ number: 42 });
    });

    it('does not normalize the pagination `limit` (0 falls through to the handler)', async () => {
      const seen: { value?: Record<string, unknown> } = {};
      const wrapped = withNumericForgiveness(
        defWith({ number: { type: 'number' }, limit: { type: 'number' } }, seen)
      );

      const result = await wrapped.handler({ number: 5, limit: 0 });

      expect(result.isError).toBeUndefined();
      expect(seen.value).toEqual({ number: 5, limit: 0 });
    });

    it('returns the unwrapped definition when the tool declares no numeric-id params', () => {
      const seen: { value?: Record<string, unknown> } = {};
      const def = defWith({ owner: { type: 'string' }, limit: { type: 'number' } }, seen);
      expect(withNumericForgiveness(def)).toBe(def);
    });

    it('returns a teaching error and never calls the handler for a non-numeric string id', async () => {
      const seen: { value?: Record<string, unknown> } = {};
      const wrapped = withNumericForgiveness(defWith({ number: { type: 'number' } }, seen));

      const result = await wrapped.handler({ number: 'not-a-number' });

      expect(seen.value).toBeUndefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Error: Invalid number (received: "not-a-number"). Pass number as a positive integer or its ' +
          'digit string, optionally prefixed with \'#\' (e.g. 42 or "#42").'
      );
    });

    it.each(['4.5', '-3', '0x2A', '1e3', '', '   ', '#'])(
      'rejects the exotic/empty numeric form %j instead of coercing it',
      async (value) => {
        const seen: { value?: Record<string, unknown> } = {};
        const wrapped = withNumericForgiveness(defWith({ number: { type: 'number' } }, seen));

        const result = await wrapped.handler({ number: value });

        expect(seen.value).toBeUndefined();
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid number');
      }
    );

    it('passes non-object params straight through to the handler', async () => {
      const def: ToolDefinition = {
        tool: {
          name: 'sample',
          description: 'd',
          inputSchema: { type: 'object', properties: { number: { type: 'number' } } },
        },
        handler: async () => jsonResult({ ok: true }),
      };
      const wrapped = withNumericForgiveness(def);
      const result = await wrapped.handler(undefined as unknown as Record<string, unknown>);
      expect(result).toEqual(jsonResult({ ok: true }));
    });
  });
});

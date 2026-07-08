/**
 * Tests for the withValidation wrapper (client null-check + error formatting).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { withValidation } from './validation.js';
import { GitHubClient } from '../client.js';
import { notConfiguredMessage, jsonResult } from '@speedwave/mcp-shared';

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
    // Same text shape as a translated 404, but never passed through markExpected — still a bug.
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

    it('supports a repo name containing extra slashes (nested owner segment)', async () => {
      const client = new GitHubClient({ token: 'x' });
      let seen: Record<string, unknown> | undefined;
      const wrapped = withValidation<{ repo: string }>(client, async (_c, params) => {
        seen = params as unknown as Record<string, unknown>;
        return jsonResult({ ok: true });
      });

      await wrapped({ repo: 'octocat/hello/world' });

      expect(seen).toEqual({ owner: 'octocat', repo: 'hello/world' });
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
          "(with a separate 'owner' param) or a full 'owner/repo' string with non-empty segments on " +
          'both sides of the slash.'
      );
    });
  });

  describe('numeric-id forgiveness', () => {
    it.each(['number', 'run_id', 'artifact_id'] as const)(
      'strips a leading # and coerces %s to a number',
      async (key) => {
        const client = new GitHubClient({ token: 'x' });
        let seen: Record<string, unknown> | undefined;
        const wrapped = withValidation<Record<string, unknown>>(client, async (_c, params) => {
          seen = params;
          return jsonResult({ ok: true });
        });

        await wrapped({ [key]: '#42' });

        expect(seen).toEqual({ [key]: 42 });
      }
    );

    it('leaves an already-numeric id untouched', async () => {
      const client = new GitHubClient({ token: 'x' });
      let seen: Record<string, unknown> | undefined;
      const wrapped = withValidation<{ number: number }>(client, async (_c, params) => {
        seen = params as unknown as Record<string, unknown>;
        return jsonResult({ ok: true });
      });

      await wrapped({ number: 42 });

      expect(seen).toEqual({ number: 42 });
    });

    it('returns a teaching error and never calls the handler for a non-numeric string id', async () => {
      const client = new GitHubClient({ token: 'x' });
      let handlerCalled = false;
      const wrapped = withValidation<{ number: unknown }>(client, async () => {
        handlerCalled = true;
        return jsonResult({ ok: true });
      });

      const result = await wrapped({ number: 'not-a-number' });

      expect(handlerCalled).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Error: Invalid number (received: "not-a-number"). Pass number as a number or a numeric ' +
          'string, optionally prefixed with \'#\' (e.g. 42 or "#42").'
      );
    });

    it.each(['run_id', 'artifact_id'] as const)(
      'returns a teaching error naming %s when it is a non-numeric string',
      async (key) => {
        const client = new GitHubClient({ token: 'x' });
        let handlerCalled = false;
        const wrapped = withValidation<Record<string, unknown>>(client, async () => {
          handlerCalled = true;
          return jsonResult({ ok: true });
        });

        const result = await wrapped({ [key]: 'abc' });

        expect(handlerCalled).toBe(false);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(`Invalid ${key} (received: "abc")`);
      }
    );
  });
});

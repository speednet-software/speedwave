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
});

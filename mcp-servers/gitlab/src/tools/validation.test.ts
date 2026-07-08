/**
 * Tests for the withValidation wrapper (client null-check + error formatting).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { withValidation, normalizeIid } from './validation.js';
import { GitLabClient } from '../client.js';
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
      content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitLab')}` }],
      isError: true,
    });
  });

  it('invokes the handler with the client and params and returns its result on success', async () => {
    // `new GitLabClient` makes no network calls until a method is invoked, so it is safe to construct.
    const client = new GitLabClient({ token: 'x', host: 'https://gitlab.example.com' });
    let seenClient: GitLabClient | undefined;
    let seenParams: { name: string } | undefined;
    const wrapped = withValidation<{ name: string }>(client, async (c, params) => {
      seenClient = c;
      seenParams = params;
      return jsonResult({ greeting: `hi ${params.name}` });
    });

    const result = await wrapped({ name: 'tanuki' });

    expect(seenClient).toBe(client);
    expect(seenParams).toEqual({ name: 'tanuki' });
    expect(result).toEqual(jsonResult({ greeting: 'hi tanuki' }));
  });

  it('formats errors thrown by the handler via GitLabClient.formatError, and logs non-GitBeaker errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new GitLabClient({ token: 'x', host: 'https://gitlab.example.com' });
    const wrapped = withValidation<undefined>(client, async () => {
      throw new Error('boom from handler');
    });

    const result = await wrapped(undefined);

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: boom from handler' }],
      isError: true,
    });
    // A plain Error (name !== "Gitbeaker…") is a programming bug — it must be logged.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected (non-GitBeaker) error'),
      expect.any(Error)
    );
  });

  it('does not log GitBeaker request errors as bugs', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new GitLabClient({ token: 'x', host: 'https://gitlab.example.com' });
    const wrapped = withValidation<undefined>(client, async () => {
      const gbError = new Error('404 Not Found');
      gbError.name = 'GitbeakerRequestError';
      throw gbError;
    });

    const result = await wrapped(undefined);

    expect(result.isError).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('normalizeIid', () => {
  it('accepts a plain number', () => {
    expect(normalizeIid(42, 'mr_iid')).toEqual({ ok: true, value: 42 });
  });

  it('accepts a numeric string', () => {
    expect(normalizeIid('42', 'mr_iid')).toEqual({ ok: true, value: 42 });
  });

  it('accepts a "#"-prefixed numeric string', () => {
    expect(normalizeIid('#42', 'mr_iid')).toEqual({ ok: true, value: 42 });
  });

  it.each(['', '   ', '#'])('returns a teaching error for %j instead of coercing to 0', (value) => {
    const result = normalizeIid(value, 'mr_iid');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isError).toBe(true);
      expect(result.error.content[0].text).toContain('mr_iid');
    }
  });

  it('returns a teaching error for a non-numeric string', () => {
    const result = normalizeIid('not-a-number', 'mr_iid');

    expect(result.ok).toBe(false);
  });
});

/**
 * Tests for the withValidation wrapper (client null-check, numeric-id
 * normalization, and error formatting).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { withValidation } from './validation.js';
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

  it('passes non-object params through untouched', async () => {
    const client = new GitLabClient({ token: 'x', host: 'https://gitlab.example.com' });
    const wrapped = withValidation<undefined>(client, async (_c, params) => {
      expect(params).toBeUndefined();
      return jsonResult({ ok: true });
    });

    await wrapped(undefined);
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

describe('withValidation numeric-id normalization', () => {
  const paramNames = ['mr_iid', 'issue_iid', 'pipeline_id', 'job_id'] as const;

  function echoHandler() {
    const client = new GitLabClient({ token: 'x', host: 'https://gitlab.example.com' });
    return withValidation<Record<string, unknown>>(client, async (_c, params) =>
      jsonResult(params)
    );
  }

  it.each(paramNames)('normalizes a plain number for %s', async (param) => {
    const wrapped = echoHandler();
    const result = await wrapped({ [param]: 42 });
    expect(JSON.parse(result.content[0].text as string)).toEqual({ [param]: 42 });
  });

  it.each(paramNames)('normalizes a numeric string for %s', async (param) => {
    const wrapped = echoHandler();
    const result = await wrapped({ [param]: '42' });
    expect(JSON.parse(result.content[0].text as string)).toEqual({ [param]: 42 });
  });

  it.each(paramNames)('strips a "#" prefix for %s', async (param) => {
    const wrapped = echoHandler();
    const result = await wrapped({ [param]: '#42' });
    expect(JSON.parse(result.content[0].text as string)).toEqual({ [param]: 42 });
  });

  it('strips a "!" prefix for mr_iid (GitLab MR reference syntax)', async () => {
    const wrapped = echoHandler();
    const result = await wrapped({ mr_iid: '!42' });
    expect(JSON.parse(result.content[0].text as string)).toEqual({ mr_iid: 42 });
  });

  it.each(['', '   ', '#', 'not-a-number'])(
    'rejects %j with a teaching error naming the param, without calling the handler',
    async (value) => {
      const wrapped = echoHandler();
      const result = await wrapped({ mr_iid: value });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('mr_iid');
    }
  );

  it.each(['4.5', '-3', '0x2A', '1e3'])(
    'rejects the exotic numeric form %j instead of coercing it via Number()',
    async (value) => {
      const wrapped = echoHandler();
      const result = await wrapped({ pipeline_id: value });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('pipeline_id');
    }
  );

  it('rejects a present null value', async () => {
    const wrapped = echoHandler();
    const result = await wrapped({ job_id: null });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('job_id');
  });

  it('leaves params without a numeric-id key untouched', async () => {
    const wrapped = echoHandler();
    const result = await wrapped({ project_id: 'group/project', search: 'foo' });
    expect(JSON.parse(result.content[0].text as string)).toEqual({
      project_id: 'group/project',
      search: 'foo',
    });
  });

  it('leaves a param absent (not undefined-coerced) when not passed', async () => {
    const wrapped = echoHandler();
    const result = await wrapped({ project_id: 1 });
    expect(JSON.parse(result.content[0].text as string)).toEqual({ project_id: 1 });
  });
});

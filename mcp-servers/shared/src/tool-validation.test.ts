import { describe, it, expect, vi } from 'vitest';
import {
  withResultValidation,
  withClientValidation,
  withDeclaredParams,
  type ToolResult,
} from './tool-validation.js';
import type { Tool } from './types.js';

describe('withResultValidation (Family A)', () => {
  it('formats a successful result as pretty JSON by default (indent 2)', async () => {
    const wrapped = withResultValidation<{ x: number }>((p) => ({
      success: true,
      data: { echo: p.x },
    }));
    const res = await wrapped({ x: 5 });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(JSON.stringify({ echo: 5 }, null, 2));
  });

  it('formats with no indent when indent=0 (sharepoint style)', async () => {
    const wrapped = withResultValidation<unknown>(() => ({ success: true, data: { a: 1 } }), 0);
    const res = await wrapped({});
    expect(res.content[0].text).toBe(JSON.stringify({ a: 1 }));
  });

  it('formats an indent=0 failure as compact JSON error', async () => {
    const wrapped = withResultValidation<unknown>(
      (): ToolResult => ({ success: false, error: { code: 'X', message: 'y' } }),
      0
    );
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(JSON.stringify({ code: 'X', message: 'y' }));
  });

  it('rejects non-object params with INVALID_INPUT', async () => {
    const handler = vi.fn();
    const wrapped = withResultValidation(handler);
    const res = await wrapped([] as unknown as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('INVALID_INPUT');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects null params with INVALID_INPUT', async () => {
    const wrapped = withResultValidation(() => ({ success: true }));
    const res = await wrapped(null as unknown as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('INVALID_INPUT');
  });

  it('formats an explicit failure result as an error', async () => {
    const wrapped = withResultValidation<unknown>((): ToolResult => ({
      success: false,
      error: { code: 'NOPE', message: 'bad' },
    }));
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOPE');
  });

  it('maps a thrown Error to HANDLER_ERROR with the message', async () => {
    const wrapped = withResultValidation(() => {
      throw new Error('boom');
    });
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('HANDLER_ERROR');
    expect(res.content[0].text).toContain('boom');
  });

  it('stringifies a thrown non-Error value', async () => {
    const wrapped = withResultValidation(() => {
      throw 'raw';
    });
    const res = await wrapped({});
    expect(res.content[0].text).toContain('raw');
  });

  it('awaits async handlers', async () => {
    const wrapped = withResultValidation(async () => ({ success: true, data: 'async' }));
    const res = await wrapped({});
    expect(res.content[0].text).toContain('async');
  });

  it('short-circuits with a MISSING_PARAM teaching error when a required param is absent', async () => {
    const handler = vi.fn();
    const wrapped = withResultValidation(handler, 2, {
      required: ['channel'],
      toolName: 'sendChannel',
    });
    const res = await wrapped({ text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('MISSING_PARAM');
    expect(res.content[0].text).toContain('channel');
    expect(res.content[0].text).toContain('sendChannel');
    expect(handler).not.toHaveBeenCalled();
  });

  it('treats null and empty-string required params as missing', async () => {
    const handler = vi.fn();
    const nullRes = await withResultValidation(handler, 2, { required: ['channel'] })({
      channel: null,
    });
    const emptyRes = await withResultValidation(handler, 2, { required: ['channel'] })({
      channel: '',
    });
    expect(nullRes.isError).toBe(true);
    expect(emptyRes.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports the first missing required param when several are absent', async () => {
    const wrapped = withResultValidation(vi.fn(), 2, { required: ['channel', 'ts'] });
    const res = await wrapped({});
    expect(res.content[0].text).toContain('channel');
    expect(res.content[0].text).not.toContain('Invalid ts');
  });

  it('invokes the handler when all required params are present', async () => {
    const handler = vi.fn().mockReturnValue({ success: true, data: 'ok' });
    const wrapped = withResultValidation(handler, 2, { required: ['channel'] });
    const res = await wrapped({ channel: 'C1' });
    expect(handler).toHaveBeenCalledWith({ channel: 'C1' });
    expect(res.content[0].text).toContain('ok');
  });

  it('does not treat a numeric 0 required value as missing', async () => {
    const handler = vi.fn().mockReturnValue({ success: true, data: 'ok' });
    const wrapped = withResultValidation(handler, 2, { required: ['count'] });
    await wrapped({ count: 0 });
    expect(handler).toHaveBeenCalled();
  });
});

describe('withClientValidation (Family B)', () => {
  const opts = {
    serviceName: 'TestSvc',
    formatError: (e: unknown) => `formatted:${e instanceof Error ? e.message : String(e)}`,
  };

  it('short-circuits to a not-configured error when client is null', async () => {
    const handler = vi.fn();
    const wrapped = withClientValidation(null, handler, opts);
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('TestSvc not configured');
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes the handler with the client and params when configured', async () => {
    const client = { id: 1 };
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const wrapped = withClientValidation(client, handler, opts);
    const res = await wrapped({ p: 2 });
    expect(handler).toHaveBeenCalledWith(client, { p: 2 });
    expect(res.content[0].text).toBe('ok');
  });

  it('maps a thrown error via formatError', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('api down'));
    const wrapped = withClientValidation({ id: 1 }, handler, opts);
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('formatted:api down');
  });

  it('calls onUnexpectedError for unrecognised errors', async () => {
    const onUnexpectedError = vi.fn();
    const handler = vi.fn().mockRejectedValue(new TypeError('bug'));
    const wrapped = withClientValidation({ id: 1 }, handler, { ...opts, onUnexpectedError });
    await wrapped({});
    expect(onUnexpectedError).toHaveBeenCalledWith(expect.any(TypeError));
  });

  it('does not require onUnexpectedError', async () => {
    const handler = vi.fn().mockRejectedValue('plain');
    const wrapped = withClientValidation({ id: 1 }, handler, opts);
    const res = await wrapped({});
    expect(res.content[0].text).toContain('formatted:plain');
  });
});

describe('withDeclaredParams', () => {
  const tool = (properties: Record<string, unknown>, required?: string[]): Tool => ({
    name: 'updateThing',
    description: 'Update a thing',
    inputSchema: { type: 'object', properties, ...(required ? { required } : {}) },
  });
  const ok = { content: [{ type: 'text' as const, text: 'ok' }] };

  it('passes a call whose arguments are all declared to the handler unchanged', async () => {
    const handler = vi.fn().mockResolvedValue(ok);
    const wrapped = withDeclaredParams(tool({ id: {}, title: {} }), handler);
    const res = await wrapped({ id: 1, title: 'x' });
    expect(res).toBe(ok);
    expect(handler).toHaveBeenCalledWith({ id: 1, title: 'x' });
  });

  it('passes an empty call through when nothing is declared', async () => {
    const handler = vi.fn().mockResolvedValue(ok);
    const res = await withDeclaredParams(tool({}), handler)({});
    expect(res).toBe(ok);
  });

  it('forwards the caller context to the handler', async () => {
    const handler = vi.fn().mockResolvedValue(ok);
    await withDeclaredParams(tool({ id: {} }), handler)({ id: 1 }, { caller: 'svc' });
    expect(handler).toHaveBeenCalledWith({ id: 1 }, { caller: 'svc' });
  });

  it('rejects an undeclared argument without calling the handler', async () => {
    const handler = vi.fn();
    const wrapped = withDeclaredParams(tool({ id: {}, title: {} }), handler);
    const res = await wrapped({ id: 1, version_id: 999999 });
    expect(handler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      'Error: Invalid version_id. updateThing does not accept this parameter, ' +
        'so the call was rejected and nothing was sent. Accepted parameters: id, title. ' +
        'Retry with accepted parameters only.'
    );
  });

  it('names every undeclared argument without echoing any value', async () => {
    const handler = vi.fn();
    const res = await withDeclaredParams(
      tool({ id: {} }),
      handler
    )({
      id: 1,
      a: 'jan.kowalski@example.com',
      b: null,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain('Invalid a, b.');
    expect(res.content[0].text).toContain('does not accept these parameters');
    expect(res.content[0].text).not.toContain('jan.kowalski');
  });

  it('names at most 20 undeclared arguments and counts the rest', async () => {
    const params = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    const res = await withDeclaredParams(tool({}), vi.fn())(params);
    expect(res.content[0].text).toContain('k19 and 5 more.');
    expect(res.content[0].text).not.toContain('k20');
  });

  it('rejects a call missing a required argument without calling the handler', async () => {
    const handler = vi.fn();
    const res = await withDeclaredParams(tool({ identifier: {} }, ['identifier']), handler)({});
    expect(handler).not.toHaveBeenCalled();
    expect(res.content[0].text).toBe(
      'Error: Invalid identifier (received: undefined). updateThing requires identifier, ' +
        'so the call was rejected and nothing was sent.'
    );
  });

  it.each([null, ''])('treats a required argument set to %j as missing', async (value) => {
    const handler = vi.fn();
    const res = await withDeclaredParams(tool({ id: {} }, ['id']), handler)({ id: value });
    expect(handler).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain('updateThing requires id');
  });

  it('accepts a required argument set to 0 or false', async () => {
    const handler = vi.fn().mockResolvedValue(ok);
    const wrapped = withDeclaredParams(tool({ n: {}, f: {} }, ['n', 'f']), handler);
    expect(await wrapped({ n: 0, f: false })).toBe(ok);
  });

  it('reports an undeclared argument before a missing required one', async () => {
    const res = await withDeclaredParams(tool({ id: {} }, ['id']), vi.fn())({ extra: 1 });
    expect(res.content[0].text).toContain('Invalid extra.');
  });

  it('says no parameters are accepted by a tool that declares none', async () => {
    const res = await withDeclaredParams(tool({}), vi.fn())({ verbose: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Accepted parameters: none.');
  });

  it('rejects an argument that only matches an Object prototype member', async () => {
    const handler = vi.fn();
    const res = await withDeclaredParams(tool({ id: {} }), handler)({ constructor: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain('Invalid constructor');
  });

  it('rejects a name that differs from a declared one only in case', async () => {
    const handler = vi.fn();
    const res = await withDeclaredParams(tool({ issue_id: {} }), handler)({ Issue_ID: 5 });
    expect(handler).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain('Invalid Issue_ID.');
  });
});

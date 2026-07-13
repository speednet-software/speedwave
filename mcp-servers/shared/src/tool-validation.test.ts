import { describe, it, expect, vi } from 'vitest';
import { withResultValidation, withClientValidation, type ToolResult } from './tool-validation.js';

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
    const wrapped = withResultValidation<unknown>(
      (): ToolResult => ({ success: false, error: { code: 'NOPE', message: 'bad' } })
    );
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

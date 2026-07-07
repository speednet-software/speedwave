/** Tests for withValidation wrapper. */

import { describe, it, expect, vi } from 'vitest';
import { teachingErrorResult } from '@speedwave/mcp-shared';
import { withValidation, missingParamResult, ToolResult } from './validation.js';

describe('withValidation', () => {
  describe('parameter validation', () => {
    it('returns INVALID_INPUT error when params is null', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockReturnValue({
        success: true,
        data: 'ok',
      });
      const wrapped = withValidation(handler);

      const result = await wrapped(null as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
      expect(parsed.message).toContain('non-null object');
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns INVALID_INPUT error when params is an array', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockReturnValue({
        success: true,
        data: 'ok',
      });
      const wrapped = withValidation(handler);

      const result = await wrapped([] as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns INVALID_INPUT error when params is a string', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockReturnValue({
        success: true,
        data: 'ok',
      });
      const wrapped = withValidation(handler);

      const result = await wrapped('string' as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns INVALID_INPUT error when params is a number', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockReturnValue({
        success: true,
        data: 'ok',
      });
      const wrapped = withValidation(handler);

      const result = await wrapped(42 as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
    });

    it('returns INVALID_INPUT error when params is undefined', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockReturnValue({
        success: true,
        data: 'ok',
      });
      const wrapped = withValidation(handler);

      const result = await wrapped(undefined as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
    });
  });

  describe('happy path', () => {
    it('calls handler with valid object params and returns formatted success result', async () => {
      const mockData = { channel: '#general', ts: '12345.67890' };
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockReturnValue({
        success: true,
        data: mockData,
      });
      const wrapped = withValidation(handler);

      const result = await wrapped({ channel: '#general', message: 'hi' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed).toEqual(mockData);
      expect(handler).toHaveBeenCalledWith({ channel: '#general', message: 'hi' });
    });

    it('works with empty object params', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockReturnValue({
        success: true,
        data: { channels: [] },
      });
      const wrapped = withValidation(handler);

      const result = await wrapped({});

      expect(result.isError).toBeUndefined();
      expect(handler).toHaveBeenCalledWith({});
    });

    it('awaits async handler and returns result', async () => {
      const asyncHandler = vi
        .fn<(p: Record<string, unknown>) => Promise<ToolResult>>()
        .mockResolvedValue({ success: true, data: { ok: true } });
      const wrapped = withValidation(asyncHandler);

      const result = await wrapped({ email: 'alice@example.com' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed).toEqual({ ok: true });
    });

    it('formats success result with pretty-printed JSON', async () => {
      const handler = vi
        .fn<(p: Record<string, unknown>) => ToolResult>()
        .mockReturnValue({ success: true, data: { a: 1 } });
      const wrapped = withValidation(handler);

      const result = await wrapped({});

      // JSON.stringify with indent 2
      expect(result.content[0].text).toBe(JSON.stringify({ a: 1 }, null, 2));
    });
  });

  describe('error path from handler', () => {
    it('formats handler error result correctly', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockReturnValue({
        success: false,
        error: { code: 'SEND_FAILED', message: 'channel_not_found' },
      });
      const wrapped = withValidation(handler);

      const result = await wrapped({ channel: '#no-such', message: 'hi' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('SEND_FAILED');
      expect(parsed.message).toBe('channel_not_found');
    });
  });

  describe('handler throws', () => {
    it('catches Error thrown by handler and returns HANDLER_ERROR', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockImplementation(() => {
        throw new Error('unexpected failure');
      });
      const wrapped = withValidation(handler);

      const result = await wrapped({ channel: '#general' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('HANDLER_ERROR');
      expect(parsed.message).toBe('unexpected failure');
    });

    it('catches non-Error thrown by handler and converts to string', async () => {
      const handler = vi.fn<(p: Record<string, unknown>) => ToolResult>().mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string-error';
      });
      const wrapped = withValidation(handler);

      const result = await wrapped({});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('HANDLER_ERROR');
      expect(parsed.message).toBe('string-error');
    });

    it('catches async handler rejection and returns HANDLER_ERROR', async () => {
      const asyncHandler = vi
        .fn<(p: Record<string, unknown>) => Promise<ToolResult>>()
        .mockRejectedValue(new Error('async failure'));
      const wrapped = withValidation(asyncHandler);

      const result = await wrapped({});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('HANDLER_ERROR');
      expect(parsed.message).toBe('async failure');
    });
  });
});

describe('missingParamResult', () => {
  it('wraps the shared teachingErrorResult message into a MISSING_PARAM ToolResult', () => {
    const teaching = teachingErrorResult({
      paramName: 'message',
      received: undefined,
      nextStep: 'Provide the text to send.',
    });
    const expectedMessage = (teaching.content[0].text as string).replace(/^Error: /, '');

    const result = missingParamResult('message', undefined, 'Provide the text to send.');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAM');
    expect(result.error?.message).toBe(expectedMessage);
    expect(result.error?.message).toContain('Invalid message');
    expect(result.error?.message).toContain('undefined');
    expect(result.error?.message).toContain('Provide the text to send.');
  });

  it('quotes a received string value', () => {
    const result = missingParamResult('channel', '', 'Provide a channel name.');

    expect(result.error?.message).toContain('received: ""');
  });

  it('renders a received null value', () => {
    const result = missingParamResult('users', null, 'Provide an array of user IDs.');

    expect(result.error?.message).toContain('received: null');
  });

  it('stringifies a non-string, non-null received value', () => {
    const result = missingParamResult('limit', 0, 'Provide a positive number.');

    expect(result.error?.message).toContain('received: 0');
  });
});

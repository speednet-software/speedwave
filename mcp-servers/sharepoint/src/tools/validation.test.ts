/**
 * Tests for withValidation wrapper — parameter validation and error wrapping.
 */

import { describe, it, expect } from 'vitest';
import { teachingToolResult } from '@speedwave/mcp-shared';
import { withValidation, validateGraphId } from './validation.js';
import type { ToolResult } from './validation.js';

describe('validateGraphId', () => {
  it('returns null for a valid id', () => {
    expect(validateGraphId('L1', 'listId')).toBeNull();
    expect(validateGraphId('abc-123.def_456', 'listId')).toBeNull();
  });

  it('rejects a non-string value and names the received value', () => {
    const result = validateGraphId(42, 'listId');
    expect(result?.success).toBe(false);
    expect(result?.error?.code).toBe('INVALID_ID');
    expect(result?.error?.message).toContain('listId');
    expect(result?.error?.message).toContain('42');
  });

  it('rejects undefined and renders it as "undefined"', () => {
    const result = validateGraphId(undefined, 'itemId');
    expect(result?.error?.message).toContain('undefined');
  });

  it('rejects a path-traversal string and quotes the received value', () => {
    const result = validateGraphId('bad/../path', 'listId');
    expect(result?.error?.message).toContain('"bad/../path"');
  });

  it('without a sourceTool, derives the char set and length bounds from the regex', () => {
    const result = validateGraphId('bad/../path', 'listId');
    // Both the min (1) and max (128) length bounds come from GRAPH_ID_RE.
    expect(result?.error?.message).toContain('1 to 128 characters');
    expect(result?.error?.message).toContain('[A-Za-z0-9._-]');
  });

  it('with a sourceTool, names it as the place to get a valid value', () => {
    const result = validateGraphId('bad/../path', 'listId', 'listLists');
    expect(result?.error?.message).toContain('listLists');
    expect(result?.error?.message).not.toContain('characters from the set');
  });

  it('rejects an empty string', () => {
    const result = validateGraphId('', 'pageId');
    expect(result?.success).toBe(false);
    expect(result?.error?.code).toBe('INVALID_ID');
  });

  it('rejects a string longer than 128 characters', () => {
    const result = validateGraphId('a'.repeat(129), 'pageId');
    expect(result?.success).toBe(false);
  });

  it('accepts a string exactly 128 characters long', () => {
    expect(validateGraphId('a'.repeat(128), 'pageId')).toBeNull();
  });

  it('produces the exact shared teachingToolResult envelope (message and code)', () => {
    const result = validateGraphId('bad/../path', 'listId', 'listLists');
    const expected = teachingToolResult(
      {
        paramName: 'listId',
        received: 'bad/../path',
        correctValueTool: 'listLists',
        nextStep: 'Retry with that id instead of guessing one.',
      },
      'INVALID_ID'
    );

    expect(result).toEqual(expected);
  });
});

describe('withValidation', () => {
  // ─── validateParams guard ────────────────────────────────────────────────────

  describe('invalid params (INVALID_INPUT)', () => {
    it('returns INVALID_INPUT when params is null', async () => {
      const handler = withValidation(async (_p: Record<string, unknown>) => ({
        success: true,
        data: 'ok',
      }));

      const result = await handler(null as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
      expect(parsed.message).toContain('non-null object');
    });

    it('returns INVALID_INPUT when params is an array', async () => {
      const handler = withValidation(async (_p: unknown[]) => ({
        success: true,
        data: 'ok',
      }));

      const result = await handler([] as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
    });

    it('returns INVALID_INPUT when params is a string', async () => {
      const handler = withValidation(async (_p: string) => ({
        success: true as const,
        data: 'ok',
      }));

      const result = await handler('oops' as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
    });

    it('returns INVALID_INPUT when params is a number', async () => {
      const handler = withValidation(async (_p: unknown) => ({
        success: true as const,
        data: 'ok',
      }));

      const result = await handler(42 as unknown as Record<string, unknown>);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('INVALID_INPUT');
    });
  });

  // ─── handler success path ────────────────────────────────────────────────────

  describe('successful handler', () => {
    it('formats success result as JSON text', async () => {
      const handler = withValidation(
        async (_p: Record<string, unknown>): Promise<ToolResult> => ({
          success: true,
          data: { message: 'hello', count: 3 },
        })
      );

      const result = await handler({ key: 'value' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.message).toBe('hello');
      expect(parsed.count).toBe(3);
    });

    it('formats failure result as JSON text with isError flag', async () => {
      const handler = withValidation(
        async (_p: Record<string, unknown>): Promise<ToolResult> => ({
          success: false,
          error: { code: 'MY_ERROR', message: 'something went wrong' },
        })
      );

      const result = await handler({});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('MY_ERROR');
      expect(parsed.message).toBe('something went wrong');
    });
  });

  // ─── HANDLER_ERROR catch branch ──────────────────────────────────────────────

  describe('HANDLER_ERROR (unexpected throw from handler)', () => {
    it('catches synchronous Error thrown from handler', async () => {
      const handler = withValidation((_p: Record<string, unknown>): ToolResult => {
        throw new Error('Boom from handler');
      });

      const result = await handler({});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('HANDLER_ERROR');
      expect(parsed.message).toBe('Boom from handler');
    });

    it('catches rejected promise from handler', async () => {
      const handler = withValidation(async (_p: Record<string, unknown>): Promise<ToolResult> => {
        return Promise.reject(new Error('async boom'));
      });

      const result = await handler({});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('HANDLER_ERROR');
      expect(parsed.message).toBe('async boom');
    });

    it('catches non-Error thrown value and stringifies it', async () => {
      const handler = withValidation((_p: Record<string, unknown>): ToolResult => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string error';
      });

      const result = await handler({});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('HANDLER_ERROR');
      expect(parsed.message).toBe('string error');
    });
  });
});

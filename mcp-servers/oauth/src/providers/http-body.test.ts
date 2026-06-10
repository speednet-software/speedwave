import { describe, it, expect } from 'vitest';
import { MAX_BODY_BYTES, readJsonCapped } from './http-body.js';

/** Minimal headers stub for a Response-like object. */
function headersOf(map: Record<string, string>): { get: (h: string) => string | null } {
  return { get: (h: string) => map[h.toLowerCase()] ?? null };
}

describe('readJsonCapped', () => {
  it('rejects a declared oversized content-length without reading the body', async () => {
    const response = {
      headers: headersOf({
        'content-type': 'application/json',
        'content-length': String(MAX_BODY_BYTES + 1),
      }),
      body: null,
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        throw new Error('body must not be read');
      },
    } as unknown as Response;

    const result = await readJsonCapped(response);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('exceeds');
  });

  it('reads a chunked streamed body to completion under the cap', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"a":'));
        controller.enqueue(enc.encode('1}'));
        controller.close();
      },
    });
    const response = {
      headers: headersOf({ 'content-type': 'application/json' }),
      body: stream,
    } as unknown as Response;

    const result = await readJsonCapped(response);
    expect(result).toEqual({ ok: true, json: { a: 1 } });
  });
});

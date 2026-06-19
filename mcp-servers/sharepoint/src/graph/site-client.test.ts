/**
 * Tests for {@link ./site-client.ts} — `GraphRequester` interface and `graphV1BaseUrl`.
 */
import { describe, it, expect, vi } from 'vitest';
import { graphV1BaseUrl, type GraphRequester } from './site-client.js';

describe('site-client', () => {
  it('graphV1BaseUrl returns the Microsoft Graph v1.0 endpoint', () => {
    expect(graphV1BaseUrl()).toBe('https://graph.microsoft.com/v1.0');
  });

  it('GraphRequester interface accepts any object with getSiteId + graphRequest', async () => {
    // Smoke: a minimal stub typechecks and can be used by domain clients.
    const stub: GraphRequester = {
      getSiteId: () => 'site-id',
      graphRequest: vi.fn().mockResolvedValue({ ok: true }),
    };
    expect(stub.getSiteId()).toBe('site-id');
    const result = (await stub.graphRequest('GET', '/anything')) as { ok: boolean } | undefined;
    expect(result?.ok).toBe(true);
  });
});

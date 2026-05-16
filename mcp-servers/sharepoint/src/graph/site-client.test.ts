/**
 * Tests for {@link ./site-client.ts} — the shared `GraphRequester` interface
 * and base-URL helper used by the per-domain Graph clients.
 *
 * `SharePointClient` implements `GraphRequester` directly; here we only assert
 * the contract is small and stable. A consumer that imports this module must
 * be able to wire any object that provides `getSiteId` + `graphRequest`.
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

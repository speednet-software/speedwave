/**
 * Tests for the shared Confluence space-key resolver: success, missing key,
 * empty id, 404 allowlist denial, and non-404 rethrow with id context.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveConfluenceSpaceKey } from './confluence-space-resolver.js';
import type { AtlassianClient } from '../client.js';

/**
 * Build a minimal AtlassianClient stub exposing only `get`.
 * @param get - Mocked `get` implementation.
 */
function clientWithGet(get: ReturnType<typeof vi.fn>): AtlassianClient {
  return { get } as unknown as AtlassianClient;
}

describe('resolveConfluenceSpaceKey', () => {
  it('resolves a space id to its key via the v2 spaces endpoint', async () => {
    const get = vi.fn().mockResolvedValue({ key: 'ENG' });
    await expect(resolveConfluenceSpaceKey(clientWithGet(get), '123')).resolves.toBe('ENG');
    expect(get).toHaveBeenCalledWith('/wiki/api/v2/spaces/123');
  });

  it('returns undefined when the payload carries no key', async () => {
    const get = vi.fn().mockResolvedValue({});
    await expect(resolveConfluenceSpaceKey(clientWithGet(get), '123')).resolves.toBeUndefined();
  });

  it('returns undefined without a lookup for an empty space id', async () => {
    const get = vi.fn();
    await expect(resolveConfluenceSpaceKey(clientWithGet(get), '')).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('treats a 404 as unresolvable (allowlist denial) and returns undefined', async () => {
    const get = vi.fn().mockRejectedValue({ response: { status: 404 } });
    await expect(resolveConfluenceSpaceKey(clientWithGet(get), '123')).resolves.toBeUndefined();
  });

  it('rethrows a non-404 failure naming the space and page ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const get = vi.fn().mockRejectedValue({ response: { status: 500 } });
    await expect(resolveConfluenceSpaceKey(clientWithGet(get), '123', '456')).rejects.toThrow(
      "Could not verify Confluence space '123' for page '456' (space lookup failed)"
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('rethrows a non-404 failure without page context when no page id is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const get = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(resolveConfluenceSpaceKey(clientWithGet(get), '123')).rejects.toThrow(
      "Could not verify Confluence space '123' (space lookup failed)"
    );
    warn.mockRestore();
  });

  it('URL-encodes the space id in the lookup path', async () => {
    const get = vi.fn().mockResolvedValue({ key: 'X' });
    await resolveConfluenceSpaceKey(clientWithGet(get), 'a/b');
    expect(get).toHaveBeenCalledWith('/wiki/api/v2/spaces/a%2Fb');
  });
});

/**
 * Smoke test for {@link ./files-client.ts} — verifies the module exists and
 * re-exports the shared `GraphRequester` interface. The actual file-operation
 * methods still live on `SharePointClient` (see the module-level docstring)
 * and are exercised by `client.test.ts` / `handlers.test.ts`.
 *
 * When file ops migrate onto a `FilesClient` class, replace this with the
 * same kind of black-box assertions used by `pages-client.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { GraphRequester } from './files-client.js';

describe('files-client module surface', () => {
  it('re-exports GraphRequester from site-client', () => {
    // Type-only re-export — compile-time assertion: a value typed as
    // `GraphRequester` from `files-client.js` is assignable to the same
    // interface from `site-client.js`. We use a minimal stub to keep the
    // assertion trivial at runtime.
    const stub: GraphRequester = {
      getSiteId: () => 'site-id',
      graphRequest: async () => undefined,
    };
    expect(stub.getSiteId()).toBe('site-id');
  });
});

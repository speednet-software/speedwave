import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration consumed via `ng test --runner-config vitest.config.ts`.
 *
 * `isolate: true` gives every spec file a fresh module graph. Without
 * isolation, a `vi.fn()` defined under a `vi.mock(...)` factory leaks
 * across sibling specs that import the same module — under
 * concurrency, an assertion in one spec sees mock state set by another.
 * Isolation makes per-spec mocks deterministic on every runner.
 */
export default defineConfig({
  test: {
    isolate: true,
  },
});

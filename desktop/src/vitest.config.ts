import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration consumed via `ng test --runner-config vitest.config.ts`.
 * `isolate: true` gives every spec file a fresh module graph (no mock leakage between specs).
 */
export default defineConfig({
  test: {
    isolate: true,
  },
});

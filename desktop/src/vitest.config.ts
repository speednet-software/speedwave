import { defineConfig } from 'vitest/config';

/**
 * `isolate: true` gives every spec file a fresh module graph (no mock leakage between specs).
 */
export default defineConfig({
  test: {
    isolate: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});

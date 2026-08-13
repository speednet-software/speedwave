import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // wasm-pkg is generated wasm-bindgen glue (crates/pii-engine-wasm), not our source.
      exclude: ['wasm-pkg/**', 'coverage/**', 'dist/**', 'node_modules/**'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 95,
        statements: 100,
      },
    },
  },
});

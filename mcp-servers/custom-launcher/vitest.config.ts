import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['src/index.ts', 'src/**/*.test.ts', 'test/**'],
      thresholds: {
        lines: 98,
        functions: 96,
        branches: 95,
        statements: 98,
      },
    },
  },
});

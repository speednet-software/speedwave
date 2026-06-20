import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Floors trail measured values; funcs floor reflects unspyable ESM fs/promises paths in restricted-write.ts.
      thresholds: {
        lines: 99,
        functions: 96,
        branches: 95,
        statements: 99,
      },
    },
  },
});

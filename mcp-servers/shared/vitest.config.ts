import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Floors trail measured values by ~1 pp so CI never auto-loosens but
      // does not block on two stubborn fn-coverage paths in
      // `restricted-write.ts` (the `.catch(() => {})` arrows inside the
      // error-cleanup branch — fired only when `handle.writeFile` /
      // `handle.chmod` / `handle.sync` throw after `fs.open` succeeded;
      // the ESM `fs/promises` module namespace is not configurable so
      // those handle methods cannot be spied on at unit-test scope).
      //
      // Actual at landing (PR #671): stmts 99.3 / branches 97.9 /
      //                              funcs 96.77 / lines 99.46
      thresholds: {
        lines: 99,
        functions: 96,
        branches: 95,
        statements: 99,
      },
    },
  },
});
